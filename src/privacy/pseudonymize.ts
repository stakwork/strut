import { resolve } from "./detect.js";
import { escRe } from "./gazetteer.js";
import type { Span, TokenMap } from "./types.js";

type Ent = { type: string; surface: string; first: number; token?: string; aliasOf?: Ent; aliasN: number };

/** Replace the resolved spans with typed numbered tokens ([PERSON_1]); a first name that is
 *  part of a full name in the text becomes an alias ([PERSON_1a]); other whole-word
 *  occurrences of a found name are swept. `allow` keeps words. */
export function pseudonymize(text: string, cands: Span[], opts: { allow: string[] }): { out: string; map: TokenMap; counts: Record<string, number> } {
  const allow = new Set(opts.allow.map((a) => a.toLowerCase()));
  let spans = resolve(cands).filter((sp) => !allow.has(text.slice(sp.s, sp.e).toLowerCase()));
  const ents: Ent[] = [];
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
  for (const e of ents) {
    if (e.aliasOf) continue;
    counters[e.type] = (counters[e.type] || 0) + 1;
    e.token = "[" + e.type + "_" + counters[e.type] + "]";
  }
  const letter = (n: number) => String.fromCharCode(96 + n);
  const aliasTok = (f: Ent) => { f.aliasN++; return f.token!.slice(0, -1) + letter(f.aliasN) + "]"; };
  for (const e of ents) if (e.aliasOf) e.token = aliasTok(e.aliasOf);

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

  const map: TokenMap = {};
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
