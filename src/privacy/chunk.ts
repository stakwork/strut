/** Split a text into [start, end) windows of about `max` chars at a newline, sentence or space, overlapping by about `ov`. */
export function chunk(t: string, max: number, ov: number): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  while (i < t.length) {
    let e = Math.min(t.length, i + max);
    if (e < t.length) {
      let k = t.lastIndexOf("\n", e);
      if (k <= i + max / 2) k = t.lastIndexOf(". ", e) + 1;
      if (k <= i + max / 2) k = t.lastIndexOf(" ", e);
      if (k > i) e = k;
    }
    out.push([i, e]);
    if (e >= t.length) break;
    let n = e;
    if (ov > 0) {
      const b = Math.max(i + 1, e - ov);
      const sp = t.indexOf(" ", b);
      if (sp >= 0 && sp + 1 < e) n = sp + 1;
    }
    i = n;
  }
  return out;
}
