/** A detected span of the text. `clue` is reserved for the quasi-identifier stage that follows. */
export type Span = {
  s: number;
  e: number;
  type: string;
  src: "deny" | "rule" | "heur" | "ner" | "clue" | "llm" | "sweep";
  score?: number;
};

/** What a vault keeps per token. `mode` / `gen` are reserved and ignored today. */
export type MapEntry = { type: string; value: string; mode?: string; gen?: string };
export type TokenMap = Record<string, MapEntry>;

/** Never carries an original text or value. */
export type Warning = { code: string; message: string; count?: number };

export type VaultKind = "memory" | "file";

/** A span as the NER model reports it, before post-processing. */
export type RawNerSpan = { s: number; e: number; type: string; score: number };

export interface NerEngine {
  detect(texts: string[]): Promise<{ spans: RawNerSpan[][]; unaligned: number }>;
}

/** The optional LLM detector: names it found, verbatim, per text. */
export interface LlmEngine {
  detect(texts: string[]): Promise<{ items: { text: string; type: string }[][]; invalid: number }>;
}
