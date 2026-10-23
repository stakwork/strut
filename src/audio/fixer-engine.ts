/**
 * What runs in the dictation fixer's worker thread (fixer.ts): the prompts
 * and the model on node-llama-cpp (Metal, GGUF). Only types are imported
 * from strut, so the worker loads this file alone, under tsx or built.
 */
import type { JudgeQuestion, Retraction, ScoreSentence } from "./lingo.js";

// ── Prompts ─────────────────────────────────────────────────────────────────

type Shot = [user: string, assistant: string];

export const JUDGE_SYSTEM = `You review one change a user made to text typed by dictation (speech to text). Answer "yes" if it is a MISHEARING: the user said a name, product, brand, acronym, code or technical term, and dictation wrote what it SOUNDS like ("dev ops" → "DevOps", "e c two" → "EC2", "jason" → "JSON", "Stokwork" → "Stakwork").
Answer "no" for anything else: a different word or name the user chose instead (Mark → Mike, Paris → London, 3 → 4); an ordinary spelling or grammar fix (your → you're, their → there, tense, plural, possessive); capitalising an ordinary word or the letter i; punctuation; numbers as digits; a rewrite; two forms of the same known word ("same thing"); a word turned off for dictation; or dictation's text is itself something real the user could have meant, like an acronym ("PH" → "P8").
Answer only yes or no.`;

const JUDGE_EXAMPLES: [typed: string, edited: string, from: string, to: string, known: string, answer: "yes" | "no"][] = [
  ["ping the dev ops team", "ping the DevOps team", "dev ops", "DevOps", "", "yes"],
  ["I'll call mark tomorrow", "I'll call Mike tomorrow", "mark", "Mike", "", "no"],
  ["deploy it to e c two", "deploy it to EC2", "e c two", "EC2", "", "yes"],
  ["your welcome to join", "you're welcome to join", "your", "you're", "", "no"],
  ["update the jason file", "update the JSON file", "jason", "JSON", "", "yes"],
  ["pay in ETH", "pay in Ether", "ETH", "Ether", "Ether, ETH (same thing)", "no"],
  ["send the AC file", "send the A6 file", "AC", "A6", "", "no"],
  ["store it in mongo d b", "store it in MongoDB", "mongo d b", "MongoDB", "", "yes"],
  ["the Acme team", "Acme's team", "the Acme", "Acme's", "Acme", "no"],
];

export function judgeUser(q: Pick<JudgeQuestion, "typed" | "edited" | "from" | "to" | "known">): string {
  return `Typed: ${q.typed}\nEdited: ${q.edited}\nChange: "${q.from}" → "${q.to}"${q.known ? `\nKnown: ${q.known}` : ""}`;
}
const JUDGE_SHOTS: Shot[] = JUDGE_EXAMPLES.map(([typed, edited, from, to, known, a]) => [judgeUser({ typed, edited, from, to, known }), a]);

export const RETRACT_SYSTEM = `Text from dictation may contain words the speaker took back and said again differently ("Friday, sorry, Saturday"). For each, answer the words taken back ("wrong") and the words that took them back ("cue"), exactly as in the text. Answer ONLY a JSON array [{"wrong": "...", "cue": "..."}], or [] when nothing was taken back ("no problem", "I mean it", "sorry for the delay" take nothing back).`;
const RETRACT_SHOTS: Shot[] = [
  ["call me Friday, sorry, Saturday", '[{"wrong":"Friday","cue":"sorry"}]'],
  ["sorry for the delay, no problem on my side", "[]"],
  ["we need two, I mean three more tests", '[{"wrong":"two","cue":"I mean"}]'],
  ["send it to Anna, no wait, to Ben", '[{"wrong":"to Anna","cue":"no wait"}]'],
  ["I mean it, this is great", "[]"],
  ["take the blue one, actually the red one", '[{"wrong":"the blue one","cue":"actually"}]'],
];

const KIND: Record<string, string> = { Organization: "a company", Project: "a product", Person: "a person", Lingo: "a term" };

/** The line a sentence is scored after. */
export const scorePrefix = (s: Pick<ScoreSentence, "name" | "type">) => `Dictated by someone who often mentions ${s.name} (${KIND[s.type] ?? "a term"}).\n\n`;

/** ChatML with Qwen3's thinking turned off: the empty think block its chat
 *  template writes for enable_thinking=false. */
function chatml(system: string, shots: Shot[], user: string): string {
  let s = `<|im_start|>system\n${system}<|im_end|>\n`;
  for (const [u, a] of shots) s += `<|im_start|>user\n${u}<|im_end|>\n<|im_start|>assistant\n${a}<|im_end|>\n`;
  return s + `<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
}

/** The `{ wrong, cue }` items of a reply; [] when it holds no JSON array. */
export function parseRetractions(reply: string): Retraction[] {
  const m = reply.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const v = JSON.parse(m[0]);
    if (!Array.isArray(v)) return [];
    return v.flatMap((e) => (typeof e?.wrong === "string" && typeof e?.cue === "string" ? [{ wrong: e.wrong, cue: e.cue }] : []));
  } catch {
    return [];
  }
}

// ── In the worker: the model on node-llama-cpp ──────────────────────────────

/** What the worker's object answers (`ModelWorker.call`). */
export interface FixerEngine {
  judge(questions: JudgeQuestion[]): Promise<number[]>;
  score(sentences: ScoreSentence[]): Promise<number[]>;
  retract(text: string): Promise<Retraction[]>;
  /** Resolves once the model is loaded (it is, by the time the worker answers anything). */
  ready(): Promise<void>;
  dispose(): Promise<void>;
}

/** The factory the fixer's worker builds: loads the GGUF at `path`. */
export async function loadLlamaFixer(o: { path: string }): Promise<FixerEngine> {
  // Lazy: node-llama-cpp loads a native addon and Metal; only this worker needs it.
  const lib = await import("node-llama-cpp");
  // The prebuilt binary only: never a build from source or a download (a
  // packaged strut ships its binaries in native/llama; package-desktop.mjs).
  const llama = await lib.getLlama({ build: "never" });
  const model = await llama.loadModel({ modelPath: o.path });
  const context = await model.createContext({ contextSize: 4096, sequences: 3 });
  // One sequence per task, so each keeps its fixed prefix cached.
  const judging = context.getSequence(), scoring = context.getSequence();
  const completion = new lib.LlamaCompletion({ contextSequence: context.getSequence() });
  const yesNo = ["yes", "no"].map((w) => model.tokenize(w, false)[0]!);

  type Sequence = typeof scoring;
  /** Evaluates `toks` on `seq`, keeping the tokens it already holds of them
   *  before `from`, the first position whose next-token logits are read;
   *  `want(i)` says which tokens' logits to read at position `i`. */
  async function evaluate(seq: Sequence, toks: number[], from: number, want: (i: number) => readonly number[] | null) {
    const have = seq.contextTokens as number[];
    let k = 0;
    while (k < have.length && k < from && have[k] === toks[k]) k++;
    if (k < seq.nextTokenIndex) await seq.eraseContextTokenRanges([{ start: k, end: seq.nextTokenIndex }]);
    const input = toks.slice(k).map((t, j) => {
      const filter = want(k + j);
      return filter
        ? [t, { generateNext: { token: true, options: { temperature: 0 }, logits: { filter: { tokens: filter, includeSelected: true } }, totalLogitWeight: true } }]
        : t;
    });
    const out = (await seq.controlledEvaluate(input as never)) as any[];
    return { k, out };
  }
  // log-softmax of one token: at temperature 0 the selected token is the argmax, so its logit is the max.
  const logp = (next: any, id: number) => next.logits.get(id) - next.logits.get(next.token) - Math.log(next.totalLogitWeight);

  // One call at a time: the sequences are shared state.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const p = queue.then(f);
    queue = p.catch(() => {});
    return p;
  };

  return {
    judge: (qs) => serial(async () => {
      const out: number[] = [];
      for (const q of qs) {
        const toks = model.tokenize(chatml(JUDGE_SYSTEM, JUDGE_SHOTS, judgeUser(q)), true) as number[];
        const r = await evaluate(judging, toks, toks.length - 1, (i) => (i === toks.length - 1 ? yesNo : null));
        const next = r.out.at(-1).next;
        out.push(logp(next, yesNo[0]!) - logp(next, yesNo[1]!));
      }
      return out;
    }),
    score: (ss) => serial(async () => {
      const out: number[] = [];
      for (const s of ss) {
        const a = model.tokenize(scorePrefix(s), true) as number[], b = model.tokenize(s.text, false) as number[];
        const toks = [...a, ...b];
        const r = await evaluate(scoring, toks, a.length - 1, (i) => (i >= a.length - 1 && i < toks.length - 1 ? [toks[i + 1]!] : null));
        let sum = 0;
        r.out.forEach((o, j) => {
          if (o?.next?.logits) sum += logp(o.next, toks[r.k + j + 1]!);
        });
        out.push(sum);
      }
      return out;
    }),
    retract: (text) => serial(async () => {
      const reply = await completion.generateCompletion(model.tokenize(chatml(RETRACT_SYSTEM, RETRACT_SHOTS, text), true), {
        maxTokens: 64, temperature: 0, customStopTriggers: ["<|im_end|>"],
      });
      return parseRetractions(reply);
    }),
    ready: async () => {},
    dispose: () => serial(async () => {
      await context.dispose();
      await model.dispose();
    }),
  };
}
