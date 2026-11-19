// The type editor's DRAFT (plans/human-steps.md §9.5): a task type as the
// strings a form edits, and back to what `staff/save-type` sends. A save is
// a PUT of the whole type — what is left out is the default — so the draft
// carries every field the type has, its tests and copies included, and a
// save never drops one the page does not show.
import { answerSchemaProblem, type AnswerSchema } from "@strut/kit/folds";
import { modelOf, schemaOf, STARTER, type AnswerModel } from "./schema";
import type { AttachmentRule, CopiesRule, GradeRule, TaskType, TestRules } from "./types";

/** The store's defaults (src/tasks/tasks.ts, task-store.ts, task-copies.ts), shown on a new type. */
export const DEFAULTS = {
  leaseSeconds: 600,
  withinHours: 72,
  holdHours: 0,
  tests: { rate: 0.05, newRate: 0.25, newTasks: 50, qualify: 10, window: 20, minGraded: 10, threshold: 0.8, grade: "equal", gradeCapUsd: 0.05 } as TestRules,
  copies: { max: 3, agree: 2, compare: "equal", onDisagree: "more" } as CopiesRule,
  attachments: { max: 1, min: 0, types: ["image/*", "application/pdf"] } as AttachmentRule,
};

export interface GradeDraft {
  /** `equal`, or a sealed step (`grade/overlap`, `grade/judge`, …). */
  kind: "equal" | "step";
  step: string;
  /** The step's config as JSON. */
  config: string;
}

export interface Draft {
  name: string;
  /** What workers call it; empty: none, they read the name. */
  title: string;
  app: string;
  leaseMinutes: string;
  withinHours: string;
  enabled: boolean;
  /** Ruling 9: open to any signed-in worker, or invite-only. */
  open: boolean;
  /** The answer's shape: the fields (`model`), or JSON when they cannot draw it. */
  model: AnswerModel | null;
  json: string;
  paySats: string;
  holdHours: string;
  /** The type's limits: the most it pays in all, the most tasks one worker
   *  takes a day; empty: none. */
  budgetSats: string;
  perWorkerDay: string;
  testsOn: boolean;
  tests: Record<"rate" | "newRate" | "newTasks" | "qualify" | "window" | "minGraded" | "threshold" | "gradeCapUsd", string> & { grade: GradeDraft };
  copiesOn: boolean;
  copies: { max: string; agree: string; onDisagree: "more" | "fail"; compare: GradeDraft };
  /** §5.6: the files an answer carries; `types` comma-separated. */
  filesOn: boolean;
  files: { max: string; min: string; types: string };
  /** When there is work: `sent` — a workflow's human step makes each task;
   *  `standing` — any time, a worker's ask makes it (plans/human-steps.md
   *  §5.7); `round` — one for each item, sent in rounds. The last two name
   *  `workflow`. */
  when: "sent" | "standing" | "round";
  workflow: string;
}

const s = (n: number | undefined) => (n === undefined ? "" : String(n));

export function gradeDraftOf(g: GradeRule | undefined): GradeDraft {
  if (!g || g === "equal") return { kind: "equal", step: "", config: "" };
  return { kind: "step", step: g.step, config: g.config ? JSON.stringify(g.config, null, 2) : "" };
}

/** A type as a draft; a new type from the store's defaults. */
export function draftOf(t?: TaskType): Draft {
  const tests = t?.tests ?? DEFAULTS.tests;
  const copies = t?.copies ?? DEFAULTS.copies;
  const files = t?.attachments ?? DEFAULTS.attachments;
  const answer = t?.answer ?? (schemaOf(STARTER) as AnswerSchema);
  return {
    name: t?.name ?? "",
    title: t?.title ?? "",
    app: t?.app ?? "",
    leaseMinutes: s((t?.leaseSeconds ?? DEFAULTS.leaseSeconds) / 60),
    withinHours: s(t?.withinHours ?? DEFAULTS.withinHours),
    enabled: t?.enabled ?? true,
    open: t?.open ?? true,
    model: modelOf(answer),
    json: JSON.stringify(answer, null, 2),
    paySats: s(t?.paySats),
    holdHours: s(t?.holdHours ?? DEFAULTS.holdHours),
    budgetSats: s(t?.limits?.budgetSats),
    perWorkerDay: s(t?.limits?.perWorkerDay),
    testsOn: !!t?.tests,
    tests: {
      rate: s(tests.rate),
      newRate: s(tests.newRate),
      newTasks: s(tests.newTasks),
      qualify: s(tests.qualify),
      window: s(tests.window),
      minGraded: s(tests.minGraded),
      threshold: s(tests.threshold),
      gradeCapUsd: s(tests.gradeCapUsd),
      grade: gradeDraftOf(tests.grade),
    },
    copiesOn: !!t?.copies,
    copies: { max: s(copies.max), agree: s(copies.agree), onDisagree: copies.onDisagree, compare: gradeDraftOf(copies.compare) },
    filesOn: !!t?.attachments,
    files: { max: s(files.max), min: s(files.min), types: files.types.join(", ") },
    when: t?.standing ? "standing" : t?.round ? "round" : "sent",
    workflow: t?.standing?.workflow ?? t?.round?.workflow ?? "",
  };
}

/** The draft's answer schema: the fields', or the JSON's. */
export function answerOfDraft(d: Pick<Draft, "model" | "json">): { schema: AnswerSchema } | { problem: string } {
  if (d.model) return { schema: schemaOf(d.model) };
  try {
    const v = JSON.parse(d.json) as unknown;
    const p = answerSchemaProblem(v);
    return p ? { problem: `the answer's shape: ${p}` } : { schema: v as AnswerSchema };
  } catch (err) {
    return { problem: `the answer's shape is not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function gradeOf(g: GradeDraft, what: string): GradeRule | { problem: string } {
  if (g.kind === "equal") return "equal";
  if (!g.step.trim()) return { problem: `${what}: name the step that grades (grade/overlap, grade/judge, or a sealed step of your own)` };
  if (!g.config.trim()) return { step: g.step.trim() };
  try {
    const config = JSON.parse(g.config) as unknown;
    if (!config || typeof config !== "object" || Array.isArray(config)) return { problem: `${what}: its config is a JSON object` };
    return { step: g.step.trim(), config: config as Record<string, unknown> };
  } catch {
    return { problem: `${what}: its config is not JSON` };
  }
}

/** What `staff/save-type` sends for the draft, or why not yet. The numbers'
 *  bounds are the store's to check: a refusal comes back in its words. */
export function saveOf(d: Draft, shown: { pay: boolean; tests: boolean; copies: boolean; open?: boolean }, was?: TaskType): { input: Record<string, unknown> } | { problem: string } {
  const answer = answerOfDraft(d);
  if ("problem" in answer) return answer;
  if (!d.app) return { problem: "pick the app that draws this type" };
  const num = (v: string, what: string): number | { problem: string } => {
    const n = Number(v);
    return v.trim() !== "" && Number.isFinite(n) ? n : { problem: `${what} is a number` };
  };
  const lease = num(d.leaseMinutes, "the lease");
  if (typeof lease !== "number") return lease;
  const within = num(d.withinHours, "expires after");
  if (typeof within !== "number") return within;
  const input: Record<string, unknown> = { name: d.name, app: d.app, answer: answer.schema, leaseSeconds: Math.round(lease * 60), withinHours: within, enabled: d.enabled };
  if (d.title.trim()) input["title"] = d.title.trim();
  if (shown.open) input["open"] = d.open;
  else if (was?.open !== undefined) input["open"] = was.open;
  if (shown.pay) {
    if (d.paySats.trim() !== "") {
      const pay = num(d.paySats, "pay");
      if (typeof pay !== "number") return pay;
      input["paySats"] = pay;
    }
    const hold = num(d.holdHours, "the hold");
    if (typeof hold !== "number") return hold;
    input["holdHours"] = hold;
    const limits: Record<string, number> = {};
    if (d.budgetSats.trim() !== "") {
      const budget = num(d.budgetSats, "the budget");
      if (typeof budget !== "number") return budget;
      limits["budgetSats"] = budget;
    }
    if (d.perWorkerDay.trim() !== "") {
      const day = num(d.perWorkerDay, "a worker's day");
      if (typeof day !== "number") return day;
      limits["perWorkerDay"] = day;
    }
    input["limits"] = Object.keys(limits).length ? limits : null;
  } else {
    // A part the page does not show is sent back as it was.
    if (was?.paySats !== undefined) input["paySats"] = was.paySats;
    if (was?.holdHours !== undefined) input["holdHours"] = was.holdHours;
    if (was?.limits !== undefined) input["limits"] = was.limits;
  }
  if (shown.tests) {
    if (d.testsOn) {
      const tests: Record<string, unknown> = {};
      for (const k of ["rate", "newRate", "newTasks", "qualify", "window", "minGraded", "threshold", "gradeCapUsd"] as const) {
        const n = num(d.tests[k], k);
        if (typeof n !== "number") return n;
        tests[k] = n;
      }
      const grade = gradeOf(d.tests.grade, "the grader");
      if (typeof grade === "object" && "problem" in grade) return grade;
      tests["grade"] = grade;
      input["tests"] = tests;
    } else input["tests"] = null;
  } else if (was?.tests) input["tests"] = was.tests;
  if (shown.copies) {
    if (d.copiesOn) {
      const max = num(d.copies.max, "the most copies");
      if (typeof max !== "number") return max;
      const agree = num(d.copies.agree, "agree");
      if (typeof agree !== "number") return agree;
      const compare = gradeOf(d.copies.compare, "the comparison");
      if (typeof compare === "object" && "problem" in compare) return compare;
      input["copies"] = { max, agree, compare, onDisagree: d.copies.onDisagree };
    } else input["copies"] = null;
  } else if (was?.copies) input["copies"] = was.copies;
  if (d.filesOn) {
    const max = num(d.files.max, "the most files");
    if (typeof max !== "number") return max;
    const min = num(d.files.min, "the fewest files");
    if (typeof min !== "number") return min;
    const types = d.files.types.split(",").map((t) => t.trim()).filter(Boolean);
    if (!types.length) return { problem: "name the files' types (image/*, application/pdf)" };
    input["attachments"] = { max, min, types };
  }
  // Off: left out, which a whole-type PUT saves as none.
  // When there is work: a standing type or a round type names its workflow;
  // the store checks it can be one, and says why not.
  if (d.when !== "sent") {
    if (!d.workflow) return { problem: d.when === "standing" ? "pick the workflow each answer starts" : "pick the workflow a round runs" };
    input[d.when] = { workflow: d.workflow };
  }
  return { input };
}

/** Whether a save changes the answer's shape (its open tasks' answers are
 *  then checked against the new one, §9.5). */
export function shapeChanged(was: TaskType | undefined, schema: AnswerSchema): boolean {
  return !!was && JSON.stringify(sortKeys(was.answer)) !== JSON.stringify(sortKeys(schema));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}
