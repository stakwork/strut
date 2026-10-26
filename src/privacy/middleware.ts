import { randomBytes } from "node:crypto";
import { emitMasked } from "./events.js";
import type { ModelCallInfo, StepContext } from "./host.js";
import { maskText } from "./index.js";
import { policyKey, type PrivacyPolicy } from "./policy.js";
import { indexAssistant, indexSession, lateEntities, newSession, restoredHash, sha, type SessionPrivacy, type StoredMasked } from "./session.js";
import { readStamp, stripStamp, unstamped, withStamp } from "./stamp.js";
import { restore } from "./restore.js";
import { StreamRestorer } from "./stream-restore.js";
import { keepsPseudonyms } from "./tool-policy.js";
import { jsonEscape, restoreToolInput } from "./tool-restore.js";
import type { TranscriptStore } from "./transcript.js";
import type { TokenMap } from "./types.js";

// A language-model middleware (AI SDK, spec v4). What a hosted provider is sent is masked; what comes
// back is restored. Strut's code, tools and session files only ever see real text.
//
// MASK ONCE, RESEND BYTE FOR BYTE. The SDK resends the whole history on every call. Masking old
// messages again would not give the same bytes (restore accepts variants like person_1, NER may
// miss a name in the model's own words): the provider's prompt cache would miss, and on a model with
// signed thinking the call would fail, the signature being tied to the exact earlier text. So each
// message part is masked ONE time and its masked form stored; the model's own output is stored RAW
// (text, reasoning with signatures, tool input as written) before anything is restored, and a stamp
// on `providerMetadata` — which the SDK returns as `providerOptions` on the next call's assistant
// part — names that copy. Later calls send the stored bytes, and mask only what is new.
//
// TRADE-OFF: a name first detected in a later message stays plain in the earlier stored ones (they
// were sent as they were). `hosted` counts and warns (`late_entities`); `strict` starts the
// transcript over with the larger map and reports how many values had already gone out.

export interface MiddlewareDeps {
  policy: PrivacyPolicy;
  key: string;
  info: ModelCallInfo;
  ctx?: StepContext;
  store: TranscriptStore;
}

const lost = (what: string) => new Error(`privacy_transcript_lost: ${what}`);
const newId = () => randomBytes(8).toString("hex");

/** One live session per context, for the tool guard. */
const LIVE = new WeakMap<object, SessionPrivacy>();
export const liveSession = (ctx: object | undefined): SessionPrivacy | undefined => (ctx ? LIVE.get(ctx) : undefined);

type Prepared = { prompt: any[]; st: SessionPrivacy; mapRef: TokenMap };

export function privacyMiddleware(d: MiddlewareDeps) {
  const { policy, store, key } = d;
  const pol = policyKey(policy);
  const strict = policy.mode === "strict";
  const warn = (m: string) => console.warn(`[privacy] ${m}`);

  async function prepare(params: any): Promise<Prepared & { params: any }> {
    let st = await store.load(key);
    const prompt: any[] = params.prompt;
    const hasAssistant = prompt.some((m) => m.role === "assistant");
    let reset = false;
    let fresh = false;
    if (st && st.policy !== pol) { st = newSession(pol, st.epoch + 1, st.map); fresh = reset = true; } // the `mask` list changed
    else if (!st) {
      st = newSession(pol);
      if (hasAssistant) { fresh = true; if (strict && hasSignedReasoning(prompt)) throw lost("this session's masked history is gone and its reasoning is signed"); }
    } else if (hasAssistant) {
      const stamped = prompt.flatMap((m) => (m.role === "assistant" && Array.isArray(m.content) ? m.content : [])).filter((p: any) => readStamp(p.providerOptions));
      if (stamped.length && stamped.every((p: any) => !st!.byId["a:" + readStamp(p.providerOptions)!.id])) {
        fresh = true; // every copy is gone
        if (strict && hasSignedReasoning(prompt)) throw lost("the stored copies of this session's messages are gone and its reasoning is signed");
      }
    }
    if (!st.ix) indexSession(st);
    let out = await build(prompt, st, fresh);
    // strict: a value found only now was already sent as plain text earlier → start over with the larger map
    for (let round = 0; strict && out.late && round < 3; round++) {
      const next = newSession(pol, st.epoch + 1, st.map);
      const first = out.late;
      st = next; reset = true; fresh = true;
      out = await build(prompt, st, true);
      out.lateReported = Math.max(out.lateReported ?? 0, first);
    }
    if (reset) out.added = { ...st.byId };
    await store.save(key, st, out.added, reset);
    LIVE.set(d.ctx ?? {}, st);
    await emitMasked(d.ctx, { counts: out.counts, late_entities: out.lateReported ?? out.late, epoch: st.epoch, mode: policy.mode });
    if (out.late && !strict) warn(`late_entities: ${out.late} value(s) were first detected after they had already been sent in an earlier message`);
    return { params: { ...params, prompt: out.prompt }, prompt: out.prompt, st, mapRef: st.map };
  }

  // Signed = the provider put something on the part; our own stamp is not a signature.
  const hasSignedReasoning = (prompt: any[]) =>
    prompt.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((p: any) => p.type === "reasoning" && stripStamp(p.providerOptions) !== undefined));

  async function build(prompt: any[], st: SessionPrivacy, fresh: boolean) {
    const added: Record<string, StoredMasked> = {};
    const counts: Record<string, number> = {};
    const before = new Set(Object.keys(st.map));
    const lastUser = prompt.map((m) => m.role).lastIndexOf("user");
    let media = 0;
    const ctx = d.ctx ?? { services: undefined };

    const once = async (k: string, make: () => Promise<string>): Promise<string> => {
      const hit = st.byId["m:" + k];
      if (hit?.kind === "text") return hit.masked;
      const masked = await make();
      added["m:" + k] = st.byId["m:" + k] = { kind: "text", masked };
      return masked;
    };
    const mask = async (text: string): Promise<string> =>
      once(sha("t:" + text), async () => {
        const r = await maskText(text, { policy, map: st.map }, ctx);
        for (const [t, n] of Object.entries(r.counts)) counts[t] = (counts[t] ?? 0) + n;
        return r.out;
      });
    const onceJson = async (k: string, make: () => Promise<unknown>): Promise<any> => JSON.parse(await once(k, async () => JSON.stringify(await make())));
    const sequentialJson = async (v: unknown): Promise<unknown> => { // in order: tokens are numbered as the text reads
      if (typeof v === "string") return mask(v);
      if (Array.isArray(v)) { const o = []; for (const x of v) o.push(await sequentialJson(x)); return o; }
      if (v && typeof v === "object") { const o: Record<string, unknown> = {}; for (const [k, y] of Object.entries(v)) o[k] = await sequentialJson(y); return o; }
      return v;
    };

    const maskOutput = async (o: any): Promise<any> => {
      if (!o || typeof o !== "object") return o;
      if (o.type === "text" || o.type === "error-text") return { ...o, value: await mask(o.value) };
      if (o.type === "json" || o.type === "error-json") return { ...o, value: await sequentialJson(o.value) };
      if (o.type === "content" && Array.isArray(o.value)) {
        const v = [];
        for (const e of o.value) {
          if (e?.type === "text") v.push({ ...e, text: await mask(e.text) });
          else { if (e?.type !== "custom") media++; v.push(e); }
        }
        return { ...o, value: v };
      }
      if (o.type === "execution-denied" && typeof o.reason === "string") return { ...o, reason: await mask(o.reason) };
      return o;
    };

    const promptPart = (raw: any, orig: any): any => {
      const opts = { ...(raw.providerMetadata ?? {}), ...(stripStamp(orig.providerOptions) ?? {}) };
      const tail = Object.keys(opts).length ? { providerOptions: opts } : {};
      if (raw.type === "text" || raw.type === "reasoning") return { type: raw.type, text: raw.text, ...tail };
      if (raw.type === "tool-call") {
        let input = raw.input;
        if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* sent as written */ } }
        return { type: "tool-call", toolCallId: raw.toolCallId, toolName: raw.toolName, input, ...(raw.providerExecuted ? { providerExecuted: true } : {}), ...tail };
      }
      return unstamped(orig);
    };

    const outPrompt: any[] = [];
    for (let mi = 0; mi < prompt.length; mi++) {
      const m = prompt[mi];
      if (m.role === "system") { outPrompt.push({ ...m, content: await mask(m.content) }); continue; }
      if (m.role === "user") {
        const content = [];
        for (const p of m.content) {
          if (p.type === "text") content.push({ ...p, text: await mask(p.text) });
          else { media++; content.push(p); }
        }
        outPrompt.push({ ...m, content });
        continue;
      }
      if (m.role === "tool") {
        const content = [];
        for (const p of m.content) {
          if (p.type !== "tool-result") { content.push(unstamped(p)); continue; }
          const output = await onceJson(sha("r:" + p.toolCallId + JSON.stringify(p.output)), () => maskOutput(p.output));
          content.push(unstamped({ ...p, output }));
        }
        outPrompt.push({ ...m, content });
        continue;
      }
      if (m.role === "assistant" && Array.isArray(m.content)) {
        const content: any[] = [];
        for (const p of m.content) {
          if (p.providerExecuted || (p.type !== "text" && p.type !== "reasoning" && p.type !== "tool-call")) { content.push(unstamped(p)); continue; }
          const stamp = readStamp(p.providerOptions);
          let raw: any;
          if (!fresh) {
            const e = stamp ? st.byId["a:" + stamp.id] : undefined;
            raw = e?.kind === "assistant" ? e.parts[stamp!.i] : undefined;
            if (!raw && st.ix) {
              const hit = p.type === "tool-call" ? st.ix.call.get(p.toolCallId) : st.ix.text.get(p.type + ":" + sha(p.text));
              const e2 = hit ? st.byId["a:" + hit.id] : undefined;
              raw = e2?.kind === "assistant" ? e2.parts[hit!.i] : undefined;
            }
          }
          if (raw && raw.type === p.type) { content.push(promptPart(raw, p)); continue; }
          // no stored copy of this part
          if (p.type === "reasoning") {
            if (mi > lastUser) throw lost("a reasoning block of the current tool loop has no stored copy; it is signed and cannot be re-masked");
            continue; // earlier turns' reasoning may be left out
          }
          if (p.type === "text") content.push({ type: "text", text: await mask(p.text), ...optsOf(p) });
          else content.push({ type: "tool-call", toolCallId: p.toolCallId, toolName: p.toolName, input: await onceJson(sha("c:" + JSON.stringify(p.input)), () => sequentialJson(p.input)), ...optsOf(p) });
        }
        outPrompt.push({ ...m, content });
        continue;
      }
      outPrompt.push(m);
    }

    if (media) {
      if (strict) throw new Error("privacy_media_unsupported: images and files cannot be masked; refusing to send them under privacy: strict");
      warn(`${media} image/file part(s) in the prompt cannot be masked and are sent as they are`);
    }
    const late = Object.keys(st.map).length > before.size ? lateEntities(st, before) : 0;
    return { prompt: outPrompt, added, counts, late, lateReported: undefined as number | undefined };
  }
  const optsOf = (p: any) => { const o = stripStamp(p.providerOptions); return o ? { providerOptions: o } : {}; };

  const escapeFor = (params: any) => (params.responseFormat?.type === "json" ? jsonEscape : undefined);
  const keep = (name: string) => keepsPseudonyms(name, d.ctx);

  /** The raw part as returned, stamped part for part; the caller gets the restored one. */
  async function finish(st: SessionPrivacy, id: string, parts: Array<Record<string, any>>) {
    st.byId["a:" + id] = { kind: "assistant", parts };
    indexAssistant(st, id, parts);
    await store.save(key, st, { ["a:" + id]: st.byId["a:" + id]! });
  }

  return {
    specificationVersion: "v4" as const,

    async wrapGenerate({ params, model }: { params: any; model: any }) {
      const p = await prepare(params);
      const r = await model.doGenerate(p.params);
      const esc = escapeFor(params);
      const raw: Array<Record<string, any>> = [];
      const id = newId();
      const content = r.content.map((part: any) => {
        const rawPart: Record<string, any> = JSON.parse(JSON.stringify(part));
        let out = part;
        if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
          out = { ...part, text: restore(part.text, p.st.map, part.type === "text" ? esc : undefined).text };
          rawPart._h = restoredHash(part.text, p.st.map, part.type === "text" ? esc : undefined);
        } else if (part.type === "tool-call" && !part.providerExecuted && !keep(part.toolName)) {
          out = { ...part, input: restoreToolInput(part.input, p.st.map) };
        }
        raw.push(rawPart);
        return STAMPED.has(part.type) ? { ...out, providerMetadata: withStamp(part.providerMetadata, { id, i: raw.length - 1 }) } : out;
      });
      await finish(p.st, id, raw);
      return { ...r, content };
    },

    async wrapStream({ params, model }: { params: any; model: any }) {
      const p = await prepare(params);
      const r = await model.doStream(p.params);
      const esc = escapeFor(params);
      const raw: Array<Record<string, any>> = [];
      type Open = { raw: string; shown: string; pm: Record<string, any> | undefined; r: StreamRestorer };
      const open = new Map<string, Open>();
      const execIds = new Set<string>();
      const mergePm = (a: any, b: any) => { if (!b) return a; const o = { ...(a ?? {}) }; for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === "object" ? { ...(o[k] ?? {}), ...v } : v; return o; };
      const id = newId();
      const stamp = (pm: any) => withStamp(pm, { id, i: raw.length - 1 });
      const key2 = (t: string, id: string) => t + ":" + id;

      const stream = r.stream.pipeThrough(new TransformStream({
        async transform(chunk: any, ctl: TransformStreamDefaultController) {
          const t: string = chunk.type;
          if (t === "text-start" || t === "reasoning-start") {
            open.set(key2(t.split("-")[0]!, chunk.id), { raw: "", shown: "", pm: chunk.providerMetadata, r: new StreamRestorer(p.st.map, t === "text-start" ? esc : undefined) });
            ctl.enqueue(chunk);
          } else if (t === "text-delta" || t === "reasoning-delta") {
            const kind = t.split("-")[0]!;
            const o = open.get(key2(kind, chunk.id));
            if (!o) { ctl.enqueue(chunk); return; }
            o.raw += chunk.delta;
            o.pm = mergePm(o.pm, chunk.providerMetadata);
            const shown = o.r.push(chunk.delta);
            o.shown += shown;
            ctl.enqueue({ ...chunk, delta: shown });
          } else if (t === "text-end" || t === "reasoning-end") {
            const kind = t.split("-")[0]!;
            const o = open.get(key2(kind, chunk.id));
            if (!o) { ctl.enqueue(chunk); return; }
            open.delete(key2(kind, chunk.id));
            const rest = o.r.flush();
            if (rest) { o.shown += rest; ctl.enqueue({ type: `${kind}-delta`, id: chunk.id, delta: rest }); }
            const pm = mergePm(o.pm, chunk.providerMetadata);
            const rawPart: Record<string, any> = { type: kind, text: o.raw, ...(pm ? { providerMetadata: pm } : {}), _h: sha(o.shown) };
            raw.push(rawPart);
            ctl.enqueue({ ...chunk, providerMetadata: stamp(pm) });
          } else if (t === "tool-input-start") {
            if (chunk.providerExecuted) execIds.add(chunk.id);
            ctl.enqueue(chunk);
          } else if (t === "tool-input-delta") {
            if (execIds.has(chunk.id)) ctl.enqueue(chunk); // a provider-run tool: nothing to restore
          } else if (t === "tool-call") {
            raw.push(JSON.parse(JSON.stringify(chunk)));
            const out = !chunk.providerExecuted && !keep(chunk.toolName) ? { ...chunk, input: restoreToolInput(chunk.input, p.st.map) } : chunk;
            ctl.enqueue({ ...out, providerMetadata: stamp(chunk.providerMetadata) });
          } else if (t === "file" || t === "tool-result") {
            raw.push(JSON.parse(JSON.stringify(chunk)));
            ctl.enqueue({ ...chunk, providerMetadata: stamp(chunk.providerMetadata) });
          } else if (t === "finish") {
            await finish(p.st, id, raw);
            ctl.enqueue(chunk);
          } else ctl.enqueue(chunk);
        },
      }));
      return { ...r, stream };
    },
  };
}

const STAMPED = new Set(["text", "reasoning", "tool-call", "file", "tool-result", "reasoning-file"]);
