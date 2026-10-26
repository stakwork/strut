import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolLoopAgent, generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { FIX, NER, REAL_VALUES, fakeNer, makeCtx, uid, wrap } from "./testing/harness.js";
import { mockModel, sent } from "./testing/mock-model.js";
import { MemoryTranscriptStore } from "./transcript.js";

const sig = (n: string) => ({ anthropic: { signature: n } });
const PROMPT = `Hi, I'm ${FIX.person}, email ${FIX.email}, phone ${FIX.phone}. Look me up; I work at ${FIX.org}.`;

function script(extra: Record<string, unknown> = {}) {
  return [
    // turn 1: signed reasoning that names the person, then a tool call with a pseudonym
    [
      { type: "reasoning", text: "The user is [PERSON_1] at [ORG_1].", providerMetadata: sig("sigA") },
      { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: '{"name":"[PERSON_1]","note":"call [PHONE_1]"}' },
    ],
    [
      { type: "reasoning", text: "Found. Check [EMAIL_1] too.", providerMetadata: sig("sigB") },
      { type: "text", text: "Looking at the address for [PERSON_1]." },
      { type: "tool-call", toolCallId: "c2", toolName: "lookup", input: '{"name":"[PERSON_1]","note":"again"}' },
    ],
    [{ type: "text", text: "Done: [PERSON_1] lives at [ADDRESS_1]." }],
  ];
}

function setup(over: { issuedFrom?: any; privacy?: unknown; turns?: any[]; chunk?: number; session?: string; ctxOver?: Record<string, unknown> } = {}) {
  const seen: unknown[] = [];
  const model = mockModel({ turns: over.turns ?? script(), verifySignatures: true, chunk: over.chunk, issuedFrom: over.issuedFrom });
  const tools = {
    lookup: tool({
      description: "look up a person",
      inputSchema: z.object({ name: z.string(), note: z.string().optional() }),
      execute: async (i: any) => { seen.push(i); return `Record for ${i.name}: ${FIX.street}, works at ${FIX.org}, id ${FIX.id}`; },
    }),
  };
  const ctx = makeCtx({ privacy: over.privacy ?? "hosted", ...(over.ctxOver ?? {}) });
  return { model, tools, seen, ctx, session: over.session ?? uid("s") };
}

async function run(s: ReturnType<typeof setup>, prompt = PROMPT, stream = false) {
  const m = await wrap(s.model, { ctx: s.ctx, session: s.session });
  const agent = new ToolLoopAgent({ model: m, tools: s.tools, stopWhen: stepCountIs(10) });
  if (!stream) return agent.generate({ prompt });
  const r = await agent.stream({ prompt });
  await r.consumeStream();
  return { text: await r.text, steps: await r.steps };
}

for (const stream of [false, true]) {
  describe(`mask once, resend byte for byte (${stream ? "stream" : "generate"})`, () => {
    it("the bytes sent for message N are identical in every later call; each prompt extends the last", async () => {
      const s = setup({ chunk: 3 });
      const r = await run(s, PROMPT, stream);
      assert.equal(s.model.count, 3);
      for (let k = 0; k + 1 < s.model.calls.length; k++) {
        const a = s.model.calls[k]!, b = s.model.calls[k + 1]!;
        assert.ok(b.startsWith(a.slice(0, -1)), `call ${k + 1} does not start with call ${k}`);
        assert.ok(b.length > a.length);
      }
      // the reasoning (signed) went back exactly as issued
      assert.ok(s.model.calls[1]!.includes("The user is [PERSON_1] at [ORG_1]."));
      assert.ok(s.model.calls[1]!.includes("sigA"));
      assert.ok(!s.model.calls.join("").includes("strutPrivacy"), "the stamp never reaches the provider");
      assert.match(r.text, new RegExp(`Done: ${FIX.person} lives at ${FIX.street}\\.`));
    });

    it("no real value reaches the provider; tools and the final answer see real ones", async () => {
      const s = setup();
      const r = await run(s, PROMPT, stream);
      const wire = sent(s.model);
      for (const v of REAL_VALUES) assert.ok(!wire.includes(v), `leaked: ${v}`);
      assert.deepEqual(s.seen[0], { name: FIX.person, note: `call ${FIX.phone}` });
      assert.equal((s.seen[1] as any).name, FIX.person);
      assert.ok(r.text.includes(FIX.person));
    });
  });
}

describe("signed reasoning", () => {
  it("a full session passes the signature check; a changed block would not", async () => {
    const s = setup();
    await run(s); // verifySignatures is on: any change to a signed block is a 400
    const bad = mockModel({ turns: script(), verifySignatures: true });
    await assert.rejects(async () => {
      await bad.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }] });
      await bad.doGenerate({ prompt: [{ role: "assistant", content: [{ type: "reasoning", text: "tampered", providerOptions: sig("sigA") }] }] });
    }, /400/);
  });

  it("variants: the model writes person_1 and misses a name; the next call still resends the raw form", async () => {
    const turns = [
      [{ type: "reasoning", text: "ask about person_1", providerMetadata: sig("sigV") }, { type: "tool-call", toolCallId: "v1", toolName: "lookup", input: '{"name":"person_1"}' }],
      [{ type: "text", text: "Thanks [Person 1]. Also met Zed Quillfeather there." }],
    ];
    const s = setup({ turns });
    const r = await run(s);
    assert.equal((s.seen[0] as any).name, FIX.person, "variant restored for the tool");
    assert.ok(s.model.calls[1]!.includes("ask about person_1"), "raw reasoning resent");
    assert.ok(s.model.calls[1]!.includes('"name":"person_1"') || s.model.calls[1]!.includes('"name": "person_1"'));
    assert.ok(r.text.includes(`Thanks ${FIX.person}.`));
  });
});

describe("history edits", () => {
  async function twoTurns(s: ReturnType<typeof setup>, history: any[]) {
    const m = await wrap(s.model, { ctx: s.ctx, session: s.session });
    return generateText({ model: m, messages: history, tools: s.tools, stopWhen: stepCountIs(10) });
  }

  it("a compaction summary is just a new message: masked once, the prefix before it is unchanged", async () => {
    const s = setup({ turns: [[{ type: "text", text: "Hello [PERSON_1]." }], [{ type: "text", text: "Summary ack." }]] });
    const first = await twoTurns(s, [{ role: "user", content: PROMPT }]);
    const h1 = [{ role: "user", content: PROMPT }, ...first.response.messages];
    await twoTurns(s, [...h1, { role: "user", content: `[compaction] ${FIX.person} asked about ${FIX.org}` }]);
    const [a, b] = s.model.calls;
    assert.ok(b!.startsWith(a!.slice(0, -1)));
    assert.ok(!sent(s.model).includes(FIX.org));
  });

  it("truncation: the remaining messages keep their stored forms", async () => {
    const s = setup({ turns: [[{ type: "text", text: "Hello [PERSON_1]." }], [{ type: "text", text: "ok" }]] });
    const first = await twoTurns(s, [{ role: "user", content: PROMPT }]);
    await twoTurns(s, [...first.response.messages, { role: "user", content: `More about ${FIX.person}` }]);
    const p = s.model.prompts[1]!;
    assert.equal(p[0].role, "assistant");
    assert.deepEqual(p[0].content[0].text, "Hello [PERSON_1].");
    assert.ok(!sent(s.model).includes(FIX.person));
  });

  it("restart with the file store keeps the stored copies; a memory store starts a fresh transcript", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { FileTranscriptStore } = await import("./transcript-file.js");
    const { putVault, getVault, destroyVault } = await import("./vault.js");
    const dir = await mkdtemp(join(tmpdir(), "strut-privacy-tr-"));
    try {
      const keys = { get: async () => ({ kid: "k", material: new TextEncoder().encode("secret-key") }) };
      const vdeps = { dir: join(dir, "vault"), keys };
      const mk = () => new FileTranscriptStore(join(dir, "transcripts"), {
        put: (map) => putVault("file", map, 60, {}, vdeps), get: (h) => getVault(h, {}, vdeps), destroy: (h) => destroyVault(h, vdeps),
      });
      const session = uid("file");
      const turns = [
        [{ type: "reasoning", text: "pondering [PERSON_1]", providerMetadata: sig("sigF") }, { type: "tool-call", toolCallId: "f1", toolName: "lookup", input: '{"name":"[PERSON_1]"}' }],
        [{ type: "text", text: "fin [PERSON_1]" }],
        [{ type: "text", text: "again" }],
      ];
      const s = setup({ turns, session, ctxOver: { services: { privacy: { ner: fakeNer(NER), transcripts: mk() } } } });
      const a = await run(s);
      // "restart": a new store object over the same files, a new model that verifies signatures
      const s2 = setup({ issuedFrom: s.model, turns, session, ctxOver: { services: { privacy: { ner: fakeNer(NER), transcripts: mk() } } } });
      const m2 = await wrap(s2.model, { ctx: s2.ctx, session });
      const history = [{ role: "user" as const, content: PROMPT }, ...a.steps.flatMap((x: any) => x.response.messages), { role: "user" as const, content: "and now?" }];
      await generateText({ model: m2, messages: history, tools: s2.tools });
      const wire = s2.model.calls[0]!;
      assert.ok(wire.includes("pondering [PERSON_1]") && wire.includes("sigF"), "the raw reasoning came back from the file");
      assert.ok(!wire.includes(FIX.person));

      // memory store: nothing remembered → fresh transcript, old reasoning dropped (before the last user message)
      const s3 = setup({ turns, session: uid("mem"), ctxOver: { services: { privacy: { ner: fakeNer(NER), transcripts: new MemoryTranscriptStore(1000, Date.now, false) } } } });
      const m3 = await wrap(s3.model, { ctx: s3.ctx, session: s3.session });
      await generateText({ model: m3, messages: history, tools: s3.tools });
      const w3 = s3.model.calls[0]!;
      assert.ok(!w3.includes("sigF") && !w3.includes("pondering [PERSON_1]"), "old signed reasoning is dropped");
      assert.ok(!w3.includes(FIX.person));
      assert.ok(w3.includes("[PERSON_1]"));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("a lost copy: plain text is masked again; signed reasoning before the last user message is dropped; inside the tool loop it throws", async () => {
    const stored = new MemoryTranscriptStore(1000, Date.now, false);
    const mk = () => setup({ ctxOver: { services: { privacy: { ner: fakeNer(NER), transcripts: stored } } } });
    const signed = { type: "reasoning" as const, text: "old thoughts", providerOptions: { strutPrivacy: { id: "gone", i: 0 }, ...sig("sigX") } };
    // seed one real entry so the transcript exists and is not "all lost"
    const s = mk();
    const m = await wrap(s.model, { ctx: s.ctx, session: "lc" });
    await generateText({ model: m, prompt: "hello there" });
    const base = [{ role: "user" as const, content: "hello there" }];
    const before = [...base, { role: "assistant" as const, content: [signed, { type: "text" as const, text: `plain ${FIX.person}` }] }, { role: "user" as const, content: "next" }];
    await generateText({ model: m, messages: before, tools: s.tools });
    const w = s.model.calls.at(-1)!;
    assert.ok(!w.includes("old thoughts"), "dropped");
    assert.ok(!w.includes(FIX.person), "text masked again");
    const inLoop = [...base, { role: "assistant" as const, content: [signed, { type: "tool-call" as const, toolCallId: "z", toolName: "lookup", input: {} }] }, { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "z", toolName: "lookup", output: { type: "text" as const, value: "x" } }] }];
    await assert.rejects(generateText({ model: m, messages: inLoop, tools: s.tools }), /privacy_transcript_lost/);
  });
});

describe("late entities", () => {
  const mk = (privacy: unknown) => {
    // NER only learns the name from the second message on
    let seen = 0;
    const ner = { async detect(texts: string[]) { seen++; return { spans: texts.map((t) => (seen > 1 && t.includes("Zed Quill") ? [{ s: t.indexOf("Zed Quill"), e: t.indexOf("Zed Quill") + 9, type: "PER", score: 0.99 }] : [])), unaligned: 0 }; } };
    return setup({ privacy, turns: [[{ type: "text", text: "ok" }], [{ type: "text", text: "ok2" }]], ctxOver: { services: { privacy: { ner } } } });
  };
  it("hosted: warns and counts; earlier messages stay as sent", async () => {
    const s = mk("hosted");
    const events: any[] = [];
    s.ctx.emit = (async (e: any) => void events.push(e)) as any;
    const m = await wrap(s.model, { ctx: s.ctx, session: s.session });
    const r1 = await generateText({ model: m, messages: [{ role: "user", content: "I met Zed Quill today" }] });
    await generateText({ model: m, messages: [{ role: "user", content: "I met Zed Quill today" }, ...r1.response.messages, { role: "user", content: "Zed Quill again" }] });
    assert.ok(s.model.calls[1]!.includes("Zed Quill today"), "the earlier message is resent as it was");
    const ev = events.find((e) => e.type === "privacy.masked");
    assert.ok(ev, "a counts-only event");
    assert.ok(!JSON.stringify(events).includes("Zed Quill"));
  });
  it("strict: a fresh transcript with the larger map", async () => {
    const s = mk("strict");
    const m = await wrap(s.model, { ctx: s.ctx, session: s.session });
    const r1 = await generateText({ model: m, messages: [{ role: "user", content: "I met Zed Quill today" }] });
    await generateText({ model: m, messages: [{ role: "user", content: "I met Zed Quill today" }, ...r1.response.messages, { role: "user", content: "Zed Quill again" }] });
    assert.ok(!s.model.calls[1]!.includes("Zed Quill"), "nothing plain goes out the second time");
  });
});

describe("where the wrapper applies", () => {
  it("loopback base URL: not applied; routed through a gateway on loopback: applied", async () => {
    const s = setup();
    const raw = await wrap(s.model, { ctx: s.ctx, baseUrl: "http://127.0.0.1:11434" });
    assert.equal(raw, s.model);
    const routed = await wrap(s.model, { ctx: s.ctx, baseUrl: "http://localhost:8181", routed: true });
    assert.notEqual(routed, s.model);
    assert.equal(await wrap(s.model, { ctx: makeCtx({}) }), s.model, "off by default");
  });

  it("detection failure: the call throws and the model saw nothing", async () => {
    const boom = { async detect() { throw new Error("no model"); } };
    const s = setup({ ctxOver: { services: { privacy: { ner: boom } } } });
    const m = await wrap(s.model, { ctx: s.ctx, session: s.session });
    await assert.rejects(generateText({ model: m, prompt: PROMPT }), /ner_unavailable/);
    assert.equal(s.model.count, 0);
  });

  it("images and files: hosted passes with a warning, strict refuses", async () => {
    const msg = [{ role: "user" as const, content: [{ type: "text" as const, text: "see" }, { type: "file" as const, mediaType: "image/png", data: new Uint8Array([1, 2, 3]) }] }];
    const h = setup({ turns: [[{ type: "text", text: "ok" }]] });
    const warns: string[] = []; const w = console.warn; console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
    try { await generateText({ model: await wrap(h.model, { ctx: h.ctx, session: h.session }), messages: msg }); } finally { console.warn = w; }
    assert.equal(h.model.count, 1);
    assert.ok(warns.some((x) => /image\/file/.test(x)));
    const st = setup({ privacy: "strict", turns: [[{ type: "text", text: "ok" }]] });
    await assert.rejects(generateText({ model: await wrap(st.model, { ctx: st.ctx, session: st.session }), messages: msg }), /privacy_media_unsupported/);
    assert.equal(st.model.count, 0);
  });
});
