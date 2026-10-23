import { ORG_CUE, LOC_CUE, ORG_SET, ORG_SET_CI, LOC_SET, ORG_SUF_END, LOC_SUF_END, STOP, escRe } from "./gazetteer.js";
import { RULES_LEGACY, RULES_NEW, RULES_HEUR, type Rule } from "./rules.js";
import type { Span, Warning } from "./types.js";

export function ruleSpans(text: string): Span[] {
  const out: Span[] = [];
  const sets: [Rule[], "rule" | "heur"][] = [[RULES_LEGACY, "rule"], [RULES_NEW, "rule"], [RULES_HEUR, "heur"]];
  for (const [rules, defSrc] of sets) {
    for (const [type0, re, src0] of rules) {
      const src = (src0 || defSrc) as "rule" | "heur";
      const type = type0 === "POSTAL" ? "ADDRESS" : type0;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        if (src === "heur" && type === "PERSON") {
          // drop stopwords (days, months, Mum...) from heuristic names
          const ws = m[0].split(/\s+/);
          if (STOP.has(ws[0]!.toLowerCase())) continue;
          const keep: string[] = [];
          for (const w of ws) { if (STOP.has(w.toLowerCase())) break; keep.push(w); }
          out.push({ s: m.index, e: m.index + keep.join(" ").length, type, src });
          continue;
        }
        out.push({ s: m.index, e: m.index + m[0].length, type, src });
      }
    }
  }
  return out;
}

/** Whole-word, case-insensitive matches of each deny string (priority 0). */
export function denySpans(text: string, deny: string[]): Span[] {
  const out: Span[] = [];
  for (const d of deny) {
    const w = d.trim();
    if (!w) continue;
    const re = new RegExp("(?<![\\p{L}\\p{N}])" + escRe(w) + "(?![\\p{L}\\p{N}])", "giu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push({ s: m.index, e: m.index + m[0].length, type: "PERSON", src: "deny" });
  }
  return out;
}

export const SRC_ORDER: Record<string, number> = { deny: 0, rule: 1, heur: 2, ner: 3, clue: 3.5, llm: 4, sweep: 5 };
const pri = (x: Span) => (x.src === "deny" ? 0 : x.src === "rule" ? 1 : x.src === "llm" ? 3 : 2);

/** Priority, then longest, then source order; a candidate overlapping a kept span is dropped. */
export function resolve(cands: Span[]): Span[] {
  const sorted = [...cands].sort((a, b) => pri(a) - pri(b) || (b.e - b.s) - (a.e - a.s) || (SRC_ORDER[a.src] ?? 9) - (SRC_ORDER[b.src] ?? 9) || a.s - b.s);
  // kept spans never overlap, so they are sorted by start AND end: only the
  // neighbour before the first start >= c.e can overlap c.
  const kept: Span[] = [];
  for (const c of sorted) {
    let lo = 0, hi = kept.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (kept[mid]!.s < c.e) lo = mid + 1; else hi = mid; }
    const prev = kept[lo - 1];
    if (prev && prev.e > c.s) continue;
    kept.splice(lo, 0, c);
  }
  return kept;
}

export function typeFix(t: string, s: number, e: number, type: string): string {
  if (type !== "LOC" && type !== "ORG") return type;
  const surf = t.slice(s, e);
  if (ORG_SET.has(surf) || ORG_SET_CI.has(surf.toLowerCase())) return "ORG";
  if (LOC_SET.has(surf)) return "LOC";
  if (ORG_SUF_END.test(surf)) return "ORG";
  const before = t.slice(Math.max(0, s - 40), s);
  if (type === "LOC" && ORG_CUE.test(before)) return "ORG";
  if (type === "ORG" && (LOC_SUF_END.test(surf) || LOC_CUE.test(before))) return "LOC";
  return type;
}

export interface DetectOpts {
  deny: string[];
  minScore: number;
  /** A stage reports partial detection here; never with an original value. */
  warn: (w: Warning) => void;
}

/** A detector. `priority` orders stages for a stable candidate list; which
 *  span wins an overlap is decided by the span's `src` (resolve). */
export type Stage = {
  name: string;
  priority: number;
  detect(text: string, opts: DetectOpts): Span[] | Promise<Span[]>;
};

export const denyStage: Stage = { name: "deny", priority: 0, detect: (t, o) => denySpans(t, o.deny) };
export const ruleStage: Stage = { name: "rules", priority: 1, detect: (t) => ruleSpans(t) };

export async function detectAll(text: string, stages: Stage[], opts: DetectOpts): Promise<Span[]> {
  const cands: Span[] = [];
  for (const st of [...stages].sort((a, b) => a.priority - b.priority)) cands.push(...(await st.detect(text, opts)));
  return resolve(cands);
}
