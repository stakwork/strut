// Text matching for keyword search: words in any script, a light stemmer,
// typo distance, and a ranker that scores candidate
// texts by how rare the query words they match are. Pure: no index, no
// model. Taken from stakwork/strut#162's memory matcher
// (src/steps/lib/memory/_match.ts there), which can import these instead
// once both are merged. The Ladybug reader (`ladybug/reader.ts`) ranks its
// full-text candidates with it; `npm run bench:memory-graph` measures it.

// Words that carry no meaning in a search. First-person words are here too:
// they read as "about the user" (SELF) instead.
export const STOP = new Set([
  "a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "for", "from", "by", "with", "as", "is", "are", "was", "were",
  "be", "been", "am", "do", "does", "did", "has", "have", "had", "what", "who", "whom", "whose", "where", "when", "which",
  "how", "why", "that", "this", "these", "those", "it", "its", "there", "about", "know", "tell", "you", "your", "can", "could",
  "would", "should", "s", "t", "re", "ve", "ll", "d", "whats", "wheres", "whos", "any", "some", "all", "just", "now",
  "user", "users", "please", "anything", "something", "i", "me", "my", "mine", "myself", "im", "ive",
]);
export const SELF = new Set(["i", "me", "my", "mine", "myself", "im", "ive"]);

/** Lowercase, accents that Unicode folds dropped, Arabic harakat and Hebrew points dropped, whitespace collapsed. */
export function fold(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ًͯ-ٰٟ֑-ׇֽֿׁׂׅׄ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Lowercase words of letters and digits in any script, accents folded; a possessive 's is dropped ("Kate's" → "kate"). */
export function words(text: string): string[] {
  return fold(text).replace(/['’]s\b/g, "").replace(/['’]/g, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** True when the word is not in a spaced script (CJK, Thai, …): such text may have no spaces between words. */
export function unspaced(word: string): boolean {
  return /[^\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}]/u.test(word);
}

/** A light English stemmer: enough that cycling/cycles, designers/design and baked/baking meet. Applied to both sides. */
export function stem(w: string): string {
  if (w.length <= 3 || !/^[a-z]+$/.test(w)) return w;
  let s = w;
  for (const [suffix, repl] of [["ies", "y"], ["ied", "y"], ["ings", ""], ["ing", ""], ["ers", ""], ["er", ""], ["edly", ""], ["ed", ""], ["es", ""], ["ly", ""], ["s", ""]] as const) {
    if (s.endsWith(suffix) && s.length - suffix.length >= 3 && !(suffix === "s" && s.endsWith("ss"))) {
      s = s.slice(0, -suffix.length) + repl;
      break;
    }
  }
  if (s.length > 3 && s.endsWith("e")) s = s.slice(0, -1);
  if (s.length > 3 && s.at(-1) === s.at(-2) && !"aeiouls".includes(s.at(-1)!)) s = s.slice(0, -1);
  return s;
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

/** The words a text writes with a capital, as `words` gives them: in a title, a name. */
export function capitalised(text: string): string[] {
  return text.split(/[^\p{L}\p{N}'’]+/u).filter((t) => /^\p{Lu}/u.test(t)).flatMap((t) => words(t));
}

/** The words a sentence writes with a capital other than at its start ("Gareth Jones moved" → jones): names, in running text. */
export function namedInText(text: string): string[] {
  return text.split(/(?<=[.!?:;])\s+|\n+/u).flatMap((sentence) => capitalised(sentence.trim().replace(/^\S+\s*/u, "")));
}

// ---- Ranking ----

/** How much a query word counts when it meets a text's word other than as itself. */
export const WEIGHTS = { exact: 1, prefix: 0.8, typo: 0.6, predicate: 0.8 } as const;

/** A search query as words: its terms (no stop words) and whether it is about the user. */
export interface TextQuery {
  terms: string[];
  /** Every word, stop words included. */
  words: string[];
  /** Says I, me, my, …. */
  self: boolean;
}

export function textQuery(q: string): TextQuery {
  const all = words(q);
  return { terms: [...new Set(all.filter((w) => !STOP.has(w)))], words: all, self: all.some((w) => SELF.has(w)) };
}

/** Words of a vocabulary a term may have meant: a typo of it, or a longer word it starts (renovat → renovation). */
export function corrections(term: string, vocabulary: Iterable<string>): Array<{ word: string; weight: number }> {
  const s = stem(term);
  const out: Array<{ word: string; weight: number }> = [];
  for (const w of vocabulary) {
    if (w === term) continue;
    if (s.length >= 5 && w.startsWith(s) && stem(w) !== s) out.push({ word: w, weight: WEIGHTS.prefix });
    else if (typo(w, term)) out.push({ word: w, weight: WEIGHTS.typo });
  }
  return out;
}

/** One candidate to rank. */
export interface MatchDoc {
  /** Everything it is found by. */
  text: string;
  /** Its title, when it is a named thing: more of it matched ranks it above longer names (Lisbon over Lisbon trip). */
  title?: string;
  /** It is the user, or a fact about them. */
  self?: boolean;
  /** A fact's predicate (its edge type). */
  predicate?: string;
}

/** The predicates a word names, by stem: each predicate's own words and its aliases' (works_at → work; job_at → job). */
export function predicateWords(predicates: Iterable<string>, aliases: ReadonlyMap<string, readonly string[]> = new Map()): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const p of predicates) {
    for (const w of words([p, ...(aliases.get(p) ?? [])].join(" ").replace(/_/g, " "))) {
      if (STOP.has(w) || w.length < 3) continue;
      (out.get(stem(w)) ?? out.set(stem(w), new Set()).get(stem(w))!).add(p);
    }
  }
  return out;
}

export interface RankOptions {
  /** Words never stemmed (people's names: Jones is not Jon, Fisher not fishing). */
  names?: ReadonlySet<string>;
  /** Other words a term may mean, from `corrections`. */
  extra?: ReadonlyMap<string, Array<{ word: string; weight: number }>>;
  /** How many texts there are in all, when the docs are only the candidates
   *  (every text holding a query word): rarity is out of these. Default: the docs. */
  total?: number;
  /** The predicates a word names, from `predicateWords`: a fact of one counts the word as matched, and more. */
  predicates?: ReadonlyMap<string, ReadonlySet<string>>;
}

type Meaning = { key: string; weight: number; how: "word" | "sub" };

/**
 * Scores each doc, 0 when it matches no term: each term counts its best
 * meaning (the word, a correction, or a
 * substring for unspaced text) weighted by how rare that meaning is among
 * the docs; a term naming a fact's predicate counts on that fact as a
 * match and half a point more (work → works_at), so the fact that answers
 * a question outranks its subject; a query about the user favours the
 * user's docs (×1.5); a doc with a title gains for how much of its title
 * the query names.
 */
export function rankScores(tq: TextQuery, docs: MatchDoc[], opts: RankOptions = {}): number[] {
  if (!tq.terms.length || !docs.length) return docs.map(() => 0);
  const names = opts.names ?? new Set<string>();
  const key = (w: string) => (names.has(w) ? w : stem(w));
  const keys = (text: string) => new Set(words(text).map(key));
  const prepared = docs.map((d) => ({ stems: keys(d.text), text: fold(d.text), title: d.title ? words(d.title) : [] }));
  const df = new Map<string, number>();
  for (const p of prepared) for (const s of p.stems) df.set(s, (df.get(s) ?? 0) + 1);
  const n = Math.max(docs.length, opts.total ?? 0);
  const idf = (s: string) => Math.log(1 + n / (df.get(s) ?? 0.5));
  const subIdf = (w: string) => Math.log(1 + n / (prepared.filter((p) => p.text.includes(w)).length || 0.5));

  const meanings = tq.terms.map((w) => {
    const out: Meaning[] = [{ key: key(w), weight: WEIGHTS.exact, how: "word" }];
    if (unspaced(w)) out.push({ key: w, weight: WEIGHTS.exact, how: "sub" });
    for (const c of opts.extra?.get(w) ?? []) out.push({ key: key(c.word), weight: c.weight, how: "word" });
    return { out, cues: opts.predicates?.get(stem(w)), word: w };
  });

  return prepared.map((p, i) => {
    let score = 0;
    for (const { out, cues, word } of meanings) {
      let best = 0;
      if (docs[i]!.predicate && cues?.has(docs[i]!.predicate!)) best = WEIGHTS.predicate * idf(key(word)) + 0.5;
      for (const m of out) {
        const hit = m.how === "sub" ? p.text.includes(m.key) : p.stems.has(m.key);
        if (!hit) continue;
        const rarity = m.how === "sub" ? subIdf(m.key) : idf(m.key);
        best = Math.max(best, m.weight * rarity);
      }
      score += best;
    }
    if (!score) return 0;
    if (tq.self && docs[i]!.self) score *= 1.5;
    if (p.title.length) {
      const hit = p.title.filter((w) => meanings.some(({ out }) => out.some((m) => m.key === key(w) || m.key === w)));
      score += 0.5 + hit.length / p.title.length;
    }
    return score;
  });
}

/** The predicates the query's terms name. */
export function cuedPredicates(tq: TextQuery, predicates: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  return new Set(tq.terms.flatMap((t) => [...(predicates.get(stem(t)) ?? [])]));
}

/** The terms no doc matches as a word or a substring: the ones worth a typo lookup. */
export function unmatched(tq: TextQuery, docs: MatchDoc[], names: ReadonlySet<string> = new Set()): string[] {
  const key = (w: string) => (names.has(w) ? w : stem(w));
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const d of docs) {
    for (const w of words(d.text)) seen.add(key(w));
    texts.push(fold(d.text));
  }
  return tq.terms.filter((t) => !seen.has(key(t)) && !(unspaced(t) && texts.some((x) => x.includes(t))));
}
