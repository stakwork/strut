// A fenced block of markdown as react-markdown hands it to a component: the
// `<pre>` element's hast node (DocumentView draws a ```mermaid one as a
// diagram).

/** A hast node (what react-markdown hands a component as `node`), as far as
 *  a fenced block's code is read. */
export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

/** The text of a `<pre>` that is one fenced block in `lang` (its code's
 *  class `language-<lang>`), or null. */
export function fencedSource(pre: HastNode | undefined, lang: string): string | null {
  const code = pre?.children?.find((c) => c.type === "element");
  const classes = code?.tagName === "code" ? code.properties?.className : undefined;
  if (!Array.isArray(classes) || !classes.includes(`language-${lang}`)) return null;
  const text = (n: HastNode): string => (n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(text).join(""));
  return text(code!);
}
