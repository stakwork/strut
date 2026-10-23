import WORDS from "./words-en.js";

let words: Set<string> | undefined;

/** Whether a lowercased word is an everyday English word (words-en.ts,
 *  SCOWL's small spell-checker list): never rewritten on its own, never
 *  taken for a name. A single letter is not, other than "a" and "i". The set
 *  is built on first use. */
export function isCommon(word: string): boolean {
  words ??= new Set(WORDS.split("\n").filter(Boolean));
  return words.has(word.replace(/’/g, "'"));
}
