import { resolve } from "./detect.js";
import { escRe } from "./gazetteer.js";
import type { Span, TokenMap } from "./types.js";

type Ent = { type: string; surface: string; first: number; token?: string; aliasOf?: Ent; aliasN: number };

/** Replace the resolved spans with typed numbered tokens ([PERSON_1]); a first name that is
 *  part of a full name in the text becomes an alias ([PERSON_1a]); other whole-word
 *  occurrences of a found name are swept. `allow` keeps words. */
export function pseudonymize(
  text: string,
  cands: Span[],
  opts: {
    allow: string[];
    /** Only these types are masked; a span of another type is dropped before anything else (and not swept). */
    mask?: string[];
    /** A span the mask list leaves visible → the sub-spans of it that must be masked anyway. */
    refine?: (sp: Span, text: string) => Span[];
    /** Tokens already handed out: reused for the same value, numbering goes on after them. Extended in place. */
    map?: TokenMap;
  },
): { out: string; map: TokenMap; counts: Record<string, number> } {
  const allow = new Set(opts.allow.map((a) => a.toLowerCase()));
  const keepType = opts.mask ? new Set(opts.mask) : undefined;
  if (keepType) cands = cands.flatMap((sp) => (keepType.has(sp.type) ? [sp] : opts.refine ? opts.refine(sp, text) : []));
  let spans = resolve(cands).filter((sp) => !allow.has(text.slice(sp.s, sp.e).toLowerCase()));
  const map: TokenMap = opts.map ?? {};
  const ents: Ent[] = [];
  const taken0 = new Set<string>();
  for (const [token, e] of Object.entries(map)) {
    ents.push({ type: e.type, surface: e.value.replace(/\s+/g, " "), first: -1, token, aliasN: 0 });
    taken0.add(token);
  }
  const find = (type: string, surface: string) => ents.find((x) => x.type === type && x.surface === surface);
  for (const sp of spans) {
    const surface = text.slice(sp.s, sp.e).replace(/\s+/g, " ");
    if (!find(sp.type, surface)) ents.push({ type: sp.type, surface, first: sp.s, aliasN: 0 });
  }
  const multi = ents.filter((x) => x.type === "PERSON" && x.surface.includes(" "));
  for (const e of ents) {
    if (e.type === "PERSON" && !e.surface.includes(" ")) {
      const f = multi.find((m) => m.surface.split(" ").includes(e.surface));
      if (f) e.aliasOf = f;
    }
  }
  const counters: Record<string, number> = {};
  for (const t of taken0) {
    const m = /^\[([A-Z_]+?)_(\d+)[a-z]?\]$/.exec(t);
    if (m) counters[m[1]!] = Math.max(counters[m[1]!] || 0, Number(m[2]));
  }
  for (const e of ents) {
    if (e.aliasOf || e.token) continue;
    counters[e.type] = (counters[e.type] || 0) + 1;
    e.token = "[" + e.type + "_" + counters[e.type] + "]";
  }
  const letter = (n: number) => String.fromCharCode(96 + n);
  const used = new Set(taken0);
  const aliasTok = (f: Ent) => {
    let tok: string;
    do { f.aliasN++; tok = f.token!.slice(0, -1) + letter(f.aliasN) + "]"; } while (used.has(tok));
    used.add(tok);
    return tok;
  };
  for (const e of ents) if (e.aliasOf && !e.token) e.token = aliasTok(e.aliasOf);

  const extra: Span[] = [];
  const taken = (s: number, e: number) => spans.some((k) => s < k.e && k.s < e) || extra.some((k) => s < k.e && k.s < e);
  const sweep = (type: string, surface: string) => {
    const re = new RegExp("(?<![\\p{L}\\p{N}_])" + escRe(surface).replace(/ /g, "\\s+") + "(?![\\p{L}\\p{N}_])", "gu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) if (!taken(m.index, m.index + m[0].length)) extra.push({ s: m.index, e: m.index + m[0].length, type, src: "sweep" });
  };
  for (const e of [...ents]) {
    if (["PERSON", "ORG", "LOC"].includes(e.type) && e.surface.length >= 3) sweep(e.type, e.surface);
  }
  for (const f of multi) {
    for (const w of f.surface.split(" ")) {
      if (w.length < 3 || !/^\p{Lu}/u.test(w)) continue;
      let alias = find("PERSON", w);
      const before = extra.length;
      sweep("PERSON", w);
      if (extra.length > before && !alias) {
        alias = { type: "PERSON", surface: w, first: 0, aliasN: 0, aliasOf: f };
        alias.token = aliasTok(f);
        ents.push(alias);
      }
    }
  }
  spans = [...spans, ...extra].sort((a, b) => a.s - b.s);

  const counts: Record<string, number> = {};
  let out = "";
  let cur = 0;
  for (const sp of spans) {
    const surface = text.slice(sp.s, sp.e);
    const ent = find(sp.type, surface.replace(/\s+/g, " "));
    if (!ent || !ent.token) continue;
    if (!map[ent.token]) { map[ent.token] = { type: sp.type, value: surface }; counts[sp.type] = (counts[sp.type] || 0) + 1; }
    out += text.slice(cur, sp.s) + ent.token;
    cur = sp.e;
  }
  out += text.slice(cur);
  return { out, map, counts };
}
