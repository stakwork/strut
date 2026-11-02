// A .docx as HTML and text (docx/to-html). Read straight off the parts:
// paragraphs, headings (by style or outline level), Word's own list numbers,
// bullet lists, tables (merged cells kept), links, bold / italic / underline /
// strike / super- and subscript. Tracked changes come out as <ins> / <del>
// with their author and date; comments, footnotes and endnotes as numbered
// notes ([1]) listed at the end. Images, text boxes, equations and
// headers / footers are left out. The HTML is a fragment of the elements
// strut/views' DocumentView draws, every text escaped.

import { Docx } from "./_docx.js";
import { attr, child, children, isEl, rootOf, textOf, type XEl, type XNode } from "./_xml.js";

export interface DocxChange {
  kind: "insert" | "delete";
  text: string;
  author?: string;
  date?: string;
  /** Moved text: the deleted copy (`delete`) or the inserted one (`insert`). */
  move?: true;
}

export interface DocxNote {
  /** The `[n]` the document's text carries where the note is. */
  n: number;
  kind: "comment" | "footnote" | "endnote";
  text: string;
  author?: string;
  date?: string;
  /** A comment: the text it is on. A footnote: the words before it. */
  anchor?: string;
}

export interface DocxHtml {
  html: string;
  /** The document as it reads with every change accepted, notes listed at the end. */
  text: string;
  title: string | null;
  changes: DocxChange[];
  notes: DocxNote[];
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const TAB_HTML = " ";
const val = (el: XEl | undefined) => attr(el, "w:val");
/** An on/off property (`<w:b/>`, `<w:b w:val="false"/>`). */
const on = (el: XEl | undefined) => !!el && !/^(0|false|off|none)$/i.test(val(el) ?? "");
const dayOf = (date?: string) => date?.slice(0, 10);

// ── styles and numbering ─────────────────────────────────────────────────────

interface Style {
  name?: string;
  basedOn?: string;
  numId?: string;
  ilvl?: number;
  outline?: number;
}

interface Level {
  fmt: string;
  text: string;
  start: number;
  suff: string;
  legal: boolean;
}

function readStyles(doc: Docx): Map<string, Style> {
  const out = new Map<string, Style>();
  const part = doc.related("styles");
  const nodes = part ? doc.xml(part) : undefined;
  if (!nodes) return out;
  for (const s of children(rootOf(nodes), "w:style")) {
    const id = attr(s, "w:styleId");
    if (!id) continue;
    const pPr = child(s, "w:pPr");
    const numPr = child(pPr, "w:numPr");
    const outline = val(child(pPr, "w:outlineLvl"));
    out.set(id, {
      name: val(child(s, "w:name")),
      basedOn: val(child(s, "w:basedOn")),
      numId: val(child(numPr, "w:numId")),
      ilvl: numPr && val(child(numPr, "w:ilvl")) ? Number(val(child(numPr, "w:ilvl"))) : undefined,
      outline: outline !== undefined ? Number(outline) : undefined,
    });
  }
  return out;
}

function readLevel(lvl: XEl): Level {
  return {
    fmt: val(child(lvl, "w:numFmt")) ?? "decimal",
    text: val(child(lvl, "w:lvlText")) ?? "",
    start: Number(val(child(lvl, "w:start")) ?? 1),
    suff: val(child(lvl, "w:suff")) ?? "tab",
    legal: on(child(lvl, "w:isLgl")),
  };
}

/** numId → ilvl → the level as that list instance uses it (overrides applied). */
function readNumbering(doc: Docx): Map<string, Map<number, Level>> {
  const out = new Map<string, Map<number, Level>>();
  const part = doc.related("numbering");
  const nodes = part ? doc.xml(part) : undefined;
  if (!nodes) return out;
  const root = rootOf(nodes);
  const abstract = new Map<string, Map<number, Level>>();
  for (const a of children(root, "w:abstractNum")) {
    const levels = new Map<number, Level>();
    for (const l of children(a, "w:lvl")) levels.set(Number(attr(l, "w:ilvl") ?? 0), readLevel(l));
    abstract.set(attr(a, "w:abstractNumId") ?? "", levels);
  }
  for (const n of children(root, "w:num")) {
    const levels = new Map(abstract.get(val(child(n, "w:abstractNumId")) ?? "") ?? []);
    for (const o of children(n, "w:lvlOverride")) {
      const ilvl = Number(attr(o, "w:ilvl") ?? 0);
      const lvl = child(o, "w:lvl");
      const start = val(child(o, "w:startOverride"));
      const base = lvl ? readLevel(lvl) : levels.get(ilvl);
      if (base) levels.set(ilvl, start !== undefined ? { ...base, start: Number(start) } : base);
    }
    out.set(attr(n, "w:numId") ?? "", levels);
  }
  return out;
}

function roman(n: number): string {
  const r: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  for (const [v, s] of r) for (; n >= v; n -= v) out += s;
  return out;
}

function letters(n: number): string {
  // Word's lowerLetter: a … z, then aa … zz.
  const c = String.fromCharCode(97 + ((n - 1) % 26));
  return c.repeat(Math.floor((n - 1) / 26) + 1);
}

function formatNumber(n: number, fmt: string): string {
  switch (fmt) {
    case "lowerLetter": return letters(n);
    case "upperLetter": return letters(n).toUpperCase();
    case "lowerRoman": return roman(n);
    case "upperRoman": return roman(n).toUpperCase();
    case "decimalZero": return String(n).padStart(2, "0");
    case "none": return "";
    default: return String(n);
  }
}

// ── the renderer ─────────────────────────────────────────────────────────────

interface Out {
  html: string;
  /** Accepted text: insertions in, deletions out. */
  text: string;
  /** Everything shown, deletions included. */
  seen: string;
}

interface Block {
  html: string;
  text: string;
  bullet?: number;
}

const newOut = (): Out => ({ html: "", text: "", seen: "" });

class Renderer {
  readonly changes: DocxChange[] = [];
  readonly notes: DocxNote[] = [];
  private readonly styles: Map<string, Style>;
  private readonly numbering: Map<string, Map<number, Level>>;
  private readonly links = new Map<string, string>();
  private readonly comments = new Map<string, { author?: string; date?: string; text: string }>();
  private readonly footnotes = new Map<string, string>();
  private readonly endnotes = new Map<string, string>();
  private readonly counters = new Map<string, number[]>();
  /** Comment id → the text under it so far, while its range is open. */
  private readonly anchors = new Map<string, { text: string; accepted: string; open: boolean }>();
  private readonly noteOf = new Map<string, DocxNote>();
  private readonly commentIds = new Map<DocxNote, string>();
  /** What the paragraph being rendered reads so far, changes accepted (a footnote's anchor). */
  private para = "";

  constructor(private readonly doc: Docx) {
    this.styles = readStyles(doc);
    this.numbering = readNumbering(doc);
    for (const r of doc.rels(doc.main)) if (r.external && r.type.endsWith("/hyperlink")) this.links.set(r.id, r.target);
    const commentsPart = doc.related("comments");
    const cNodes = commentsPart ? doc.xml(commentsPart) : undefined;
    if (cNodes) {
      for (const c of children(rootOf(cNodes), "w:comment")) {
        this.comments.set(attr(c, "w:id") ?? "", { author: attr(c, "w:author"), date: attr(c, "w:date"), text: plainText(c) });
      }
    }
    for (const [type, tag, into] of [["footnotes", "w:footnote", this.footnotes], ["endnotes", "w:endnote", this.endnotes]] as const) {
      const part = doc.related(type);
      const nodes = part ? doc.xml(part) : undefined;
      if (!nodes) continue;
      for (const f of children(rootOf(nodes), tag)) {
        if (attr(f, "w:type") && attr(f, "w:type") !== "normal") continue;
        into.set(attr(f, "w:id") ?? "", plainText(f));
      }
    }
  }

  render(): { html: string; text: string } {
    const body = child(rootOf(this.doc.xml(this.doc.main)!), "w:body");
    const { html, text } = assemble(this.blocks(body?.kids ?? []));
    // Comments nothing references go last; every comment's anchor is read
    // now, since a range may end after its reference.
    for (const [id] of this.comments) if (!this.noteOf.has(`comment:${id}`)) this.note("comment", id);
    for (const [note, id] of this.commentIds) {
      const a = this.anchors.get(id);
      const anchor = a?.accepted.trim() || a?.text.trim();
      if (anchor) note.anchor = anchor;
    }
    if (!this.notes.length) return { html, text };
    const items = this.notes.map((n) => `<li>${noteHtml(n)}</li>`).join("");
    return {
      html: `${html}\n<section><h2>Notes</h2><ol>${items}</ol></section>`,
      text: `${text}\n\nNotes\n${this.notes.map((n) => `[${n.n}] ${noteText(n)}`).join("\n")}`,
    };
  }

  private note(kind: DocxNote["kind"], id: string): DocxNote {
    const key = `${kind}:${id}`;
    const known = this.noteOf.get(key);
    if (known) return known;
    const source = kind === "comment" ? this.comments.get(id) : { text: (kind === "footnote" ? this.footnotes : this.endnotes).get(id) ?? "" };
    const note: DocxNote = { n: this.notes.length + 1, kind, text: source?.text ?? "" };
    if (kind === "comment") {
      this.commentIds.set(note, id);
      if (source && "author" in source && source.author) note.author = source.author;
      if (source && "date" in source && source.date) note.date = source.date;
    }
    if (kind !== "comment") {
      const tail = this.para.trim();
      if (tail) note.anchor = tail.length > 60 ? `…${tail.slice(-60).trimStart()}` : tail;
    }
    this.notes.push(note);
    this.noteOf.set(key, note);
    return note;
  }

  // Blocks: paragraphs, tables, and the containers that hold them.
  private blocks(nodes: XNode[]): Block[] {
    const out: Block[] = [];
    for (const n of nodes) {
      if (!isEl(n)) continue;
      if (n.name === "w:p") {
        const b = this.paragraph(n);
        if (b) out.push(b);
      } else if (n.name === "w:tbl") {
        out.push(this.table(n));
      } else if (n.name === "w:sdt") {
        out.push(...this.blocks(child(n, "w:sdtContent")?.kids ?? []));
      } else if (["w:customXml", "w:ins", "w:del", "w:moveTo", "w:moveFrom"].includes(n.name)) {
        out.push(...this.blocks(n.kids));
      }
    }
    return out;
  }

  private style(id: string | undefined): Style[] {
    const chain: Style[] = [];
    for (let s = id ? this.styles.get(id) : undefined; s && chain.length < 20; s = s.basedOn ? this.styles.get(s.basedOn) : undefined) chain.push(s);
    return chain;
  }

  private headingLevel(pPr: XEl | undefined): number | null {
    const outline = val(child(pPr, "w:outlineLvl"));
    if (outline !== undefined) return Number(outline) < 6 ? Number(outline) + 1 : null;
    const id = val(child(pPr, "w:pStyle"));
    if (!id) return null;
    for (const [i, s] of [{ name: id }, ...this.style(id)].entries()) {
      const name = s.name ?? "";
      if (/^title$/i.test(name)) return 1;
      if (/^subtitle$/i.test(name)) return 2;
      const m = /^heading\s*([1-6])$/i.exec(name);
      if (m) return Number(m[1]);
      if (i > 0 && s.outline !== undefined) return s.outline < 6 ? s.outline + 1 : null;
    }
    return null;
  }

  private numberingOf(pPr: XEl | undefined): { numId: string; ilvl: number } | null {
    const numPr = child(pPr, "w:numPr");
    let numId = val(child(numPr, "w:numId"));
    let ilvl = numPr && val(child(numPr, "w:ilvl")) !== undefined ? Number(val(child(numPr, "w:ilvl"))) : undefined;
    if (numId === undefined) {
      for (const s of this.style(val(child(pPr, "w:pStyle")))) {
        if (s.numId !== undefined) {
          numId = s.numId;
          ilvl ??= s.ilvl;
          break;
        }
      }
    }
    return numId && numId !== "0" ? { numId, ilvl: ilvl ?? 0 } : null;
  }

  /** The list label Word draws for this paragraph, counted as Word counts. */
  private label(numId: string, ilvl: number): { bullet: boolean; label: string; suff: string } | null {
    const levels = this.numbering.get(numId);
    const lvl = levels?.get(ilvl);
    if (!levels || !lvl) return null;
    if (lvl.fmt === "bullet") return { bullet: true, label: "", suff: "" };
    const counts = this.counters.get(numId) ?? [];
    for (let k = 0; k < ilvl; k++) counts[k] ??= levels.get(k)?.start ?? 1;
    counts[ilvl] = (counts[ilvl] ?? (lvl.start - 1)) + 1;
    counts.length = ilvl + 1;
    this.counters.set(numId, counts);
    const label = lvl.text.replace(/%(\d)/g, (_, d: string) => {
      const k = Number(d) - 1;
      const fmt = lvl.legal ? "decimal" : levels.get(k)?.fmt ?? "decimal";
      return counts[k] !== undefined ? formatNumber(counts[k]!, fmt) : "";
    });
    return { bullet: false, label, suff: lvl.suff === "space" ? " " : lvl.suff === "nothing" ? "" : "\t" };
  }

  private paragraph(p: XEl): Block | null {
    const pPr = child(p, "w:pPr");
    this.para = "";
    const out = newOut();
    this.inline(p.kids, out, false);
    if (!out.seen.trim() && !out.html.includes("<sup>")) return null;
    const num = this.numberingOf(pPr);
    const label = num ? this.label(num.numId, num.ilvl) : null;
    if (label?.bullet) return { html: out.html, text: `${"  ".repeat(num!.ilvl)}• ${out.text}`, bullet: num!.ilvl };
    let html = out.html;
    let text = out.text;
    if (label?.label) {
      html = `${escapeHtml(label.label)}${label.suff === "\t" ? TAB_HTML : label.suff}${html}`;
      text = `${label.label}${label.suff}${text}`;
    }
    const level = this.headingLevel(pPr);
    return { html: level ? `<h${level}>${html}</h${level}>` : `<p>${html}</p>`, text };
  }

  private table(tbl: XEl): Block {
    interface Cell { el: XEl; col: number; span: number; merge?: "restart" | "continue"; header: boolean }
    const rows: Cell[][] = children(tbl, "w:tr").map((tr) => {
      const header = on(child(child(tr, "w:trPr"), "w:tblHeader"));
      let col = 0;
      return children(tr, "w:tc").map((tc) => {
        const tcPr = child(tc, "w:tcPr");
        const span = Number(val(child(tcPr, "w:gridSpan")) ?? 1) || 1;
        const vMerge = child(tcPr, "w:vMerge");
        const cell: Cell = { el: tc, col, span, header, ...(vMerge ? { merge: val(vMerge) === "restart" ? "restart" : "continue" } : {}) };
        col += span;
        return cell;
      });
    });
    const htmlRows: string[] = [];
    const textRows: string[] = [];
    rows.forEach((cells, r) => {
      let html = "";
      const texts: string[] = [];
      for (const cell of cells) {
        if (cell.merge === "continue") continue;
        let rowspan = 1;
        if (cell.merge === "restart") {
          for (let k = r + 1; k < rows.length && rows[k]!.some((c) => c.col === cell.col && c.merge === "continue"); k++) rowspan++;
        }
        const content = assemble(this.blocks(cell.el.kids));
        const tag = cell.header ? "th" : "td";
        const attrs = `${cell.span > 1 ? ` colspan="${cell.span}"` : ""}${rowspan > 1 ? ` rowspan="${rowspan}"` : ""}`;
        html += `<${tag}${attrs}>${content.html}</${tag}>`;
        texts.push(content.text.replace(/\n/g, " "));
      }
      htmlRows.push(`<tr>${html}</tr>`);
      textRows.push(texts.join(" | "));
    });
    return { html: `<table><tbody>${htmlRows.join("")}</tbody></table>`, text: textRows.join("\n") };
  }

  // Inline content: runs, tracked changes, links, and the wrappers around them.
  private inline(nodes: XNode[], out: Out, deleted: boolean): void {
    for (const n of nodes) {
      if (!isEl(n)) continue;
      switch (n.name) {
        case "w:r":
          this.run(n, out, deleted);
          break;
        case "w:ins":
        case "w:moveTo":
        case "w:del":
        case "w:moveFrom": {
          const del = n.name === "w:del" || n.name === "w:moveFrom";
          const inner = newOut();
          this.inline(n.kids, inner, del || deleted);
          const author = attr(n, "w:author");
          const date = attr(n, "w:date");
          const change: DocxChange = { kind: del ? "delete" : "insert", text: del ? inner.seen : inner.text };
          if (author) change.author = author;
          if (date) change.date = date;
          if (n.name.startsWith("w:move")) change.move = true;
          if (change.text) this.changes.push(change);
          const tag = del ? "del" : "ins";
          const title = `${del ? "Deleted" : "Inserted"}${author ? ` by ${author}` : ""}${date ? `, ${dayOf(date)}` : ""}`;
          const attrs = `${date ? ` datetime="${escapeHtml(date)}"` : ""} title="${escapeHtml(title)}"${author ? ` data-author="${escapeHtml(author)}"` : ""}`;
          if (inner.html) out.html += `<${tag}${attrs}>${inner.html}</${tag}>`;
          out.text += del ? "" : inner.text;
          out.seen += inner.seen;
          break;
        }
        case "w:hyperlink": {
          const inner = newOut();
          this.inline(n.kids, inner, deleted);
          const href = this.links.get(attr(n, "r:id") ?? "");
          out.html += href && /^(https?:|mailto:)/i.test(href) ? `<a href="${escapeHtml(href)}">${inner.html}</a>` : inner.html;
          out.text += inner.text;
          out.seen += inner.seen;
          break;
        }
        case "w:sdt":
          this.inline(child(n, "w:sdtContent")?.kids ?? [], out, deleted);
          break;
        case "w:smartTag":
        case "w:customXml":
        case "w:fldSimple":
        case "w:dir":
        case "w:bdo":
          this.inline(n.kids, out, deleted);
          break;
        case "w:commentRangeStart":
          this.anchors.set(attr(n, "w:id") ?? "", { text: "", accepted: "", open: true });
          break;
        case "w:commentRangeEnd": {
          const a = this.anchors.get(attr(n, "w:id") ?? "");
          if (a) a.open = false;
          break;
        }
      }
    }
  }

  private shown(out: Out, text: string, deleted: boolean, html = escapeHtml(text)): void {
    out.html += html;
    out.seen += text;
    if (!deleted) (out.text += text), (this.para += text);
    for (const a of this.anchors.values()) {
      if (!a.open) continue;
      a.text += text;
      if (!deleted) a.accepted += text;
    }
  }

  private run(r: XEl, out: Out, deleted: boolean): void {
    const rPr = child(r, "w:rPr");
    const inner = newOut();
    for (const k of r.kids) {
      if (!isEl(k)) continue;
      switch (k.name) {
        case "w:t":
        case "w:delText":
          this.shown(inner, textOf(k), deleted || k.name === "w:delText");
          break;
        case "w:tab":
        case "w:ptab":
          this.shown(inner, "\t", deleted, TAB_HTML);
          break;
        case "w:br":
        case "w:cr":
          if (attr(k, "w:type") === "page" || attr(k, "w:type") === "column") break;
          this.shown(inner, "\n", deleted, "<br>");
          break;
        case "w:noBreakHyphen":
          this.shown(inner, "‑", deleted);
          break;
        case "w:footnoteReference":
        case "w:endnoteReference":
        case "w:commentReference": {
          const kind = k.name === "w:commentReference" ? "comment" : k.name === "w:footnoteReference" ? "footnote" : "endnote";
          inner.html += `<sup>[${this.note(kind, attr(k, "w:id") ?? "").n}]</sup>`;
          break;
        }
      }
    }
    if (!inner.html) return;
    let html = inner.html;
    const vert = val(child(rPr, "w:vertAlign"));
    const marks: [boolean, string][] = [
      [on(child(rPr, "w:b")), "strong"],
      [on(child(rPr, "w:i")), "em"],
      [on(child(rPr, "w:u")), "u"],
      [on(child(rPr, "w:strike")) || on(child(rPr, "w:dstrike")), "s"],
      [vert === "superscript", "sup"],
      [vert === "subscript", "sub"],
    ];
    if (inner.seen) for (const [yes, tag] of marks) if (yes) html = `<${tag}>${html}</${tag}>`;
    out.html += html;
    out.text += inner.text;
    out.seen += inner.seen;
  }
}

/** A part's paragraphs as plain text, one line each (a comment's or a note's body). */
function plainText(el: XEl): string {
  const lines: string[] = [];
  const visit = (n: XEl) => {
    if (n.name === "w:p") {
      let line = "";
      const walk = (e: XEl) => {
        for (const k of e.kids) {
          if (!isEl(k)) continue;
          if (k.name === "w:t") line += textOf(k);
          else if (k.name === "w:tab") line += "\t";
          else if (k.name === "w:br") line += "\n";
          else if (!["w:del", "w:moveFrom", "w:rPr", "w:pPr", "w:instrText"].includes(k.name)) walk(k);
        }
      };
      walk(n);
      if (line.trim()) lines.push(line.trim());
    } else for (const k of children(n)) visit(k);
  };
  visit(el);
  return lines.join("\n");
}

function noteHtml(n: DocxNote): string {
  const who = n.kind === "comment" ? `<strong>${escapeHtml(n.author ?? "Comment")}</strong>${n.date ? ` (${escapeHtml(dayOf(n.date)!)})` : ""}: ` : "";
  const on = n.anchor ? ` — ${n.kind === "comment" ? "on" : "after"} “${escapeHtml(n.anchor)}”` : "";
  return `${who}${escapeHtml(n.text).replace(/\n/g, "<br>")}${on}`;
}

function noteText(n: DocxNote): string {
  const who = n.kind === "comment" ? `${n.author ?? "Comment"}${n.date ? ` (${dayOf(n.date)})` : ""}: ` : `${n.kind === "footnote" ? "Footnote" : "Endnote"}: `;
  const on = n.anchor ? ` — ${n.kind === "comment" ? "on" : "after"} “${n.anchor}”` : "";
  return `${who}${n.text}${on}`;
}

/** Blocks as HTML (bullets grouped into nested <ul>s) and text, one line a block. */
function assemble(blocks: Block[]): { html: string; text: string } {
  let html = "";
  const open: number[] = [];
  for (const b of blocks) {
    if (b.bullet === undefined) {
      while (open.length) (open.pop(), (html += "</li></ul>"));
      html += `${html ? "\n" : ""}${b.html}`;
      continue;
    }
    while (open.length && open[open.length - 1]! > b.bullet) (open.pop(), (html += "</li></ul>"));
    if (open.length && open[open.length - 1] === b.bullet) html += "</li>";
    else {
      html += `${html && !open.length ? "\n" : ""}<ul>`;
      open.push(b.bullet);
    }
    html += `<li>${b.html}`;
  }
  while (open.length) (open.pop(), (html += "</li></ul>"));
  return { html, text: blocks.map((b) => b.text).join("\n") };
}

function coreTitle(doc: Docx): string | null {
  const core = doc.rels("").find((r) => r.type.endsWith("/core-properties"));
  const nodes = core ? doc.xml(core.target) : undefined;
  const title = nodes ? child(rootOf(nodes), "dc:title") : undefined;
  return title ? textOf(title).trim() || null : null;
}

export function docxToHtml(bytes: Buffer): DocxHtml {
  const doc = new Docx(bytes);
  const r = new Renderer(doc);
  const { html, text } = r.render();
  const heading = /<h[1-6]>([\s\S]*?)<\/h[1-6]>/.exec(html)?.[1];
  const title = coreTitle(doc) ?? (heading ? heading.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim() || null : null);
  return { html, text, title, changes: r.changes, notes: r.notes };
}
