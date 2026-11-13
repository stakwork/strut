/**
 * `task/set-type` (plans/human-steps.md §9.8): the builder ASKS for a task
 * type, an ADMIN says yes. The pieces the step, its door and its tests
 * share:
 *
 * - `typeChangeInput`: the step's input — the name and the fields to change,
 *   as `PUT /tasks/types/:name` takes them — every field checked as the store
 *   checks it (the answer's shape by `answerSchemaProblem`, the tests and
 *   copies rules by their own checks), so a bad shape is refused to the
 *   model before any proposal is made.
 * - `mergeType`: the change merged over the type when there is one (ruled,
 *   §9.12): a field left out keeps its value, and a `tests` or `copies`
 *   object is merged over the type's own rules. A new type needs `answer`.
 * - `createTaskTypes`: `ctx.services.taskTypes` on the shared bag (§9.2) —
 *   `list()` (each type with its open tasks, how many workers hold it and
 *   its answers over the last week), the card's two reads, and `save`,
 *   which opens only for an ACCEPTED `task/set-type` proposal on disk for
 *   that name and that input, the admin's edits included, and saves the type
 *   with that admin as `changedBy`. It grants no worker, deletes no type and
 *   changes no worker: those are a person's, in `strut/staff`.
 * - `typeCard`: the card (`describe`). It reads a type's rules, never a
 *   test: no expected answer is on it.
 */
import { z } from "zod";
import type { CardField, ProposalDescription } from "../core.js";
import type { Proposal } from "../proposals.js";
import { answerSchemaProblem } from "./answer-schema.js";
import { copiesRuleOf } from "./task-copies.js";
import { RuleProblem, sameJson, testRulesOf } from "./task-tests.js";
import { DEFAULT_HOLD_HOURS, type CopiesRule, type GradeRule, type TaskType, type TestRules } from "./task-store.js";
import {
  DEFAULT_LEASE_SECONDS,
  DEFAULT_WITHIN_HOURS,
  HOLD_HOURS_MAX,
  HOLD_HOURS_MIN,
  LEASE_SECONDS_MAX,
  PAY_SATS_MAX,
  TaskError,
  TYPE_NAME_MAX,
  TYPE_NAME_RE,
  WITHIN_HOURS_MAX,
  type TasksCapability,
  type TaskTypeInput,
} from "./tasks.js";

export const SET_TYPE_STEP = "task/set-type";

/** A grader is checked when the type is saved (the registry's); here only
 *  the rules' shape. */
const shapeOnly = (): undefined => undefined;

/** A rule's check, its refusal as the field's issue. */
function ruleIssue(c: z.RefinementCtx, check: () => unknown): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof RuleProblem)) throw err;
    c.addIssue({ code: "custom", message: err.message });
  }
}

/** The step's input: what `PUT /tasks/types/:name` takes, the name beside
 *  it, every field optional but `app`, each checked as the store checks it. */
export const typeChangeInput = z.object({
  name: z
    .string()
    .max(TYPE_NAME_MAX)
    .regex(TYPE_NAME_RE, 'a task type\'s name is lowercase letters, digits, ".", "_" and "-", segments joined by "/"')
    .describe("The task type's name, as a `human` step's `task` names it (pet-match, acme/pet-match). An existing type is changed; a new name makes a new type."),
  app: z.string().min(1).describe("The app that draws its tasks: the worker app, which must grant task/next and task/submit (task/* covers them)."),
  answer: z
    .any()
    .optional()
    .superRefine((v, c) => {
      if (v === undefined) return;
      const problem = answerSchemaProblem(v);
      if (problem) c.addIssue({ code: "custom", message: `answer: ${problem}` });
    })
    .describe(
      "The answer's shape, a JSON Schema in the subset strut checks: `type` on every schema; `properties` + `required`; `items`, `minItems`, `maxItems`; `enum`; `minimum`, `maximum`; `minLength`, `maxLength`; `title`, `description`. " +
        "An object of plain fields (text, numbers, yes or no, a pick from an enum) is drawn by strut/views' TaskForm; anything else needs the app's own view. Required for a new type; left out, a type keeps its shape.",
    ),
  leaseSeconds: z.number().int().min(1).max(LEASE_SECONDS_MAX).optional().describe("How long a worker holds a task once taken, in seconds (600 for a new type)."),
  withinHours: z.number().positive().max(WITHIN_HOURS_MAX).optional().describe("How long a task may wait unanswered before it expires, in hours (72 for a new type); a `human` step may set its own."),
  enabled: z.boolean().optional().describe("false turns the type off: no new task of it, and its open tasks are not handed out and expire when due."),
  paySats: z
    .number()
    .min(0)
    .max(PAY_SATS_MAX)
    .optional()
    .refine((v) => v === undefined || Math.abs(v * 1000 - Math.round(v * 1000)) <= 1e-6, "paySats is sats to the msat (at most three decimals)")
    .describe("What one accepted answer earns its worker, in sats (0: unpaid, a new type's default). A rise is shown to the admin as a danger."),
  holdHours: z.number().min(HOLD_HOURS_MIN).max(HOLD_HOURS_MAX).optional().describe(`How long an earning waits before it can be withdrawn, in hours (${HOLD_HOURS_MIN} to ${HOLD_HOURS_MAX}; 72 for a new type).`),
  tests: z
    .record(z.string(), z.any())
    .nullable()
    .optional()
    .superRefine((v, c) => ruleIssue(c, () => testRulesOf(v, shapeOnly)))
    .describe("Test tasks mixed among its tasks to qualify and score workers: { rate, newRate, newTasks, qualify, window, minGraded, threshold, grade, gradeCapUsd }, merged over the type's own (or the defaults); null turns them off. The tests themselves are an admin's, in strut/staff."),
  copies: z
    .record(z.string(), z.any())
    .nullable()
    .optional()
    .superRefine((v, c) => ruleIssue(c, () => copiesRuleOf(v, shapeOnly)))
    .describe("How many workers a `human` step may ask one task, each paid: { max, agree, compare, onDisagree }, merged over the type's own (or the defaults: 3, 2, \"equal\", \"more\"); null: one worker a task."),
});

/** What `task/set-type` asks, as its schema parsed it. */
export type TypeChange = z.infer<typeof typeChangeInput>;
/** The fields to change, without the name: what `save` takes. */
export type TypeFields = Omit<TypeChange, "name">;

/** One type as `list()` reads it: the type, without who saved it last
 *  (who is the staff's to read), with its open tasks, how many workers hold
 *  it and its answers in the last 7 days — where the store counts them (a
 *  host's own store may not). */
export type TaskTypeRow = Omit<TaskType, "changedBy"> & { open?: number; workers?: number; answeredWeek?: number };

/** `ctx.services.taskTypes` (plans/human-steps.md §9.2, §9.8). */
export interface TaskTypesCapability {
  list(): Promise<TaskTypeRow[]>;
  /** What is wrong with the app a type names (`taskAppProblem`), or undefined. */
  appProblem(app: string): Promise<string | undefined>;
  /** Dollars per bitcoin now, or undefined when no rate can be read. */
  usdPerBtc(): Promise<number | undefined>;
  /** Saves `name` merged with `change` — only as the apply of an ACCEPTED
   *  `task/set-type` proposal for that very name and input, its admin as
   *  `changedBy`. */
  save(name: string, change: TypeFields, o: { proposal: string; actor?: string }): Promise<TaskType>;
}

export interface TaskTypesDeps {
  /** The store the staff routes hold: strut's own, or a host's. */
  tasks: Pick<TasksCapability, "types" | "setType"> & Partial<Pick<TasksCapability, "stats">>;
  /** A proposal's record on disk, or null. */
  proposal(id: string): Promise<Proposal | null>;
  appProblem?(app: string): Promise<string | undefined>;
  usdPerBtc?(): Promise<number>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `change` merged over `existing` (ruled, §9.12): what is left out keeps
 *  its value; `tests` and `copies` merge over the type's own rules, `null`
 *  turns them off. A new type needs `answer` (`bad_request`). */
export function mergeType(name: string, existing: Pick<TaskType, "app" | "answer" | "leaseSeconds" | "withinHours" | "enabled" | "paySats" | "holdHours" | "tests" | "copies"> | undefined, change: TypeFields): TaskTypeInput {
  const answer = change.answer !== undefined ? change.answer : existing?.answer;
  if (answer === undefined) throw new TaskError("bad_request", `task type ${name} is new: it needs answer, the shape of its answer`);
  const rules = <T extends object>(was: T | undefined, given: Record<string, unknown> | null | undefined): Partial<T> | null | undefined =>
    given === undefined ? was : given === null ? null : ({ ...(was ?? {}), ...given } as Partial<T>);
  const out: TaskTypeInput = { app: change.app ?? existing?.app ?? "", answer };
  const leaseSeconds = change.leaseSeconds ?? existing?.leaseSeconds;
  const withinHours = change.withinHours ?? existing?.withinHours;
  const enabled = change.enabled ?? existing?.enabled;
  const paySats = change.paySats ?? existing?.paySats;
  const holdHours = change.holdHours ?? existing?.holdHours;
  const tests = rules<TestRules>(existing?.tests, change.tests);
  const copies = rules<CopiesRule>(existing?.copies, change.copies);
  if (leaseSeconds !== undefined) out.leaseSeconds = leaseSeconds;
  if (withinHours !== undefined) out.withinHours = withinHours;
  if (enabled !== undefined) out.enabled = enabled;
  if (paySats !== undefined) out.paySats = paySats;
  if (holdHours !== undefined) out.holdHours = holdHours;
  if (tests !== undefined) out.tests = tests;
  if (copies !== undefined) out.copies = copies;
  return out;
}

export function createTaskTypes(deps: TaskTypesDeps): TaskTypesCapability {
  const { tasks } = deps;
  return {
    async list() {
      const types = await tasks.types();
      const stats = typeof tasks.stats === "function" ? await tasks.stats().catch(() => undefined) : undefined;
      const counted = new Map((stats?.types ?? []).map((s) => [s.type, s]));
      return types.map((t) => {
        const { changedBy: _who, ...type } = t;
        const s = counted.get(t.name);
        return { ...type, ...(s ? { open: s.waiting + s.working, workers: s.granted, answeredWeek: s.windows.week.answered } : {}) };
      });
    },

    async appProblem(app) {
      return deps.appProblem ? deps.appProblem(app).catch(() => undefined) : undefined;
    },

    async usdPerBtc() {
      if (!deps.usdPerBtc) return undefined;
      const rate = await deps.usdPerBtc().catch(() => undefined);
      return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : undefined;
    },

    async save(name, change, o) {
      // The door: an ACCEPTED proposal of this very step, only an admin's to
      // accept, for this name and this input — the admin's edits merged as
      // the decision merged them, parsed as the step parses them.
      const rec = typeof o?.proposal === "string" ? await deps.proposal(o.proposal) : null;
      const asked = rec ? { ...(isRecord(rec.input) ? rec.input : {}), ...(isRecord(rec.decision?.input) ? rec.decision.input : {}) } : {};
      const parsed = typeChangeInput.safeParse(asked);
      if (!rec || rec.step !== SET_TYPE_STEP || rec.status !== "accepted" || rec.approver !== "admin" || !parsed.success || !sameJson(parsed.data, { ...change, name })) {
        throw new Error(
          `set_type_needs_admin: saving the task type ${name} runs only as the apply of a proposal an admin accepted for it` +
            (rec ? ` (proposal ${rec.id} is ${rec.status}, for ${rec.step}${isRecord(rec.input) && typeof rec.input["name"] === "string" ? ` ${rec.input["name"]}` : ""})` : ""),
        );
      }
      const existing = (await tasks.types()).find((t) => t.name === name);
      const by = rec.decision?.by ?? o.actor;
      return tasks.setType(name, mergeType(name, existing, change), by);
    },
  };
}

// ── the card ────────────────────────────────────────────────────────────────

/** The type as it would be saved, every field filled; what is wrong with a
 *  field the save would refuse (the merged rules), by field. */
interface Planned {
  app: string;
  answer: unknown;
  leaseSeconds: number;
  withinHours: number;
  enabled: boolean;
  paySats: number;
  holdHours: number;
  tests?: TestRules;
  copies?: CopiesRule;
}

const plannedOf = (t: TaskTypeRow): Planned => ({
  app: t.app,
  answer: t.answer,
  leaseSeconds: t.leaseSeconds,
  withinHours: t.withinHours,
  enabled: t.enabled,
  paySats: t.paySats ?? 0,
  holdHours: t.holdHours,
  ...(t.tests ? { tests: t.tests } : {}),
  ...(t.copies ? { copies: t.copies } : {}),
});

function plan(name: string, existing: TaskTypeRow | undefined, change: TypeFields): { planned: Planned; problems: { answer?: string; tests?: string; copies?: string } } {
  const problems: { answer?: string; tests?: string; copies?: string } = {};
  let merged: TaskTypeInput;
  try {
    merged = mergeType(name, existing, change);
  } catch (err) {
    problems.answer = err instanceof Error ? err.message.replace(/^bad_request: /, "") : String(err);
    merged = { ...mergeType(name, existing, { ...change, answer: null }), answer: undefined };
  }
  const rule = <T>(key: "tests" | "copies", check: () => T | undefined): T | undefined => {
    try {
      return check();
    } catch (err) {
      problems[key] = err instanceof Error ? err.message : String(err);
      return undefined;
    }
  };
  const tests = rule("tests", () => testRulesOf(merged.tests, shapeOnly));
  const copies = rule("copies", () => copiesRuleOf(merged.copies, shapeOnly));
  const pay = merged.paySats && merged.paySats > 0 ? Math.round(merged.paySats * 1000) / 1000 : 0;
  return {
    planned: {
      app: merged.app,
      answer: merged.answer,
      leaseSeconds: merged.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
      withinHours: merged.withinHours ?? DEFAULT_WITHIN_HOURS,
      enabled: merged.enabled ?? true,
      paySats: pay,
      holdHours: merged.holdHours ?? DEFAULT_HOLD_HOURS,
      ...(tests ? { tests } : {}),
      ...(copies ? { copies } : {}),
    },
    problems,
  };
}

const plural = (n: number, w: string) => `${n.toLocaleString("en-US", { maximumFractionDigits: 3 })} ${w}${n === 1 ? "" : "s"}`;
const roundMsat = (sats: number) => Math.round(sats * 1000) / 1000;
const satsText = (sats: number) => plural(roundMsat(sats), "sat");
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
/** Dollars as the cards write them (`usdText`, src/remote.ts). */
const usdText = (n: number) => (n === 0 || Math.abs(n) >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toPrecision(2)}`);

/** A lease's length in the unit it is a whole number of. */
export function secondsText(s: number): string {
  if (s % 3600 === 0) return plural(s / 3600, "hour");
  if (s % 60 === 0) return plural(s / 60, "minute");
  return plural(s, "second");
}

/** Why `schema` is not a flat form strut/views' TaskForm draws, or null:
 *  kit/src/folds/answer-form.ts's `formProblem`, which the engine's build
 *  cannot import (set-type.test.ts holds the two to the same verdict). */
export function formProblem(schema: unknown): string | null {
  if (!isRecord(schema) || schema["type"] !== "object") return "the answer is not an object of fields";
  const props = schema["properties"];
  if (!isRecord(props) || !Object.keys(props).length) return "the answer has no fields";
  for (const [name, raw] of Object.entries(props)) {
    if (!isRecord(raw)) return `${name} has no schema`;
    const type = raw["type"];
    const items = isRecord(raw["items"]) ? raw["items"] : undefined;
    if (type === "string" || type === "number" || type === "integer" || type === "boolean") continue;
    if (type === "array" && ((Array.isArray(items?.["enum"]) && items["enum"].length) || (Array.isArray(items?.["anyOf"]) && items["anyOf"].length))) continue;
    if (type === "array") return `${name} is a list of values a form cannot pick from (no enum)`;
    return `${name} is ${type === "object" ? "a nested object" : `of type ${String(type)}`}`;
  }
  return null;
}

const between = (lo: unknown, hi: unknown, what: (lo: string, hi: string) => [string, string, string]): string => {
  const [both, low, high] = what(String(lo), String(hi));
  if (typeof lo === "number" && typeof hi === "number") return both;
  if (typeof lo === "number") return low;
  if (typeof hi === "number") return high;
  return "";
};

/** One field of a flat form, as the card writes it: `same: yes or no, required`. */
function fieldLine(key: string, p: Record<string, unknown>, required: boolean): string {
  const title = typeof p["title"] === "string" && p["title"] ? ` ("${p["title"]}")` : "";
  let kind: string;
  if (Array.isArray(p["enum"])) kind = `one of ${p["enum"].map(String).join(", ")}`;
  else if (p["type"] === "boolean") kind = "yes or no";
  else if (p["type"] === "string") kind = `text${between(p["minLength"], p["maxLength"], (a, b) => [` of ${a} to ${b} characters`, ` of at least ${a} characters`, ` up to ${b} characters`])}`;
  else if (p["type"] === "number" || p["type"] === "integer") {
    kind = `${p["type"] === "integer" ? "a whole number" : "a number"}${between(p["minimum"], p["maximum"], (a, b) => [` from ${a} to ${b}`, ` of at least ${a}`, ` of at most ${b}`])}`;
  } else {
    const items = isRecord(p["items"]) ? p["items"] : {};
    const options = Array.isArray(items["enum"]) ? items["enum"].map(String) : Array.isArray(items["anyOf"]) ? items["anyOf"].map((o) => String(isRecord(o) ? (o["title"] ?? o["const"]) : o)) : [];
    kind = `any of ${options.join(", ")}${between(p["minItems"], p["maxItems"], (a, b) => [` (${a} to ${b} of them)`, ` (at least ${a})`, ` (at most ${b})`])}`;
  }
  return `${key}${title}: ${kind}${required ? ", required" : ""}`;
}

/** The answer as the card says it: one line per field, or what the app must
 *  draw itself, with the schema. */
export function answerText(schema: unknown): string {
  const problem = formProblem(schema);
  if (problem) return `needs the app's own view (${problem}):\n${JSON.stringify(schema)}`;
  const s = schema as { properties: Record<string, Record<string, unknown>>; required?: unknown };
  const required = new Set(Array.isArray(s.required) ? s.required : []);
  return Object.entries(s.properties)
    .map(([k, p]) => fieldLine(k, p, required.has(k)))
    .join("\n");
}

const gradeText = (g: GradeRule) => (g === "equal" ? "equal answers" : `the step ${g.step}`);

export function testsText(r: TestRules | undefined): string {
  if (!r) return "off";
  return (
    `on: ${pct(r.rate)} of tasks are tests (${pct(r.newRate)} until a worker has answered ${r.newTasks} real ones); ` +
    `${r.qualify ? `${plural(r.qualify, "test")} to qualify before any real task` : "no qualifying"}; ` +
    `a grant is revoked under ${pct(r.threshold)} passed of the last ${r.window} graded, read once ${r.minGraded} are; ` +
    `graded by ${gradeText(r.grade)}${r.grade === "equal" ? "" : `, at most ${usdText(r.gradeCapUsd)} a grading`}`
  );
}

export function copiesText(c: CopiesRule | undefined): string {
  if (!c) return "off: a step asks one worker";
  return (
    `on: a step may ask up to ${plural(c.max, "worker")}, each paid; ${c.agree} matching answers settle a task, compared by ${gradeText(c.compare)}; ` +
    `when they disagree ${c.onDisagree === "more" ? `one more worker is asked, up to ${c.max}` : "the task is disputed"}`
  );
}

const ruleValue = (v: unknown) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));

/** A rules object's change, key by key: `tests: rate 0.05 → 0.1`. */
function rulesDiff(label: string, before: object | undefined, after: object | undefined): string | undefined {
  if (!before && !after) return undefined;
  if (!before) return `${label}: off → on`;
  if (!after) return `${label}: on → off`;
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const keys = Object.keys(a).filter((k) => !sameJson(b[k], a[k]));
  return keys.length ? `${label}: ${keys.map((k) => `${k} ${ruleValue(b[k])} → ${ruleValue(a[k])}`).join(", ")}` : undefined;
}

const onOff = (on: boolean) => (on ? "on" : "off");

/**
 * The card (§9.8): what the type would be, and for a change what changes;
 * the app's problem and a rise in pay marked as dangers. `existing` is the
 * type as `list()` reads it; `appProblem` and `usdPerBtc` the door's reads.
 */
export function typeCard(cfg: TypeChange, o: { existing?: TaskTypeRow; appProblem?: string; usdPerBtc?: number } = {}): ProposalDescription {
  const { name, ...change } = cfg;
  const { existing, appProblem, usdPerBtc } = o;
  const { planned: after, problems } = plan(name, existing, change);
  const before = existing ? plannedOf(existing) : undefined;
  const turnsOff = !!before?.enabled && !after.enabled;
  const title = !existing ? `New task type ${name}` : turnsOff ? `Turn off task type ${name}` : `Change task type ${name}`;
  const dollars = (sats: number) => (usdPerBtc ? ` (${usdText((roundMsat(sats) * usdPerBtc) / 1e8)})` : "");

  // What changes, field by field.
  const changes: string[] = [];
  if (before) {
    if (before.app !== after.app) changes.push(`drawn by: ${before.app} → ${after.app}`);
    if (after.answer !== undefined && !sameJson(before.answer, after.answer)) changes.push("answer: a new shape (see The answer)");
    if (before.leaseSeconds !== after.leaseSeconds) changes.push(`lease: ${secondsText(before.leaseSeconds)} → ${secondsText(after.leaseSeconds)}`);
    if (before.withinHours !== after.withinHours) changes.push(`expires after: ${plural(before.withinHours, "hour")} → ${plural(after.withinHours, "hour")}`);
    if (before.enabled !== after.enabled) changes.push(after.enabled ? "turned on" : "turned off");
    if (before.paySats !== after.paySats) changes.push(`pay: ${before.paySats ? satsText(before.paySats) : "unpaid"} → ${after.paySats ? satsText(after.paySats) : "unpaid"}`);
    if (before.holdHours !== after.holdHours) changes.push(`hold: ${plural(before.holdHours, "hour")} → ${plural(after.holdHours, "hour")}`);
    if (!problems.tests) {
      const d = rulesDiff("tests", before.tests, after.tests);
      if (d) changes.push(d);
    }
    if (!problems.copies) {
      const d = rulesDiff("copies", before.copies, after.copies);
      if (d) changes.push(d);
    }
  }
  const shapeChanged = !!before && after.answer !== undefined && !sameJson(before.answer, after.answer);
  const payBefore = before?.paySats ?? 0;
  const rises = after.paySats > payBefore;

  const fields: CardField[] = [];
  fields.push({ label: "Drawn by", value: appProblem ? `${after.app} — ${appProblem}` : after.app, ...(appProblem ? { danger: true } : {}) });
  fields.push(
    after.answer === undefined
      ? { label: "The answer", value: `none given — ${problems.answer ?? "a new type needs one"}`, danger: true }
      : { label: "The answer", value: answerText(after.answer) },
  );
  fields.push({ label: "Lease", value: secondsText(after.leaseSeconds) });
  fields.push({ label: "Expires after", value: `${plural(after.withinHours, "hour")} unanswered` });
  fields.push({ label: "On", value: onOff(after.enabled) });
  if (before) {
    fields.push({ label: "What changes", value: changes.length ? changes.join("\n") : "nothing: the type is already so" });
    const open = existing?.open;
    fields.push({
      label: "Open tasks",
      value:
        open === undefined
          ? "not counted on this server"
          : turnsOff && open
            ? `${open}: not handed out once it is off; they expire when due`
            : shapeChanged && open
              ? `${open}: their answers are checked against the new shape when submitted`
              : String(open),
    });
  }
  const workers = existing?.workers;
  fields.push({
    label: "Workers",
    value: !existing
      ? "none: this grants it to nobody — an admin grants workers in Tasks and workers (strut/staff)"
      : workers === undefined
        ? "not counted on this server"
        : `${workers} hold it`,
  });
  let pay = after.paySats ? `${satsText(after.paySats)} an answer${dollars(after.paySats)}, held ${plural(after.holdHours, "hour")} before it can be withdrawn` : "unpaid";
  if (before && payBefore !== after.paySats) pay += `; now ${payBefore ? `${satsText(payBefore)}${dollars(payBefore)}` : "unpaid"}`;
  const week = existing?.answeredWeek;
  if (existing && week !== undefined) {
    pay += !week
      ? ". No answers in the last week"
      : `. The last week's ${plural(week, "answer")} would have cost ${satsText(week * after.paySats)}${dollars(week * after.paySats)}` +
        (payBefore !== after.paySats ? `, against ${satsText(week * payBefore)}${dollars(week * payBefore)} at the pay now` : "");
  }
  fields.push({ label: "Pay", value: pay, ...(rises ? { danger: true } : {}) });
  fields.push(problems.tests ? { label: "Tests", value: `refused: ${problems.tests}`, danger: true } : { label: "Tests", value: testsText(after.tests) });
  fields.push(problems.copies ? { label: "Copies", value: `refused: ${problems.copies}`, danger: true } : { label: "Copies", value: copiesText(after.copies) });

  const lines: string[] = [];
  if (!existing) {
    lines.push(`A new task type ${name}, drawn by the app ${after.app}: a \`human\` step that names it makes a task a worker answers there.`);
    lines.push("It grants it to no worker: an admin does, in Tasks and workers.");
  } else if (turnsOff) {
    lines.push(`Turns off the task type ${name}: a \`human\` step can make no new task of it, and its open tasks are not handed out and expire when due.`);
  } else {
    lines.push(changes.length ? `Changes the task type ${name}: ${changes.map((c) => c.split(":")[0]).join(", ")}.` : `Changes nothing in the task type ${name}: it is already so.`);
  }
  if (appProblem) lines.push(`Workers cannot answer it yet: ${appProblem}.`);
  if (rises) lines.push(`Its pay rises from ${payBefore ? satsText(payBefore) : "nothing"} to ${satsText(after.paySats)} an answer${dollars(after.paySats)}.`);
  const fails = problems.answer ?? problems.tests ?? problems.copies;
  if (fails) lines.push(`Accepting it fails: ${fails}.`);
  return { title, summary: lines.join(" "), fields, actions: { accept: "Save type", reject: "Don't" }, full: true };
}
