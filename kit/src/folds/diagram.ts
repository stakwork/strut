// A ```mermaid block drawn as a diagram (strut/views' MermaidDiagram, the
// UI's Markdown): Mermaid's settings for the page's light or dark, and the
// SVG it draws as an IMAGE — a `data:` URL, which an app's CSP allows for
// `img-src` and in which nothing runs and nothing loads. Mermaid itself is
// the caller's (an app's from the kit, the UI's a chunk of its own); this
// is what they share. No DOM but the browser's DOMParser and XMLSerializer,
// as `sanitizeHtml` (a test gets both from happy-dom).

/** Mermaid's settings: its own look for the page's light or dark; labels as
 *  SVG text, since an image draws no HTML; nothing a diagram could run
 *  (`strict`); no error picture of its own (the block says what went wrong). */
export function mermaidConfig(theme: "light" | "dark") {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: theme === "dark" ? "dark" : "neutral",
    // A face both the live page (where Mermaid measures text) and the image
    // have: an image loads no web font.
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
  } as const;
}

export interface DiagramImage {
  src: string;
  width: number;
  height: number;
}

/**
 * The SVG Mermaid drew as an image: sized by its viewBox (Mermaid sizes it
 * `width="100%"` with a max-width, which an image has nothing to resolve
 * against), and written as XML, which is how an image is parsed: Mermaid's
 * markup is read as XML, or as HTML when it is not XML (a `<br>` in a
 * label). Null when it holds no sized SVG.
 */
export function diagramImage(svg: string): DiagramImage | null {
  const parser = new DOMParser();
  const xml = parser.parseFromString(svg, "image/svg+xml");
  const ok = !xml.getElementsByTagName("parsererror").length && xml.documentElement?.nodeName.toLowerCase() === "svg";
  // Not XML (an HTML `<br>` in a label): the HTML parser reads it, and it is written back as XML.
  const el = ok ? xml.documentElement : parser.parseFromString(svg, "text/html").querySelector("svg");
  if (!el) return null;
  const [, , width, height] = (el.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  el.setAttribute("width", String(width));
  el.setAttribute("height", String(height));
  el.removeAttribute("style");
  const out = new XMLSerializer().serializeToString(el);
  return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(out)}`, width: Math.ceil(width), height: Math.ceil(height) };
}

/** What went wrong, in a line: the first of Mermaid's message, or for a
 *  parse error where it stopped. (Its "on line N" counts Mermaid's own
 *  lines, not the block's; the line after quotes the text it stopped at,
 *  and the rest lists every token it expected.) */
export function errorLine(message: string): string {
  const lines = message.split("\n").map((l) => l.trim()).filter(Boolean);
  let line = lines[0] ?? "Mermaid could not read it.";
  if (/^Parse error on line \d+:$/.test(line) && lines[1]) line = `Parse error at ${lines[1].replace(/^\.\.\.\s*/, "")}`;
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}
