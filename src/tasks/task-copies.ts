/**
 * Copies: the pure parts (plans/human-steps.md §7.6, item 4b). One `human`
 * step may ask several workers (`copies`); the task settles when enough of
 * their answers agree. A task type's copies rule checked and filled from
 * §7.8's defaults, the answers grouped, and the decision. The store
 * (`task-store*.ts`) writes it, the service (`tasks.ts`) holds the rest:
 * when to decide, a step comparator's runs, `onAgreed`.
 */
import { gradeRuleOf, RuleProblem } from "./task-tests.js";
import type { CopiesDecision, CopiesRule } from "./task-store.js";

/** The most copies a type may allow (`copies.max`), a guard against a slip. */
export const COPIES_MAX = 10;

/** §7.8's defaults, ruled. */
export const DEFAULT_COPIES_RULE: Readonly<CopiesRule> = Object.freeze({ max: 3, agree: 2, compare: "equal", onDisagree: "more" });

const RULE_KEYS = new Set<string>(Object.keys(DEFAULT_COPIES_RULE));

/** A type's `copies` as saved: undefined (null or absent) is off — its steps
 *  ask one worker; an object is §7.8's defaults with what staff set over
 *  them, every field checked. A step comparator is a grader (sealed). */
export function copiesRuleOf(raw: unknown, graderProblem: (step: string) => string | undefined): CopiesRule | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new RuleProblem("bad_request", "copies is an object of copies rules, or null for one worker a task");
  for (const k of Object.keys(raw)) {
    if (!RULE_KEYS.has(k)) throw new RuleProblem("bad_request", `copies.${k} is not a copies rule (${[...RULE_KEYS].join(", ")})`);
  }
  const set = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) as Partial<CopiesRule>;
  const r = { ...DEFAULT_COPIES_RULE, ...set };
  if (!Number.isSafeInteger(r.max) || r.max < 1 || r.max > COPIES_MAX) throw new RuleProblem("bad_request", `copies.max is a whole number from 1 to ${COPIES_MAX}`);
  if (!Number.isSafeInteger(r.agree) || r.agree < 1 || r.agree > r.max) throw new RuleProblem("bad_request", `copies.agree is a whole number from 1 to copies.max (${r.max})`);
  if (r.onDisagree !== "more" && r.onDisagree !== "fail") throw new RuleProblem("bad_request", 'copies.onDisagree is "more" (ask one more worker, up to max) or "fail"');
  // The grader's shape and check: `equal`, or a sealed step comparing two
  // answers in the grader's contract.
  let compare: CopiesRule["compare"];
  try {
    compare = gradeRuleOf(r.compare, graderProblem);
  } catch (err) {
    if (err instanceof RuleProblem) throw new RuleProblem(err.code, /^grade\b/.test(err.message) ? err.message.replace(/^grade/, "copies.compare") : `copies.compare: ${err.message}`);
    throw err;
  }
  return { max: r.max, agree: r.agree, compare, onDisagree: r.onDisagree };
}

/** The rule a task with copies is decided by: its type's; a type whose
 *  copies were turned off since is decided by `equal` and the default
 *  `agree`, never asking more. */
export function decidingRule(rule: CopiesRule | undefined): CopiesRule {
  return rule ?? { ...DEFAULT_COPIES_RULE, onDisagree: "fail" };
}

/** §7.6's grouping: each answer joins the group of the FIRST earlier answer
 *  it matches (`same(later, earlier)`), else starts its own. The answer at
 *  each index's group, by the index of the group's first answer. */
export function groupsOf(n: number, same: (later: number, earlier: number) => boolean): number[] {
  const groups: number[] = [];
  for (let i = 0; i < n; i++) {
    let g = i;
    for (let j = 0; j < i; j++) {
      if (same(i, j)) {
        g = groups[j]!;
        break;
      }
    }
    groups.push(g);
  }
  return groups;
}

/** The same with a comparator that answers later (a step's run): one
 *  comparison at a time, in the order `groupsOf` makes them. */
export async function groupsOfAsync(n: number, same: (later: number, earlier: number) => Promise<boolean>): Promise<number[]> {
  const groups: number[] = [];
  for (let i = 0; i < n; i++) {
    let g = i;
    for (let j = 0; j < i; j++) {
      if (await same(i, j)) {
        g = groups[j]!;
        break;
      }
    }
    groups.push(g);
  }
  return groups;
}

/** §7.6's decision over every answer asked for (`copies` of them, grouped):
 *  a group of `agree` or more — at most the answers the task wants — settles
 *  the task with its first answer; with two, the larger, then the earlier.
 *  Otherwise `more` asks one more worker while the task wants fewer than
 *  `max`; at `max`, or with `fail`, the task is disputed. */
export function decideCopies(groups: number[], rule: CopiesRule, copies: number): CopiesDecision {
  const agree = Math.min(rule.agree, copies);
  const sizes = new Map<number, number>();
  for (const g of groups) sizes.set(g, (sizes.get(g) ?? 0) + 1);
  let best: number | undefined;
  for (const [g, size] of sizes) {
    if (best === undefined || size > sizes.get(best)! || (size === sizes.get(best)! && g < best)) best = g;
  }
  if (best !== undefined && sizes.get(best)! >= agree) return { outcome: "agreed", index: best, agrees: groups.map((g) => g === best) };
  if (rule.onDisagree === "more" && copies < rule.max) return { outcome: "more" };
  return { outcome: "disputed" };
}
