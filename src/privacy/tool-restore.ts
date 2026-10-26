import { restore } from "./restore.js";
import type { TokenMap } from "./types.js";

/** A real value inside a JSON string: quotes, backslashes and control characters escaped. */
export const jsonEscape = (s: string): string => JSON.stringify(s).slice(1, -1);

/** The model wrote pseudonyms into a tool call's input; the tool is handed real values.
 *  JSON: each string value is restored and the document re-serialised. Not JSON: restored as text. */
export function restoreToolInput(raw: string, map: TokenMap): string {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return restore(raw, map, jsonEscape).text; }
  const walk = (x: unknown): unknown =>
    typeof x === "string" ? restore(x, map).text :
    Array.isArray(x) ? x.map(walk) :
    x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x;
  return JSON.stringify(walk(v));
}
