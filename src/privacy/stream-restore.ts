import { restore } from "./restore.js";
import type { TokenMap } from "./types.js";

// What could still become a token if more text arrives: an open bracket, or a trailing word
// that looks like the start of TYPE_N (upper case: restore.ts takes no bare lower-case token).
// Held back until the next delta (or the end).
const OPEN_BRACKET = /\[[^\]\n]{0,16}$/;
const TRAILING_WORD = /(?<![A-Za-z0-9_])[A-Z]{1,10}_?\d{0,4}[a-z]?$/;

/** Restore real values in a stream of text deltas: a pseudonym split across deltas is never
 *  emitted half restored. Concatenated, the output equals `restore(whole)`. */
export class StreamRestorer {
  private buf = "";
  restored = 0;
  constructor(private map: TokenMap, private escape?: (s: string) => string) {}

  private run(s: string): string {
    const r = restore(s, this.map, this.escape);
    this.restored += r.restored;
    return r.text;
  }

  push(delta: string): string {
    this.buf += delta;
    const a = OPEN_BRACKET.exec(this.buf)?.index ?? this.buf.length;
    const b = TRAILING_WORD.exec(this.buf)?.index ?? this.buf.length;
    const cut = Math.min(a, b);
    const ready = this.buf.slice(0, cut);
    this.buf = this.buf.slice(cut);
    return ready ? this.run(ready) : "";
  }

  flush(): string {
    const rest = this.buf;
    this.buf = "";
    return rest ? this.run(rest) : "";
  }
}
