/**
 * Exact-match edits of a node's text (`graph/edit-node`'s `edits`): each
 * quotes the text it changes, so a writer changes the lines it means to and
 * never sends a whole page back, where a line it failed to copy is lost
 * (plans/dream-memory.md, Peel 2026-11-16).
 */
export interface TextEdit {
  /** The text property it changes. Default `docs`. */
  property?: string;
  /** The text as it is now, which must occur exactly once. */
  old: string;
  /** What it becomes. */
  new: string;
}

/** The text properties after `edits`, applied in order, each to the result
 *  of the ones before. Throws, naming the edit, when an `old` is empty or is
 *  not found exactly once. */
export function applyTextEdits(props: Record<string, unknown>, edits: readonly TextEdit[]): Record<string, string> {
  const out: Record<string, string> = {};
  edits.forEach((e, i) => {
    const prop = e.property || "docs";
    const at = `edits[${i}]`;
    const now = prop in out ? out[prop] : props[prop];
    if (!e.old) throw new Error(`${at}: \`old\` is empty; quote the text you change`);
    if (typeof now !== "string" || !now) throw new Error(`${at}: the node has no ${prop} text to change; set it with node_data`);
    const first = now.indexOf(e.old);
    if (first < 0) throw new Error(`${at}: \`old\` is not in ${prop}; read the node again and quote its text exactly`);
    if (now.indexOf(e.old, first + 1) >= 0) throw new Error(`${at}: \`old\` occurs more than once in ${prop}; quote more of the text around it so it occurs once`);
    out[prop] = now.slice(0, first) + e.new + now.slice(first + e.old.length);
  });
  return out;
}
