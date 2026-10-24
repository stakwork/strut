/**
 * Dictation's vocabulary (plans/dictation-models.md): the rewrite of a
 * transcript before it is typed, and what an edit of the typed text teaches.
 *
 * Code finds and builds; a small local model (the fixer, fixer.ts) only
 * scores. The model never writes text:
 *
 * - Learn (`mishearings`, the dictation/correction step): the edit is diffed
 *   here; each short change that could sound like what was typed is asked
 *   yes/no, and learned when the model puts more weight on yes.
 * - Fix (`rewrite`, POST /audio/transcribe): `recall` finds spans that may be
 *   a vocabulary word; each is kept when the model finds the sentence with
 *   the word likelier than as heard. Fillers and doubled words go by rule; a
 *   phrase the speaker took back goes when the model names it and code finds
 *   it right before its cue.
 * - With no fixer (none picked, or too slow): fillers and doubled words still
 *   go by rule, and only exact learned mishearings of two or more words are
 *   applied (`heardOnly`); nothing is learned from edits.
 *
 * Pure over a `Lexicon` (memory/lexicon's output) and a `Fixer`, so both are
 * tested with scores injected.
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

/** One change the rewrite made: `heard` at offset `at` of the transcript
 *  became `written` ("" when it was removed: a filler, a doubled word, a
 *  phrase taken back). */
export interface Change {
  heard: string;
  written: string;
  at: number;
}

export interface Mishearing {
  heard: string;
  written: string;
  /** Learn `written` as a term with no mapping: dictation's text is a code
   *  of its own ("PH" → "P8"), so recall finds the code by its near
   *  spellings and each sentence decides. */
  term?: true;
}

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

/** The entry with `text` among its written forms, matched without case,
 *  turned off for dictation or not: it is still that thing. */
export function entryWriting(lexicon: Lexicon, text: string): LexiconEntry | undefined {
  const key = text.toLowerCase();
  return lexicon.entries.find((e) => e.written.some((w) => w.toLowerCase() === key));
}

export function wasUndone(lexicon: Lexicon, value: string, written: string): boolean {
  return lexicon.undone.some((u) => u.value.toLowerCase() === value.toLowerCase() && u.written.toLowerCase() === written.toLowerCase());
}

// ── The fixer: what the model is asked ─────────────────────────────────────

/** One change of an edit, asked yes/no: is it a mishearing? */
export interface JudgeQuestion {
  typed: string;
  /** `typed` with this change alone made: the other changes of the edit
   *  would make the sentence read as rewritten. */
  edited: string;
  from: string;
  to: string;
  /** Where `from` is in `typed`. */
  at: number;
  /** The vocabulary entries the change touches, as the prompt names them ("" for none). */
  known: string;
}

/** Whether `word` is a name, product, brand, code or term in `text`, or an ordinary word. */
export interface NameQuestion {
  text: string;
  word: string;
}

/** A sentence to score, after a line saying the speaker often mentions `name` (a `type`). */
export interface ScoreSentence {
  name: string;
  type: string;
  text: string;
}

/** What the model named as taken back: the words, and the words that took them back. */
export interface Retraction {
  wrong: string;
  cue: string;
}

/** A loaded fixer model (fixer.ts), or a fake with scores injected (tests). */
export interface Fixer {
  /** The catalog id (models.ts FIXER_MODELS). */
  id: string;
  /** How much more weight (in nats) "yes" needs than "no" for a learn. */
  learnMargin: number;
  /** log P(yes) − log P(no) for each question, from one forward pass each. */
  judge(questions: JudgeQuestion[]): Promise<number[]>;
  /** log P(yes) − log P(no) that each word is a name in its sentence. */
  named(questions: NameQuestion[]): Promise<number[]>;
  /** log P(yes) − log P(no) that each word, on its own, is an everyday dictionary word, not only a name. */
  everyday(words: string[]): Promise<number[]>;
  /** The log-likelihood of each sentence. */
  score(sentences: ScoreSentence[]): Promise<number[]>;
  /** What the speaker took back in `text`; only asked when a cue word appears. */
  retract(text: string): Promise<Retraction[]>;
}

// ── Learning from an edit ───────────────────────────────────────────────────

/** More than this many words on either side is a rewrite, not a correction. */
const MAX_HUNK = 4;

/** The changes of an edit the fixer is asked about: both sides present,
 *  at most four words a side, and sounding alike (a word that sounds nothing
 *  like it is a changed mind, not a mishearing). Each is asked alone, in its
 *  own sentence: `typed` is that sentence (and a neighbour when it is under
 *  four words), `edited` the same with only that change made. So a long
 *  dictation stays a short prompt, and the edit's other changes do not make
 *  it read as a rewrite. */
export function questions(typed: string, edited: string, lexicon: Lexicon): JudgeQuestion[] {
  const toks = tokens(typed);
  return hunks(typed, edited)
    .filter((h) => h.from && h.to && h.from.split(" ").length <= MAX_HUNK && h.to.split(" ").length <= MAX_HUNK && soundsAlike(h.from, h.to))
    .map((h) => {
      const at = toks[h.a[0]]!.start, end = toks[h.a[1] - 1]!.end;
      const [s0, s1] = sentenceAround(typed, at, end);
      const own = typed.slice(s0, s1);
      return { typed: own, edited: own.slice(0, at - s0) + h.to + own.slice(end - s0), from: h.from, to: h.to, at: at - s0, known: knownFor(lexicon, h.from, h.to) };
    });
}

/** Where the sentence holding `at`–`end` starts and ends in `text`, with the
 *  sentence before it (else after it) when it has fewer than four words. */
function sentenceAround(text: string, at: number, end: number): [number, number] {
  const starts = [0, ...[...text.matchAll(/[.!?]+["'”’)\]]*\s+/gu)].map((m) => m.index! + m[0].length).filter((i) => i < text.length)];
  let i = starts.filter((s) => s <= at).length - 1, j = starts.filter((s) => s < end).length;
  const stop = () => starts[j] ?? text.length;
  if (tokens(text.slice(starts[i]!, stop())).length < 4) {
    if (i > 0) i--;
    else if (j < starts.length) j++;
  }
  return [starts[i]!, text.slice(0, stop()).trimEnd().length];
}

/** What an edit teaches: each change the fixer judges a mishearing, as a
 *  mapping, or as a term alone when dictation's text is a code of its own
 *  ("PH" → "P8": `term`). Either way the rewrite applies it only where the
 *  sentence reads likelier with it. Never,
 *  whatever the fixer says: a pair the user undid, a word turned off for
 *  dictation, or dictation's text when it is already a vocabulary word ("BTC"
 *  → "Bitcoin": two forms of one thing; "PH" → "P8": learning it would
 *  rewrite real uses of PH). */
export async function mishearings(typed: string, edited: string, lexicon: Lexicon, fixer: Fixer): Promise<Mishearing[]> {
  const qs = questions(typed, edited, lexicon);
  if (!qs.length) return [];
  const d = await fixer.judge(qs);
  const yes = qs.map((_, i) => (d[i] ?? -Infinity) > fixer.learnMargin);
  // What the judge turns down although it is the same spoken word: a name,
  // product or term spelled its own way where dictation wrote a real word
  // ("stadium" → "Stadeum", "peel" → "Peel") or a code a digit off ("PH" →
  // "P8"). Learned when the user's word is a name in the edited sentence and,
  // unless a code is involved, dictation's is an everyday word: asked of the word alone
  // and in lower case, so dictation's casing ("a product called Stadium") does
  // not make it a name, and "jon" → "Jen", a different person, is not
  // learned. The rewrite still decides each sentence.
  const alike = qs.flatMap((q, i) => (!yes[i] && sameWord(q) ? [i] : []));
  if (alike.length) {
    // A code on either side ("PH" → "P8", "p eight" → "P8") is no person renamed: only the user's word is asked.
    const words = alike.filter((i) => !isCode(qs[i]!.from) && !isCode(qs[i]!.to));
    const [n, e] = await Promise.all([
      fixer.named(alike.map((i) => ({ text: qs[i]!.edited, word: qs[i]!.to }))),
      words.length ? fixer.everyday(words.map((i) => qs[i]!.from.toLowerCase())) : Promise.resolve([]),
    ]);
    alike.forEach((i, k) => {
      const j = words.indexOf(i);
      yes[i] = (n[k] ?? -Infinity) > 0 && (j < 0 || (e[j] ?? -Infinity) > EVERYDAY_MARGIN);
    });
  }
  return qs
    .filter((_, i) => yes[i])
    .map((q): Mishearing => ({ heard: q.from, written: q.to, ...(isCode(q.from) ? { term: true as const } : {}) }))
    .filter((p) => !wasUndone(lexicon, p.heard, p.written) && !entryWriting(lexicon, p.written)?.dictationOff && !entryWriting(lexicon, p.heard));
}

/** How surely (in nats) dictation's word must read as an everyday word for a
 *  same-sounding change to be learned: on the 1.7B "stadium", "peel", "hive"
 *  read so by 17 to 22, first names ("jon", "michael", "catherine") as names
 *  by 7 to 16. */
const EVERYDAY_MARGIN = 2;

/** The same spoken word written another way: the same sound key (a casing
 *  change too, unless it begins a sentence), or a code a digit off. */
function sameWord(q: JudgeQuestion): boolean {
  if (nearCode(q.from, letters(q.from), q.to, letters(q.to))) return true;
  if (soundKey(q.from) !== soundKey(q.to)) return false;
  if (letters(q.from) !== letters(q.to)) return true;
  const at = find(q.edited, q.to);
  return at > 0 && !SENTENCE_START.test(q.edited.slice(0, at));
}

/** The lexicon entries a change touches, as the judge's prompt names them:
 *  so "BTC" → "Bitcoin" reads as one thing, and an off word as off. */
export function knownFor(lexicon: Lexicon, from: string, to: string): string {
  const near = (s: string, e: LexiconEntry) => !!s && [...e.written, ...e.heard.map((h) => h.value)].some((w) => letters(w) === letters(s));
  return lexicon.entries.filter((e) => near(from, e) || near(to, e))
    .map((e) => `${e.written.join(", ")}${e.written.length > 1 ? " (same thing)" : ""}${e.dictationOff ? " (turned off for dictation)" : ""}`)
    .join("; ");
}

// ── The rewrite ─────────────────────────────────────────────────────────────

/** An edit of a transcript: `from` at offset `at` becomes `to`. The offset
 *  matters: `from` alone is ambiguous when a word repeats. */
export interface Edit {
  from: string;
  to: string;
  at: number;
}

/** A span of the transcript that may be a vocabulary word. */
export interface Candidate {
  span: string;
  at: number;
  written: string;
  type: string;
  /** The span is a mishearing the user taught, exactly. */
  heardBefore: boolean;
}

/** What dictation's text becomes with the fixer: vocabulary words where the
 *  model reads them likelier (by more than `margin` nats), fillers, doubled
 *  words and taken-back phrases removed. `changes` lists every edit, in order. */
export async function rewrite(text: string, lexicon: Lexicon, fixer: Fixer, margin = 0): Promise<{ text: string; changes: Change[] }> {
  // Each candidate in up to three readings: with the word, as heard, and as
  // heard with the span's own capitals (so "tory" in lower case is no
  // evidence for Tauri). All start with a capital, so "Peel the oranges" is
  // no evidence for Peel.
  const readings = recall(text, lexicon).map((c) => {
    const edit = { from: c.span, to: c.written, at: c.at };
    const heard = [text];
    if (letters(c.span) !== letters(c.written)) heard.push(applyEdits(text, [{ ...edit, to: titleCase(c.span) }]));
    return {
      edit, sameSound: sameSound(c.span, c.written),
      sentences: [applyEdits(text, [edit]), ...heard].map((s) => ({ name: c.written, type: c.type, text: capitalised(s) })),
    };
  });
  const scores = readings.length ? await fixer.score(readings.flatMap((r) => r.sentences)) : [];
  let k = 0;
  const scored: (Edit & { d: number })[] = [];
  for (const r of readings) {
    const s = scores.slice(k, (k += r.sentences.length));
    const d = (s[0] ?? -Infinity) - Math.max(...s.slice(1));
    if (d > margin + (r.sameSound ? SAME_SOUND_MARGIN : 0)) scored.push({ ...r.edit, d });
  }
  // Where two words claim the same span, the likelier.
  const vocab: Edit[] = scored.filter((x) => !scored.some((y) => y !== x && overlap(x, y) && y.d > x.d)).map(({ d: _, ...e }) => e);
  const removals = fillers(text);
  if (TAKE_BACK.test(text)) {
    for (const r of await fixer.retract(text)) {
      const e = retraction(text, r.wrong, r.cue);
      if (e) removals.push(e);
    }
  }
  return finish(text, [...removals, ...vocab]);
}

/** How much likelier (in nats) a sentence must read with a vocabulary word
 *  than as heard when the heard text is an ordinary word that sounds just
 *  like it ("stadium" for Stadeum, "tory" for Tauri). The sound is then no
 *  evidence either way and the scoring line, which names the word, favours
 *  it: on the 1.7B "we watched the game at the stadium" reads 3.9 nats
 *  likelier as Stadeum, "open it in stadium" 5.8 to 7.5. */
export const SAME_SOUND_MARGIN = 5;

/** Heard in lower case (an ordinary word, not a name dictation already
 *  capitalised), spelled otherwise, with the same sound key. */
function sameSound(span: string, written: string): boolean {
  return !UPPER.test(span) && letters(span) !== letters(written) && soundKey(span) === soundKey(written);
}

/** With no fixer: fillers and doubled words by rule, and what the user
 *  taught, exactly — a learned `heard` value of two or more words, as whole
 *  words, never across punctuation, the longest first. A one-word mishearing
 *  ("fix" for Sphinx) is an everyday word elsewhere: only the fixer, reading
 *  the sentence, can tell, so without it it is left as heard. */
export function heardOnly(text: string, lexicon: Lexicon): { text: string; changes: Change[] } {
  const toks = tokens(text);
  const pairs = lexicon.entries.filter((e) => !e.dictationOff)
    .flatMap((e) => e.heard.map((h) => ({ keys: tokens(h.value).map((t) => t.core.toLowerCase()), written: h.form ?? e.name })))
    // One word needs the fixer's check in context; none ("&") would match every bare mark.
    .filter((p) => p.keys.length >= 2)
    .sort((a, b) => b.keys.length - a.keys.length);
  const edits: Edit[] = [];
  for (let i = 0; i < toks.length; i++) {
    const p = pairs.find((p) => i + p.keys.length <= toks.length && p.keys.every((key, j) => toks[i + j]!.core.toLowerCase() === key) && contiguous(toks, i, p.keys.length));
    if (!p) continue;
    const from = text.slice(toks[i]!.start, toks[i + p.keys.length - 1]!.end);
    if (from !== p.written) edits.push({ from, to: p.written, at: toks[i]!.start });
    i += p.keys.length - 1;
  }
  const removals = fillers(text);
  // Spacing is tidied only after a removal; a replacement alone leaves the text as it was around it.
  return finish(text, [...removals, ...edits], removals.length > 0);
}

/** Applies the edits that do not overlap an earlier one; the changes in text
 *  order. A removal leaves spacing and punctuation to tidy. */
function finish(text: string, all: Edit[], tidying = true): { text: string; changes: Change[] } {
  const edits = all.filter((x, i) => !all.slice(0, i).some((y) => overlap(x, y))).sort((a, b) => a.at - b.at);
  if (!edits.length) return { text, changes: [] };
  return { text: applyEdits(text, edits, tidying), changes: edits.map((e) => ({ heard: e.from, written: e.to, at: e.at })) };
}

// ── Recall: candidate vocabulary spans in a transcript ─────────────────────

const MAX_CANDIDATES = 8;

/** Fuzzy + sound-alike match of the transcript's 1–3-word spans against
 *  every entry's heard values and written forms (not one turned off). It
 *  finds; it never decides. Where spans for one word overlap, the better
 *  match wins (an exact past mishearing, then the same letters or sounds,
 *  then near), then the shortest ("stack work", not "the stack work"). */
export function recall(text: string, lexicon: Lexicon): Candidate[] {
  const toks = tokens(text);
  // Each key's forms once, not once per span: the lexicon is every entity the memory knows.
  const keys: { key: string; written: string; heard: boolean; type: string; lk: string; kk: string; said: string }[] = [];
  const key = (k: string, written: string, heard: boolean, type: string) =>
    keys.push({ key: k.toLowerCase(), written, heard, type, lk: letters(k), kk: soundKey(k), said: spoken(k) });
  for (const e of lexicon.entries) {
    if (e.dictationOff) continue;
    for (const w of e.written) key(w, w, false, e.type);
    for (const h of e.heard) key(h.value, h.form ?? e.name, true, e.type);
  }
  const found: (Candidate & { score: number })[] = [];
  for (let i = 0; i < toks.length; i++) {
    for (let n = 1; n <= 3 && i + n <= toks.length; n++) {
      // Not across punctuation: "a stack. Work" is not "stack work".
      if (!contiguous(toks, i, n)) break;
      const span = text.slice(toks[i]!.start, toks[i + n - 1]!.end);
      const ls = letters(span);
      if (ls.length < 2) continue;
      const lower = span.toLowerCase(), sk = soundKey(span), said = spoken(span);
      // A written form with a plural or possessive ending ("Stakwork's") is that word, already right.
      const stem = lower.replace(/['’]?s$/, "");
      for (const k of keys) {
        if (span === k.written || (stem !== lower && stem === k.written.toLowerCase())) continue;
        const { lk, kk } = k;
        const long = Math.max(ls.length, lk.length);
        // 3: heard exactly so before; 2: the same letters or sounds; 1: near.
        const score =
          k.heard && lower === k.key ? 3
          : ls === lk || (sk.length >= 3 && sk === kk) || (said === k.said && said.includes(" ")) ? 2
          : (long >= 6 && distance(ls, lk) * 4 <= long) || (sk.length >= 6 && distance(sk, kk) <= 1) || (!k.heard && nearCode(span, ls, k.written, lk)) ? 1
          : 0;
        if (!score) continue;
        const at = toks[i]!.start;
        const seen = found.find((f) => f.at === at && f.span === span && f.written === k.written);
        if (seen) (seen.score = Math.max(seen.score, score)), (seen.heardBefore ||= score === 3);
        else found.push({ span, at, written: k.written, type: k.type, heardBefore: score === 3, score });
      }
    }
  }
  const better = (g: { score: number; span: string }, f: { score: number; span: string }) => g.score > f.score || (g.score === f.score && g.span.length < f.span.length);
  return found
    .filter((f) => !found.some((g) => g !== f && g.written === f.written && overlap(g, f) && better(g, f)))
    .slice(0, MAX_CANDIDATES)
    .map(({ score: _, ...c }) => c);
}

/** Two codes of the same length one character apart, a letter for a digit
 *  ("PH" or "P H" for P8, "AC" for A6): dictation writes a digit's name as a
 *  letter that sounds like it. Not two letters ("API" is not "KPI"). */
function nearCode(span: string, ls: string, written: string, lk: string): boolean {
  if (ls.length < 2 || ls.length > 5 || ls.length !== lk.length || !codeLike(span) || !codeLike(written)) return false;
  const off = [...ls].flatMap((c, i) => (c === lk[i] ? [] : [[c, lk[i]!]]));
  return off.length === 1 && NUMBER.test(off[0]![0]!) !== NUMBER.test(off[0]![1]!);
}

/** Each word a single character or holding a capital or a digit: "PH", "P H", "pH", "P8"; not "an". */
function codeLike(text: string): boolean {
  return tokens(text).every((t) => [...t.core].length === 1 || UPPER.test(t.core) || NUMBER.test(t.core));
}

// ── Removals: fillers, doubled words, a phrase taken back ──────────────────

const FILLERS = new Set(["um", "uh", "er", "erm", "uhm", "umm", "uhh", "hmm"]);
/** Words a speaker can mean twice: "I know that that is", "she had had". */
const DOUBLE_OK = new Set(["that", "had", "is", "do", "very", "really", "so", "no", "bye"]);

/** Fillers, with the commas that set them off ("is, um, really" → "is
 *  really"; "the plan, um." → "the plan."), and the first of a word said
 *  twice in a row. */
export function fillers(text: string): Edit[] {
  const toks = tokens(text);
  const out: Edit[] = [];
  toks.forEach((t, i) => {
    const key = t.core.toLowerCase();
    if (FILLERS.has(key)) {
      // A comma after it goes with it; a sentence's end stays. A comma before
      // goes too, unless a filler before it already took it ("um, uh, so").
      const prev = toks[i - 1];
      const at = prev?.trail === "," && !t.lead && !FILLERS.has(prev.core.toLowerCase()) ? prev.end : t.start;
      const end = t.end + (/^[,;:]*$/.test(t.trail) ? t.trail.length : 0);
      out.push({ from: text.slice(at, end), to: "", at });
    } else if (i + 1 < toks.length && toks[i + 1]!.core.toLowerCase() === key && !t.trail && !toks[i + 1]!.lead && !DOUBLE_OK.has(key)) out.push({ from: t.core, to: "", at: t.start });
  });
  return out;
}

/** A phrase that may take back what came before it: only then is the fixer asked. */
export const TAKE_BACK = /(?:,|\b)\s*(?:no|sorry|I mean|actually|wait|or rather|scratch that)\s*,?\s/i;

/** The span a take-back removes: from the wrong words through the cue and
 *  the punctuation after it; null unless the cue follows the wrong words
 *  with only punctuation and spaces between. */
export function retraction(text: string, wrong: string, cue: string): Edit | null {
  wrong = wrong.trim();
  cue = cue.trim();
  if (!wrong || !cue) return null;
  const at = find(text, wrong);
  if (at < 0) return null;
  const rest = text.slice(at + wrong.length);
  const c = find(rest, cue);
  if (c < 0 || /[\p{L}\p{N}]/u.test(rest.slice(0, c))) return null;
  let end = at + wrong.length + c + cue.length;
  while (end < text.length && /[,;:.!?]/.test(text[end]!)) end++;
  return { from: text.slice(at, end), to: "", at };
}

// ── Applying edits ──────────────────────────────────────────────────────────

/** Applies edits at their offsets in `text` (right to left, so each offset
 *  holds), then tidies the spacing and punctuation a removal leaves. A
 *  removal that began a sentence (at the start, or after . ? !) leaves the
 *  word after it to begin it: "team? Um, about" → "team? About". */
export function applyEdits(text: string, edits: Edit[], tidying = true): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.at - a.at)) {
    // Right to left: what precedes `e.at` is still the text as heard.
    const before = out.slice(0, e.at), after = out.slice(e.at + e.from.length);
    out = before + e.to + (!e.to && SENTENCE_START.test(before) ? capitalisedWord(after) : after);
  }
  return tidying ? tidy(out) : out;
}

/** The text before a sentence's first word: nothing, or an end mark, then space or an opening quote. */
const SENTENCE_START = /(?:^|[.!?])[\s"'“‘(]*$/u;

/** `t` with its first word capitalised when it is all lower case ("about";
 *  not "iPhone", not "3"). */
function capitalisedWord(t: string): string {
  return t.replace(/^([^\p{L}\p{N}]*)(\p{Ll})(\S*)/u, (all, lead: string, first: string, rest: string) => (/\p{Lu}/u.test(rest) ? all : lead + first.toUpperCase() + rest));
}

function tidy(out: string): string {
  return out.replace(/[ \t]+/g, " ").replace(/\s+([,.!?;:])/g, "$1").replace(/([,;:])(?:\s*[,;:])+/g, "$1").replace(/([,;:])([.!?])/g, "$2").replace(/^[\s,;:]+/, "").trim();
}

const width = (x: { from?: string; span?: string }) => (x.from ?? x.span ?? "").length;
const overlap = (x: { at: number; from?: string; span?: string }, y: { at: number; from?: string; span?: string }) =>
  x.at < y.at + width(y) && y.at < x.at + width(x);
const capitalised = (t: string) => t.replace(/\p{L}/u, (ch) => ch.toUpperCase());
const titleCase = (t: string) => t.replace(/\p{L}+/gu, (w) => w[0]!.toUpperCase() + w.slice(1));
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where `needle` occurs in `text` as whole words, case-insensitively. */
function find(text: string, needle: string): number {
  const m = new RegExp(`(?<![\\p{L}\\p{N}])${esc(needle)}(?![\\p{L}\\p{N}])`, "iu").exec(text);
  return m ? m.index : -1;
}

// ── Sounding alike ──────────────────────────────────────────────────────────

const LETTER_NAMES: Record<string, string> = {
  a: "ay", b: "bee", c: "see", d: "dee", e: "ee", f: "eff", g: "gee", h: "aitch", i: "eye", j: "jay", k: "kay", l: "el", m: "em",
  n: "en", o: "oh", p: "pee", q: "cue", r: "ar", s: "ess", t: "tee", u: "you", v: "vee", w: "double you", x: "ex", y: "why", z: "zed",
};
const DIGIT_NAMES: Record<string, string> = { 0: "zero", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine" };

/** How it is said: the letters and digits of a code by name ("P8" → "pee eight"), words as they are. */
export function spoken(text: string): string {
  return tokens(text).flatMap((t) => {
    if (!spelt(t.core)) return [t.core.toLowerCase()];
    return [...t.core].map((c) => c.toLowerCase()).map((c) => DIGIT_NAMES[c] ?? LETTER_NAMES[c] ?? c);
  }).join(" ");
}

/** Said letter by letter: one character, anything with a digit, or up to five capitals. */
function spelt(word: string): boolean {
  const core = [...word];
  return core.length === 1 || core.some((c) => NUMBER.test(c)) || (core.length <= 5 && core.every((c) => UPPER.test(c) || NUMBER.test(c)));
}

/** One word of two or more characters said letter by letter: a code ("PH", "P8"). */
export function isCode(text: string): boolean {
  const t = tokens(text);
  return t.length === 1 && [...t[0]!.core].length >= 2 && spelt(t[0]!.core);
}

/** A crude sound key: the consonant skeleton after common spelling merges ("stack work", "Stakwork" → stkwrk). */
export function soundKey(text: string): string {
  let s = letters(text).replace(/\d/g, (d) => DIGIT_NAMES[d] ?? d);
  if (!s) return "";
  s = s.replace(/ph/g, "f").replace(/ck/g, "k").replace(/c(?=[eiy])/g, "s").replace(/c/g, "k").replace(/q/g, "k").replace(/x/g, "ks").replace(/z/g, "s").replace(/gh/g, "");
  s = s[0] + s.slice(1).replace(/[aeiouyhw]/g, "");
  return s.replace(/(.)\1+/g, "$1");
}

/** Whether two spellings could be one sound: their letters, sound keys or
 *  spelled-out sounds within 40% of each other. Lenient: it gates what the
 *  fixer is asked; it decides nothing. */
export function soundsAlike(a: string, b: string): boolean {
  const near = (x: string, y: string) => !!x && !!y && distance(x, y) <= 0.4 * Math.max(x.length, y.length);
  const forms = (t: string) => [letters(t), soundKey(t), letters(spoken(t)), soundKey(spoken(t))];
  const fa = forms(a), fb = forms(b);
  return fa.some((x) => fb.some((y) => near(x, y)));
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

// ── Diffing ─────────────────────────────────────────────────────────────────

/** One run of changed words: `from` in the first text, `to` in the second. */
export interface Hunk {
  from: string;
  to: string;
  /** The run's token range in the first text. */
  a: [number, number];
}

/** Word-level differences between two texts, punctuation aside, compared as
 *  written (a casing fix is a change). */
export function hunks(from: string, to: string): Hunk[] {
  const a = tokens(from).map((t) => t.core), b = tokens(to).map((t) => t.core);
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const out: Hunk[] = [];
  let i = 0, j = 0, ai = -1, bj = -1;
  const close = () => {
    if (ai >= 0) out.push({ from: a.slice(ai, i).join(" "), to: b.slice(bj, j).join(" "), a: [ai, i] });
    ai = bj = -1;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      close();
      i++;
      j++;
    } else {
      if (ai < 0) (ai = i), (bj = j);
      if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) j++;
      else i++;
    }
  }
  close();
  return out;
}

// ── Text as words ───────────────────────────────────────────────────────────

// Marks too: a vowel sign or accent belongs to its letter.
const PART = /[\p{L}\p{M}\p{N}]/u;
const UPPER = /\p{Lu}/u;
const NUMBER = /\p{N}/u;
const isPart = (c: string) => PART.test(c);

/** A word of a text: its core (from its first letter or digit to its last)
 *  at `start`–`end`, and the punctuation around it. */
interface Token {
  core: string;
  start: number;
  end: number;
  lead: string;
  trail: string;
}

/** The whitespace-separated words of a text that hold a letter or digit. */
function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const chars = [...m[0]];
    const first = chars.findIndex(isPart);
    if (first < 0) continue;
    let last = chars.length - 1;
    while (!isPart(chars[last]!)) last--;
    const lead = chars.slice(0, first).join(""), core = chars.slice(first, last + 1).join("");
    const start = m.index! + lead.length;
    out.push({ core, start, end: start + core.length, lead, trail: chars.slice(last + 1).join("") });
  }
  return out;
}

/** Whether `n` tokens from `i` run on without punctuation between them. */
function contiguous(toks: Token[], i: number, n: number): boolean {
  for (let k = i; k < i + n - 1; k++) if (toks[k]!.trail || toks[k + 1]!.lead) return false;
  return true;
}

// ── Strut's memory steps ────────────────────────────────────────────────────

/** memory/remember's input for one mishearing: `heard` is how dictation
 *  mishears `written`, on the entity that writes it, or on a new word of the
 *  lingo type when none does. Only the pair is said, never the sentence it
 *  was in. A `term` learn writes only the new word, with no mapping; null
 *  when the vocabulary already writes it. */
export function learnInput(heard: string, written: string, lexicon: Lexicon, term = false): Record<string, unknown> | null {
  const entry = entryWriting(lexicon, written);
  if (term) {
    if (entry) return null;
    if (!lexicon.lingoType) throw new Error("the memory has no entity type with role dictation for a new word");
    return { episode: `Dictation: corrected “${heard}” to “${written}”.`, kind: "note", created_by: "dictation", mentions: [{ type: lexicon.lingoType, name: written }] };
  }
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
