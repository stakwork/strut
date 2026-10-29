import { h, Fragment, JSX } from "preact";

// ── Tiny markdown renderer ─────────────────────────────────────────────────
// Supports: headers (#..######), unordered lists (- / *), ordered lists (1.),
// fenced code blocks (```), blockquotes (>), pipe tables (a header row, a
// `---` separator row, then rows), inline code (`x`), bold (**x**),
// italic (*x* / _x_), links [text](url), images ![alt](src), horizontal
// rules (---), paragraphs. Deliberately small — no external deps.
//
// A link opens in a new tab. A caller that knows where a link LEADS — the
// artifact viewer, for a file whose links name its siblings — passes
// `resolveLink`: what it returns for an href is the link's real URL and,
// when the caller can show the target itself, an `open` that a plain click
// runs instead of leaving the page (a modified click still gets the URL).
// An image renders only through it: a markdown file an agent wrote may name
// any URL, and the UI loads nothing but the scope's own files; otherwise the
// image is the link it names. A caller whose files no plain `src` can load
// (a peer's, read with the UI's credential) renders the image itself (`img`).

/** Where a link leads, by the caller: its URL, how to open it in place, and
 *  how to show it as an image when a plain `<img src={url}>` cannot. */
export interface MarkdownLink { url: string; open?: () => void; img?: (alt: string) => JSX.Element }
type Resolve = ((href: string) => MarkdownLink | null) | undefined;

type Node = JSX.Element | string;

function plainClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

function renderLink(label: string, href: string, resolve: Resolve): JSX.Element {
  const to = resolve?.(href) ?? null;
  const open = to?.open;
  if (open) {
    return (
      <a href={to.url} onClick={(e) => { if (plainClick(e)) { e.preventDefault(); open(); } }}>
        {renderInline(label, resolve)}
      </a>
    );
  }
  return <a href={to?.url ?? href} target="_blank" rel="noopener noreferrer">{renderInline(label, resolve)}</a>;
}

/** `[label](target)` starting at `i` (at the `[`): the pieces and where it
 *  ends, or null when the brackets do not close. */
function parseLink(text: string, i: number): { label: string; target: string; end: number } | null {
  const closeBracket = text.indexOf("]", i + 1);
  if (closeBracket === -1 || text[closeBracket + 1] !== "(") return null;
  const closeParen = text.indexOf(")", closeBracket + 2);
  if (closeParen === -1) return null;
  return { label: text.slice(i + 1, closeBracket), target: text.slice(closeBracket + 2, closeParen), end: closeParen + 1 };
}

function renderInline(text: string, resolve: Resolve): Node[] {
  const nodes: Node[] = [];
  let i = 0;
  let buf = "";
  const flush = () => { if (buf) { nodes.push(buf); buf = ""; } };

  while (i < text.length) {
    const ch = text[i];

    // Inline code: `...`
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        nodes.push(<code class="md-code-inline">{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }

    // Bold: **...**
    if (ch === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        flush();
        nodes.push(<strong>{renderInline(text.slice(i + 2, end), resolve)}</strong>);
        i = end + 2;
        continue;
      }
    }

    // Italic: *...* or _..._
    if ((ch === "*" || ch === "_") && text[i + 1] !== ch) {
      const end = text.indexOf(ch, i + 1);
      if (end !== -1 && end > i + 1) {
        flush();
        nodes.push(<em>{renderInline(text.slice(i + 1, end), resolve)}</em>);
        i = end + 1;
        continue;
      }
    }

    // Image: ![alt](src) — shown only for a target the caller resolves,
    // else the link it names.
    if (ch === "!" && text[i + 1] === "[") {
      const link = parseLink(text, i + 1);
      if (link) {
        flush();
        const to = resolve?.(link.target) ?? null;
        nodes.push(to ? to.img?.(link.label) ?? <img class="md-img" src={to.url} alt={link.label} /> : renderLink(link.label, link.target, resolve));
        i = link.end;
        continue;
      }
    }

    // Link: [text](url)
    if (ch === "[") {
      const link = parseLink(text, i);
      if (link) {
        flush();
        nodes.push(renderLink(link.label, link.target, resolve));
        i = link.end;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return nodes;
}

export function Markdown(props: { source: string; class?: string; resolveLink?: (href: string) => MarkdownLink | null }) {
  const resolve = props.resolveLink;
  const src = props.source.replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const out: JSX.Element[] = [];

  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push(<p key={out.length}>{renderInline(para.join(" "), resolve)}</p>);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line)) {
      flushPara();
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // closing fence
      out.push(
        <pre key={out.length} class="md-code-block" data-lang={lang || undefined}>
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // Headers
    const hMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hMatch) {
      flushPara();
      const level = hMatch[1].length;
      const text = hMatch[2];
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      out.push(h(Tag, { key: out.length, class: `md-h md-h${level}` }, renderInline(text, resolve)));
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\s*\1\s*\1[-*_\s]*$/.test(line)) {
      flushPara();
      out.push(<hr key={out.length} class="md-hr" />);
      i++;
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push(
        <ul key={out.length} class="md-ul">
          {items.map((it, idx) => <li key={idx}>{renderInline(it, resolve)}</li>)}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push(
        <ol key={out.length} class="md-ol">
          {items.map((it, idx) => <li key={idx}>{renderInline(it, resolve)}</li>)}
        </ol>
      );
      continue;
    }

    // Pipe table: a `| a | b |` row followed by its `| --- | --- |` separator.
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flushPara();
      const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      out.push(
        <table key={out.length} class="md-table">
          <thead><tr>{head.map((c, idx) => <th key={idx}>{renderInline(c, resolve)}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => <tr key={ri}>{head.map((_, ci) => <td key={ci}>{renderInline(r[ci] ?? "", resolve)}</td>)}</tr>)}</tbody>
        </table>
      );
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      flushPara();
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(<blockquote key={out.length} class="md-quote">{renderInline(quoted.join(" "), resolve)}</blockquote>);
      continue;
    }

    // Blank line → paragraph break
    if (/^\s*$/.test(line)) {
      flushPara();
      i++;
      continue;
    }

    // Paragraph line
    para.push(line);
    i++;
  }
  flushPara();

  return <div class={`md-view ${props.class || ""}`}>{out}</div>;
}

/** Detect whether a step output is an object with a `markdown` string field. */
export function hasMarkdownField(v: unknown): v is { markdown: string } & Record<string, unknown> {
  return (
    v != null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).markdown === "string" &&
    ((v as Record<string, unknown>).markdown as string).length > 0
  );
}
