/**
 * Dictation's vocabulary (ported from Peel's Lingo.swift): the rewrite of a
 * transcript before it is typed, and what an edit of the typed text teaches.
 * Pure and deterministic over a `Lexicon` (memory/lexicon's output) and an
 * everyday-word test (common-words.ts), so both are tested without a memory.
 *
 * `POST /audio/transcribe` applies `rewrite`; the `dictation/correction` step
 * runs `lessons` and writes each mishearing with `learnInput`.
 */

/** memory/lexicon's output, as dictation reads it. */
export interface Lexicon {
  entries: LexiconEntry[];
  /** Pairs the user undid: never learned again. */
  undone: { value: string; written: string }[];
  /** The type a new word is made as (the one with role dictation); its entities are taught to dictation. */
  lingoType?: string;
  /** The predicate a mishearing is written with (the one with role mishearing). */
  mishearing?: string;
}

export interface LexiconEntry {
  refId: string;
  type: string;
  name: string;
  /** Correct ways to write it, the name first ("Bitcoin", "BTC"). */
  written: string[];
  heard: Heard[];
  dictationOff: boolean;
  /** Current facts it is in, its mishearings among them. */
  facts: number;
}

/** A mishearing: dictation writes `value` for `form` (null: the entity's name). */
export interface Heard {
  refId: string;
  value: string;
  form: string | null;
}

/** Whether a lowercased word is an everyday word. */
export type IsCommonWord = (word: string) => boolean;

export interface Change {
  /** What dictation wrote, and what was typed in its place. */
  heard: string;
  written: string;
}

/** What one hunk of an edit means: a mishearing to learn, or nothing. */
export type Lesson = { kind: "misheard"; heard: string; written: string } | { kind: "nothing" };

const NOTHING: Lesson = { kind: "nothing" };

/** memory/lexicon's output → a Lexicon. */
export function lexiconFrom(output: any): Lexicon {
  const entries: LexiconEntry[] = [];
  for (const e of output?.entities ?? []) {
    if (typeof e?.ref_id !== "string" || typeof e?.name !== "string") continue;
    const heard: Heard[] = [];
    for (const h of e.heard ?? []) {
      if (typeof h?.ref_id === "string" && typeof h?.value === "string") heard.push({ refId: h.ref_id, value: h.value, form: typeof h.form === "string" ? h.form : null });
    }
    const written = Array.isArray(e.written) ? e.written.filter((w: unknown): w is string => typeof w === "string") : [e.name];
    entries.push({
      refId: e.ref_id, type: typeof e.type === "string" ? e.type : "", name: e.name, written, heard,
      dictationOff: e.dictation_off === true, facts: typeof e.facts === "number" ? e.facts : 0,
    });
  }
  const undone: Lexicon["undone"] = [];
  for (const u of output?.undone ?? []) {
    const written = typeof u?.form === "string" ? u.form : u?.entity?.name;
    if (typeof u?.value === "string" && typeof written === "string") undone.push({ value: u.value, written });
  }
  return {
    entries, undone,
    ...(typeof output?.lingo_type === "string" ? { lingoType: output.lingo_type } : {}),
    ...(typeof output?.mishearing === "string" ? { mishearing: output.mishearing } : {}),
  };
}

export const EMPTY_LEXICON: Lexicon = { entries: [], undone: [] };

/** The entry with `text` among its written forms, matched without case,
 *  turned off for dictation or not: it is still that thing. */
export function entryWriting(lexicon: Lexicon, text: string): LexiconEntry | undefined {
  const key = text.toLowerCase();
  return lexicon.entries.find((e) => e.written.some((w) => w.toLowerCase() === key));
}

export function wasUndone(lexicon: Lexicon, value: string, written: string): boolean {
  return lexicon.undone.some((u) => u.value.toLowerCase() === value.toLowerCase() && u.written.toLowerCase() === written.toLowerCase());
}

/** Words taught to dictation: a word of the lingo type, or anything with a
 *  mishearing; not one turned off. A name an agent stored in its own casing
 *  ("github") is not, so it never undoes how the user writes it. */
const taught = (lexicon: Lexicon) =>
  lexicon.entries.filter((e) => !e.dictationOff && ((!!lexicon.lingoType && e.type === lexicon.lingoType) || e.heard.length > 0));

// ── The rewrite ─────────────────────────────────────────────────────────────

/**
 * What dictation's text becomes before it is typed: each known mishearing
 * replaced by what it stands for, new spellings of taught words put right,
 * then taught words given their casing. What it changed is reported.
 */
export function rewrite(text: string, lexicon: Lexicon, isCommon: IsCommonWord): { text: string; changes: Change[] } {
  const words = new Words(text);
  const changes: Change[] = [];
  // Mishearings, longest first, so "bee tee see" wins over "see".
  const pairs = lexicon.entries.filter((e) => !e.dictationOff)
    .flatMap((e) => e.heard.map((h) => ({ heard: new Words(h.value), written: h.form ?? e.name })))
    // A token with no letters or digits ("&") is no mishearing: it would match every bare punctuation mark.
    .filter((p) => p.heard.tokens.length > 0 && p.heard.keys.every(Boolean))
    // One common word is never rewritten on its own ("fix" for Sphinx):
    // that would be worse than the mistake.
    .filter((p) => !(p.heard.tokens.length === 1 && isCommon(p.heard.keys[0]!)))
    .sort((a, b) => b.heard.tokens.length - a.heard.tokens.length);
  for (let index = 0; index < words.tokens.length; index++) {
    const pair = pairs.find((p) => words.matches(p.heard, index));
    if (!pair) continue;
    const heard = words.text(index, pair.heard.tokens.length);
    words.replace(index, pair.heard.tokens.length, pair.written);
    changes.push({ heard, written: pair.written });
  }
  fuzzy(words, changes, lexicon, isCommon);
  // Casing: a single-word written form that is not an everyday word takes
  // its own casing ("stakwork" → "Stakwork"; "peel" stays). Taught words only.
  const cased = new Map<string, string>();
  for (const w of taught(lexicon).flatMap((e) => e.written)) {
    // Not a one-letter form ("X"): every lone x would take its casing.
    if (!w.includes(" ") && length(letters(w)) > 1 && !cased.has(w.toLowerCase())) cased.set(w.toLowerCase(), w);
  }
  for (let i = 0; i < words.tokens.length; i++) {
    const key = words.keys[i]!;
    const form = cased.get(key);
    if (!form || isCommon(key) || words.core(i) === form) continue;
    changes.push({ heard: words.core(i), written: form });
    words.replace(i, 1, form);
  }
  return { text: words.joined, changes };
}

/** Dictation spells a name a new way each time ("Stockwork", "stackwork",
 *  "stock work"): one word, or two, put right when its letters, spaces and
 *  case aside, are a known form's, or for a long word nearly so (a quarter of
 *  its letters off at most). Only taught words, never an everyday word alone. */
function fuzzy(words: Words, changes: Change[], lexicon: Lexicon, isCommon: IsCommonWord): void {
  // Each form's letters, and the word it stands for.
  const exact = new Map<string, string>();
  const near: { letters: string; written: string }[] = [];
  // A form of one letter or none ("C#", "&") is left out: it would take every lone letter.
  const add = (l: string, written: string) => {
    if (length(l) > 1 && !exact.has(l)) exact.set(l, written);
  };
  for (const entry of taught(lexicon)) {
    for (const written of entry.written) {
      const l = letters(written);
      add(l, written);
      if (length(l) >= 6) near.push({ letters: l, written });
    }
    for (const heard of entry.heard) add(letters(heard.value), heard.form ?? entry.name);
  }
  if (exact.size === 0) return;
  for (let index = 0; index < words.tokens.length; index++) {
    for (const count of [2, 1]) {
      if (index + count > words.tokens.length) continue;
      // Not across punctuation: "a stack. Work" stays.
      if (!words.contiguous(index, count)) continue;
      const keys = words.keys.slice(index, index + count);
      if (count === 1 && isCommon(keys[0]!)) continue;
      const joined = keys.join("");
      // A known form with a plural or possessive ending ("Stakwork's", "stakworks") is that word, already right.
      const stem = joined.replace(/['’]?s$/, "");
      if (count === 1 && stem !== joined && exact.has(stem)) continue;
      // Two words only as a known form exactly ("stock work"); one long word
      // also when nearly so ("Stockwork").
      const written = exact.get(joined) ?? (count === 1 && length(joined) >= 6
        ? near.find((n) => distance(joined, n.letters) * 4 <= Math.max(length(joined), length(n.letters)))?.written
        : undefined);
      if (written === undefined || words.text(index, count) === written) continue;
      changes.push({ heard: words.text(index, count), written });
      words.replace(index, count, written);
      break;
    }
  }
}

// ── Learning from an edit ───────────────────────────────────────────────────

/** More than this many words on either side is a rewrite, not a correction. */
const MAX_HUNK = 4;

/** The lessons in turning `typed` into `edited`, one per changed run; empty
 *  when the edit is a rewrite rather than corrections. */
export function lessons(typed: string, edited: string, lexicon: Lexicon, isCommon: IsCommonWord): Lesson[] {
  const a = new Words(typed), b = new Words(edited);
  // Compared as written, so a casing fix ("stakwork" → "Stakwork") is a change.
  const hunks = diff(a.tokens.map((_, i) => a.core(i)), b.tokens.map((_, i) => b.core(i)));
  // Each run counts by its shorter side: "k p i" → "KPI" is one change, not three.
  const changed = hunks.reduce((n, h) => n + Math.min(Math.max(h.a.length, 1), Math.max(h.b.length, 1)), 0);
  // A short dictation may change by half or more ("stakwork" → "Stakwork").
  if (hunks.length === 0 || !(changed * 2 <= a.keys.length || a.keys.length <= 3)) return [];
  if (!hunks.every((h) => h.a.length <= MAX_HUNK && h.b.length <= MAX_HUNK)) return [];
  return hunks.map((h) => lesson(h.a.map((i) => a.core(i)).join(" "), h.b.map((i) => b.core(i)).join(" "), lexicon, isCommon));
}

/** One hunk: dictation's `from`, the user's `to`. */
export function lesson(from: string, to: string, lexicon: Lexicon, isCommon: IsCommonWord): Lesson {
  // A cut or an addition teaches nothing.
  if (!from || !to) return NOTHING;
  const fromWords = new Words(from), toWords = new Words(to);
  // Both everyday words: "their" → "there".
  if (fromWords.keys.every(isCommon) && toWords.keys.every(isCommon) && from.toLowerCase() !== to.toLowerCase()) return NOTHING;
  // Two correct ways to write one thing: "BTC" → "Bitcoin".
  const entry = entryWriting(lexicon, from);
  if (entry && entry === entryWriting(lexicon, to)) return NOTHING;
  // A word the user turned off for dictation is left alone.
  if (entryWriting(lexicon, to)?.dictationOff) return NOTHING;
  if (!lingoShaped(to, lexicon, isCommon)) return NOTHING;
  // Same letters, other casing: "stakwork" → "Stakwork". Not an everyday
  // word or a letter capitalised ("i" → "I", "so" → "So", "apple" → "Apple").
  const sameLetters = letters(from) === letters(to);
  if (sameLetters && fromWords.tokens.length === toWords.tokens.length && fromWords.keys.every((k) => isCommon(k) || length(k) === 1)) return NOTHING;
  if (!sameLetters && !soundsLike(from, to)) return NOTHING;
  // Dictation wrote something the user could mean ("PH" for P8): learning
  // it would rewrite real uses of it.
  if (!sameLetters && plausible(from, lexicon, isCommon)) return NOTHING;
  if (wasUndone(lexicon, from, to)) return NOTHING;
  return { kind: "misheard", heard: from, written: to };
}

/** Something the user might write on purpose: one everyday word, an acronym
 *  or other word-like token ("PH", "2FA", "iOS"), or a word already in the vocabulary. */
function plausible(text: string, lexicon: Lexicon, isCommon: IsCommonWord): boolean {
  if (entryWriting(lexicon, text)) return true;
  const words = new Words(text);
  if (words.tokens.length !== 1) return false;
  return isCommon(words.keys[0]!) || wordLike(words.core(0));
}

/** Looks like a name or a term: not an everyday word, or cased, or carrying
 *  digits; or already in the vocabulary. */
function lingoShaped(text: string, lexicon: Lexicon, isCommon: IsCommonWord): boolean {
  if (entryWriting(lexicon, text)) return true;
  return new Words(text).keys.some((k) => !isCommon(k)) || UPPER.test(text) || NUMBER.test(text);
}

/** An acronym, a mixed-case word or letters with digits: two or more
 *  characters, all capitals, a capital inside, or a digit. */
function wordLike(word: string): boolean {
  const core = [...word].filter(isPart);
  if (core.length < 2) return false;
  const capitals = core.filter((c) => UPPER.test(c)).length;
  return core.some((c) => NUMBER.test(c)) || capitals >= 2 || core.slice(1).some((c) => UPPER.test(c));
}

// ── Sounding alike ──────────────────────────────────────────────────────────

/** Whether `a` and `b` say the same thing: one word split into several or
 *  several run into one, near enough letter for letter ("stack work" /
 *  "Stakwork", "l sat" / "LSAT"); a long word misspelt ("Stackwork" /
 *  "Stakwork"); or the same sounds spelled out ("p eight" / "P8"). Not a
 *  short word swapped for one like it ("Jon" / "Jen", "Sarah" / "Sara"):
 *  that is the user choosing a different name. */
export function soundsLike(a: string, b: string): boolean {
  const la = letters(a), lb = letters(b);
  if (!la || !lb) return false;
  const longest = Math.max(length(la), length(lb));
  const splitOrJoined = new Words(a).tokens.length !== new Words(b).tokens.length;
  if (splitOrJoined && distance(la, lb) * 3 <= longest) return true;
  if (longest >= 6 && distance(la, lb) * 4 <= longest) return true;
  const sa = spoken(a), sb = spoken(b);
  return sa.length > 0 && sa.join(" ") === sb.join(" ");
}

const LETTER_NAMES: Record<string, string> = {
  a: "ay", b: "bee", c: "see", d: "dee", e: "ee", f: "eff", g: "gee", h: "aitch", i: "eye", j: "jay", k: "kay", l: "el", m: "em",
  n: "en", o: "oh", p: "pee", q: "cue", r: "ar", s: "ess", t: "tee", u: "you", v: "vee", w: "double you", x: "ex", y: "why", z: "zed",
};
const DIGIT_NAMES: Record<string, string> = {
  0: "zero", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine",
};
const SPOKEN_WORDS: Record<string, string> = { to: "two", too: "two", for: "four", won: "one", ate: "eight", oh: "zero" };

/** How it is said, sound by sound: digits and lone letters by name, a short
 *  all-capital or letter-and-digit token letter by letter. */
export function spoken(text: string): string[] {
  return new Words(text).tokens.flatMap((token) => {
    const core = [...token].filter(isPart);
    if (core.length === 0) return [];
    const spellOut = core.length === 1 || core.some((c) => NUMBER.test(c)) || (core.length <= 5 && core.every((c) => UPPER.test(c) || NUMBER.test(c)));
    if (spellOut) return core.map((c) => c.toLowerCase()).map((c) => DIGIT_NAMES[c] ?? LETTER_NAMES[c] ?? c);
    const word = core.join("").toLowerCase();
    return [SPOKEN_WORDS[word] ?? word];
  });
}

/** Letters and digits only, lowercased. */
export function letters(text: string): string {
  return [...text.toLowerCase()].filter(isPart).join("");
}

/** Edit distance, by character. */
export function distance(a: string, b: string): number {
  const x = [...a], y = [...b];
  const row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const current = row[j]!;
      row[j] = x[i - 1] === y[j - 1] ? previous : Math.min(previous, row[j]!, row[j - 1]!) + 1;
      previous = current;
    }
  }
  return row[y.length]!;
}

const length = (s: string) => [...s].length;

// ── Diffing ─────────────────────────────────────────────────────────────────

interface Hunk {
  a: number[];
  b: number[];
}

/** Word-level differences, as runs of replaced, cut or added words. */
export function diff(a: string[], b: string[]): Hunk[] {
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const hunks: Hunk[] = [];
  let current: Hunk = { a: [], b: [] };
  const close = () => {
    if (current.a.length || current.b.length) hunks.push(current);
    current = { a: [], b: [] };
  };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      close();
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      current.b.push(j++);
    } else {
      current.a.push(i++);
    }
  }
  close();
  return hunks;
}

// ── Text as words ───────────────────────────────────────────────────────────

// Marks too: a vowel sign or accent belongs to its letter, as in a Swift Character.
const PART = /[\p{L}\p{M}\p{N}]/u;
const UPPER = /\p{Lu}/u;
const NUMBER = /\p{N}/u;
const SPACE = /\s/u;
const isPart = (c: string) => PART.test(c);

/** Text as words: each token with what surrounds it kept, so a rewrite
 *  leaves the punctuation and spacing as they were. */
export class Words {
  /** Whitespace-separated tokens, punctuation attached. */
  tokens: string[] = [];
  private separators: string[] = [""];
  /** Each token's core, lowercased: what is compared. Kept with `tokens`. */
  keys: string[];

  constructor(text: string) {
    let token = "";
    for (const c of text) {
      if (SPACE.test(c)) {
        if (token) {
          this.tokens.push(token);
          token = "";
          this.separators.push("");
        }
        this.separators[this.separators.length - 1] += c;
      } else {
        token += c;
      }
    }
    if (token) {
      this.tokens.push(token);
      this.separators.push("");
    }
    this.keys = this.tokens.map((t) => split(t).core.toLowerCase());
  }

  /** A token without the punctuation around it. */
  core(i: number): string {
    return split(this.tokens[i]!).core;
  }

  get joined(): string {
    let out = this.separators[0]!;
    this.tokens.forEach((t, i) => (out += t + this.separators[i + 1]!));
    return out;
  }

  text(start: number, count: number): string {
    return Array.from({ length: count }, (_, k) => this.core(start + k)).join(" ");
  }

  /** Whether `count` tokens from `start` run on without punctuation between them. */
  contiguous(start: number, count: number): boolean {
    for (let i = start; i < start + count - 1; i++) {
      if (split(this.tokens[i]!).trail || split(this.tokens[i + 1]!).lead) return false;
    }
    return true;
  }

  /** `other`'s words at `start`, not across a sentence's or a clause's
   *  punctuation ("a stack. Work" is not "stack work"). */
  matches(other: Words, start: number): boolean {
    const theirs = other.keys;
    if (start + theirs.length > this.keys.length) return false;
    return theirs.every((k, i) => this.keys[start + i] === k) && this.contiguous(start, theirs.length);
  }

  /** Replaces `count` tokens from `start` with `text`, keeping the first
   *  token's leading and the last token's trailing punctuation. */
  replace(start: number, count: number, text: string): void {
    const lead = split(this.tokens[start]!).lead;
    const trail = split(this.tokens[start + count - 1]!).trail;
    this.tokens.splice(start, count, lead + text + trail);
    this.separators.splice(start + 1, count - 1);
    this.keys.splice(start, count, split(text).core.toLowerCase());
  }
}

function split(token: string): { lead: string; core: string; trail: string } {
  const chars = [...token];
  const first = chars.findIndex(isPart);
  if (first < 0) return { lead: token, core: "", trail: "" };
  let last = chars.length - 1;
  while (!isPart(chars[last]!)) last--;
  return { lead: chars.slice(0, first).join(""), core: chars.slice(first, last + 1).join(""), trail: chars.slice(last + 1).join("") };
}

// ── Strut's memory steps ────────────────────────────────────────────────────

/** memory/remember's input for one mishearing: `heard` is how dictation
 *  mishears `written`, on the entity that writes it, or on a new word of the
 *  lingo type when none does. Only the pair is said, never the sentence it was in. */
export function learnInput(heard: string, written: string, lexicon: Lexicon): Record<string, unknown> {
  const entry = entryWriting(lexicon, written);
  if (!lexicon.mishearing) throw new Error("the memory has no predicate with role mishearing");
  if (!entry && !lexicon.lingoType) throw new Error("the memory has no entity type with role dictation for a new word");
  const subject = entry ? { ref_id: entry.refId, type: entry.type, name: entry.name } : { type: lexicon.lingoType, name: written };
  return {
    episode: `Dictation: corrected “${heard}” to “${written}”.`,
    kind: "note",
    created_by: "dictation",
    facts: [{
      subject, predicate: lexicon.mishearing, text: `Dictation hears ${written} as “${heard}”.`, value: heard,
      ...(entry && entry.name !== written ? { form: written } : {}),
    }],
  };
}

/** What a learn wrote, to forget on Undo: the new entity when one was made
 *  (its facts go with it), else the new fact; nothing when strut already had it. */
export function undoIds(output: any): string[] {
  const created = (rows: any) => (Array.isArray(rows) ? rows : []).filter((r) => r?.status === "created" && typeof r.ref_id === "string").map((r) => r.ref_id as string);
  const entities = created(output?.entities);
  return entities.length ? entities : created(output?.facts);
}
