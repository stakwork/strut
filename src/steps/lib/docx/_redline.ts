// Edits into a .docx as real tracked changes (docx/redline). Each edit's
// `find` is looked up in the body's paragraphs — the text Word shows, so a
// match may cross runs, links and content controls — and its difference from
// `replace` goes in word by word: the words that change become a `w:del`
// and a `w:ins` (author, date), the words that stay are left as they were,
// formatting and all. A reason (and its sources) becomes a Word comment on
// the edited text. What cannot be placed — not found, more than one match,
// inside someone's tracked change or a field — is reported, and nothing of
// that edit is written.

import { posix } from "node:path";
import { COMMENTS_TYPE, Docx, REL_COMMENTS, W_NS } from "./_docx.js";
import { attr, child, children, clone, el, isEl, parseXml, rootOf, textOf, type XEl, type XNode } from "./_xml.js";

export type RedlineSource = string | { title?: string; url?: string; ref_id?: string; quote?: string };

export interface RedlineEdit {
  find: string;
  /** Omitted (or equal to `find`): a comment on the text, no change. */
  replace?: string;
  reason?: string;
  sources?: RedlineSource[];
  /** Text the paragraph holding the match contains, to pick one of several. */
  paragraph?: string;
  /** Every match, not just one (a defined term renamed throughout). */
  all?: boolean;
}

export interface RedlineResult {
  index: number;
  find: string;
  status: "applied" | "unplaced";
  /** Matches changed (or commented). */
  count: number;
  /** `normalized`: found once curly quotes, dashes and no-break spaces were read as plain ones. */
  matched?: "exact" | "normalized";
  /** Why it was not placed. */
  reason?: string;
  /** Where the text was seen: the paragraphs of an ambiguous match, or a near miss. */
  candidates?: string[];
  /** With `all`: matches that could not be changed, and why. */
  skipped?: string[];
  comment?: boolean;
}

// ── the paragraph's text, run by run ─────────────────────────────────────────

/** A piece of a run's content: text (`w:t`, split anywhere), one character
 *  (`w:tab`, `w:br`), or nothing (a field mark, a note reference, a picture). */
interface Seg {
  kid: XEl;
  start: number;
  len: number;
  kind: "text" | "char" | "zero";
  /** A zero-width piece that may sit inside deleted text (a soft hyphen). */
  harmless?: boolean;
}

interface RunInfo {
  run: XEl;
  parent: XEl;
  start: number;
  text: string;
  segs: Seg[];
  locked?: string;
}

const HARMLESS = new Set(["w:softHyphen", "w:lastRenderedPageBreak"]);

function runSegs(run: XEl): { text: string; segs: Seg[]; fields: number[] } {
  let text = "";
  const segs: Seg[] = [];
  const fields: number[] = [];
  for (const k of run.kids) {
    if (!isEl(k) || k.name === "w:rPr") continue;
    const start = text.length;
    let piece = "";
    let kind: Seg["kind"] = "zero";
    if (k.name === "w:t") (piece = textOf(k)), (kind = "text");
    else if (k.name === "w:tab" || k.name === "w:ptab") (piece = "\t"), (kind = "char");
    else if ((k.name === "w:br" || k.name === "w:cr") && !/^(page|column)$/.test(attr(k, "w:type") ?? "")) (piece = "\n"), (kind = "char");
    else if (k.name === "w:noBreakHyphen") (piece = "‑"), (kind = "char");
    else if (k.name === "w:fldChar") fields.push(attr(k, "w:fldCharType") === "begin" ? 1 : attr(k, "w:fldCharType") === "end" ? -1 : 0);
    text += piece;
    segs.push({ kid: k, start, len: piece.length, kind, ...(HARMLESS.has(k.name) ? { harmless: true } : {}) });
  }
  return { text, segs, fields };
}

/** The paragraph's text as Word shows it (tracked deletions left out), and
 *  where each run's part of it is. `depth`: the complex fields open where
 *  it starts (a table of contents spans paragraphs). */
function paragraphRuns(p: XEl, depthIn = 0): { text: string; runs: RunInfo[]; depth: number } {
  const runs: RunInfo[] = [];
  let text = "";
  let depth = depthIn;
  const walk = (parent: XEl, locked?: string) => {
    for (const k of parent.kids) {
      if (!isEl(k)) continue;
      if (k.name === "w:r") {
        const info = runSegs(k);
        let inField = depth > 0;
        for (const f of info.fields) (depth = Math.max(0, depth + f)), (inField ||= depth > 0);
        const why = locked ?? (inField ? "inside a field" : undefined);
        runs.push({ run: k, parent, start: text.length, text: info.text, segs: info.segs, ...(why ? { locked: why } : {}) });
        text += info.text;
      } else if (k.name === "w:ins" || k.name === "w:moveTo") walk(k, locked ?? "inside a tracked change already in the document");
      else if (k.name === "w:fldSimple") walk(k, locked ?? "inside a field");
      else if (k.name === "w:sdt") {
        const content = child(k, "w:sdtContent");
        if (content) walk(content, locked);
      } else if (["w:hyperlink", "w:smartTag", "w:customXml", "w:dir", "w:bdo"].includes(k.name)) walk(k, locked);
    }
  };
  walk(p);
  return { text, runs, depth };
}

/** Every paragraph of the body, tables and content controls included. */
function bodyParagraphs(body: XEl): XEl[] {
  const out: XEl[] = [];
  const walk = (e: XEl) => {
    for (const k of e.kids) {
      if (!isEl(k)) continue;
      if (k.name === "w:p") out.push(k);
      else if (["w:tbl", "w:tr", "w:tc", "w:sdt", "w:sdtContent", "w:customXml"].includes(k.name)) walk(k);
    }
  };
  walk(body);
  return out;
}

// ── matching ─────────────────────────────────────────────────────────────────

/** Curly quotes, dashes and odd spaces as plain ones — one character for one,
 *  so positions in the normalized text are positions in the original. */
export function normalize(s: string): string {
  return s
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[   ]/g, " ")
    .replace(/[‐‑‒–—−]/g, "-");
}

function indexesOf(hay: string, needle: string): number[] {
  const out: number[] = [];
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) out.push(at);
  return out;
}

function snippet(text: string, at: number, len: number): string {
  const from = Math.max(0, at - 40);
  const to = Math.min(text.length, at + len + 40);
  return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`.replace(/\s+/g, " ");
}

// ── the word-level difference ────────────────────────────────────────────────

/** A change in the matched text: [start, end) deleted (empty: none), `insert` put in its place. */
interface Change {
  start: number;
  end: number;
  insert: string;
}

/** Words (with their apostrophes and hyphens), numbers (with their
 *  decimal points and thousands separators: "1.5", "40,000"), runs of
 *  space, and single marks. */
const tokens = (s: string) => s.match(/\s+|\p{N}+(?:[.,]\p{N}+)*|[\p{L}\p{N}_]+(?:['’‑-][\p{L}\p{N}_]+)*|\S/gu) ?? [];

/** `from` → `to` as the fewest changes of whole words; words equal once
 *  normalized (a curly quote for a straight one) count as unchanged. Changes
 *  with only spaces and punctuation between them are one change, so
 *  "thirty (30)" → "sixty (60)" reads as one deletion and one insertion. */
export function wordChanges(from: string, to: string): Change[] {
  const a = tokens(from);
  const b = tokens(to);
  const eq = (x: string, y: string) => normalize(x) === normalize(y);
  // Equal tokens trimmed off both ends, the longest common subsequence of
  // what is left (or, past a size, all of it changed).
  type Op = "eq" | "del" | "ins";
  const ops: [Op, string][] = [];
  let lo = 0;
  while (lo < a.length && lo < b.length && eq(a[lo]!, b[lo]!)) ops.push(["eq", a[lo++]!]);
  let ha = a.length;
  let hb = b.length;
  const tail: [Op, string][] = [];
  while (ha > lo && hb > lo && eq(a[ha - 1]!, b[hb - 1]!)) (tail.unshift(["eq", a[--ha]!]), hb--);
  const n = ha - lo;
  const m = hb - lo;
  if (n * m <= 250_000) {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i]![j] = eq(a[lo + i]!, b[lo + j]!) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    for (let i = 0, j = 0; i < n || j < m; ) {
      if (i < n && j < m && eq(a[lo + i]!, b[lo + j]!)) (ops.push(["eq", a[lo + i]!]), i++, j++);
      else if (j < m && (i === n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) ops.push(["ins", b[lo + j++]!]);
      else ops.push(["del", a[lo + i++]!]);
    }
  } else {
    for (let i = lo; i < ha; i++) ops.push(["del", a[i]!]);
    for (let j = lo; j < hb; j++) ops.push(["ins", b[j]!]);
  }
  ops.push(...tail);

  // The ops as spans of both texts, then spans a wordless gap apart joined.
  const spans: { start: number; end: number; bStart: number; bEnd: number }[] = [];
  let pa = 0;
  let pb = 0;
  let open = false;
  for (const [op, tok] of ops) {
    if (op === "eq") {
      // An equal token's length on the `to` side: normalize keeps lengths.
      (pa += tok.length), (pb += tok.length), (open = false);
      continue;
    }
    if (!open) spans.push({ start: pa, end: pa, bStart: pb, bEnd: pb });
    open = true;
    const s = spans[spans.length - 1]!;
    if (op === "del") (pa += tok.length), (s.end = pa);
    else (pb += tok.length), (s.bEnd = pb);
  }
  const joined: typeof spans = [];
  for (const s of spans) {
    const last = joined[joined.length - 1];
    if (last && !/[\p{L}\p{N}]/u.test(from.slice(last.end, s.start))) (last.end = s.end), (last.bEnd = s.bEnd);
    else joined.push({ ...s });
  }
  // A replacement takes the brackets, quotes and signs stuck to it: "(30)"
  // → "(60)", "$40,000" → "$35,000", not the digits alone (a full stop or
  // comma stays). The text around it is equal on both sides, one character
  // for one.
  const opens = (c: string | undefined) => !!c && /[([{“‘"'$€£¥#]/.test(c);
  const closes = (c: string | undefined) => !!c && /[)\]}”’"'%]/.test(c);
  joined.forEach((s, k) => {
    if (s.end === s.start || s.bEnd === s.bStart) return;
    const prevEnd = joined[k - 1]?.end ?? 0;
    const nextStart = joined[k + 1]?.start ?? from.length;
    while (s.start > prevEnd && opens(from[s.start - 1])) (s.start--, s.bStart--);
    while (s.end < nextStart && closes(from[s.end])) (s.end++, s.bEnd++);
  });
  return joined.map((s) => ({ start: s.start, end: s.end, insert: to.slice(s.bStart, s.bEnd) }));
}

// ── writing the changes ──────────────────────────────────────────────────────

interface Stamp {
  author: string;
  date: string;
  nextId: () => string;
}

const textEl = (text: string) => el("w:t", { "xml:space": "preserve" }, [text]);

/** Run content for new text: tabs and line breaks as Word writes them. */
function contentFor(text: string): XEl[] {
  return text
    .split(/(\t|\n)/)
    .filter(Boolean)
    .map((piece) => (piece === "\t" ? el("w:tab") : piece === "\n" ? el("w:br") : textEl(piece)));
}

/** A run's properties for a copy: a tracked formatting change stays with
 *  the original only (its id must not repeat). */
function rPrFor(run: XEl, keepChange: boolean): XEl | undefined {
  const rPr = child(run, "w:rPr");
  if (!rPr) return undefined;
  const copy = clone(rPr);
  if (!keepChange) copy.kids = copy.kids.filter((k) => !(isEl(k) && k.name === "w:rPrChange"));
  return copy;
}

/** A run cut at [a, b) of its text: what is before, inside and after. */
function splitRun(info: RunInfo, a: number, b: number): { before?: XEl; middle?: XEl; after?: XEl } {
  const parts: Record<"before" | "middle" | "after", XNode[]> = { before: [], middle: [], after: [] };
  for (const s of info.segs) {
    if (s.kind === "text") {
      const t = textOf(s.kid);
      const end = s.start + s.len;
      const pieces: ["before" | "middle" | "after", number, number][] = [
        ["before", s.start, Math.min(end, a)],
        ["middle", Math.max(s.start, a), Math.min(end, b)],
        ["after", Math.max(s.start, b), end],
      ];
      for (const [side, from, to] of pieces) if (to > from) parts[side].push(textEl(t.slice(from - s.start, to - s.start)));
      if (s.len === 0) parts[s.start <= a ? "before" : "after"].push(clone(s.kid));
    } else if (s.kind === "char") {
      parts[s.start < a ? "before" : s.start >= b ? "after" : "middle"].push(clone(s.kid));
    } else {
      parts[s.start <= a ? "before" : s.start >= b ? "after" : "middle"].push(clone(s.kid));
    }
  }
  const out: { before?: XEl; middle?: XEl; after?: XEl } = {};
  let first = true;
  for (const side of ["before", "middle", "after"] as const) {
    if (!parts[side].length) continue;
    const rPr = rPrFor(info.run, first);
    out[side] = { name: "w:r", attrs: info.run.attrs.map((x) => ({ ...x })), kids: [...(rPr ? [rPr] : []), ...parts[side]] };
    first = false;
  }
  return out;
}

/** A run's text as deleted text (`w:delText`), as a `w:del` holds it. */
function asDeleted(run: XEl): XEl {
  for (const k of run.kids) if (isEl(k) && k.name === "w:t") k.name = "w:delText";
  return run;
}

function replaceKid(parent: XEl, old: XEl, by: XEl[]): void {
  const at = parent.kids.indexOf(old);
  parent.kids.splice(at, 1, ...by);
}

function insertAt(parent: XEl, ref: XEl, nodes: XEl[], after: boolean): void {
  const at = parent.kids.indexOf(ref);
  parent.kids.splice(after ? at + 1 : at, 0, ...nodes);
}

/** The run new text at `at` joins: the one holding the character before
 *  it — unless that one ends there inside a link or a content control the
 *  next one is not in, so "Schedule A" + " (attached)" stays out of the link. */
function insertionRun(runs: RunInfo[], at: number, p: XEl): RunInfo | undefined {
  const prev = runs.find((x) => x.text && at > x.start && at <= x.start + x.text.length);
  const next = runs.find((x) => x.text && x.start === at);
  if (prev && next && prev.start + prev.text.length === at && prev.parent !== p && prev.parent !== next.parent) return next;
  return prev ?? next;
}

/** Why [start, end) of the paragraph cannot take a change, or null. */
function refusal(p: XEl, runs: RunInfo[], start: number, end: number): string | null {
  if (start === end) return insertionRun(runs, start, p)?.locked ?? null;
  for (const r of runs) {
    if (!r.text || r.start >= end || r.start + r.text.length <= start) continue;
    if (r.locked) return r.locked;
    const a = start - r.start;
    const b = end - r.start;
    if (r.segs.some((s) => s.kind === "zero" && !s.harmless && s.start > a && s.start < b)) {
      return "spans a picture, a field or a note reference";
    }
  }
  return null;
}

/** One change into the paragraph: the text in [start, end) deleted (or, with
 *  `mark`, left alone), `insert` after it. Returns the first and last element
 *  written, where a comment's range starts and ends. */
function applyChange(p: XEl, depth: number, c: Change & { mark?: boolean }, stamp: Stamp): { first: XEl; last: XEl } {
  const { runs } = paragraphRuns(p, depth);
  const track = (name: "w:ins" | "w:del", kids: XEl[]) => el(name, { "w:id": stamp.nextId(), "w:author": stamp.author, "w:date": stamp.date }, kids);
  const insertion = (from: RunInfo | undefined) => {
    const rPr = from ? rPrFor(from.run, false) : undefined;
    return track("w:ins", [el("w:r", {}, [...(rPr ? [rPr] : []), ...contentFor(c.insert)])]);
  };
  if (c.start === c.end) {
    const r = insertionRun(runs, c.start, p);
    const ins = insertion(r);
    if (!r) {
      p.kids.push(ins);
      return { first: ins, last: ins };
    }
    const local = c.start - r.start;
    const { before, after } = splitRun(r, local, local);
    replaceKid(r.parent, r.run, [...(before ? [before] : []), ins, ...(after ? [after] : [])]);
    return { first: ins, last: ins };
  }
  const hit = runs.filter((r) => r.text && r.start < c.end && r.start + r.text.length > c.start);
  let first: XEl | undefined;
  let last: XEl | undefined;
  hit.forEach((r, k) => {
    const { before, middle, after } = splitRun(r, Math.max(0, c.start - r.start), Math.min(r.text.length, c.end - r.start));
    const inner = c.mark ? middle! : track("w:del", [asDeleted(middle!)]);
    const written: XEl[] = [inner];
    if (k === hit.length - 1 && c.insert) written.push(insertion(hit[0]));
    replaceKid(r.parent, r.run, [...(before ? [before] : []), ...written, ...(after ? [after] : [])]);
    first ??= inner;
    last = written[written.length - 1];
  });
  return { first: first!, last: last! };
}

/** The parent of `node` under `root`. */
function parentOf(root: XEl, node: XEl): XEl | undefined {
  for (const k of root.kids) {
    if (!isEl(k)) continue;
    if (k === node) return root;
    const found = parentOf(k, node);
    if (found) return found;
  }
  return undefined;
}

/** `node`, or the tracked change or field around it: a comment's marks go
 *  outside someone else's revision, never into it. */
function outside(p: XEl, node: XEl): XEl {
  for (let parent = parentOf(p, node); parent && parent !== p && ["w:ins", "w:moveTo", "w:del", "w:moveFrom", "w:fldSimple"].includes(parent.name); parent = parentOf(p, node)) {
    node = parent;
  }
  return node;
}

// ── comments ─────────────────────────────────────────────────────────────────

function sourceText(s: RedlineSource): string {
  if (typeof s === "string") return s;
  return [s.title, s.quote ? `“${s.quote}”` : undefined, s.url, s.ref_id ? `ref ${s.ref_id}` : undefined].filter(Boolean).join(" — ");
}

function commentBody(edit: RedlineEdit): string[] {
  const lines: string[] = [];
  if (edit.reason?.trim()) lines.push(edit.reason.trim());
  if (edit.sources?.length) lines.push("Sources:", ...edit.sources.map((s) => `– ${sourceText(s)}`));
  return lines;
}

/** The comments part, made (and related, and typed) when the document has none. */
function commentsPart(doc: Docx): { name: string; nodes: XNode[]; root: XEl } {
  const existing = doc.related("comments");
  if (existing) {
    const nodes = doc.xml(existing)!;
    return { name: existing, nodes, root: rootOf(nodes) };
  }
  const name = posix.join(posix.dirname(doc.main), "comments.xml");
  const nodes = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="${W_NS}"/>`);
  const relsName = posix.join(posix.dirname(doc.main), "_rels", `${posix.basename(doc.main)}.rels`);
  const rels = doc.xml(relsName) ?? parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
  const relsRoot = rootOf(rels);
  const ids = new Set(children(relsRoot, "Relationship").map((r) => attr(r, "Id")));
  let n = ids.size + 1;
  while (ids.has(`rId${n}`)) n++;
  relsRoot.kids.push(el("Relationship", { Id: `rId${n}`, Type: REL_COMMENTS, Target: posix.relative(posix.dirname(doc.main), name) }));
  doc.set(relsName, rels);
  const types = doc.xml("[Content_Types].xml");
  if (types) {
    const typesRoot = rootOf(types);
    if (!children(typesRoot, "Override").some((o) => attr(o, "PartName") === `/${name}`)) {
      typesRoot.kids.push(el("Override", { PartName: `/${name}`, ContentType: COMMENTS_TYPE }));
      doc.set("[Content_Types].xml", types);
    }
  }
  return { name, nodes, root: rootOf(nodes) };
}

// ── the whole pass ───────────────────────────────────────────────────────────

export interface RedlineOptions {
  author: string;
  /** ISO time stamped on every change; now when omitted. */
  date?: string;
}

export function redlineDocx(bytes: Buffer, edits: RedlineEdit[], opts: RedlineOptions): { bytes: Buffer; results: RedlineResult[] } {
  const doc = new Docx(bytes);
  const nodes = doc.xml(doc.main)!;
  const body = child(rootOf(nodes), "w:body");
  if (!body) throw new Error("not a .docx (no w:body)");
  const date = (opts.date ? new Date(opts.date) : new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  let maxId = 0;
  for (const part of [doc.main, doc.related("comments"), doc.related("footnotes"), doc.related("endnotes")]) {
    for (const m of (part ? doc.text(part) ?? "" : "").matchAll(/\bw:id="(-?\d+)"/g)) maxId = Math.max(maxId, Number(m[1]));
  }
  const stamp: Stamp = { author: opts.author, date, nextId: () => String(++maxId) };
  const initials = opts.author.split(/\s+/).map((w) => w[0] ?? "").join("").toUpperCase() || "S";
  let comments: ReturnType<typeof commentsPart> | undefined;

  const results = edits.map((edit, index): RedlineResult => {
    const base = { index, find: edit.find };
    const unplaced = (reason: string, candidates?: string[]): RedlineResult => ({ ...base, status: "unplaced", count: 0, reason, ...(candidates?.length ? { candidates } : {}) });
    if (!edit.find) return unplaced("find is empty");
    const lines = commentBody(edit);
    let depth = 0;
    const paragraphs = bodyParagraphs(body).map((p, pi) => {
      const fieldDepth = depth;
      const read = paragraphRuns(p, fieldDepth);
      depth = read.depth;
      return { p, pi, fieldDepth, text: read.text, runs: read.runs };
    });
    const hint = edit.paragraph ? normalize(edit.paragraph).toLowerCase() : null;
    const pool = hint ? paragraphs.filter((x) => normalize(x.text).toLowerCase().includes(hint)) : paragraphs;
    if (hint && !pool.length) return unplaced(`no paragraph contains the hint "${edit.paragraph}"`);

    let matched: "exact" | "normalized" = "exact";
    let hits = pool.flatMap((x) => indexesOf(x.text, edit.find).map((at) => ({ ...x, at })));
    if (!hits.length) {
      matched = "normalized";
      hits = pool.flatMap((x) => indexesOf(normalize(x.text), normalize(edit.find)).map((at) => ({ ...x, at })));
    }
    if (!hits.length) {
      if (edit.find.includes("\n")) return unplaced("not found: find spans more than one paragraph — make one edit per paragraph");
      const loose = (s: string) => normalize(s).toLowerCase().replace(/\s+/g, " ").trim();
      const near = pool.filter((x) => loose(x.text).includes(loose(edit.find))).slice(0, 3).map((x) => snippet(x.text, 0, x.text.length).slice(0, 240));
      return unplaced(near.length ? "not found exactly: the text differs in case or spacing — copy it from the document" : "not found", near);
    }
    if (hits.length > 1 && !edit.all) {
      return unplaced(
        `ambiguous: ${hits.length} matches — add a paragraph hint (text the right paragraph contains) or all: true`,
        hits.slice(0, 5).map((h) => snippet(h.text, h.at, edit.find.length)),
      );
    }

    const found = (h: (typeof hits)[number]) => h.text.slice(h.at, h.at + edit.find.length);
    const plan = hits.map((h) => {
      const changes = edit.replace === undefined ? [] : wordChanges(found(h), edit.replace).map((c) => ({ ...c, start: c.start + h.at, end: c.end + h.at }));
      const why = changes.map((c) => refusal(h.p, h.runs, c.start, c.end)).find(Boolean) ?? null;
      return { h, changes, commentOnly: !changes.length, why };
    });
    const placeable = plan.filter((x) => !x.why && (!x.commentOnly || lines.length));
    if (!placeable.length) {
      const why = plan.find((x) => x.why)?.why;
      return unplaced(why ? `the text is ${why}: accept or reject it first, or edit text around it` : "replace is the same as find and there is no reason to comment: nothing to do");
    }
    const commented = lines.length ? placeable[0] : undefined;
    let commentId: string | undefined;
    if (commented) {
      comments ??= commentsPart(doc);
      commentId = stamp.nextId();
      comments.root.kids.push(
        el(
          "w:comment",
          { "w:id": commentId, "w:author": opts.author, "w:date": date, "w:initials": initials },
          lines.map((line, i) => el("w:p", {}, [...(i === 0 ? [el("w:r", {}, [el("w:annotationRef")])] : []), el("w:r", {}, [textEl(line)])])),
        ),
      );
    }
    // Right to left, so the positions of what is still to do hold. The
    // comment's range is the whole match: its runs are cut at the match's
    // ends first, and the changes inside then replace runs between the marks.
    for (const x of [...placeable].sort((u, v) => u.h.pi - v.h.pi || v.h.at - u.h.at)) {
      if (x === commented && commentId) {
        const span = applyChange(x.h.p, x.h.fieldDepth, { start: x.h.at, end: x.h.at + edit.find.length, insert: "", mark: true }, stamp);
        const first = outside(x.h.p, span.first);
        const last = outside(x.h.p, span.last);
        insertAt(parentOf(x.h.p, first)!, first, [el("w:commentRangeStart", { "w:id": commentId })], false);
        insertAt(parentOf(x.h.p, last)!, last, [el("w:commentRangeEnd", { "w:id": commentId }), el("w:r", {}, [el("w:commentReference", { "w:id": commentId })])], true);
      }
      for (const c of [...x.changes].sort((u, v) => v.start - u.start)) applyChange(x.h.p, x.h.fieldDepth, c, stamp);
    }
    const skipped = plan.filter((x) => x.why).map((x) => `${snippet(x.h.text, x.h.at, edit.find.length)}: ${x.why}`);
    return {
      ...base,
      status: "applied",
      count: placeable.length,
      matched,
      ...(commented ? { comment: true } : {}),
      ...(skipped.length ? { skipped } : {}),
    };
  });

  doc.set(doc.main, nodes);
  if (comments) doc.set(comments.name, comments.nodes);
  return { bytes: doc.bytes(), results };
}
