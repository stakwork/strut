/**
 * `task/set-type` (plans/human-steps.md §9.8): the builder ASKS for a task
 * type, an ADMIN says yes. The pieces the step, its door and its tests
 * share:
 *
 * - `typeChangeInput`: the step's input — the name and the fields to change,
 *   as `PUT /tasks/types/:name` takes them — every field checked as the store
 *   checks it (the answer's shape by `answerSchemaProblem`, the tests and
 *   copies rules and the files an answer carries by their own checks), so a bad shape is refused to the
 *   model before any proposal is made.
 * - `mergeType`: the change merged over the type when there is one (ruled,
 *   §9.12): a field left out keeps its value, and a `tests` or `copies`
 *   object is merged over the type's own rules. A new type with no `answer`
 *   takes the empty object (`EMPTY_ANSWER`: a files-only task).
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
import { attachmentRuleOf, type AttachmentRule } from "./answer-files.js";
import { openPayProblem, openPayWarning, RuleProblem, sameJson, testRulesOf } from "./task-tests.js";
import { DEFAULT_HOLD_HOURS, type CopiesRule, type GradeRule, type RoundRule, type StandingRule, type TaskType, type TestRules } from "./task-store.js";
import {
  DEFAULT_LEASE_SECONDS,
  DEFAULT_WITHIN_HOURS,
  HOLD_HOURS_MAX,
  HOLD_HOURS_MIN,
  LEASE_SECONDS_MAX,
  PAY_SATS_MAX,
  TYPE_NAME_MAX,
  TYPE_NAME_RE,
  TYPE_TITLE_MAX,
  WITHIN_HOURS_MAX,
  type TasksCapability,
  type TaskTypeInput,
} from "./tasks.js";

export const SET_TYPE_STEP = "task/set-type";

/** A new type's answer when none is given: no fields (files only). */
export const EMPTY_ANSWER = { type: "object", properties: {} } as const;

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

/** An object field a model sent as JSON TEXT (it did, twice, for `answer`):
 *  parsed, so the field's own check reads the object. Text that does not
 *  parse is left as it is, for that check's own refusal. */
function fromJsonText(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
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
  title: z
    .string()
    .max(TYPE_TITLE_MAX)
    .nullable()
    .optional()
    .describe("What workers call it, in their own language and words (\"Revisión de recibo\"): the name is ASCII, the title anything. Left out, a type keeps its title; null: none, and workers read its name."),
  app: z.string().min(1).describe("The app that draws its tasks: the worker app, which must grant task/next and task/submit (task/* covers them)."),
  answer: z
    .preprocess(
      fromJsonText,
      z
        .any()
        .optional()
        .superRefine((v, c) => {
          if (v === undefined) return;
          const problem = answerSchemaProblem(v);
          if (problem) c.addIssue({ code: "custom", message: `answer: ${problem}` });
        }),
    )
    // The tool's JSON schema says "object", so the model sends one.
    .meta({ type: "object" })
    .describe(
      "The answer's shape, a JSON Schema in the subset strut checks: `type` on every schema; `properties` + `required`; `items`, `minItems`, `maxItems`; `enum`; `minimum`, `maximum`; `minLength`, `maxLength`; `title`, `description`. " +
        "An object of plain fields (text, numbers, yes or no, a pick from an enum) is drawn by strut/views' TaskForm; anything else needs the app's own view. Left out, a type keeps its shape, and a new type takes the empty object { type: \"object\", properties: {} }: a files-only task (photos and nothing else) needs no fields.",
    ),
  leaseSeconds: z.number().int().min(1).max(LEASE_SECONDS_MAX).optional().describe("How long a worker holds a task once taken, in seconds (600 for a new type)."),
  withinHours: z.number().positive().max(WITHIN_HOURS_MAX).optional().describe("How long a task may wait unanswered before it expires, in hours (72 for a new type); a `human` step may set its own."),
  enabled: z.boolean().optional().describe("false turns the type off: no new task of it, and its open tasks are not handed out and expire when due."),
  open: z
    .boolean()
    .optional()
    .describe(
      "true (a new type's default): any signed-in worker of the app who is not suspended or banned takes its tasks with no grant, qualifying first on its tests when it has them. false: invite-only, an admin grants each worker. " +
        "A PAID open type needs its tests on and at least `tests.qualify` (10 by default) of them ready, or the save is refused: make a new paid type invite-only, or unpaid, until an admin has made its tests.",
    ),
  paySats: z
    .number()
    .min(0)
    .max(PAY_SATS_MAX)
    .optional()
    .refine((v) => v === undefined || Math.abs(v * 1000 - Math.round(v * 1000)) <= 1e-6, "paySats is sats to the msat (at most three decimals)")
    .describe("What one accepted answer earns its worker, in sats (0: unpaid, a new type's default). A rise is shown to the admin as a danger."),
  holdHours: z.number().min(HOLD_HOURS_MIN).max(HOLD_HOURS_MAX).optional().describe(`How long an earning waits before it can be withdrawn, in hours (${HOLD_HOURS_MIN} to ${HOLD_HOURS_MAX}; 72 for a new type).`),
  tests: z
    .preprocess(
      fromJsonText,
      z
        .record(z.string(), z.any())
        .nullable()
        .optional()
        .superRefine((v, c) => ruleIssue(c, () => testRulesOf(v, shapeOnly))),
    )
    .describe("Test tasks mixed among its tasks to qualify and score workers: { rate, newRate, newTasks, qualify, window, minGraded, threshold, grade, gradeCapUsd }, merged over the type's own (or the defaults); null turns them off. The tests themselves are an admin's, in strut/staff."),
  copies: z
    .preprocess(
      fromJsonText,
      z
        .record(z.string(), z.any())
        .nullable()
        .optional()
        .superRefine((v, c) => ruleIssue(c, () => copiesRuleOf(v, shapeOnly))),
    )
    .describe("How many workers a `human` step may ask one task, each paid: { max, agree, compare, onDisagree }, merged over the type's own (or the defaults: 3, 2, \"equal\", \"more\"); null: one worker a task."),
  attachments: z
    .preprocess(
      fromJsonText,
      z
        .record(z.string(), z.any())
        .nullable()
        .optional()
        .superRefine((v, c) => ruleIssue(c, () => attachmentRuleOf(v))),
    )
    .describe("The files a worker sends with each answer — a photo of a document, a signed form: { max, min, types }, merged over the type's own (or the defaults: 1, 0, [\"image/*\", \"application/pdf\"]); max at most 10, types media types (`image/*` a family); null: none. They are saved in the task's run, and the `human` step's output names them as `attachments`."),
  standing: z
    .preprocess(fromJsonText, z.object({ workflow: z.string().min(1) }).strict().nullable().optional())
    .describe("A STANDING type, for work a worker starts — a photo of something they found: { workflow }. A worker's ask makes the task whenever they like, any number of workers at once, and each answer starts `workflow`, whose FIRST step must be this type's `human` step (its show reading only input and params, no files). The workflow runs only once someone answers, billed to its owner. null: not standing — a `human` step in a run makes its tasks."),
  round: z
    .preprocess(fromJsonText, z.object({ workflow: z.string().min(1) }).strict().nullable().optional())
    .describe("A ROUND type, for work one for each item of a list — each shop, each page: { workflow }, the workflow whose run makes one task of this type for each item (its `human` step of this type, in a `foreach`). Name it so the person can send a round from Tasks and workers (Send a round, the items ticked) as well as by asking in the conversation. Never with standing. null: none named."),
});

/** What `task/set-type` asks, as its schema parsed it. */
export type TypeChange = z.infer<typeof typeChangeInput>;

/** A new ask built on the one still WAITING for the same name (its card not
 *  approved yet, so no type of that name exists): every field the ask
 *  leaves out is the waiting one's, `tests`, `copies` and `attachments`
 *  merged key by key (`null` turns one off), `standing` replaced — the type
 *  the person would get had they approved the first card and this one been
 *  a change of it. */
export function askOver(waiting: TypeChange, ask: TypeChange): TypeChange {
  const out: Record<string, unknown> = { ...waiting };
  for (const [k, v] of Object.entries(ask)) {
    if (v === undefined) continue;
    const was = (waiting as Record<string, unknown>)[k];
    out[k] = (k === "tests" || k === "copies" || k === "attachments") && isRecord(v) && isRecord(was) ? { ...was, ...v } : v;
  }
  return out as TypeChange;
}
/** The fields to change, without the name: what `save` takes. */
export type TypeFields = Omit<TypeChange, "name">;

/** One type as `list()` reads it: the type, without who saved it last
 *  (who is the staff's to read), with its open tasks, how many workers hold
 *  it, its answers in the last 7 days and its ready tests — where the store
 *  counts them (a host's own store may not). */
export type TaskTypeRow = Omit<TaskType, "changedBy" | "open"> & { open?: boolean; openTasks?: number; workers?: number; answeredWeek?: number; readyTests?: number };

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
 *  its value; `tests`, `copies` and `attachments` merge over the type's own
 *  rules, `standing` replaces it, and `null` turns any of them off. A new
 *  type with no `answer` takes `EMPTY_ANSWER`. */
export function mergeType(
  name: string,
  existing: (Pick<TaskType, "title" | "app" | "answer" | "leaseSeconds" | "withinHours" | "enabled" | "paySats" | "holdHours" | "tests" | "copies" | "attachments" | "standing" | "round"> & { open?: boolean }) | undefined,
  change: TypeFields,
): TaskTypeInput {
  // A new type with no shape given takes the empty object: a files-only
  // task (photos and nothing else) needs none.
  const answer = change.answer !== undefined ? change.answer : (existing?.answer ?? EMPTY_ANSWER);
  const rules = <T extends object>(was: T | undefined, given: Record<string, unknown> | null | undefined): Partial<T> | null | undefined =>
    given === undefined ? was : given === null ? null : ({ ...(was ?? {}), ...given } as Partial<T>);
  const out: TaskTypeInput = { app: change.app ?? existing?.app ?? "", answer };
  // A title is whole: given, it replaces; null clears it.
  const title = change.title === undefined ? existing?.title : change.title;
  if (title) out.title = title;
  const leaseSeconds = change.leaseSeconds ?? existing?.leaseSeconds;
  const withinHours = change.withinHours ?? existing?.withinHours;
  const enabled = change.enabled ?? existing?.enabled;
  const open = change.open ?? existing?.open;
  const paySats = change.paySats ?? existing?.paySats;
  const holdHours = change.holdHours ?? existing?.holdHours;
  const tests = rules<TestRules>(existing?.tests, change.tests);
  const copies = rules<CopiesRule>(existing?.copies, change.copies);
  const attachments = rules<AttachmentRule>(existing?.attachments, change.attachments);
  if (leaseSeconds !== undefined) out.leaseSeconds = leaseSeconds;
  if (withinHours !== undefined) out.withinHours = withinHours;
  if (enabled !== undefined) out.enabled = enabled;
  if (open !== undefined) out.open = open;
  if (paySats !== undefined) out.paySats = paySats;
  if (holdHours !== undefined) out.holdHours = holdHours;
  if (tests !== undefined) out.tests = tests;
  if (copies !== undefined) out.copies = copies;
  if (attachments !== undefined) out.attachments = attachments;
  // Standing (§5.7) is whole: given, it replaces; null turns it off.
  const standing = change.standing === undefined ? existing?.standing : change.standing;
  if (standing !== undefined) out.standing = standing;
  // So is a round's workflow.
  const round = change.round === undefined ? existing?.round : change.round;
  if (round !== undefined) out.round = round;
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
        return {
          ...type,
          ...(s ? { openTasks: s.waiting + s.working, workers: s.granted, answeredWeek: s.windows.week.answered, ...(s.readyTests === undefined ? {} : { readyTests: s.readyTests }) } : {}),
        };
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
  title?: string;
  app: string;
  answer: unknown;
  leaseSeconds: number;
  withinHours: number;
  enabled: boolean;
  open: boolean;
  paySats: number;
  holdHours: number;
  tests?: TestRules;
  copies?: CopiesRule;
  attachments?: AttachmentRule;
  standing?: StandingRule;
  round?: RoundRule;
}

const plannedOf = (t: TaskTypeRow): Planned => ({
  ...(t.title ? { title: t.title } : {}),
  app: t.app,
  answer: t.answer,
  leaseSeconds: t.leaseSeconds,
  withinHours: t.withinHours,
  enabled: t.enabled,
  open: t.open ?? true,
  paySats: t.paySats ?? 0,
  holdHours: t.holdHours,
  ...(t.tests ? { tests: t.tests } : {}),
  ...(t.copies ? { copies: t.copies } : {}),
  ...(t.attachments ? { attachments: t.attachments } : {}),
  ...(t.standing ? { standing: t.standing } : {}),
  ...(t.round ? { round: t.round } : {}),
});

interface Problems {
  tests?: string;
  copies?: string;
  attachments?: string;
}

function plan(name: string, existing: TaskTypeRow | undefined, change: TypeFields): { planned: Planned; problems: Problems; openWarning?: string } {
  const problems: Problems = {};
  const merged = mergeType(name, existing, change);
  const rule = <T>(key: "tests" | "copies" | "attachments", check: () => T | undefined): T | undefined => {
    try {
      return check();
    } catch (err) {
      problems[key] = err instanceof Error ? err.message : String(err);
      return undefined;
    }
  };
  const tests = rule("tests", () => testRulesOf(merged.tests, shapeOnly));
  const copies = rule("copies", () => copiesRuleOf(merged.copies, shapeOnly));
  const attachments = rule("attachments", () => attachmentRuleOf(merged.attachments));
  const pay = merged.paySats && merged.paySats > 0 ? Math.round(merged.paySats * 1000) / 1000 : 0;
  // Ruling 12: who a paid open type lets in is the admin's, so this is
  // said, never refused. A new type has no tests yet; a host's store that
  // counts none is not counted here.
  const ready = existing ? existing.readyTests : 0;
  const paid = { name, open: merged.open ?? true, paySats: pay, ...(tests ? { tests } : {}) };
  const openWarning = problems.tests ? undefined : (openPayWarning(paid) ?? (ready === undefined ? undefined : openPayProblem(paid, ready)));
  return {
    ...(openWarning ? { openWarning } : {}),
    planned: {
      ...(merged.title ? { title: merged.title.trim() } : {}),
      app: merged.app,
      answer: merged.answer,
      leaseSeconds: merged.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
      withinHours: merged.withinHours ?? DEFAULT_WITHIN_HOURS,
      enabled: merged.enabled ?? true,
      open: merged.open ?? true,
      paySats: pay,
      holdHours: merged.holdHours ?? DEFAULT_HOLD_HOURS,
      ...(tests ? { tests } : {}),
      ...(copies ? { copies } : {}),
      ...(attachments ? { attachments } : {}),
      ...(merged.standing ? { standing: merged.standing } : {}),
      ...(merged.round ? { round: merged.round } : {}),
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
  if (sameJson(schema, EMPTY_ANSWER)) return "no fields: only the files sent with it";
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

/** What the save would refuse, first by field: the card's "Approving it fails". */
const failureOf = (problems: Problems): string | undefined => problems.tests ?? problems.copies ?? problems.attachments;

/** A hold in days when it is a whole number of them. */
const holdText = (hours: number) => (hours % 24 === 0 ? plural(hours / 24, "day") : plural(hours, "hour"));

/** "4 photos", "1 to 3 photos", "up to 2 files": what an answer carries, in
 *  the person's words; "" for none. */
function filesWords(a: AttachmentRule | undefined): string {
  if (!a || a.max === 0) return "";
  const photos = a.types.every((t) => t.startsWith("image/"));
  const noun = (n: number) => (photos ? (n === 1 ? "photo" : "photos") : n === 1 ? "file" : "files");
  if (a.min === a.max) return `${a.max} ${noun(a.max)}`;
  if (a.min === 0) return `up to ${a.max} ${noun(a.max)}`;
  return `${a.min} to ${a.max} ${noun(a.max)}`;
}

/** One question of the answer, as a worker reads it: its title (else its
 *  key) and what they give. */
function questionLine(key: string, p: Record<string, unknown>, required: boolean): string {
  const title = typeof p["title"] === "string" && p["title"] ? p["title"] : `${key[0]!.toUpperCase()}${key.slice(1)}`;
  let kind: string;
  if (Array.isArray(p["enum"])) {
    const opts = p["enum"].map(String);
    kind = opts.length > 1 ? `${opts.slice(0, -1).join(", ")} or ${opts.at(-1)}` : opts.join("");
  } else if (p["type"] === "boolean") kind = "yes or no";
  else if (p["type"] === "number" || p["type"] === "integer") kind = typeof p["minimum"] === "number" && typeof p["maximum"] === "number" ? `${p["minimum"]} to ${p["maximum"]}` : "a number";
  else if (p["type"] === "array") kind = "a few picks from a list";
  else kind = "a few words";
  return `• ${title} — ${kind}${required ? "" : " (optional)"}`;
}

/** What a worker hands in: the files, then the questions they answer. */
function handInText(answer: unknown, a: AttachmentRule | undefined): string {
  const files = filesWords(a);
  if (answer === undefined || sameJson(answer, EMPTY_ANSWER)) return files || "nothing";
  if (formProblem(answer)) return `${files ? `${files}, and ` : ""}an answer the worker app draws itself (see The answer under Details)`;
  const s = answer as { properties: Record<string, Record<string, unknown>>; required?: unknown };
  const required = new Set(Array.isArray(s.required) ? s.required : []);
  const questions = Object.entries(s.properties).map(([k, p]) => questionLine(k, p, required.has(k)));
  return `${files ? `${files}, and answers` : "Answers"}:\n${questions.join("\n")}`;
}

/** A change's line, in the card's plain labels. */
const changeLabel: Record<string, string> = {
  title: "what workers call it",
  "drawn by": "worker app",
  answer: "questions",
  lease: "time to finish",
  "expires after": "expiry",
  "turned on": "turned on",
  "turned off": "turned off",
  "who takes it": "who can do it",
  pay: "pay",
  hold: "wait before withdrawing",
  tests: "tests",
  copies: "copies",
  files: "photos",
  when: "when",
};

/**
 * The card (§9.8), for a person who is not technical: a sentence, then what
 * a worker hands in, when, who can do it and the pay, in their words; the
 * type's own settings under Details (`detail`). For a change, what changes.
 * The app's problem, a rise in pay, a paid type anyone may take and what the
 * save would refuse are dangers, never folded. `existing` is the type as
 * `list()` reads it; `appProblem` and `usdPerBtc` the door's reads.
 */
export function typeCard(cfg: TypeChange, o: { existing?: TaskTypeRow; appProblem?: string; usdPerBtc?: number } = {}): ProposalDescription {
  const { name, ...change } = cfg;
  const { existing, appProblem, usdPerBtc } = o;
  const { planned: after, problems, openWarning } = plan(name, existing, change);
  const before = existing ? plannedOf(existing) : undefined;
  const turnsOff = !!before?.enabled && !after.enabled;
  const human = after.title ?? name.replace(/[-_]+/g, " ");
  const title = !existing ? `New task: ${human}` : turnsOff ? `Turn off task: ${human}` : `Change task: ${human}`;
  /** "$3.50 (5,500 sats)", or the sats alone with no rate. */
  const money = (sats: number) => (!sats ? "unpaid" : usdPerBtc ? `${usdText((roundMsat(sats) * usdPerBtc) / 1e8)} (${satsText(sats)})` : satsText(sats));
  const whoWords = (open: boolean) => (open ? "anyone signed in to the worker page" : "only people you invite");
  const whenWords = (p: Pick<Planned, "standing" | "round">) => (p.standing ? "any time" : p.round ? "one for each item, when you send a round" : "when a workflow sends one");

  // What changes, field by field, in the card's words.
  const changes: string[] = [];
  if (before) {
    const line = (key: string, was: string, now: string) => changes.push(`${changeLabel[key] ?? key}: ${was} → ${now}`);
    if ((before.title ?? "") !== (after.title ?? "")) line("title", before.title ? `“${before.title}”` : "none", after.title ? `“${after.title}”` : "none");
    if (before.app !== after.app) line("drawn by", before.app, after.app);
    if (after.answer !== undefined && !sameJson(before.answer, after.answer)) changes.push("questions: new ones (see A worker hands in)");
    if (before.leaseSeconds !== after.leaseSeconds) line("lease", secondsText(before.leaseSeconds), secondsText(after.leaseSeconds));
    if (before.withinHours !== after.withinHours) line("expires after", plural(before.withinHours, "hour"), plural(after.withinHours, "hour"));
    if (before.enabled !== after.enabled) changes.push(after.enabled ? "turned on" : "turned off");
    if (before.open !== after.open) line("who takes it", whoWords(before.open), whoWords(after.open));
    if (before.paySats !== after.paySats) line("pay", money(before.paySats), money(after.paySats));
    if (before.holdHours !== after.holdHours) line("hold", holdText(before.holdHours), holdText(after.holdHours));
    if (!problems.tests) {
      const d = rulesDiff("tests", before.tests, after.tests);
      if (d) changes.push(d);
    }
    if (!problems.copies) {
      const d = rulesDiff("copies", before.copies, after.copies);
      if (d) changes.push(d);
    }
    if (!problems.attachments && !sameJson(before.attachments, after.attachments)) line("files", filesWords(before.attachments) || "none", filesWords(after.attachments) || "none");
    if (before.standing?.workflow !== after.standing?.workflow || before.round?.workflow !== after.round?.workflow) line("when", whenWords(before), whenWords(after));
  }
  const shapeChanged = !!before && after.answer !== undefined && !sameJson(before.answer, after.answer);
  const payBefore = before?.paySats ?? 0;
  const rises = after.paySats > payBefore;

  // Shown: what the person decides on, in their words.
  const fields: CardField[] = [];
  if (before) fields.push({ label: "What changes", value: changes.length ? changes.join("\n") : "nothing: it is already so" });
  fields.push(
    problems.attachments
      ? { label: "A worker hands in", value: `refused: ${problems.attachments}`, danger: true }
      : { label: "A worker hands in", value: handInText(after.answer, after.attachments) },
  );
  fields.push({
    label: "When",
    value: after.standing
      ? `Any time: a worker starts one whenever they like, and many can work at once. Each one they hand in starts the workflow ${after.standing.workflow}.`
      : after.round
        ? `One for each item, when you send a round: from Tasks and workers (Send a round), or by asking here. The workflow ${after.round.workflow} makes them.`
        : "When a workflow sends one out: one for each thing it asks about.",
  });
  // A paid type anyone may take (ruling 12), in the person's words: no
  // qualifying test, or too few of its test tasks ready.
  const qualify = after.tests?.qualify ?? 0;
  const ready = existing?.readyTests ?? 0;
  const warn = !openWarning
    ? undefined
    : qualify
      ? { who: `but only ${ready} of its ${plural(qualify, "test task")} are ready, so nobody new can start until ${qualify - ready} more are made`, summary: `Nobody new can start it until ${qualify - ready} more test tasks are made.` }
      : { who: "and they are paid from their first one: there is no qualifying test, so only your own review of their answers checks them", summary: "Anyone signed in is paid from their first one, with no qualifying test." };
  const who = after.open
    ? `Anyone signed in to the worker page${qualify ? `, after passing a test of ${plural(qualify, "task")}` : ""}${warn ? `, ${warn.who}` : ""}.`
    : "Only people you invite: give it to each of them in Tasks and workers.";
  fields.push({ label: "Who can do it", value: who, ...(warn ? { danger: true } : {}) });
  let pay = after.paySats
    ? `${money(after.paySats)} for each one, from this server's wallet. Workers can withdraw it ${holdText(after.holdHours)} later.`
    : "Unpaid.";
  if (before && payBefore !== after.paySats) pay += ` It is ${money(payBefore)} now.`;
  const week = existing?.answeredWeek;
  if (existing && week !== undefined && after.paySats) {
    pay += !week
      ? " None were done in the last week."
      : ` The last week's ${plural(week, "answer")} would have cost ${money(week * after.paySats)}` + (payBefore !== after.paySats ? `, against ${money(week * payBefore)} at the pay now.` : ".");
  }
  fields.push({ label: "Pay", value: pay, ...(rises ? { danger: true } : {}) });

  // Under Details: the type's own settings, for whoever wants them.
  const named = after.title ? `${name} (“${after.title}”)` : name;
  fields.push({ label: "Task type", value: appProblem ? `${named}, in the app ${after.app} — ${appProblem}` : `${named}, in the app ${after.app}`, ...(appProblem ? { danger: true } : { detail: true }) });
  fields.push({ label: "The answer", value: answerText(after.answer), detail: true });
  fields.push({
    label: "Time limits",
    value: `${secondsText(after.leaseSeconds)} to finish one once started${after.standing ? "" : `; one nobody takes expires after ${plural(after.withinHours, "hour")}`}`,
    detail: true,
  });
  const workers = existing?.workers;
  fields.push({
    label: "Workers",
    value: !existing
      ? after.open
        ? "none yet: anyone signed in holds it from their first ask"
        : "none yet: you give it to each worker in Tasks and workers (strut/staff)"
      : workers === undefined
        ? "not counted on this server"
        : `${workers} hold it`,
    detail: true,
  });
  if (before) {
    const open = existing?.openTasks;
    fields.push({
      label: "Open tasks",
      value:
        open === undefined
          ? "not counted on this server"
          : turnsOff && open
            ? `${open}: not handed out once it is off; they expire when due`
            : shapeChanged && open
              ? `${open}: their answers are checked against the new questions when handed in`
              : String(open),
      detail: true,
    });
  }
  fields.push(problems.tests ? { label: "Tests", value: `refused: ${problems.tests}`, danger: true } : { label: "Tests", value: testsText(after.tests), detail: true });
  fields.push(problems.copies ? { label: "Copies", value: `refused: ${problems.copies}`, danger: true } : { label: "Copies", value: copiesText(after.copies), detail: true });

  const lines: string[] = [];
  if (!existing) {
    const whoShort = after.open ? "Anyone signed in to the worker page" : "Only people you invite";
    const whenShort = after.standing ? " whenever they like, as many as they like," : " when a workflow sends one out,";
    lines.push(`${whoShort} can do the "${human}" task${whenShort} ${after.paySats ? `for ${money(after.paySats)} each, paid from this server's wallet` : "unpaid"}.`);
    if (!after.enabled) lines.push("It starts switched off: nobody gets one until it is turned on.");
  } else if (turnsOff) {
    lines.push(`Turns off the "${human}" task: nobody gets a new one, and the open ones expire when due.`);
  } else {
    lines.push(changes.length ? `Changes the "${human}" task: ${changes.map((c) => c.split(":")[0]).join(", ")}.` : `Changes nothing in the "${human}" task: it is already so.`);
  }
  if (appProblem) lines.push(`Workers cannot do it yet: ${appProblem}.`);
  if (rises && existing) lines.push(`Its pay goes up from ${money(payBefore)} to ${money(after.paySats)} each.`);
  if (warn) lines.push(warn.summary);
  const fails = failureOf(problems);
  if (fails) lines.push(`Approving it fails: ${fails}.`);
  return { title, summary: lines.join(" "), fields, actions: { accept: "Approve", reject: "Don't" }, full: true };
}
