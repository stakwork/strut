/**
 * What runs in the dictation fixer's worker thread (fixer.ts): the prompts
 * and the model on node-llama-cpp (Metal, GGUF). Only types are imported
 * from strut, so the worker loads this file alone, under tsx or built.
 *
 * node-llama-cpp is not one of strut's dependencies (fixer/ installs it, and
 * only the desktop package carries it), so it is not imported by name: the
 * worker is handed fixer/index.js, and the part of it this file calls is
 * typed here (`LlamaLib`), held to the real package by fixer/check.ts.
 */
import type { JudgeQuestion, NameQuestion, Retraction, ScoreSentence } from "./lingo.js";

// ── Prompts ─────────────────────────────────────────────────────────────────

type Shot = [user: string, assistant: string];

export const JUDGE_SYSTEM = `You review one change a user made to text typed by dictation (speech to text). Answer "yes" if it is a MISHEARING: the user said a name, product, brand, acronym, code or technical term, and dictation wrote what it SOUNDS like ("dev ops" → "DevOps", "e c two" → "EC2", "jason" → "JSON", "Stokwork" → "Stakwork"), or a person's name, said the same but spelled another way (Katherine → Kathryn, Jon → John, Steven → Stephen).
Answer "no" for anything else: a different word or name the user chose instead (Mark → Mike, Jon → Jen, Paris → London, 3 → 4); an ordinary spelling or grammar fix (your → you're, their → there, tense, plural, possessive); capitalising an ordinary word or the letter i; punctuation; numbers as digits; a rewrite; two forms of the same known word ("same thing"); or a word turned off for dictation.
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

/** Whether one word of a sentence is a name. Asked only of a same-sounding
 *  change the judge turned down (lingo.ts `mishearings`): the judge, asked
 *  "mishearing?", says no to a name that shares its sound with a real word
 *  ("stadium" → "Stadeum"), and adding that case to its prompt or shots
 *  moved its other answers (plans/dictation-models.md). */
export const NAME_SYSTEM = `In a sentence the user wrote, is the given word a name, product, brand, code or technical term (yes), or an ordinary word used in its ordinary sense (no)? Answer only yes or no.`;

export function nameUser(q: NameQuestion): string {
  return `Sentence: ${q.text}\nWord: "${q.word}"`;
}
const NAME_SHOTS: Shot[] = ([
  ["book a Lyft home", "Lyft", "yes"],
  ["the river was calm", "river", "no"],
  ["The Window is open", "Window", "no"],
  ["deploy it on Vercel", "Vercel", "yes"],
] as const).map(([text, word, a]) => [nameUser({ text, word }), a]);

/** Whether a word, alone and in lower case, is an everyday word: dictation's
 *  side of the same check. In its sentence the name question reads
 *  dictation's casing ("a product called Stadium" is a name) or, lower-cased,
 *  loses a real name ("email michael about it" reads as ordinary). */
export const WORD_SYSTEM = `Is the given word an everyday English word found in a dictionary (yes), or only a name (no)? Answer only yes or no.`;

export const wordUser = (word: string) => `Word: "${word}"`;
const WORD_SHOTS: Shot[] = [["river", "yes"], ["emma", "no"], ["window", "yes"], ["oliver", "no"]].map(([w, a]) => [wordUser(w!), a!]);

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

/** ChatML with Qwen3's thinking turned off (the empty think block its chat
 *  template writes for enable_thinking=false), around the user's turn: the
 *  text before it and after it. The turn itself is the user's text and is
 *  tokenized apart, never as special tokens. */
function chatml(system: string, shots: Shot[]): { head: string; tail: string } {
  let head = `<|im_start|>system\n${system}<|im_end|>\n`;
  for (const [u, a] of shots) head += `<|im_start|>user\n${u}<|im_end|>\n<|im_start|>assistant\n${a}<|im_end|>\n`;
  return { head: head + "<|im_start|>user\n", tail: "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n" };
}
const JUDGE_PROMPT = chatml(JUDGE_SYSTEM, JUDGE_SHOTS);
const RETRACT_PROMPT = chatml(RETRACT_SYSTEM, RETRACT_SHOTS);
const NAME_PROMPT = chatml(NAME_SYSTEM, NAME_SHOTS);
const WORD_PROMPT = chatml(WORD_SYSTEM, WORD_SHOTS);

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
  named(questions: NameQuestion[]): Promise<number[]>;
  everyday(words: string[]): Promise<number[]>;
  score(sentences: ScoreSentence[]): Promise<number[]>;
  retract(text: string): Promise<Retraction[]>;
  /** Resolves once the model is loaded (it is, by the time the worker answers anything). */
  ready(): Promise<void>;
  dispose(): Promise<void>;
}

// node-llama-cpp as this file calls it. `T` is a token and `S` a context
// sequence: fixer/check.ts reads this under node-llama-cpp's own `Token` (a
// branded number) and `LlamaContextSequence`, and checks each options type
// below against the real one, key by key.

export interface GetLlamaOptions { build: "never" }
export interface LoadModelOptions { modelPath: string }
export interface ContextOptions { contextSize: number; sequences: number }
export interface CompletionOptions<S> { contextSequence: S }
export interface GenerateOptions { maxTokens: number; temperature: number; customStopTriggers: string[] }
/** What one evaluated position asks for its next token. */
export interface GenerateNext<T = number> {
  token: true;
  options: { temperature: number };
  logits: { filter: { tokens: readonly T[]; includeSelected: boolean } };
  totalLogitWeight: true;
}
export type EvaluateItem<T = number> = T | [token: T, options: { generateNext: GenerateNext<T> }];
export interface EvaluateOutput<T = number> {
  next: { token?: T | null; logits?: ReadonlyMap<T, number>; totalLogitWeight?: number };
}
export interface LlamaSequence<T = number> {
  readonly contextTokens: readonly T[];
  readonly nextTokenIndex: number;
  eraseContextTokenRanges(ranges: { start: number; end: number }[]): Promise<void>;
  controlledEvaluate(input: EvaluateItem<T>[]): Promise<(EvaluateOutput<T> | undefined)[]>;
}
export interface LlamaModel<T = number, S extends LlamaSequence<T> = LlamaSequence<T>> {
  tokenize(text: string, specialTokens: boolean): T[];
  createContext(options: ContextOptions): Promise<{ getSequence(): S; dispose(): Promise<void> }>;
  dispose(): Promise<void>;
}
export interface LlamaLib<T = number, S extends LlamaSequence<T> = LlamaSequence<T>> {
  getLlama(options: GetLlamaOptions): Promise<{ loadModel(options: LoadModelOptions): Promise<LlamaModel<T, S>> }>;
  LlamaCompletion: new (options: CompletionOptions<S>) => {
    generateCompletion(input: T[], options: GenerateOptions): Promise<string>;
  };
}

/** The factory the fixer's worker builds: loads the GGUF at `path` on the
 *  node-llama-cpp `llama` names (fixer/index.js, by URL: fixer.ts). */
export async function loadLlamaFixer(o: { path: string; llama: string }): Promise<FixerEngine> {
  // Lazy: node-llama-cpp loads a native addon and Metal; only this worker needs it.
  const lib = (await import(o.llama)) as LlamaLib;
  // The prebuilt binary only: never a build from source or a download (a
  // packaged strut ships its binaries in native/llama; package-desktop.mjs).
  const llama = await lib.getLlama({ build: "never" });
  const model = await llama.loadModel({ modelPath: o.path });
  const context = await model.createContext({ contextSize: 4096, sequences: 3 });
  // One sequence per task, so each keeps its fixed prefix cached.
  const judging = context.getSequence(), scoring = context.getSequence();
  const completion = new lib.LlamaCompletion({ contextSequence: context.getSequence() });
  const yesNo = ["yes", "no"].map((w) => model.tokenize(w, false)[0]!);
  // Dictated text and the vocabulary's names are text, so "<|im_end|>" in
  // them is those characters, not the end of the turn.
  const prompt = (p: { head: string; tail: string }, user: string) =>
    [...model.tokenize(p.head, true), ...model.tokenize(user, false), ...model.tokenize(p.tail, true)];

  /** Evaluates `toks` on `seq`, keeping the tokens it already holds of them
   *  before `from`, the first position whose next-token logits are read;
   *  `want(i)` says which tokens' logits to read at position `i`. */
  async function evaluate(seq: LlamaSequence, toks: number[], from: number, want: (i: number) => readonly number[] | null) {
    const have = seq.contextTokens;
    let k = 0;
    while (k < have.length && k < from && have[k] === toks[k]) k++;
    if (k < seq.nextTokenIndex) await seq.eraseContextTokenRanges([{ start: k, end: seq.nextTokenIndex }]);
    const input = toks.slice(k).map((t, j): EvaluateItem => {
      const filter = want(k + j);
      return filter
        ? [t, { generateNext: { token: true, options: { temperature: 0 }, logits: { filter: { tokens: filter, includeSelected: true } }, totalLogitWeight: true } }]
        : t;
    });
    const out = (await seq.controlledEvaluate(input)) as any[];
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

  /** log P(yes) − log P(no) after each user turn, one forward pass each. */
  const yesOrNo = (seq: LlamaSequence, p: { head: string; tail: string }, users: string[]) => serial(async () => {
    const out: number[] = [];
    for (const user of users) {
      const toks = prompt(p, user) as number[];
      const r = await evaluate(seq, toks, toks.length - 1, (i) => (i === toks.length - 1 ? yesNo : null));
      const next = r.out.at(-1).next;
      out.push(logp(next, yesNo[0]!) - logp(next, yesNo[1]!));
    }
    return out;
  });

  return {
    judge: (qs) => yesOrNo(judging, JUDGE_PROMPT, qs.map(judgeUser)),
    // On the scoring sequence: its own prefix is a line long, so the judge's keeps its cache.
    named: (qs) => yesOrNo(scoring, NAME_PROMPT, qs.map(nameUser)),
    everyday: (ws) => yesOrNo(scoring, WORD_PROMPT, ws.map(wordUser)),
    score: (ss) => serial(async () => {
      const out: number[] = [];
      for (const s of ss) {
        const a = model.tokenize(scorePrefix(s), false) as number[], b = model.tokenize(s.text, false) as number[];
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
      const reply = await completion.generateCompletion(prompt(RETRACT_PROMPT, text), {
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
