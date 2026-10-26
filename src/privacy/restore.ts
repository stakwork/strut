import type { TokenMap } from "./types.js";

/** Put the originals back. Tolerates what a model does to a token: case, missing brackets,
 *  spaces. A token not in the map is left as it is and counted (never guessed). A token
 *  written literally in the ORIGINAL text is indistinguishable from ours; not handled.
 *  `escape` encodes a value for where the text is going (JSON strings). */
export function restore(text: string, map: TokenMap, escape?: (s: string) => string): { text: string; restored: number; unknown: number } {
  let restored = 0;
  const unknown = new Set<string>();
  const norm = (t: string, d: string, l: string) => "[" + t.toUpperCase() + "_" + d + (l || "").toLowerCase() + "]";
  const re = /\[\s*([A-Za-z]{2,10})[\s_-]?(\d{1,4})([a-z]?)\s*\]|(?<![A-Za-z0-9_])([A-Za-z]{2,10})_(\d{1,4})([a-z]?)(?![A-Za-z0-9_])/g;
  const out = text.replace(re, (m, t1, d1, l1, t2, d2, l2) => {
    const key = t1 ? norm(t1, d1, l1) : norm(t2, d2, l2);
    const hit = Object.hasOwn(map, key) ? map[key] : undefined;
    if (hit) { restored++; return escape ? escape(hit.value) : hit.value; }
    unknown.add(key.replace(/\d/g, "#"));
    return m;
  });
  return { text: out, restored, unknown: unknown.size };
}
