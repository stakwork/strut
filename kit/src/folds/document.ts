// A document a run produced, made SAFE to draw: HTML parsed by the browser
// (`DOMParser`, which runs nothing) and walked against a pinned allowlist of
// tags and attributes into a closed tree of plain data, which a view turns
// into elements one by one (`createElement`) — never an HTML sink. And the
// terms to highlight in it, found in its text with `indexOf`, never a RegExp
// built from them. Ported from hive's run report (src/lib/run-report/
// sanitize-schema.ts, derive.ts `flattenText` / `findHighlightRanges`),
// where the sanitizing ran on the server over hast.
//
// What survives: text, and the elements a document is made of — blocks,
// headings, inline marks, lists, tables — each with only the attributes
// named here. Unknown elements are unwrapped (their text kept); scripts,
// styles, frames, forms, SVG and MathML go with everything inside them.
// Links keep `http(s):` and `mailto:` targets; images only an inline
// `data:image/…` source, so a document can never call out.

/** A node of the safe tree: text, or an element with React's prop names. */
export type SafeNode = string | SafeElement;

export interface SafeElement {
  t: string;
  a?: Record<string, string>;
  c?: SafeNode[];
}

/** Elements kept, with their children. */
export const SAFE_TAGS = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "aside", "blockquote", "pre", "hr", "br",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "span", "a", "strong", "b", "em", "i", "u", "s", "sub", "sup", "code", "mark", "small", "abbr", "cite", "q", "time", "del", "ins", "kbd",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "figure", "figcaption", "img",
]);

/** Elements dropped with everything inside them. */
const DROPPED = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "svg", "math", "template", "noscript", "head", "title", "meta", "link", "base", "form", "input", "button", "select", "textarea", "option", "audio", "video", "canvas", "applet"]);

/** Per element: the HTML attribute → the React prop it becomes. No global ones: no class, style, id, on*. */
const ATTRS: Record<string, Record<string, string>> = {
  a: { href: "href", title: "title" },
  th: { colspan: "colSpan", rowspan: "rowSpan", align: "align", scope: "scope" },
  td: { colspan: "colSpan", rowspan: "rowSpan", align: "align" },
  col: { span: "span" },
  colgroup: { span: "span" },
  time: { datetime: "dateTime" },
  abbr: { title: "title" },
  q: { cite: "cite" },
  blockquote: { cite: "cite" },
  ol: { start: "start" },
  img: { src: "src", alt: "alt", width: "width", height: "height" },
};

/** Elements that take no children. */
export const VOID_TAGS = new Set(["br", "hr", "col", "img"]);
/** Elements whose whitespace-only text children are layout, not content (React refuses them in a table). */
const NO_TEXT = new Set(["table", "thead", "tbody", "tfoot", "tr", "colgroup", "ul", "ol", "dl"]);

const MAX_DEPTH = 64;
const MAX_NODES = 100_000;

const safeHref = (v: string) => /^(https?:|mailto:)/i.test(v.trim());
const safeCite = (v: string) => /^https?:/i.test(v.trim());
const safeSrc = (v: string) => /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]*$/i.test(v.trim());

/** The part of a DOM node the walk reads (a browser's, or a test's). */
export interface DomLike {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<DomLike>;
  getAttribute?: (name: string) => string | null;
}

/** A parsed DOM's children as the safe tree. */
export function sanitizeDom(root: DomLike): SafeNode[] {
  let budget = MAX_NODES;
  const walk = (node: DomLike, depth: number, parentTag: string): SafeNode[] => {
    if (--budget < 0) return [];
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? "";
      return NO_TEXT.has(parentTag) && !text.trim() ? [] : text ? [text] : [];
    }
    if (node.nodeType !== 1) return [];
    const tag = node.nodeName.toLowerCase();
    if (DROPPED.has(tag) || depth > MAX_DEPTH) return [];
    const children = (t: string) => Array.from(node.childNodes).flatMap((c) => walk(c, depth + 1, t));
    if (!SAFE_TAGS.has(tag)) return children(parentTag);
    const a: Record<string, string> = {};
    for (const [attr, prop] of Object.entries(ATTRS[tag] ?? {})) {
      const v = node.getAttribute?.(attr);
      if (v === null || v === undefined) continue;
      if (attr === "href" && !safeHref(v)) continue;
      if (attr === "cite" && !safeCite(v)) continue;
      if (attr === "src" && !safeSrc(v)) continue;
      a[prop] = v;
    }
    // An image with no safe source is nothing; a link with no safe target, its text.
    if (tag === "img" && !a["src"]) return [];
    if (tag === "a" && !a["href"]) return children(parentTag);
    const el: SafeElement = { t: tag };
    if (Object.keys(a).length) el.a = a;
    if (!VOID_TAGS.has(tag)) {
      const c = children(tag);
      if (c.length) el.c = c;
    }
    return [el];
  };
  return Array.from(root.childNodes).flatMap((c) => walk(c, 0, ""));
}

/** HTML text as the safe tree, parsed by the browser's `DOMParser` (or the one given). */
export function sanitizeHtml(html: string, parse?: (html: string) => DomLike): SafeNode[] {
  const p = parse ?? ((h: string) => new DOMParser().parseFromString(h, "text/html").body as unknown as DomLike);
  return sanitizeDom(p(html));
}

/** The safe tree's text, in the order a view draws it — what highlight ranges index into. */
export function flattenText(nodes: readonly SafeNode[]): string {
  let text = "";
  const visit = (list: readonly SafeNode[]) => {
    for (const n of list) {
      if (typeof n === "string") text += n;
      else if (n.c) visit(n.c);
    }
  };
  visit(nodes);
  return text;
}

export interface TextRange {
  start: number;
  end: number;
}

/** At most this many terms are looked for, each cut to this length. */
export const MAX_HIGHLIGHT_TERMS = 25;
export const MAX_TERM_LENGTH = 200;
const MAX_RANGES = 500;

/**
 * Where the terms are in `text`, case-insensitive, overlapping ranges merged.
 * The terms are whatever the page was handed — a quote, a model's words — so
 * they are capped and matched with `indexOf`: a RegExp built from them could
 * be made to backtrack for ever. A term under 2 characters is skipped.
 */
export function findHighlightRanges(text: string, terms: readonly string[]): TextRange[] {
  const ranges: TextRange[] = [];
  const hay = text.toLowerCase();
  for (const raw of terms.slice(0, MAX_HIGHLIGHT_TERMS)) {
    if (typeof raw !== "string") continue;
    const term = raw.trim().slice(0, MAX_TERM_LENGTH).toLowerCase();
    if (term.length < 2) continue;
    for (let from = 0; ranges.length < MAX_RANGES; ) {
      const at = hay.indexOf(term, from);
      if (at === -1) break;
      ranges.push({ start: at, end: at + term.length });
      from = at + term.length;
    }
  }
  ranges.sort((x, y) => x.start - y.start);
  const merged: TextRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/** A piece of a text: as it is, or highlighted. */
export type TextPiece = string | { mark: string };

/** One text, cut where the ranges (indexes into a longer text that holds it at `offset`) fall. */
export function highlightPieces(text: string, ranges: readonly TextRange[], offset = 0): TextPiece[] {
  const end = offset + text.length;
  const out: TextPiece[] = [];
  let at = 0;
  for (const r of ranges) {
    if (r.end <= offset || r.start >= end) continue;
    const from = Math.max(0, r.start - offset);
    const to = Math.min(text.length, r.end - offset);
    if (from > at) out.push(text.slice(at, from));
    if (to > from) out.push({ mark: text.slice(from, to) });
    at = Math.max(at, to);
  }
  if (at < text.length) out.push(text.slice(at));
  return out.length ? out : [text];
}
