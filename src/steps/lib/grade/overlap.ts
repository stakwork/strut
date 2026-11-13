import { z } from "zod";
import { defineStep } from "../../../core.js";

/**
 * A test's grader for boxes on an image (plans/human-steps.md §7.4, PR 4c).
 * Sealed: it reads every expected answer.
 *
 * A BOX is four numbers, `[x, y, w, h]` (the answer shape §4.5 names), or
 * `{ x, y, w, h }`: the top-left corner, then width and height above 0, in
 * whatever unit the worker app draws in (pixels or fractions), the same for
 * the answer and the expected one. The answer and `expected` are each a box,
 * a list of boxes (`[]` is none), or, with `key`, an object holding one of
 * those under `key`.
 *
 * It PASSES when the boxes pair off one to one, each pair's intersection over
 * union at least `min` (0.7). A missing box fails, and so does an extra one:
 * a box drawn where nothing is expected is wrong, and boxes drawn everywhere
 * must not pass. No boxes expected and none drawn passes.
 *
 * An `expected` that is not boxes is staff's mistake and throws, so the grade
 * is `error` and counts for nothing. An answer that is not boxes, when the
 * expected one is, fails: it fits the type's schema as `expected` does, so the
 * worker gave it (a box of no width, say).
 *
 * `content` names the counts and each expected box's IoU, never a coordinate.
 */

type Box = { x: number; y: number; w: number; h: number };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function box(v: unknown): Box | undefined {
  let n: unknown[] = [];
  if (Array.isArray(v)) n = v.length === 4 ? v : [];
  else if (v && typeof v === "object") n = ["x", "y", "w", "h"].map((k) => (v as Record<string, unknown>)[k]);
  const [x, y, w, h] = n;
  return finite(x) && finite(y) && finite(w) && finite(h) && w > 0 && h > 0 ? { x, y, w, h } : undefined;
}

/** The boxes `v` holds (under `key` when given), else a sentence saying why not. */
export function boxesOf(v: unknown, key?: string): Box[] | string {
  if (key !== undefined) {
    if (!v || typeof v !== "object" || Array.isArray(v) || !(key in v)) return `no "${key}" in it`;
    v = (v as Record<string, unknown>)[key];
  }
  const one = box(v);
  if (one) return [one];
  if (!Array.isArray(v)) return "not a box or a list of boxes";
  const list = v.map(box);
  const bad = list.findIndex((b) => !b);
  return bad < 0 ? (list as Box[]) : `item ${bad + 1} is not a box ([x, y, w, h] or { x, y, w, h }, w and h above 0)`;
}

export function iou(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const inter = w > 0 && h > 0 ? w * h : 0;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/** The most expected boxes that pair off one to one with answer boxes at
 *  IoU ≥ min (augmenting paths): `pair[e]` is the answer box of expected box
 *  `e`, or -1. */
function pairOff(fits: boolean[][], answers: number): number[] {
  const owner = new Array<number>(answers).fill(-1); // the expected box each answer box is paired with
  const place = (e: number, seen: Set<number>): boolean => {
    for (let a = 0; a < answers; a++) {
      if (!fits[e]![a] || seen.has(a)) continue;
      seen.add(a);
      if (owner[a] === -1 || place(owner[a]!, seen)) {
        owner[a] = e;
        return true;
      }
    }
    return false;
  };
  for (let e = 0; e < fits.length; e++) place(e, new Set());
  const pair = new Array<number>(fits.length).fill(-1);
  owner.forEach((e, a) => {
    if (e >= 0) pair[e] = a;
  });
  return pair;
}

const round = (n: number) => Math.round(n * 100) / 100;

export function gradeOverlap(answer: unknown, expected: unknown, min: number, key?: string): { supports: boolean; content: string } {
  const want = boxesOf(expected, key);
  if (typeof want === "string") throw new Error(`grade/overlap: the expected answer is not boxes: ${want}`);
  const got = boxesOf(answer, key);
  if (typeof got === "string") return { supports: false, content: `the answer is not boxes: ${got}` };
  const scores = want.map((e) => got.map((a) => iou(e, a)));
  const pair = pairOff(scores.map((row) => row.map((s) => s >= min)), got.length);
  const matched = pair.filter((a) => a >= 0).length;
  const supports = matched === want.length && matched === got.length;
  const each = want
    .slice(0, 20)
    .map((_, e) => `box ${e + 1}: ${pair[e]! >= 0 ? `IoU ${round(scores[e]![pair[e]!]!)}` : got.length ? `best IoU ${round(Math.max(...scores[e]!))}, unmatched` : "missing"}`);
  const extra = got.length - matched;
  return {
    supports,
    content: [
      `${want.length} expected, ${got.length} drawn, ${matched} matched at IoU ≥ ${min}`,
      ...each,
      ...(want.length > 20 ? [`and ${want.length - 20} more`] : []),
      ...(extra > 0 ? [`${extra} drawn box${extra === 1 ? "" : "es"} matched nothing expected`] : []),
    ].join("; "),
  };
}

export default defineStep({
  type: "grade/overlap",
  sealed: true,
  effect: "read",
  redact: ["expected"],
  description:
    "Grades a test task whose answer is boxes on an image (plans/human-steps.md §7.4): passes when the answer's boxes and the expected ones pair off one to one, " +
    "each pair's intersection over union at least `min` (0.7). A box is [x, y, w, h] or { x, y, w, h } in one unit for both; each side is a box, a list of them, or an object holding one under `key`. " +
    "A missing or extra box fails. Answers { supports, content }, the check contract. Sealed: a task type names it as its grader (`grade: { step: grade/overlap, config: { min } }`); no workflow runs it.",
  input: z.object({
    answer: z.unknown().describe("the worker's answer (the grader is handed it)"),
    expected: z.unknown().describe("the test's expected answer (the grader is handed it)"),
    min: z.number().gt(0).max(1).optional().describe("the least intersection over union a box must reach; default 0.7"),
    key: z.string().optional().describe("the field of the answer and the expected answer that holds the boxes, when each is an object"),
  }),
  output: z.object({ supports: z.boolean(), content: z.string() }),
  async run(cfg) {
    return gradeOverlap(cfg.answer, cfg.expected, cfg.min ?? 0.7, cfg.key);
  },
});
