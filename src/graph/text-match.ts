// Text matching for keyword search, the parts that hold for any data and
// any language: words as letters and digits in any script, typo distance,
// and the edge types a word names by the schema's own names and aliases.
// Word endings, possessives and stop words are the full-text index's own
// (Ladybug's analyser); the Ladybug reader (`ladybug/reader.ts`) asks it one
// word at a time and sums its scores. `npm run bench:memory-graph` measures it.

/** Lowercase, accents that Unicode folds dropped, Arabic harakat and Hebrew points dropped, whitespace collapsed. */
export function fold(text: string): string {
  return text.normalize("NFKD").replace(/[\u0300-\u036f\u064b-\u065f\u0670\u0591-\u05c7]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Lowercase words of letters and digits in any script, accents folded. */
export function words(text: string): string[] {
  return fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Optimal-string-alignment distance (edits plus adjacent swaps), giving up past `max`. */
export function distance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

/** A typo of each other: one edit from five letters, two from nine. Shorter words must match exactly. */
export function typo(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  if (n < 5 || a === b) return false;
  return distance(a, b, n >= 9 ? 2 : 1) <= (n >= 9 ? 2 : 1);
}

/** How much a word counts when it meets a text's word other than as itself. */
export const WEIGHTS = { prefix: 0.8, typo: 0.6 } as const;

/** A search query as words. */
export interface TextQuery {
  /** Its words, each once. */
  terms: string[];
}

export function textQuery(q: string): TextQuery {
  return { terms: [...new Set(words(q))] };
}

/** Words of a vocabulary a term may have meant: a longer word it starts (renovat → renovation), or a typo of it. */
export function corrections(term: string, vocabulary: Iterable<string>): Array<{ word: string; weight: number }> {
  const out: Array<{ word: string; weight: number }> = [];
  for (const w of vocabulary) {
    if (w === term) continue;
    if (term.length >= 5 && w.startsWith(term)) out.push({ word: w, weight: WEIGHTS.prefix });
    else if (typo(w, term)) out.push({ word: w, weight: WEIGHTS.typo });
  }
  return out;
}

/** The edge types each word names: the words of the type's own name and of its aliases (works_at → works; an alias job → job). */
export function predicateWords(predicates: Iterable<string>, aliases: ReadonlyMap<string, readonly string[]> = new Map()): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const p of predicates) {
    for (const w of words([p, ...(aliases.get(p) ?? [])].join(" ").replace(/_/g, " "))) {
      if (w.length < 3) continue;
      (out.get(w) ?? out.set(w, new Set()).get(w)!).add(p);
    }
  }
  return out;
}

/** Two words are one when either starts the other and the shorter has three letters or more (work, works). */
const sameWord = (a: string, b: string) => Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a));

/** The edge types the query's words name. */
export function cuedPredicates(tq: TextQuery, predicates: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const out = new Set<string>();
  for (const t of tq.terms) for (const [w, ps] of predicates) if (sameWord(t, w)) for (const p of ps) out.add(p);
  return out;
}
