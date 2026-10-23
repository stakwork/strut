import { ModelWorker } from "../model-worker.js";
import { chunk } from "./chunk.js";
import { escRe, STOP } from "./gazetteer.js";
import { LLM_MODEL, privacyModelOptions, type PrivacyModelOptions } from "./models.js";
import { LEAD } from "./rules.js";
import type { LlmEngine, Span } from "./types.js";

const MAX_CHARS = 700;
const OVERLAP = 80;
const SYS = 'You are a privacy filter. From the user text, list every personal name, nickname, pet name and organisation name (company, school, hospital, shop, team, institution) that appears, copied EXACTLY as written. Include first-name-only people and nicknames. Do NOT list places, dates, numbers, titles like Mr or Dr, common nouns, or relationship words like sister or Mum. Output ONLY a JSON array like [{"text":"Bean","type":"NICKNAME"}] where type is PERSON, NICKNAME or ORG. Output [] if there are none.';
const SHOTS: [string, string][] = [
  ["Bean is coming over Friday with the kids and Mum is bringing Smitty from the office.", '[{"text":"Bean","type":"NICKNAME"},{"text":"Smitty","type":"NICKNAME"}]'],
  ["Lunch at Nandos with Priya, then the train to Leeds.", '[{"text":"Nandos","type":"ORG"},{"text":"Priya","type":"PERSON"}]'],
  ["Had a quiet Sunday and watched a documentary.", "[]"],
];

type Pipe = (msgs: unknown, o: unknown) => Promise<{ generated_text: { content: string }[] }[]>;
let shared: Promise<Pipe> | null = null;

async function loadPipe(o: PrivacyModelOptions): Promise<Pipe> {
  const tf = await import("@huggingface/transformers");
  const pipe = await tf.pipeline(LLM_MODEL.task, LLM_MODEL.id, {
    dtype: LLM_MODEL.dtype,
    cache_dir: o.cacheDir,
    ...(o.offline ? { local_files_only: true } : {}),
  } as never);
  return pipe as unknown as Pipe;
}

/** Parse one reply: the found items, or null when it holds no valid JSON array of objects. */
export function parseLlmReply(content: string): { text: string; type: string }[] | null {
  const m = content.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return null;
    const found: { text: string; type: string }[] = [];
    for (const x of arr) if (x && typeof x.text === "string") found.push({ text: x.text, type: String(x.type || "PERSON") });
    return found;
  } catch {
    return null;
  }
}

/** The Qwen detector on THIS thread: one warm pipeline per thread. The factory
 *  `workerLlm`'s worker calls. */
export function transformersLlm(o: PrivacyModelOptions = privacyModelOptions()): LlmEngine {
  return {
    async detect(texts) {
      shared ??= loadPipe(o);
      let pipe: Pipe;
      try { pipe = await shared; } catch (e) { shared = null; throw e; }
      const items: { text: string; type: string }[][] = [];
      let invalid = 0;
      for (const text of texts) {
        const found: { text: string; type: string }[] = [];
        for (const [cs, ce] of chunk(text, MAX_CHARS, OVERLAP)) {
          const msgs: { role: string; content: string }[] = [{ role: "system", content: SYS }];
          for (const [u, a] of SHOTS) msgs.push({ role: "user", content: u }, { role: "assistant", content: a });
          msgs.push({ role: "user", content: text.slice(cs, ce) });
          const o = await pipe(msgs, { max_new_tokens: 200, do_sample: false });
          const parsed = parseLlmReply(o[0]!.generated_text.at(-1)!.content);
          if (parsed) found.push(...parsed);
          else invalid++;
        }
        items.push(found);
      }
      return { items, invalid };
    },
  };
}

let viaWorker: LlmEngine | undefined;

/** The Qwen detector in a worker thread of its own (`ModelWorker`), one per
 *  process — the default engine: about 3 s a chunk of synchronous native work,
 *  which on the main thread would block every request, and in the NER's
 *  worker would queue it behind every call. */
export function workerLlm(): LlmEngine {
  if (!viaWorker) {
    const w = new ModelWorker({ module: import.meta.url, factory: "transformersLlm", options: privacyModelOptions() }, "privacy llm worker");
    viaWorker = { detect: (texts) => w.call("detect", [texts]) };
  }
  return viaWorker;
}

/** The model is only trusted for short, capitalised, digit-free strings that are verbatim in the text. */
export function llmPostprocess(t: string, items: { text: string; type: string }[]): { spans: Span[]; rejected: number } {
  const spans: Span[] = [];
  let rejected = 0;
  for (const it of items) {
    let name = String(it.text).trim().replace(/[.,;:!?]+$/, "");
    const m = LEAD.exec(name);
    if (m && name.length > m[0].length) name = name.slice(m[0].length);
    if (name.length < 2 || name.length > 40 || name.split(/\s+/).length > 4 || /\d/.test(name)) { rejected++; continue; }
    if (!/^\p{Lu}/u.test(name) && !/\p{Script=Han}/u.test(name)) continue;
    if (/^[A-Z]{1,3}$/.test(name)) continue;
    if (name.split(/\s+/).every((w) => STOP.has(w.toLowerCase())) || STOP.has(name.toLowerCase())) continue;
    const type = String(it.type).toUpperCase() === "ORG" ? "ORG" : "PERSON";
    const re = new RegExp("(?<![\\p{L}\\p{N}])" + escRe(name) + "(?![\\p{L}\\p{N}])", "gu");
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(t))) {
      // a single capitalised word that merely starts a sentence is only trusted as a person/nickname, never as an organisation
      const sentenceStart = mm.index === 0 || /[.!?]\s+$/.test(t.slice(Math.max(0, mm.index - 3), mm.index));
      if (type === "ORG" && !name.includes(" ") && sentenceStart) continue;
      spans.push({ s: mm.index, e: mm.index + name.length, type, src: "llm" });
    }
  }
  return { spans, rejected };
}

export function llmStage(engine: LlmEngine): import("./detect.js").Stage {
  return {
    name: "llm",
    priority: 4,
    async detect(text, o) {
      const { items, invalid } = await engine.detect([text]);
      if (invalid) o.warn({ code: "llm_invalid_output", message: "the LLM reply was not valid JSON for some chunks; those chunks were not checked", count: invalid });
      const { spans, rejected } = llmPostprocess(text, items[0] ?? []);
      if (rejected) o.warn({ code: "llm_rejected_candidates", message: "some LLM candidates failed the sanity checks and were ignored", count: rejected });
      return spans;
    },
  };
}
