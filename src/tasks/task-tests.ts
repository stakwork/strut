/**
 * Tests, grading and standing: the pure parts (plans/human-steps.md §7.2,
 * §7.4, §7.5, item 4). A task type's test rules checked and filled from
 * §7.8's defaults, a grade rule checked, `equal`, and what a worker's
 * standing is, read from the store's rows (`StandingRow`). The service
 * (`tasks.ts`) holds the rest: serving, the grading queue, the revoke.
 */
import { DEFAULT_TEST_RULES, type GradeRule, type StandingRow, type TestRules } from "./task-store.js";
import type { Grant } from "./worker-store.js";

/** The bounds a type's rules are held to. */
export const QUALIFY_MAX = 100;
export const WINDOW_MAX = 1000;
export const NEW_TASKS_MAX = 100_000;
export const GRADE_CAP_USD_MAX = 5;

/** A rule a save refuses: the message, the caller makes it a refusal. */
export class RuleProblem extends Error {
  constructor(
    readonly code: "bad_request" | "bad_grader",
    message: string,
  ) {
    super(message);
  }
}

const RULE_KEYS = new Set<string>(Object.keys(DEFAULT_TEST_RULES));

/** A type's `tests` as saved: undefined (null or absent) is off; an object
 *  is §7.8's defaults with what staff set over them, every field checked. */
export function testRulesOf(raw: unknown, graderProblem: (step: string) => string | undefined): TestRules | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new RuleProblem("bad_request", "tests is an object of test rules, or null for none");
  for (const k of Object.keys(raw)) {
    if (!RULE_KEYS.has(k)) throw new RuleProblem("bad_request", `tests.${k} is not a test rule (${[...RULE_KEYS].join(", ")})`);
  }
  const set = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) as Partial<TestRules>;
  const r = { ...DEFAULT_TEST_RULES, ...set };
  const share = (k: "rate" | "newRate" | "threshold", min: number) => {
    const v = r[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > 1) throw new RuleProblem("bad_request", `tests.${k} is a share from ${min} to 1`);
  };
  const whole = (k: "newTasks" | "qualify" | "window" | "minGraded", min: number, max: number) => {
    const v = r[k];
    if (!Number.isSafeInteger(v) || v < min || v > max) throw new RuleProblem("bad_request", `tests.${k} is a whole number from ${min} to ${max}`);
  };
  share("rate", 0);
  share("newRate", 0);
  if (typeof r.threshold !== "number" || !Number.isFinite(r.threshold) || r.threshold <= 0 || r.threshold > 1) {
    throw new RuleProblem("bad_request", "tests.threshold is a share above 0, at most 1");
  }
  whole("newTasks", 0, NEW_TASKS_MAX);
  whole("window", 1, WINDOW_MAX);
  whole("qualify", 0, Math.min(QUALIFY_MAX, r.window));
  whole("minGraded", 1, r.window);
  if (typeof r.gradeCapUsd !== "number" || !Number.isFinite(r.gradeCapUsd) || r.gradeCapUsd <= 0 || r.gradeCapUsd > GRADE_CAP_USD_MAX) {
    throw new RuleProblem("bad_request", `tests.gradeCapUsd is dollars above 0, at most ${GRADE_CAP_USD_MAX}`);
  }
  return { ...r, grade: gradeRuleOf(r.grade, graderProblem) };
}

/** A grade rule as saved (§7.4, ruling 5): `equal`, or a registry step that
 *  may grade — sealed — with an optional config object. */
export function gradeRuleOf(raw: unknown, graderProblem: (step: string) => string | undefined): GradeRule {
  if (raw === "equal") return "equal";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RuleProblem("bad_request", 'grade is "equal" or { step, config? }');
  for (const k of Object.keys(raw)) if (k !== "step" && k !== "config") throw new RuleProblem("bad_request", `grade is { step, config? }, not ${k}`);
  const { step, config } = raw as { step?: unknown; config?: unknown };
  if (typeof step !== "string" || !step) throw new RuleProblem("bad_request", "grade.step names a registry step");
  if (config !== undefined && (!config || typeof config !== "object" || Array.isArray(config))) throw new RuleProblem("bad_request", "grade.config is an object");
  const problem = graderProblem(step);
  if (problem) throw new RuleProblem("bad_grader", problem);
  return { step, ...(config === undefined ? {} : { config: config as Record<string, unknown> }) };
}

/** §7.4's `equal`: the same JSON — object keys in any order, arrays in
 *  order, numbers by value. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b || (Number.isNaN(a) && Number.isNaN(b));
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bs = b as unknown[];
    return a.length === bs.length && a.every((x, i) => sameJson(x, bs[i]));
  }
  const ak = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const bk = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => Object.hasOwn(b as object, k) && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Where a worker is with a type's tests since their grant (§7.2 step 2,
 *  §7.5): `qualifying` — served only tests, until `qualify` of them are
 *  answered; `waiting` — answered, not yet graded, so served nothing of the
 *  type; `qualified` — real tasks, with tests drawn among them. An answer
 *  graded `error` counts neither way (§7.4), so another test takes its
 *  place. */
export type TestPhase = "qualifying" | "waiting" | "qualified";

export function phaseOf(row: Pick<StandingRow, "gradedAll" | "pending">, grant: Pick<Grant, "qualify">): TestPhase {
  const k = grant.qualify ?? 0;
  if (k <= 0 || row.gradedAll >= k) return "qualified";
  return row.gradedAll + row.pending < k ? "qualifying" : "waiting";
}

/** A worker's standing in one type, as staff read it (§7.5). */
export interface Standing {
  /** Still qualifying (or waiting for those grades): no real task yet. */
  qualifying: boolean;
  /** The grant's K (0: no qualifying). */
  qualify: number;
  /** Of the newest `window` graded tests since the grant: how many, and how
   *  many passed. */
  window: number;
  graded: number;
  passed: number;
  /** Since the grant: grader errors (counted neither way) and answers not
   *  graded yet. */
  errors: number;
  pending: number;
  minGraded: number;
  threshold: number;
}

export function standingOf(row: StandingRow, grant: Pick<Grant, "qualify">, rules: TestRules): Standing {
  return {
    qualifying: phaseOf(row, grant) !== "qualified",
    qualify: grant.qualify ?? 0,
    window: rules.window,
    graded: row.graded,
    passed: row.passed,
    errors: row.errors,
    pending: row.pending,
    minGraded: rules.minGraded,
    threshold: rules.threshold,
  };
}

/** §7.5's rule after a grade: why the grant goes (the revoke's `why`), or
 *  undefined while it stands. Qualifying is standing's first window: once
 *  K are graded the rule reads them, so it needs no more than K. */
export function revokeWhy(row: StandingRow, grant: Pick<Grant, "qualify">, rules: TestRules, type: string): string | undefined {
  const k = grant.qualify ?? 0;
  if (k > 0 && row.gradedAll < k) return undefined;
  const need = k > 0 ? Math.min(rules.minGraded, k) : rules.minGraded;
  if (row.graded < need || row.passed / row.graded >= rules.threshold) return undefined;
  const pct = `${Math.round(rules.threshold * 1000) / 10}%`;
  return k > 0 && row.gradedAll <= k
    ? `qualifying: passed ${row.passed} of ${row.graded} tests of ${type}, under ${pct}`
    : `standing: passed ${row.passed} of the last ${row.graded} tests of ${type}, under ${pct}`;
}
