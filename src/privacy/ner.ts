import { ModelWorker } from "../model-worker.js";
import { chunk } from "./chunk.js";
import { typeFix, type Stage } from "./detect.js";
import { LEAD, NER_TYPE, WORDCH } from "./rules.js";
import { STOP, escRe } from "./gazetteer.js";
import { NER_MODEL, privacyModelOptions, type PrivacyModelOptions } from "./models.js";
import type { NerEngine, RawNerSpan, Span } from "./types.js";

const MAX_CHARS = 700;
const OVERLAP = 80;

type Tok = { entity: string; word: string; index: number; score: number };

/** Group the model's B-/I- tokens of one chunk into entities and align each to the chunk text
 *  (whitespace-tolerant). Returns spans relative to `ct` plus how many could not be aligned. */
export function groupAndAlign(ct: string, toks: Tok[]): { spans: RawNerSpan[]; unaligned: number } {
  const groups: { ty: string; p: string[]; last: number; sc: number[] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  for (const t of toks) {
    const m = /^(B|I)-(.+)$/.exec(t.entity);
    if (!m) continue;
    const ty = m[2]!;
    if (cur && m[1] === "I" && cur.ty === ty && t.index === cur.last + 1) { cur.p.push(t.word); cur.last = t.index; cur.sc.push(t.score); }
    else if (cur && t.word.startsWith("##") && cur.ty === ty && t.index === cur.last + 1) { cur.p.push(t.word); cur.last = t.index; cur.sc.push(t.score); }
    else { if (cur) groups.push(cur); cur = { ty, p: [t.word], last: t.index, sc: [t.score] }; }
  }
  if (cur) groups.push(cur);
  const spans: RawNerSpan[] = [];
  let unaligned = 0;
  let cursor = 0;
  for (const g of groups) {
    const pieces = g.p.map((w) => w.replace(/^##/, ""));
    const re = new RegExp(pieces.map(escRe).join("\\s*"), "g");
    re.lastIndex = cursor;
    const m = re.exec(ct);
    if (!m) { unaligned++; continue; }
    cursor = m.index + m[0].length;
    spans.push({ s: m.index, e: m.index + m[0].length, type: g.ty, score: g.sc.reduce((a, b) => a + b, 0) / g.sc.length });
  }
  return { spans, unaligned };
}

type Pipe = (text: string) => Promise<Tok[]>;
let shared: Promise<Pipe> | null = null;

async function loadPipe(o: PrivacyModelOptions): Promise<Pipe> {
  let tf: typeof import("@huggingface/transformers");
  try {
    tf = await import("@huggingface/transformers");
  } catch (e) {
    throw new Error(`privacy NER is not available: @huggingface/transformers could not be loaded (${(e as Error).message})`);
  }
  const pipe = await tf.pipeline(NER_MODEL.task, NER_MODEL.id, {
    dtype: NER_MODEL.dtype,
    cache_dir: o.cacheDir,
    ...(o.offline ? { local_files_only: true } : {}),
  } as never);
  return pipe as unknown as Pipe;
}

/** The BERT NER on THIS thread: one warm pipeline per thread, a failed load is
 *  retried next call. The factory `workerNer`'s worker calls. */
export function transformersNer(o: PrivacyModelOptions = privacyModelOptions()): NerEngine {
  return {
    async detect(texts) {
      shared ??= loadPipe(o);
      let pipe: Pipe;
      try { pipe = await shared; } catch (e) { shared = null; throw e; }
      const spans: RawNerSpan[][] = [];
      let unaligned = 0;
      for (const text of texts) {
        const out: RawNerSpan[] = [];
        for (const [cs, ce] of chunk(text, MAX_CHARS, OVERLAP)) {
          const g = groupAndAlign(text.slice(cs, ce), await pipe(text.slice(cs, ce)));
          unaligned += g.unaligned;
          for (const x of g.spans) out.push({ ...x, s: x.s + cs, e: x.e + cs });
        }
        spans.push(out);
      }
      return { spans, unaligned };
    },
  };
}

let viaWorker: NerEngine | undefined;

/** The NER in a worker thread (`ModelWorker`), one per process — the default
 *  engine. A forward pass is synchronous native work: on the main thread it
 *  would block every request the server is handling. */
export function workerNer(): NerEngine {
  if (!viaWorker) {
    const w = new ModelWorker({ module: import.meta.url, factory: "transformersNer", options: privacyModelOptions() }, "privacy ner worker");
    viaWorker = { detect: (texts) => w.call("detect", [texts]) };
  }
  return viaWorker;
}

/** Raw model spans -> candidate spans: score floor, whole words, lead/filler strip, precision filter, type fix. */
export function nerPostprocess(t: string, raw: RawNerSpan[], minScore: number): Span[] {
  const out: Span[] = [];
  for (const x of raw) {
    if (!NER_TYPE[x.type] || x.score < minScore) continue;
    let s = x.s, e = x.e;
    // the model sometimes tags only a sub-word piece: grow the span to whole words
    while (s > 0 && WORDCH.test(t[s - 1]!)) s--;
    while (e < t.length && WORDCH.test(t[e]!)) e++;
    let type = NER_TYPE[x.type]!;
    if (type === "PERSON") { const m = LEAD.exec(t.slice(s, e)); if (m && e - s > m[0].length) s += m[0].length; }
    let txt = t.slice(s, e);
    // a span that swallowed leading filler words ("um Ahmed") keeps only the capitalised part
    const k = txt.search(/[\p{Lu}\p{Lo}]/u);
    if (k > 0 && /^[\p{Ll}\s]+$/u.test(txt.slice(0, k))) { s += k; txt = txt.slice(k); }
    // names start with an uppercase letter / CJK char; relationship words, weekdays, platforms etc. are not identifiers
    if (!/^[\p{Lu}\p{Lo}]/u.test(txt) || STOP.has(txt.toLowerCase())) continue;
    type = typeFix(t, s, e, type);
    out.push({ s, e, type, src: "ner", score: x.score });
  }
  return out;
}

export function nerStage(engine: NerEngine): Stage {
  return {
    name: "ner",
    priority: 3,
    async detect(text, o) {
      const { spans, unaligned } = await engine.detect([text]);
      if (unaligned) o.warn({ code: "ner_unaligned_spans", message: "some NER spans could not be aligned to the text and were dropped", count: unaligned });
      return nerPostprocess(text, spans[0] ?? [], o.minScore);
    },
  };
}
