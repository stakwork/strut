/**
 * The TASK STORE (plans/human-steps.md §4): people as a step of a workflow.
 * A `human` step makes a task and its run waits (item 2b); a WORKER signed
 * in to the worker app takes the next task of a type they were granted,
 * answers it, and the answer settles the task. This is the store and its
 * rules: a SQLite file strut owns, `<dataDir>/tasks/tasks.db` (`db.ts`),
 * reached only through the calls here, never a page's SQL (§4.1).
 *
 * Two sides, two modules: the TASK side (`task-store.ts`: types, tasks,
 * leases) and the WORKER side (`worker-store.ts`: workers, grants). The
 * service asks the worker side "may this actor take this type?" on every
 * worker call and holds the task side to the answer; what a worker's status
 * does to a lease they hold is decided here.
 *
 * The rules (§4.3):
 * 1. A task is made once per workflow, run and step path (`ensure`).
 * 2. `next` is one guarded write: an open task of a type the worker holds a
 *    live grant for, that the worker never held and nobody holds now. One
 *    live lease per worker.
 * 3. A worker reaches a task only through their own live lease.
 * 4. One answer per lease, checked against the type's answer schema
 *    (`answer-schema.ts`). Nothing after the lease expires.
 * 5. The worker is the ACTOR the caller passes, the session's — never an
 *    argument a page writes.
 * 6. The worker's status and grants are read on every call.
 * 7. An accepted answer settles the task; `onSettle` hears it.
 * 8. The sweep (every minute, and at boot, where a store is) expires dead
 *    leases, so their tasks are free again, and expires a task past its
 *    `withinHours`; `onSettle` hears that too.
 *
 * The worker's door (§5, item 3) is the `task/*` steps over the worker
 * calls: `next { wait }` holds up to 25 s for a task to appear, woken by
 * what could free one (a task made, skipped, let go of, a grant); each
 * worker makes at most `TASK_CALLS_PER_MINUTE` calls a minute (a held wait
 * counts once); and the service knows from memory who is an ACTIVE worker,
 * which the public routes count a request under (`isActiveWorker`).
 *
 * EARNINGS (§8.1, item 5a): a task type may pay (`paySats`), stamped on a
 * lease when it is taken. An accepted answer under a paid lease is BOOKED in
 * the ledger (src/payments/ledger.ts: `pay`, one row per lease) right after
 * it settles here, and the lease is marked `bookedAt`; a booking that fails
 * is logged, never the worker's, and the minute's sweep books what is left.
 * An earning is held the type's `holdHours` and withdrawable after; staff
 * take one back inside its hold (`takeBack`, the service's alone). No sats
 * move: the wallet pays nobody until item 5b.
 *
 * TESTS (§7, item 4): a task type may mix TESTS — tasks whose answer staff
 * know, in a sealed `tests` table — among its real tasks (`tests` on the
 * type). A worker granted it first QUALIFIES on K tests, then is served one
 * in place of a real task at the type's rate; what they are served is an
 * INSTANCE that goes through every call a real task does, so a page cannot
 * tell them apart. Answering one wakes no run: it is GRADED (`equal`, or a
 * sealed step through `deps.grade`), and a worker's standing — the newest
 * graded tests since the grant — under the type's threshold revokes the
 * grant. A `fail` inside its hold takes back what the answer earned; an
 * `error` counts for nothing. Authoring is the staff's routes'
 * (`TasksService.tests`); no capability method, step or other route holds an
 * expected answer.
 *
 * COPIES (§7.6, item 4b): a `human` step may ask several workers
 * (`copies`, up to its type's `copies.max`; a type without a copies rule
 * asks one). Each answers on their own lease and earns as any answer does.
 * When the last answer asked for is in, the task is DECIDED: grouped by the
 * type's `compare` — `equal` inside `submit`'s transaction, a sealed step
 * through `deps.grade` in the queue grading uses, while no lease can be
 * taken — it settles with the first answer of a group of `agree`, asks one
 * more worker (`more`, up to `max`), or is `disputed`, which fails the step.
 * `onAgreed` hears each decision; nothing is taken back on disagreement.
 *
 * Nothing is made until something is asked of it: no file on a strut that
 * never runs a `human` step, and a staff READ on such a strut answers empty.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { RunControl } from "../run-control.js";
import type { RunFile } from "../runs.js";
import { ZERO_BALANCE, type Earning, type LedgerStore, type PayeeBalance } from "../payments/ledger.js";
import { answerProblem, answerSchemaProblem, type AnswerSchema } from "./answer-schema.js";
import {
  DEFAULT_HOLD_HOURS,
  DEFAULT_TEST_RULES,
  MemoryTaskStore,
  STATS_WINDOWS,
  VERDICTS,
  answersOf,
  payMsatOf,
  settledOf,
  type CopiesDecision,
  type StatsWindow,
  type WindowCounts,
  type WorkerWeek,
  type CopiesRule,
  type GradeResult,
  type GradeRule,
  type Lease,
  type ReviewRecord,
  type StandingRow,
  type Verdict,
  type TaskListQuery,
  type TaskRecord,
  type TaskSettled,
  type TaskStore,
  type TaskType,
  type TestChange,
  type TestCounts,
  type TestInstance,
  type TestRecord,
  type TestRules,
} from "./task-store.js";
import { gradeRuleOf, phaseOf, revokeWhy, RuleProblem, sameJson, standingOf, testRulesOf, type Standing } from "./task-tests.js";
import { COPIES_MAX, copiesRuleOf, decideCopies, decidingRule, groupsOf, groupsOfAsync } from "./task-copies.js";
import { TEST_FILE_MAX_BYTES, type TestFiles } from "./test-files.js";
import { liveGrants, MemoryWorkerStore, noStatuses, WORKER_STATUSES, type Grant, type WorkerRecord, type WorkerStatus, type WorkerStore } from "./worker-store.js";

export type { AnswerSchema } from "./answer-schema.js";
export type { CopiesRule, GradeResult, GradeRule, Lease, ReviewRecord, StatsWindow, TaskRecord, TaskSettled, TaskStatus, TaskType, TestInstance, TestRecord, TestRules, Verdict, WorkerWeek } from "./task-store.js";
export type { PayeeBalance } from "../payments/ledger.js";
export type { Standing } from "./task-tests.js";
export { DEFAULT_HOLD_HOURS, DEFAULT_TEST_RULES, TASK_STATUSES, VERDICTS } from "./task-store.js";
export { COPIES_MAX, DEFAULT_COPIES_RULE } from "./task-copies.js";
export type { Grant, WorkerRecord, WorkerStatus } from "./worker-store.js";

/** §4.2's defaults. */
export const DEFAULT_LEASE_SECONDS = 600;
export const DEFAULT_WITHIN_HOURS = 72;
export const LEASE_SECONDS_MAX = 24 * 60 * 60;
export const WITHIN_HOURS_MAX = 365 * 24;
/** §8.1: the most one answer may earn — a guard against a slip, not a
 *  policy — and the bounds of a type's hold, in hours (never 0: earnings
 *  wait). */
export const PAY_SATS_MAX = 1_000_000;
export const HOLD_HOURS_MIN = 1;
export const HOLD_HOURS_MAX = 720;
/** §8.1: how many unbooked answers one sweep books at most. */
export const BOOK_BATCH = 500;
/** §3: what a task may show, and how many files it may name. */
export const SHOW_MAX_BYTES = 256 * 1024;
export const FILES_MAX = 200;
/** What a `human` step parks on (src/park.ts): `task:<id>`. The store is
 *  that prefix's source, registered by createStrut. */
export const TASK_PARK_PREFIX = "task";
/** Rule 8: how often the sweep runs. */
export const SWEEP_EVERY_MS = 60_000;
/** §5.1: the longest `next { wait }` holds for a task to appear, in
 *  seconds — under a host's 60 s tool-call timeout. */
export const NEXT_WAIT_MAX_S = 25;
/** §5.2: the store's own limit, in memory — worker calls (`next`, `submit`,
 *  `skip`, `file`, `me`) one worker may make in a minute. A held `next
 *  { wait }` counts once. */
export const TASK_CALLS_PER_MINUTE = 120;
/** §7.4, §7.8: a step grader's time, then force-cancelled; how many grade
 *  at once in the process; how many ungraded answers one sweep queues; how
 *  many errors in a row of one type are logged (once). */
export const GRADE_TIMEOUT_MS = 60_000;
export const GRADE_CONCURRENCY = 4;
export const UNGRADED_BATCH = 100;
export const GRADE_ERRORS_LOGGED = 3;
/** §7.6: how many copies tasks left with all their answers and no decision
 *  one sweep queues. */
export const UNDECIDED_BATCH = 100;
/** §9.6: how a take-back a review's rejection made begins its `why`, so
 *  `ok` undoes that one alone. */
export const REVIEW_TAKE_BACK = "review: ";
/** Who a grade's take-back and a standing revoke are by. */
export const GRADING_ACTOR = "grading";
export const STANDING_ACTOR = "standing";
/** §5.2: requests to `/public/*` a minute counted under an ACTIVE worker
 *  (`isActiveWorker`) in place of their address's budget, so a room of
 *  workers behind one address is not one budget. */
export const TASK_REQUESTS_PER_MINUTE = 240;

/** A task type's name (§4.2): lowercase segments joined by "/". */
export const TYPE_NAME_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*$/;
export const TYPE_NAME_MAX = 128;
const ACTOR_MAX = 512;
const TEXT_MAX = 2000;

// ── the stores ──────────────────────────────────────────────────────────────

export interface TaskStores {
  tasks: TaskStore;
  workers: WorkerStore;
  /** Folds the file's WAL into it. */
  close(): Promise<void>;
}

/** `<dataDir>/tasks/tasks.db`. */
export function tasksPath(dataDir: string): string {
  return join(dataDir, "tasks", "tasks.db");
}

/** Both sides on one file, its folder owner-only. `node:sqlite` is imported
 *  here, on first use, never at boot. */
export async function openTaskStores(o: { dataDir: string } | { file: string }): Promise<TaskStores> {
  const [{ TaskDb }, { SqliteTaskStore, taskSchema }, { SqliteWorkerStore, workerSchema }] = await Promise.all([
    import("./db.js"),
    import("./task-store-sqlite.js"),
    import("./worker-store-sqlite.js"),
  ]);
  const db = TaskDb.open("file" in o ? o.file : tasksPath(o.dataDir));
  // Both sides' tables made, or an older file's brought to version 2, in
  // one transaction (plans/human-steps.md §7.7).
  try {
    db.migrate(() => {
      taskSchema(db);
      workerSchema(db);
    });
  } catch (err) {
    db.close();
    throw err;
  }
  return { tasks: new SqliteTaskStore(db), workers: new SqliteWorkerStore(db), close: async () => db.close() };
}

export function memoryTaskStores(): TaskStores {
  return { tasks: new MemoryTaskStore(), workers: new MemoryWorkerStore(), close: async () => {} };
}

// ── errors ──────────────────────────────────────────────────────────────────

export type TaskErrorCode =
  | "refused"
  | "bad_request"
  | "bad_schema"
  | "unknown_type"
  | "type_disabled"
  | "not_active"
  | "not_granted"
  | "wrong_app"
  | "lease_held"
  | "no_lease"
  | "lease_closed"
  | "lease_expired"
  | "task_closed"
  | "bad_answer"
  | "unknown_worker"
  | "unknown_task"
  | "too_many"
  | "not_listed"
  | "no_file"
  | "in_use"
  | "unknown_test"
  | "bad_grader"
  | "no_answer"
  | "final";

/** A refusal the caller can act on; `code` first in the message, as a
 *  step's error is read. */
export class TaskError extends Error {
  constructor(
    readonly code: TaskErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "TaskError";
  }
}

// ── the capability ──────────────────────────────────────────────────────────

/** What a `human` step asks for (§3). */
export interface EnsureInput {
  /** The task type's name. It must exist and be enabled to make a task. */
  type: string;
  workflow: string;
  runId: string;
  /** The step's path in the run. */
  path: string;
  /** Any JSON, at most 256 KB. */
  show?: unknown;
  /** Paths under the run's files: the job's directory when `job` is set,
   *  else the run's artifacts. At most 200. With `resolveFiles`, the
   *  entries as the step wrote them (a pattern among them). */
  files?: string[];
  job?: string;
  /** Overrides the type's. */
  withinHours?: number;
  /** How many workers answer it (§7.6): 1 by default, at most the type's
   *  `copies.max` (1 when the type has no copies rule). */
  copies?: number;
}

/** What only the `human` step hands `ensure` beside its input. */
export interface EnsureOptions {
  /** The run asking: refused where the deps' `refusal` says (a run that
   *  may not ask a person, plans/human-steps.md §3). */
  control?: RunControl;
  /** Called once, and only when the task is MADE: the `files` entries as
   *  the task keeps them — each pattern expanded, each path checked on disk
   *  (src/tasks/files.ts). A task made already keeps the list it was made
   *  with, so a file written or removed later changes nothing. */
  resolveFiles?: (files: string[]) => Promise<string[]>;
}

export interface TaskTypeInput {
  app: string;
  /** The answer's schema (§4.5); refused when it uses what strut does not check. */
  answer: unknown;
  leaseSeconds?: number;
  withinHours?: number;
  enabled?: boolean;
  /** What one accepted answer earns, in sats to the msat (§8.1), at most
   *  `PAY_SATS_MAX`; absent or 0: unpaid. */
  paySats?: number;
  /** How long an earning waits before it can be withdrawn: hours from 1 to
   *  720, 72 by default. */
  holdHours?: number;
  /** Its test rules (§7.2, §7.5): §7.8's defaults with these over them;
   *  absent or null: off. */
  tests?: Partial<TestRules> | null;
  /** Its copies rule (§7.6): §7.8's defaults (`max` 3, `agree` 2, `equal`,
   *  `more`) with these over them; absent or null: off, a step asks one
   *  worker. */
  copies?: Partial<CopiesRule> | null;
}

/** What a settled task's answer earned (§8.1): the lease's stamp, and the
 *  dollars at the rate when it was read — left out when no rate could be. */
export interface TaskPay {
  msat: number;
  usd?: number;
}

/** One answer to a copies task (§7.6), in the order given: what it was,
 *  who gave it, and whether it agreed with the answer the task settled
 *  with. */
export interface CopyAnswer {
  answer: unknown;
  by: string;
  agrees: boolean;
}

/** A copies task decided (§7.9): settled by agreement (`agreed`) or
 *  disputed, with each answer's lease and worker and whether it agreed.
 *  What a rule on a disagreeing copy's earning would hear; none is built. */
export interface AgreedTask {
  task: string;
  type: string;
  agreed: boolean;
  answers: Array<{ lease: string; worker: string; agrees: boolean }>;
  at: number;
}

/** One task as its worker sees it: what to show, and the lease to answer by. */
export interface WorkerTask {
  lease: string;
  type: string;
  show: unknown;
  files: string[];
  /** Epoch ms. */
  expires: number;
  /** The task type's answer schema (§4.5): what a form draws (`TaskForm`). */
  answer: AnswerSchema;
  /** What an answer earns, msat: the type's pay when the lease was taken,
   *  locked (§8.1). 0: unpaid. */
  payMsat: number;
}

/** A worker as they see themselves (`task/me`). */
export interface WorkerView {
  actor: string;
  status: WorkerStatus;
  /** The enabled types they hold a live grant for (of the app asked about,
   *  when given); what they may take while `active` — each with what an
   *  answer earns now, msat (0: unpaid), and whether they are qualifying
   *  for it (§7.5, ruling 3): served only tests until they qualify. No
   *  score is shown. */
  types: Array<{ name: string; app: string; payMsat: number; qualifying: boolean }>;
  /** What they are owed here (§8.1): zeros with nothing earned. */
  balance: PayeeBalance;
}

/** An answer's earning as staff read it (§8.1): booked in the ledger. */
export type LeaseEarning = Pick<Earning, "msat" | "at" | "releases" | "takenBack" | "takenBackWhy" | "takenBackBy">;
/** A verdict as staff read it, on its answer's lease (§9.6): `until` is when
 *  it can no longer change — the answer's earning's hold end, or for an
 *  unpaid answer the type's hold from when it was answered — and `final`
 *  whether that has passed. */
export type LeaseReview = Omit<ReviewRecord, "task" | "worker"> & { until: number; final: boolean };
export type LeaseView = Lease & { earning?: LeaseEarning; review?: LeaseReview };
export type TaskView = TaskRecord & { leases: LeaseView[] };
/** A worker as staff read them: with what they are owed here (§8.1), and
 *  their standing in each type with tests they hold (§7.5). */
export type StaffWorker = WorkerRecord & {
  balance: PayeeBalance;
  standing: Record<string, Standing>;
  /** §9.5: answers in the last 7 days, and the type of the lease they hold now. */
  week: number;
  holding?: string;
};

/** A test as staff read it (§7.1): with how its instances were graded, and
 *  the listed files not there yet (absent once it is ready). */
export type TestView = TestRecord & TestCounts & { missing?: string[] };

/** What staff write to make a test. */
export interface TestInput {
  type: string;
  show?: unknown;
  /** The paths to come (`PUT /tasks/tests/:id/files/<path>`). */
  files?: string[];
  /** Checked against the type's answer schema. */
  expected: unknown;
  grade?: GradeRule;
}

/** The staff's authoring of tests (§7.1): the test routes', never a
 *  capability's — the one place, with the grader, an expected answer is
 *  read. */
export interface TestAuthoring {
  list(q?: { type?: string; retired?: boolean }): Promise<TestView[]>;
  /** The test with each instance served: who, the answer, the grade and
   *  what the grader said. */
  get(id: string): Promise<{ test: TestView; instances: TestInstance[] } | undefined>;
  create(input: TestInput, by?: string): Promise<TestView>;
  /** From a real task: its `show`, its files copied, and its accepted
   *  answer as `expected` unless one is given. Its worker is never served
   *  it. */
  fromTask(task: string, o?: { expected?: unknown; grade?: GradeRule }, by?: string): Promise<TestView>;
  /** Only before it is first served (`in_use` after, ruling 8). */
  update(id: string, change: TestChange): Promise<TestView>;
  /** One listed file's bytes; the test is ready once every one is there. */
  putFile(id: string, path: string, bytes: Uint8Array): Promise<TestView>;
  /** Never served again; kept for the grades that name it. */
  retire(id: string, by?: string): Promise<TestView>;
}

/** A test instance graded (§7.9): what item 5a's take-back and the staff's
 *  pages hear. */
export interface GradedTest {
  lease: string;
  task: string;
  test: string;
  worker: string;
  type: string;
  result: GradeResult;
  answeredAt: number;
  at: number;
}

/** What a step grader is handed (§7.4). */
export interface GradeCall {
  step: string;
  config?: Record<string, unknown>;
  input: { answer: unknown; expected: unknown; show: unknown; type: string };
  principal: string;
  maxCostUsd: number;
  timeoutMs: number;
}

/** A step grader's verdict, in the claims check contract. */
export interface GradeVerdict {
  supports: boolean;
  content: string;
}

/** What a take-back did to one answer's earning (§8.1). */
export interface TakeBackOutcome {
  lease: string;
  worker: string;
  /** `taken` (now, or already: `earning.takenBack` says when), `released`
   *  (past its hold: it is the worker's), `none` (it earned nothing). */
  result: "taken" | "released" | "none";
  earning?: LeaseEarning;
}

/** What a verdict did (§9.6): the answer it is on, the verdict as it now
 *  stands, and the answer's earning after it. */
export interface ReviewOutcome {
  task: string;
  worker: string;
  lease: string;
  review: LeaseReview;
  earning?: LeaseEarning;
}

/** p50 and p90 in ms, nearest rank (§9.4). */
export interface Percentiles {
  p50: number;
  p90: number;
}

/** One window of one type's queue as staff read it (§9.4). */
export interface StatsWindowView {
  answered: number;
  expired: number;
  cancelled: number;
  disputed: number;
  skipped: number;
  leasesLost: number;
  /** Made to answered, over the newest `STATS_SAMPLE` settled tasks; taken
   *  to answered, over the newest answers. Absent with none. */
  toAnswer?: Percentiles;
  work?: Percentiles;
}

/** One type's row of the Queue (§9.4, §9.5). */
export interface TypeStats {
  type: string;
  app: string;
  enabled: boolean;
  /** Open and not past due, with no live lease and with one. */
  waiting: number;
  working: number;
  /** The oldest waiting task's age, ms. */
  oldest?: number;
  /** Open tasks due within 24 hours, and within the hour. */
  dueSoon: number;
  dueHour: number;
  /** Workers who hold it live, hold a lease of it now, and ask for one now. */
  granted: number;
  holding: number;
  asking: number;
  windows: Record<StatsWindow, StatsWindowView>;
  /** What is wrong with its app (`taskAppProblem`): the routes add it. */
  appProblem?: string;
}

/** `GET /tasks/stats` (§9.4): computed on read, never stored. */
export interface TaskStats {
  at: number;
  types: TypeStats[];
  /** Across every type: workers by status, live leases, held `task/next`s. */
  workers: Record<WorkerStatus, number>;
  holding: number;
  asking: number;
}

/** One worker as `GET /tasks/workers/:actor` adds them up (§9.4). */
export interface WorkerActivity {
  /** Their live lease now. */
  holding?: { lease: string; task: string; type: string; expires: number };
  /** Of the leases taken in the last 7 days, by type. */
  week: Record<string, WorkerWeek>;
  /** Their newest leases, each with its task, and an answer's verdict
   *  (§9.6). */
  recent: Array<{ lease: LeaseView; task: Pick<TaskRecord, "id" | "type" | "workflow" | "runId" | "status"> & { test?: string } }>;
}

/** How many of a worker's leases `recent` lists. */
export const RECENT_LEASES = 50;

/** p50 and p90 of `xs` by nearest rank; undefined for none. */
export function percentiles(xs: readonly number[]): Percentiles | undefined {
  if (!xs.length) return undefined;
  const sorted = [...xs].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
  return { p50: at(0.5), p90: at(0.9) };
}

export interface TasksCapability {
  /** The `human` step's: the task keyed by workflow, run and path, made
   *  when there is none (rule 1). A settled task comes with what its
   *  answers earned (`pay`, §8.1), when they earned anything, and a copies
   *  task's settled with every answer (`answers`, §7.6). */
  ensure(input: EnsureInput, o?: EnsureOptions): Promise<{ task: TaskRecord; created: boolean; pay?: TaskPay; answers?: CopyAnswer[] }>;

  // The worker's. `actor` is the caller's own (rule 5); `app`, the calling
  // app's name, when the call comes from one: a lease of a type another app
  // draws is refused (`wrong_app`). Every call counts against the worker's
  // `TASK_CALLS_PER_MINUTE` (`too_many`).
  /** The worker's live lease when it is of a type asked for, else a new one
   *  on the oldest open task they may take; `{ none: true }` when there is
   *  none. `type` narrows to one type, `app` to the types an app draws.
   *  `wait` (seconds, at most `NEXT_WAIT_MAX_S`) holds that long for a task
   *  to appear before answering `{ none: true }`; it counts as one call. */
  next(actor: string, o?: { type?: string; app?: string; wait?: number }): Promise<WorkerTask | { none: true }>;
  submit(actor: string, o: { lease: string; answer: unknown; app?: string }): Promise<{ ok: true }>;
  /** The task reopens for someone else; never handed to this worker again. */
  skip(actor: string, o: { lease: string; reason?: string; app?: string }): Promise<{ ok: true }>;
  /** One file the leased task names (`files`), as `run/files` answers one
   *  (§5.5): only a path on the task's list, only through the caller's own
   *  live lease, whether or not another path exists. */
  file(actor: string, o: { lease: string; path: string; app?: string }): Promise<RunFile>;
  /** Who the worker is here, what they may take, and what they are owed;
   *  the first call writes them as `new`. */
  me(actor: string, o?: { app?: string }): Promise<WorkerView>;

  // Staff's.
  types(): Promise<TaskType[]>;
  /** Saves the whole type (a PUT: what is left out is the default — unpaid,
   *  a 72-hour hold). A change of pay reaches the next lease taken, never one
   *  in hand (§8.1). */
  setType(name: string, input: TaskTypeInput, by?: string): Promise<TaskType>;
  /** Removes a type no open task is of (`in_use` otherwise: turn it off
   *  and let them settle), and revokes its live grants. Its tasks on file
   *  keep its name. */
  deleteType(name: string, by?: string): Promise<{ name: string; revoked: number }>;
  /** Each with what they are owed here, in one grouped read (§8.1). */
  workers(q?: { status?: WorkerStatus }): Promise<StaffWorker[]>;
  /** `suspended` or `banned` expires the worker's live lease at once. */
  setWorker(actor: string, change: { status?: WorkerStatus; note?: string | null }, by?: string): Promise<WorkerRecord>;
  /** A grant of a type with tests records its K (`qualify`, §7.5): the
   *  type's, or 0 with `qualify: false` or too few ready tests (`notice`
   *  says so). A grant already live stays as it is. */
  grant(actor: string, type: string, by?: string, o?: { qualify?: boolean }): Promise<WorkerRecord & { notice?: string }>;
  /** Expires the worker's live lease of that type at once; the status stays. */
  revoke(actor: string, type: string, o?: { by?: string; why?: string }): Promise<WorkerRecord>;
  /** Tasks newest first, with their leases — each answer's earning with it
   *  (§8.1). */
  list(q?: TaskListQuery): Promise<TaskView[]>;
  task(id: string): Promise<TaskView | undefined>;
  /** One worker as staff read them, with their standing (§7.5). */
  worker(actor: string): Promise<StaffWorker | undefined>;
  /** §9.4: each type's queue (one type with `type`), and the workers across
   *  them. Computed on read. */
  stats(q?: { type?: string }): Promise<TaskStats>;
  /** §9.4: what one worker holds and did; undefined for nobody here. */
  activity(actor: string): Promise<WorkerActivity | undefined>;
  /** §9.4: one of a task's files, as `file` answers it, read by staff
   *  without a lease: only a path on the task's list (`not_listed`). */
  taskFile(id: string, path: string): Promise<RunFile>;
}

export interface TasksService {
  /** Frozen: the whole store — the staff routes' (`src/tasks/routes.ts`),
   *  which hold it. Never on a services bag (plans/human-steps.md §9.2). */
  capability: TasksCapability;
  /** Frozen: `ensure` alone, the `human` step's — what every step's
   *  `ctx.services.tasks` is on the shared bag (§9.2). */
  human: HumanTasksCapability;
  /** Frozen: the worker's calls alone — what a `worker: true` step's own
   *  call bag carries on an app door (`step_run` on `POST /mcp` and `POST
   *  /public/mcp`, §5.2, §9.2), never the staff's. */
  worker: WorkerTasksCapability;
  /** Whether `actor` is an ACTIVE worker here, from memory (the store's
   *  active workers, loaded when it opens and kept by every write): what
   *  the public routes count a request under (§5.2). False before the
   *  store is open. */
  isActiveWorker(actor: string): boolean;
  /** Rule 7 and 8's notice: tasks that left `open` — answered, expired,
   *  cancelled — so a source can wake their runs. Returns the unsubscribe. */
  onSettle(listener: (settled: TaskSettled[]) => void): () => void;
  /** Whether task `id` no longer waits: settled, expired or cancelled, or
   *  not on file (nothing will ever settle it). */
  settled(id: string): Promise<boolean>;
  /** The open task by id, or the open tasks of a run, cancelled — their
   *  leases closed. */
  cancel(id: string): Promise<TaskSettled[]>;
  cancelRun(workflow: string, runId: string): Promise<TaskSettled[]>;
  /** §8.1: takes back the earnings a task's answers made — or `worker`'s
   *  alone — while they are held, booking one not booked yet first. A
   *  person's act (`POST /tasks/:id/take-back`, full scope) and item 4's
   *  (a test graded `fail`); never on a capability, so no step reaches it. */
  takeBack(o: { task: string; worker?: string; why: string; by?: string }): Promise<TakeBackOutcome[]>;
  /** §9.6: a person's verdict on one answer — the task's, or `worker`'s
   *  when it has several — `ok` or `rejected` (with why). It can be changed
   *  until the answer's hold ends (`until`), then it is `final`; a first
   *  verdict may come later, final at once. A MARK: nothing in the run
   *  changes. A rejection counts against the worker's standing in the type
   *  as a failed test does (§7.5), and `ok` undoes that. Inside the hold a
   *  rejection takes the answer's earning back (`why` begins `review: `)
   *  and `ok` restores that take-back (the ledger's `restore`); past it no
   *  money moves. A person's act
   *  (`PUT /tasks/:id/review`, full scope); never on a capability. */
  review(o: { task: string; worker?: string; verdict: Verdict; why?: string; by?: string }): Promise<ReviewOutcome>;
  /** §7.1: the staff's tests, for the test routes alone. */
  tests: TestAuthoring;
  /** §7.9: every test instance graded. Returns the unsubscribe. */
  onGraded(listener: (graded: GradedTest) => void): () => void;
  /** §7.9: every copies task decided — settled by agreement, or disputed.
   *  Every copy keeps its earning: a rule taking back a disagreeing copy's
   *  is not built. Returns the unsubscribe. */
  onAgreed(listener: (agreed: AgreedTask) => void): () => void;
  /** Resolves once nothing waits in the queue: no answered test to grade
   *  and no copies task for a step to decide (a test's wait). */
  grading(): Promise<void>;
  /** Rule 8, now, and §8.1's backstop: books every answer whose earning is
   *  not booked, queues every answered test not graded (§7.4: after a
   *  restart) and every copies task with all its answers and no decision
   *  (§7.6, `deciding`). Opens the store. */
  sweep(): Promise<{ leases: number; expired: TaskSettled[]; booked: number; grading: number; deciding: number }>;
  /** The sweep at once and every minute, while a store is open or on file. */
  start(): void;
  stop(): void;
  close(): Promise<void>;
}

/** The worker's calls of the capability (§5.1). */
export type WorkerTasksCapability = Pick<TasksCapability, "next" | "submit" | "skip" | "file" | "me">;

/** What the shared services bag carries (§9.2): the `human` step's call. */
export type HumanTasksCapability = Pick<TasksCapability, "ensure">;

export interface TasksDeps {
  /** The stores, opened on first use. */
  open(): Promise<TaskStores>;
  /** One of a task's files, as `run/files` answers one, read from where its
   *  run's files are (src/tasks/files.ts); null when it is not there. The
   *  service checks the lease and the list first. Left out: no files. */
  file?(task: TaskRecord, path: string): Promise<RunFile | null>;
  /** `TASK_CALLS_PER_MINUTE`, for a test. */
  callsPerMinute?: number;
  /** Why the run `control` belongs to may not ask a person, else
   *  undefined: `ensure` refuses before anything is made. */
  refusal?(control: RunControl | undefined): string | undefined;
  /** Whether a store is on file already, so a read or the timer opens one
   *  only then. Left out: never (memory). */
  exists?(): boolean;
  /** §8.1: the ledger an earning is booked in, made on the first paid
   *  answer. Left out: nothing is booked. */
  ledger?(): Promise<LedgerStore>;
  /** The ledger when there is one, without making it: what a balance reads
   *  (a worker with nothing earned reads zeros, and no file is made). */
  ledgerIfAny?(): Promise<LedgerStore | null>;
  /** Dollars per bitcoin now: a settled task's pay in dollars, for the run's
   *  cost (§8.1). Left out, or failing: the pay has no dollars. */
  usdPerBtc?(): Promise<number>;
  /** §7.1: tests' files. `file` reads an instance's (`root: "test"`) from
   *  here, as it reads a real task's from its run, so both come back alike.
   *  Left out: a test may list no files. */
  testFiles?: TestFiles;
  /** One of a real task's files' bytes, for a test made from it. */
  bytes?(task: TaskRecord, path: string): Promise<Uint8Array | null>;
  /** §7.4: why a step may not grade (not sealed, not here), else
   *  undefined. Asked when a type or test is saved and at each grading.
   *  Left out: only `equal` grades. */
  graderProblem?(step: string): string | undefined;
  /** §7.4: a step grader's one run (`grade-step.ts`); throws when it cannot
   *  give a verdict. */
  grade?(call: GradeCall): Promise<GradeVerdict>;
  /** §7.12, 1: who a step grader is billed to; else the admin who last
   *  saved the type; else nobody, and it cannot run. */
  principal?: string;
  /** §7.2's draws, and the tie between least-served tests: [0, 1). */
  random?(): number;
  gradeTimeoutMs?: number;
  now?(): number;
  sweepEveryMs?: number;
}

export function createTasks(deps: TasksDeps): TasksService {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const pick = (n: number) => Math.floor(random() * n);
  /** The ACTIVE workers, by actor: loaded when the store opens, kept by
   *  every write of a worker row (`note`). */
  const active = new Set<string>();
  const note = (w: WorkerRecord): WorkerRecord => {
    if (w.status === "active") active.add(w.actor);
    else active.delete(w.actor);
    return w;
  };
  let opening: Promise<TaskStores> | undefined;
  const stores = (): Promise<TaskStores> => {
    opening ??= deps.open().then(async (s) => {
      for (const w of await s.workers.list({ status: "active" })) active.add(w.actor);
      return s;
    });
    opening.catch(() => {
      opening = undefined;
    });
    return opening;
  };
  /** The stores when there are any, without making them. */
  const storesIfAny = (): Promise<TaskStores> | undefined => (opening || deps.exists?.() ? stores() : undefined);

  const listeners = new Set<(settled: TaskSettled[]) => void>();
  const tell = (settled: TaskSettled[]) => {
    if (!settled.length) return;
    for (const fn of listeners) {
      try {
        fn(settled);
      } catch (err) {
        console.error(`[tasks] a settle listener threw:`, err);
      }
    }
  };

  /** §5.2: worker calls a minute, per worker, in memory. */
  const perMinute = deps.callsPerMinute ?? TASK_CALLS_PER_MINUTE;
  const calls = new Map<string, { minute: number; n: number }>();
  const count = (actor: string) => {
    actorOk(actor);
    const minute = Math.floor(now() / 60_000);
    const at = calls.get(actor);
    if (!at || at.minute !== minute) {
      if (calls.size > 10_000) for (const [k, v] of calls) if (v.minute !== minute) calls.delete(k);
      calls.set(actor, { minute, n: 1 });
      return;
    }
    if (++at.n > perMinute) throw new TaskError("too_many", `at most ${perMinute} task calls a minute for one worker; wait a minute (a held next { wait } counts once)`);
  };

  /** Rules 5 and 6: the worker as they are now, written `new` on first sight. */
  const worker = async (actor: string): Promise<{ s: TaskStores; w: WorkerRecord }> => {
    actorOk(actor);
    const s = await stores();
    return { s, w: note(await s.workers.seen(actor, now())) };
  };
  /** A lease's type is drawn by the calling app (§5.1): another app reaches
   *  none of its tasks, whatever lease it names. */
  const appOk = async (s: TaskStores, l: Lease, app: string | undefined, kind?: TaskType) => {
    if (app === undefined) return;
    const k = kind ?? (await s.tasks.type(l.type));
    if (!k || k.app !== app) throw new TaskError("wrong_app", `task type ${l.type} is drawn by another app`);
  };

  // ── next { wait } (§5.1) ──────────────────────────────────────────────
  // A held `next` waits here, woken by what could free a task for it: a
  // task MADE or SKIPPED of a type it may take wakes the oldest such waiter
  // — one per task, and a waiter that then takes nothing hands the wake on
  // to the next, so one task is never a thousand guarded writes — and what
  // frees tasks of unknown types (the sweep, a worker let go of, a type
  // saved) wakes every waiter once. A grant, a revoke or a status change
  // wakes that worker's own. A lease that runs out between sweeps wakes
  // nobody: the next call (a page asks again as a wait ends) finds it.
  interface Wake {
    type: string;
    tried: Set<Waiter>;
  }
  interface Waiter {
    actor: string;
    types: ReadonlySet<string>;
    wake(w: Wake | null): void;
  }
  const waiting: Waiter[] = [];
  let closing = false;
  const unwait = (w: Waiter) => {
    const i = waiting.indexOf(w);
    if (i >= 0) waiting.splice(i, 1);
  };
  /** Wake the oldest waiter for `type` that this wake has not tried. */
  const wakeFor = (type: string, tried: Set<Waiter> = new Set()) => {
    const i = waiting.findIndex((w) => w.types.has(type) && !tried.has(w));
    if (i < 0) return;
    const [w] = waiting.splice(i, 1);
    tried.add(w!);
    w!.wake({ type, tried });
  };
  const wakeAll = (actor?: string) => {
    for (const w of [...waiting]) {
      if (actor !== undefined && w.actor !== actor) continue;
      unwait(w);
      w.wake(null);
    }
  };
  /** One try at a task: the lease, or the types the worker may take now. */
  const attempt = async (actor: string, o: { type?: string; app?: string }): Promise<{ got?: WorkerTask; types: string[] }> => {
    const { s, w } = await worker(actor);
    mayWork(w);
    const held = liveGrants(w);
    const kinds = new Map((await s.tasks.types()).map((t) => [t.name, t]));
    if (o.type !== undefined) {
      const kind = kinds.get(o.type);
      if (!kind) throw new TaskError("unknown_type", `no task type ${o.type} here`);
      if (o.app !== undefined && kind.app !== o.app) throw new TaskError("wrong_app", `task type ${o.type} is drawn by another app`);
      if (!held.includes(o.type)) throw new TaskError("not_granted", `you do not hold task type ${o.type}`);
    }
    const types = held.filter((name) => {
      const kind = kinds.get(name);
      return kind && kind.enabled && (o.type === undefined || name === o.type) && (o.app === undefined || kind.app === o.app);
    });
    const at = now();
    const live = await s.tasks.heldBy(actor, at);
    if (live) {
      if (types.includes(live.type)) return { got: await workerTask(s, live), types };
      throw new TaskError("lease_held", `you hold a task of type ${live.type}; answer or skip it first`);
    }
    // §7.2: a type with tests serves the worker by where they are with it —
    // a qualifying one only tests, oldest grant first; one waiting for its
    // qualifying grades nothing; a qualified one real tasks, a test drawn in
    // place of one at the type's rate.
    const { qualifying, open, rows } = await phases(s, w, types.map((n) => kinds.get(n)!));
    for (const type of qualifying) {
      const got = await s.tasks.takeTest({ worker: actor, type, lease: randomId(), task: randomId(), now: at, pick });
      if (got) return { got: await workerTask(s, got), types };
    }
    if (open.length) {
      // A test only ever replaces a real task: drawn only when `take` would
      // hand one out now, and of that task's type.
      const kind = open.some((n) => kinds.get(n)?.tests) ? kinds.get((await s.tasks.peek({ worker: actor, types: open, now: at })) ?? "") : undefined;
      if (kind?.tests) {
        const answered = rows.get(kind.name)?.real ?? 0;
        if (random() < (answered < kind.tests.newTasks ? kind.tests.newRate : kind.tests.rate)) {
          const got = await s.tasks.takeTest({ worker: actor, type: kind.name, lease: randomId(), task: randomId(), now: at, pick });
          if (got) return { got: await workerTask(s, got), types };
        }
      }
      const taken = await s.tasks.take({ worker: actor, types: open, id: randomId(), now: at });
      if (taken) return { got: await workerTask(s, taken), types };
    }
    // Another call of the same worker may have taken one meanwhile.
    const raced = await s.tasks.heldBy(actor, at);
    return raced && types.includes(raced.type) ? { got: await workerTask(s, raced), types } : { types };
  };
  /** §7.2 step 2, §7.5: the types `w` may be served now — `qualifying` (tests
   *  alone, oldest grant first) and `open` (real tasks) — with the standing
   *  rows of those that have tests. A type waiting for its qualifying grades
   *  is in neither. A type without tests is open, as built. */
  const phases = async (s: TaskStores, w: WorkerRecord, kinds: TaskType[]) => {
    const grants = grantsOf(w);
    const rows = await standingRows(s, w.actor, kinds, grants);
    const qualifying: string[] = [];
    const open: string[] = [];
    for (const k of kinds) {
      const row = rows.get(k.name);
      const phase = k.tests && row ? phaseOf(row, grants.get(k.name)!) : "qualified";
      if (phase === "qualifying") qualifying.push(k.name);
      else if (phase === "qualified") open.push(k.name);
    }
    qualifying.sort((a, b) => grants.get(a)!.at - grants.get(b)!.at);
    return { qualifying, open, rows };
  };
  /** One worker's standing rows, by type, for the types with tests among
   *  `kinds` that they hold live. */
  const standingRows = async (s: TaskStores, actor: string, kinds: TaskType[], grants: Map<string, Grant>): Promise<Map<string, StandingRow>> => {
    const tested = kinds.filter((k) => k.tests && grants.has(k.name));
    if (!tested.length) return new Map();
    const rows = await s.tasks.standings(tested.map((k) => ({ worker: actor, type: k.name, since: grants.get(k.name)!.at, window: k.tests!.window })));
    return new Map(rows.map((r) => [r.type, r]));
  };
  const mayWork = (w: WorkerRecord) => {
    if (w.status !== "active") {
      throw new TaskError("not_active", `${w.status === "new" ? "you have no task types yet" : `you are ${w.status}`}; an admin decides who takes tasks here`);
    }
  };

  /** A lease the caller may act on (rule 3): their own, open, not past its
   *  expiry, of a type they still hold, on a task still open. */
  const ownLease = async (s: TaskStores, w: WorkerRecord, id: string): Promise<Lease> => {
    if (typeof id !== "string" || !id) throw new TaskError("bad_request", "a lease is required");
    const l = await s.tasks.lease(id);
    if (!l || l.worker !== w.actor) throw new TaskError("no_lease", "no such lease of yours");
    if (!liveGrants(w).includes(l.type)) throw new TaskError("not_granted", `you no longer hold task type ${l.type}`);
    if (l.status === "submitted") throw new TaskError("lease_closed", "this task was already answered");
    if (l.status === "skipped") throw new TaskError("lease_closed", "this task was skipped");
    const t = await s.tasks.task(l.task);
    if (!t || t.status !== "open") throw new TaskError("task_closed", `this task was ${t?.status ?? "removed"}`);
    if (l.status === "expired" || l.expires <= now()) throw new TaskError("lease_expired", "the time to answer this task ran out; ask for the next one");
    if (t.due <= now()) throw new TaskError("task_closed", "this task ran past its time");
    return l;
  };
  /** Why a guarded write on a lease that `ownLease` passed did not land:
   *  something changed in between, and `ownLease` now says what. */
  const whyNot = async (s: TaskStores, w: WorkerRecord, id: string): Promise<never> => {
    await ownLease(s, w, id);
    throw new TaskError("task_closed", "this task changed while you answered; ask for the next one");
  };

  const workerTask = async (s: TaskStores, l: Lease): Promise<WorkerTask> => {
    const [t, kind] = await Promise.all([s.tasks.task(l.task), s.tasks.type(l.type)]);
    return {
      lease: l.id,
      type: l.type,
      show: t!.show,
      files: t!.files,
      expires: l.expires,
      answer: kind?.answer ?? ({ type: "object", properties: {} } as AnswerSchema),
      payMsat: l.payMsat ?? 0,
    };
  };

  const views = async (s: TaskStores, tasks: TaskRecord[]): Promise<TaskView[]> => {
    const leases: LeaseView[] = await s.tasks.leasesOf(tasks.map((t) => t.id));
    // Each answer's earning, from the ledger — read only where one is, and
    // only when an answer on the page was paid.
    if (leases.some((l) => l.payMsat !== undefined && l.status === "submitted")) {
      const ledger = await deps.ledgerIfAny?.();
      const earned = ledger ? new Map((await ledger.payFor(tasks.map((t) => t.id))).map((e) => [e.lease, e])) : undefined;
      for (const l of leases) {
        const e = earned?.get(l.id);
        if (e) l.earning = leaseEarning(e);
      }
    }
    await withReviews(s, leases);
    return tasks.map((t) => ({ ...t, leases: leases.filter((l) => l.task === t.id) }));
  };

  // ── review (§9.6) ─────────────────────────────────────────────────────
  /** When a verdict on answer `l` can no longer change: its earning's hold
   *  end, or for an answer with none booked the type's hold from when it
   *  was answered (as booking would set it). */
  const holdEnd = (l: Lease, kind: TaskType | undefined, earning: Pick<Earning, "releases"> | undefined): number =>
    earning?.releases ?? (l.closed ?? l.taken) + Math.round((kind?.holdHours ?? DEFAULT_HOLD_HOURS) * HOUR_MS);
  const leaseReview = (r: ReviewRecord, until: number, at: number): LeaseReview => {
    const { task: _t, worker: _w, ...rest } = r;
    return { ...rest, until, final: at >= until };
  };
  /** Each answer's verdict on its lease, where one was given: its earning
   *  read for its hold where the lease does not carry it yet. */
  const withReviews = async (s: TaskStores, leases: LeaseView[]): Promise<void> => {
    const answered = leases.filter((l) => l.status === "submitted");
    if (!answered.length) return;
    const reviews = new Map((await s.tasks.reviewsOf([...new Set(answered.map((l) => l.task))])).map((r) => [`${r.task}\0${r.worker}`, r]));
    const reviewed = answered.filter((l) => reviews.has(`${l.task}\0${l.worker}`));
    if (!reviewed.length) return;
    const kinds = new Map((await s.tasks.types()).map((k) => [k.name, k]));
    const unread = reviewed.filter((l) => l.payMsat !== undefined && !l.earning);
    const ledger = unread.length ? await deps.ledgerIfAny?.() : undefined;
    const earned = ledger ? new Map((await ledger.payFor([...new Set(unread.map((l) => l.task))])).map((e) => [e.lease, e])) : undefined;
    const at = now();
    for (const l of reviewed) {
      const until = holdEnd(l, kinds.get(l.type), l.earning ?? earned?.get(l.id));
      l.review = leaseReview(reviews.get(`${l.task}\0${l.worker}`)!, until, at);
    }
  };

  // ── earnings (§8.1) ───────────────────────────────────────────────────
  /** Books a submitted, paid lease's earning in the ledger, then marks the
   *  lease booked here. The ledger answers the first row for a lease it
   *  holds already, so a crash between the two books nothing twice. */
  const book = async (s: TaskStores, leaseId: string): Promise<boolean> => {
    const l = await s.tasks.lease(leaseId);
    if (!l || l.status !== "submitted" || !l.payMsat || l.bookedAt !== undefined || !deps.ledger) return false;
    const [t, kind] = await Promise.all([s.tasks.task(l.task), s.tasks.type(l.type)]);
    const at = l.closed ?? now();
    const ledger = await deps.ledger();
    await ledger.pay({
      lease: l.id,
      task: l.task,
      worker: l.worker,
      type: l.type,
      msat: l.payMsat,
      at,
      // The hold as the type has it when the earning is booked: a change to
      // the hold reaches only later earnings.
      releases: at + Math.round((kind?.holdHours ?? DEFAULT_HOLD_HOURS) * HOUR_MS),
      workflow: t?.workflow ?? "",
      runId: t?.runId ?? "",
      path: t?.path ?? "",
    });
    await s.tasks.booked(l.id, now());
    return true;
  };
  /** What a settled task's answers earned — the submitted leases' stamps,
   *  every copy's (§7.6) — and the dollars at the rate now; and a copies
   *  task's answers in the order given. */
  const settledExtras = async (s: TaskStores, t: TaskRecord): Promise<{ pay?: TaskPay; answers?: CopyAnswer[] }> => {
    if (t.status !== "settled") return {};
    const answered = answersOf(await s.tasks.leasesOf([t.id]));
    const answers = t.copies > 1 ? answered.map((l) => ({ answer: l.answer ?? null, by: l.worker, agrees: l.agrees === true })) : undefined;
    const msat = answered.reduce((n, l) => n + (l.payMsat ?? 0), 0);
    if (!msat) return answers ? { answers } : {};
    let usd: number | undefined;
    try {
      const rate = await deps.usdPerBtc?.();
      if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) usd = Math.round(((msat * rate) / 1e11) * 1e6) / 1e6;
    } catch (err) {
      console.warn(`[tasks] no rate for task ${t.id}'s pay in dollars: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { pay: { msat, ...(usd !== undefined && usd > 0 ? { usd } : {}) }, ...(answers ? { answers } : {}) };
  };
  const balanceOf = async (actor: string): Promise<PayeeBalance> => {
    const ledger = await deps.ledgerIfAny?.();
    return ledger ? ledger.payeeBalance(actor, { now: now() }) : { ...ZERO_BALANCE };
  };

  // ── tests and standing (§7) ───────────────────────────────────────────
  const graderProblem = (step: string): string | undefined =>
    deps.graderProblem ? deps.graderProblem(step) : `this server grades by "equal" alone: no step grader (${step})`;
  /** A rule's problem as a refusal. */
  const ruled = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof RuleProblem) throw new TaskError(err.code, err.message);
      throw err;
    }
  };
  /** Workers as staff read them: each with what they are owed (one grouped
   *  read) and their standing in each type with tests they hold live. */
  const staffWorkers = async (s: TaskStores, list: WorkerRecord[]): Promise<StaffWorker[]> => {
    const ledger = list.length ? await deps.ledgerIfAny?.() : null;
    const owed = ledger ? await ledger.payeeBalances(list.map((w) => w.actor), { now: now() }) : {};
    const tested = new Map((await s.tasks.types()).filter((k) => k.tests).map((k) => [k.name, k]));
    const pairs = list.flatMap((w) =>
      w.grants.filter((g) => g.revokedAt === undefined && tested.has(g.type)).map((g) => ({ worker: w.actor, type: g.type, since: g.at, window: tested.get(g.type)!.tests!.window })),
    );
    const rows = pairs.length ? await s.tasks.standings(pairs) : [];
    const at = now();
    const doing = list.length ? await s.tasks.workersNow(at - STATS_WINDOWS.week, at) : { answered: {}, holding: {} };
    return list.map((w) => {
      const standing: Record<string, Standing> = {};
      for (const r of rows) {
        if (r.worker !== w.actor) continue;
        const g = w.grants.find((x) => x.type === r.type)!;
        standing[r.type] = standingOf(r, g, tested.get(r.type)!.tests!);
      }
      const holding = doing.holding[w.actor];
      return { ...w, balance: owed[w.actor] ?? { ...ZERO_BALANCE }, standing, week: doing.answered[w.actor] ?? 0, ...(holding !== undefined ? { holding } : {}) };
    });
  };

  const capability: TasksCapability = {
    async ensure(input, o = {}) {
      const refused = deps.refusal?.(o.control);
      if (refused) throw new TaskError("refused", refused);
      const type = need("type", input?.type);
      const workflow = need("workflow", input.workflow);
      const runId = need("runId", input.runId);
      const path = need("path", input.path);
      let files = filesOf(input.files);
      const show = input.show ?? null;
      const showBytes = jsonBytes(show);
      if (showBytes === undefined) throw new TaskError("bad_request", "show must be JSON");
      if (showBytes > SHOW_MAX_BYTES) throw new TaskError("bad_request", `show is ${showBytes} bytes as JSON; at most ${SHOW_MAX_BYTES} (name files instead of inlining them)`);
      if (input.job !== undefined) need("job", input.job);
      if (input.withinHours !== undefined) hours(input.withinHours);
      const copies = input.copies ?? 1;
      if (!Number.isSafeInteger(copies) || copies < 1 || copies > COPIES_MAX) throw new TaskError("bad_request", `copies is a whole number from 1 to ${COPIES_MAX}`);
      const s = await stores();
      // A task already made is the step's, whatever its type became since.
      const known = await s.tasks.byKey(workflow, runId, path);
      if (known) return { task: known, created: false, ...(await settledExtras(s, known)) };
      const kind = await s.tasks.type(type);
      if (!kind) throw new TaskError("unknown_type", `no task type ${type} here; an admin adds it`);
      if (!kind.enabled) throw new TaskError("type_disabled", `task type ${type} is turned off`);
      // §7.6: each copy is paid work, so how many a step may ask is the
      // type's, an admin's.
      const max = kind.copies?.max ?? 1;
      if (copies > max) {
        throw new TaskError(
          "bad_request",
          kind.copies
            ? `copies: task type ${type} asks at most ${max} workers a task (its copies.max); the step asked ${copies}`
            : `copies: task type ${type} asks one worker a task (an admin turns copies on for it); the step asked ${copies}`,
        );
      }
      if (o.resolveFiles) files = filesOf(await o.resolveFiles(files));
      const at = now();
      const made = await s.tasks.ensure({
        id: randomId(),
        type,
        workflow,
        runId,
        path,
        show,
        files,
        ...(input.job === undefined ? {} : { job: input.job }),
        created: at,
        due: at + Math.round((input.withinHours ?? kind.withinHours) * 3_600_000),
        copies,
      });
      // One waiter woken for each worker the task wants.
      if (made.created) for (let i = 0; i < made.task.copies; i++) wakeFor(made.task.type);
      return made;
    },

    async next(actor, o = {}) {
      count(actor);
      const wait = o.wait ?? 0;
      if (typeof wait !== "number" || !Number.isFinite(wait) || wait < 0 || wait > NEXT_WAIT_MAX_S) {
        throw new TaskError("bad_request", `wait is a number of seconds from 0 to ${NEXT_WAIT_MAX_S}`);
      }
      const deadline = Date.now() + wait * 1000;
      /** The wake this call was handed: passed on when it takes nothing. */
      let handed: Wake | null = null;
      for (;;) {
        let r: { got?: WorkerTask; types: string[] };
        try {
          r = await attempt(actor, o);
        } catch (err) {
          if (handed) wakeFor(handed.type, handed.tried);
          throw err;
        }
        if (r.got) return r.got;
        if (handed) wakeFor(handed.type, handed.tried);
        const left = deadline - Date.now();
        // A worker with nothing to take waits too: a page that asks again
        // the moment it hears "none" would never stop asking.
        if (left <= 0) return { none: true };
        const woke = await new Promise<Wake | null | "timeout">((resolve) => {
          const timer = setTimeout(() => {
            unwait(waiter);
            resolve("timeout");
          }, left);
          const waiter: Waiter = {
            actor,
            types: new Set(r.types),
            wake: (w) => {
              clearTimeout(timer);
              resolve(w);
            },
          };
          waiting.push(waiter);
        });
        if (woke === "timeout" || closing) return { none: true };
        handed = woke;
      }
    },

    async submit(actor, o) {
      count(actor);
      const { s, w } = await worker(actor);
      mayWork(w);
      const l = await ownLease(s, w, o?.lease);
      const kind = await s.tasks.type(l.type);
      if (!kind) throw new TaskError("unknown_type", `task type ${l.type} is gone`);
      await appOk(s, l, o.app, kind);
      const problem = answerProblem(kind.answer, o.answer);
      if (problem) throw new TaskError("bad_answer", problem);
      const r = await s.tasks.settle({ lease: l.id, worker: actor, answer: o.answer, now: now(), decide: inlineDecider(kind) });
      if (!r) return whyNot(s, w, l.id);
      const settled = r.task;
      // The answer is accepted: what it earns is owed (§8.1), a test's as a
      // real task's (§7.9), or the pay would tell. A booking that fails is
      // never the worker's — the sweep books it.
      if (l.payMsat) {
        await book(s, l.id).catch((err) => console.error(`[tasks] booking lease ${l.id}'s earning failed; the next sweep books it:`, err));
      }
      // §7.3: no run waits on a test instance, so nothing is woken: it is
      // graded, out of sight. The worker hears `ok` either way.
      if (settled.test !== undefined) queueGrade(settled.id);
      // §7.6: a copies task's last answer, decided here (`equal`), or by a
      // step in the queue; any other copy's answer waits for the rest.
      else if (r.decision) decided(settled, r.answers ?? [], r.decision);
      else if (r.answers) queueDecide(settled.id);
      else if (settled.status !== "open") tell([settledOf(settled)]);
      return { ok: true };
    },

    async skip(actor, o) {
      count(actor);
      const { s, w } = await worker(actor);
      mayWork(w);
      const l = await ownLease(s, w, o?.lease);
      await appOk(s, l, o.app);
      const reason = o.reason === undefined ? undefined : text("reason", o.reason);
      if (!(await s.tasks.skip({ lease: l.id, worker: actor, ...(reason === undefined ? {} : { reason }), now: now() }))) return whyNot(s, w, l.id);
      // The task is open for someone else.
      wakeFor(l.type);
      return { ok: true };
    },

    async file(actor, o) {
      count(actor);
      const { s, w } = await worker(actor);
      mayWork(w);
      const l = await ownLease(s, w, o?.lease);
      await appOk(s, l, o.app);
      const path = o.path;
      if (typeof path !== "string" || !path) throw new TaskError("bad_request", "path is required");
      const t = (await s.tasks.task(l.task))!;
      // Whether or not a file of that name exists: a task shows what its
      // step named, never the rest of its run (§5.5).
      if (!t.files.includes(path)) throw new TaskError("not_listed", `${JSON.stringify(path)} is not one of this task's files`);
      const f = deps.file ? await deps.file(t, path) : null;
      if (!f) throw new TaskError("no_file", `${JSON.stringify(path)} is no longer there`);
      return f;
    },

    async me(actor, o = {}) {
      count(actor);
      const { s, w } = await worker(actor);
      const kinds = new Map((await s.tasks.types()).map((t) => [t.name, t]));
      const held = liveGrants(w)
        .map((name) => kinds.get(name))
        .filter((k): k is TaskType => !!k && k.enabled && (o.app === undefined || k.app === o.app));
      // Ruling 3: a qualifying type is marked, with no score.
      const grants = grantsOf(w);
      const rows = await standingRows(s, w.actor, held, grants);
      const types = held.map((k) => {
        const row = rows.get(k.name);
        return { name: k.name, app: k.app, payMsat: payMsatOf(k) ?? 0, qualifying: !!(k.tests && row) && phaseOf(row!, grants.get(k.name)!) !== "qualified" };
      });
      // A worker's status touches no earning (§8.1): a suspended worker
      // still sees what they are owed.
      return { actor: w.actor, status: w.status, types, balance: await balanceOf(w.actor) };
    },

    async types() {
      const s = await storesIfAny();
      return s ? s.tasks.types() : [];
    },

    async setType(name, input, by) {
      if (typeof name !== "string" || name.length > TYPE_NAME_MAX || !TYPE_NAME_RE.test(name)) {
        throw new TaskError("bad_request", `a task type's name is lowercase letters, digits, ".", "_" and "-", segments joined by "/", at most ${TYPE_NAME_MAX} characters (got ${JSON.stringify(name)})`);
      }
      const app = need("app", input?.app);
      const problem = answerSchemaProblem(input.answer);
      if (problem) throw new TaskError("bad_schema", problem);
      const leaseSeconds = input.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
      if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > LEASE_SECONDS_MAX) {
        throw new TaskError("bad_request", `leaseSeconds is a whole number from 1 to ${LEASE_SECONDS_MAX}`);
      }
      const withinHours = hours(input.withinHours ?? DEFAULT_WITHIN_HOURS);
      if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new TaskError("bad_request", "enabled is true or false");
      const paySats = payOk(input.paySats);
      const holdHours = holdOk(input.holdHours);
      const tests = ruled(() => testRulesOf(input.tests, graderProblem));
      const copies = ruled(() => copiesRuleOf(input.copies, graderProblem));
      const s = await stores();
      const saved = await s.tasks.putType({
        name,
        app,
        answer: input.answer as TaskType["answer"],
        leaseSeconds,
        withinHours,
        enabled: input.enabled ?? true,
        ...(paySats ? { paySats } : {}),
        holdHours,
        ...(tests ? { tests } : {}),
        ...(copies ? { copies } : {}),
        changedAt: now(),
        ...(by === undefined ? {} : { changedBy: by }),
      });
      // Turned on, or now drawn by another app: what a waiter may take changed.
      wakeAll();
      return saved;
    },

    async deleteType(name, by) {
      if (typeof name !== "string" || !name) throw new TaskError("bad_request", "a task type's name is required");
      const s = await storesIfAny();
      const out = s ? await s.tasks.deleteType(name) : "missing";
      if (out === "missing") throw new TaskError("unknown_type", `no task type ${name} here`);
      if (out === "in_use") throw new TaskError("in_use", `task type ${name} has open tasks: turn it off (enabled: false) and let them settle or expire, or cancel their runs, then delete it`);
      // A type made again under this name later starts with no workers, and
      // its tests are never served again (§7.1).
      const at = now();
      await s!.tasks.retireTestsOf(name, by, at);
      let revoked = 0;
      for (const w of await s!.workers.list()) {
        if (!liveGrants(w).includes(name)) continue;
        const r = await s!.workers.revoke(w.actor, name, { ...(by === undefined ? {} : { by }), why: "task type deleted", now: at });
        if (r) note(r);
        revoked += 1;
      }
      return { name, revoked };
    },

    async workers(q = {}) {
      if (q.status !== undefined && !WORKER_STATUSES.includes(q.status)) throw new TaskError("bad_request", `status is one of ${WORKER_STATUSES.join(", ")}`);
      const s = await storesIfAny();
      if (!s) return [];
      return staffWorkers(s, await s.workers.list(q));
    },

    async worker(actor) {
      actorOk(actor);
      const s = await storesIfAny();
      const w = s && (await s.workers.get(actor));
      return w ? (await staffWorkers(s, [w]))[0] : undefined;
    },

    async setWorker(actor, change = {}, by) {
      actorOk(actor);
      if (change.status !== undefined && !WORKER_STATUSES.includes(change.status)) throw new TaskError("bad_request", `status is one of ${WORKER_STATUSES.join(", ")}`);
      if (change.note !== undefined && change.note !== null) text("note", change.note);
      const s = await stores();
      const at = now();
      const w = note(await s.workers.set(actor, change, by, at));
      // A worker who may no longer work lets go of what they hold, now: the
      // task is free for someone else (§4.6).
      if (w.status === "suspended" || w.status === "banned") {
        if (await s.tasks.release({ worker: actor, reason: `worker ${w.status}`, now: at })) wakeAll();
      }
      // Their held wait hears it now: a suspension at once, a lift too.
      wakeAll(actor);
      return w;
    },

    async grant(actor, type, by, o = {}) {
      actorOk(actor);
      if (o.qualify !== undefined && typeof o.qualify !== "boolean") throw new TaskError("bad_request", "qualify is true or false");
      const s = await stores();
      const kind = await s.tasks.type(type);
      if (!kind) throw new TaskError("unknown_type", `no task type ${type} here`);
      // §7.5: the type's K when it has that many ready tests, unless staff
      // know the worker (`qualify: false`, ruling 2).
      const k = kind.tests && o.qualify !== false ? kind.tests.qualify : 0;
      const ready = k > 0 ? await s.tasks.readyTests(type) : 0;
      const w = note(await s.workers.grant(actor, type, by, now(), ready >= k ? k : 0));
      wakeAll(actor);
      const made = w.grants.find((g) => g.type === type);
      return k > 0 && ready < k && made?.qualify === 0
        ? { ...w, notice: `task type ${type} has ${ready} ready test${ready === 1 ? "" : "s"}, fewer than the ${k} a worker qualifies on: this grant starts with no qualifying` }
        : w;
    },

    async revoke(actor, type, o = {}) {
      actorOk(actor);
      if (o.why !== undefined) text("why", o.why);
      const s = await stores();
      const at = now();
      const w = await s.workers.revoke(actor, type, { ...o, now: at });
      if (!w) throw new TaskError("unknown_worker", `no worker ${actor} here`);
      note(w);
      if (await s.tasks.release({ worker: actor, types: [type], reason: "grant revoked", now: at })) wakeFor(type);
      wakeAll(actor);
      return w;
    },

    async list(q = {}) {
      const s = await storesIfAny();
      return s ? views(s, await s.tasks.list(q)) : [];
    },

    async task(id) {
      const s = await storesIfAny();
      const t = s && (await s.tasks.task(id));
      return t ? (await views(s, [t]))[0] : undefined;
    },

    async stats(q = {}) {
      if (q.type !== undefined && typeof q.type !== "string") throw new TaskError("bad_request", "type is a task type's name");
      const at = now();
      const s = await storesIfAny();
      const kinds = s ? (await s.tasks.types()).filter((k) => q.type === undefined || k.name === q.type) : [];
      if (q.type !== undefined && !kinds.length) throw new TaskError("unknown_type", `no task type ${q.type} here`);
      const counted = s ? await s.tasks.stats({ types: kinds.map((k) => k.name), now: at }) : { types: [], holding: 0 };
      const people = s ? await s.workers.counts() : { statuses: noStatuses(), granted: {} };
      const types = counted.types.map((c, i): TypeStats => {
        const kind = kinds[i]!;
        const windows = {} as Record<StatsWindow, StatsWindowView>;
        for (const [w, v] of Object.entries(c.windows) as Array<[StatsWindow, WindowCounts]>) {
          const { toAnswer, work, ...counts } = v;
          const a = percentiles(toAnswer);
          const b = percentiles(work);
          windows[w] = { ...counts, ...(a ? { toAnswer: a } : {}), ...(b ? { work: b } : {}) };
        }
        return {
          type: c.type,
          app: kind.app,
          enabled: kind.enabled,
          waiting: c.waiting,
          working: c.working,
          ...(c.oldestCreated !== undefined ? { oldest: Math.max(0, at - c.oldestCreated) } : {}),
          dueSoon: c.dueSoon,
          dueHour: c.dueHour,
          granted: people.granted[c.type] ?? 0,
          holding: c.holding,
          asking: waiting.filter((w) => w.types.has(c.type)).length,
          windows,
        };
      });
      return { at, types, workers: people.statuses, holding: counted.holding, asking: new Set(waiting.map((w) => w.actor)).size };
    },

    async activity(actor) {
      actorOk(actor);
      const s = await storesIfAny();
      if (!s || !(await s.workers.get(actor))) return undefined;
      const at = now();
      const held = await s.tasks.heldBy(actor, at);
      const leases: LeaseView[] = await s.tasks.recentLeases(actor, RECENT_LEASES);
      // §9.6: their verdicts, on the answers among them.
      await withReviews(s, leases);
      const tasks = new Map((await s.tasks.byIds([...new Set(leases.map((l) => l.task))])).map((t) => [t.id, t]));
      return {
        ...(held ? { holding: { lease: held.id, task: held.task, type: held.type, expires: held.expires } } : {}),
        week: await s.tasks.workerWeek(actor, at - STATS_WINDOWS.week, at),
        recent: leases.map((lease) => {
          const t = tasks.get(lease.task);
          return {
            lease,
            task: t
              ? { id: t.id, type: t.type, workflow: t.workflow, runId: t.runId, status: t.status, ...(t.test !== undefined ? { test: t.test } : {}) }
              : { id: lease.task, type: lease.type, workflow: "", runId: "", status: "open" as const },
          };
        }),
      };
    },

    async taskFile(id, path) {
      if (typeof path !== "string" || !path) throw new TaskError("bad_request", "path is required");
      const s = await storesIfAny();
      const t = s && typeof id === "string" ? await s.tasks.task(id) : undefined;
      if (!t) throw new TaskError("unknown_task", `no task ${id}`);
      // A path not on the list is refused whether or not it exists (§5.5).
      if (!t.files.includes(path)) throw new TaskError("not_listed", `${JSON.stringify(path)} is not one of this task's files`);
      const f = deps.file ? await deps.file(t, path) : null;
      if (!f) throw new TaskError("no_file", `${JSON.stringify(path)} is no longer there`);
      return f;
    },
  };

  // ── take-back (§8.1) ──────────────────────────────────────────────────
  const takeBack: TasksService["takeBack"] = async (o) => {
    const why = text("why", o?.why);
    if (!why.trim()) throw new TaskError("bad_request", "a take-back says why");
    if (o.worker !== undefined) actorOk(o.worker);
    const s = await storesIfAny();
    const t = s && typeof o.task === "string" ? await s.tasks.task(o.task) : undefined;
    if (!s || !t) throw new TaskError("unknown_task", `no task ${o?.task}`);
    const answered = (await s.tasks.leasesOf([t.id])).filter((l) => l.status === "submitted" && (o.worker === undefined || l.worker === o.worker));
    const out: TakeBackOutcome[] = [];
    for (const l of answered) {
      if (!l.payMsat || !deps.ledger) {
        out.push({ lease: l.id, worker: l.worker, result: "none" });
        continue;
      }
      // Booked first, so a take-back never loses a race with the sweep.
      await book(s, l.id);
      const r = await (await deps.ledger()).takeBack({ lease: l.id, why, ...(o.by === undefined ? {} : { by: o.by }), at: now() });
      out.push({ lease: l.id, worker: l.worker, result: r.result, ...(r.earning ? { earning: leaseEarning(r.earning) } : {}) });
    }
    return out;
  };

  // ── review (§9.6) ─────────────────────────────────────────────────────
  const review: TasksService["review"] = async (o) => {
    if (!o || typeof o !== "object") throw new TaskError("bad_request", "a review is { worker?, verdict, why }");
    if (!VERDICTS.includes(o.verdict)) throw new TaskError("bad_request", `verdict is ${VERDICTS.join(" or ")}`);
    const why = o.why === undefined || o.why === null ? undefined : text("why", o.why).trim() || undefined;
    if (o.verdict === "rejected" && !why) throw new TaskError("bad_request", "a rejection says why");
    if (o.worker !== undefined) actorOk(o.worker);
    const s = await storesIfAny();
    const t = s && typeof o.task === "string" ? await s.tasks.task(o.task) : undefined;
    if (!s || !t) throw new TaskError("unknown_task", `no task ${o?.task}`);
    if (t.test !== undefined) throw new TaskError("bad_request", `task ${t.id} is a test: its answer is graded, not reviewed`);
    const answers = answersOf(await s.tasks.leasesOf([t.id])).filter((l) => o.worker === undefined || l.worker === o.worker);
    if (!answers.length) throw new TaskError("no_answer", o.worker === undefined ? `task ${t.id} has no answer yet` : `${o.worker} gave no answer to task ${t.id}`);
    if (answers.length > 1) throw new TaskError("bad_request", `task ${t.id} has ${answers.length} answers: say whose (worker)`);
    const l = answers[0]!;
    const at = now();
    // A paid answer not booked yet is booked first, so its hold is the
    // ledger's (as a take-back does).
    let earning: Earning | undefined;
    if (l.payMsat && deps.ledger) {
      await book(s, l.id);
      earning = await (await deps.ledger()).payOf(l.id);
    }
    const kind = await s.tasks.type(l.type);
    const until = holdEnd(l, kind, earning);
    const before = (await s.tasks.reviewsOf([t.id])).find((r) => r.worker === l.worker);
    if (before && at >= until) {
      throw new TaskError("final", `final: the hold on ${l.worker}'s answer to task ${t.id} ended at ${new Date(until).toISOString()}, so its verdict (${before.verdict}) can no longer change`);
    }
    // The money (§9.6, ruled 2026-11-13: option A): inside the hold a
    // rejection takes the earning back, and `ok` undoes a take-back a
    // rejection made (its why begins `REVIEW_TAKE_BACK`), never a staff or a
    // grading one. Past the hold nothing moves: paid money never moves back.
    if (earning && at < until && deps.ledger) {
      const ledger = await deps.ledger();
      if (o.verdict === "rejected") {
        earning = (await ledger.takeBack({ lease: l.id, why: `${REVIEW_TAKE_BACK}${why}`, ...(o.by ? { by: o.by } : {}), at })).earning ?? earning;
      } else if (earning.takenBack !== undefined && earning.takenBackWhy?.startsWith(REVIEW_TAKE_BACK)) {
        earning = (await ledger.restore({ lease: l.id, ...(o.by ? { by: o.by } : {}), at })).earning ?? earning;
      }
    }
    const row = await s.tasks.putReview({ task: t.id, worker: l.worker, verdict: o.verdict, ...(why ? { why } : {}), ...(o.by ? { by: o.by } : {}), at });
    // §7.5: a rejection counts against standing as a failed test does, so
    // the check runs as after a grade; `ok` takes it out of the window.
    if (o.verdict === "rejected" && kind?.tests) await standingCheck(s, l.worker, kind);
    return { task: t.id, worker: l.worker, lease: l.id, review: leaseReview(row, until, at), ...(earning ? { earning: leaseEarning(earning) } : {}) };
  };

  // ── the queue: grading (§7.4) and deciding copies (§7.6) ──────────────
  // Fed by `submit` and by the sweep, `GRADE_CONCURRENCY` at a time in the
  // process: an answered test instance to grade, or a copies task whose last
  // answer is in for a step comparator to decide. Each is written once: the
  // store's writes are guarded (`grade is null`; the task still open and
  // wanting what was decided on), and one queued twice is done once.
  const gradedListeners = new Set<(g: GradedTest) => void>();
  const agreedListeners = new Set<(a: AgreedTask) => void>();
  type Job = { kind: "grade" | "decide"; id: string };
  const gradeQueue: Job[] = [];
  const queued = new Set<string>();
  const drained: Array<() => void> = [];
  let gradingNow = 0;
  /** Errors in a row, by type: three are logged, once. */
  const errorsInARow = new Map<string, number>();
  /** Copies tasks whose decision failed: logged once each, until one lands. */
  const decideFailed = new Set<string>();
  const enqueue = (job: Job) => {
    const key = `${job.kind}:${job.id}`;
    if (closing || queued.has(key)) return;
    queued.add(key);
    gradeQueue.push(job);
    pump();
  };
  const queueGrade = (id: string) => enqueue({ kind: "grade", id });
  const queueDecide = (id: string) => enqueue({ kind: "decide", id });
  const pump = () => {
    while (gradingNow < GRADE_CONCURRENCY && gradeQueue.length) {
      const job = gradeQueue.shift()!;
      gradingNow++;
      const done =
        job.kind === "grade"
          ? gradeOne(job.id).catch((err) => console.error(`[tasks] grading test answer ${job.id} failed; the next sweep tries again:`, err))
          : decideOne(job.id).then(
              () => void decideFailed.delete(job.id),
              (err) => {
                if (decideFailed.has(job.id)) return;
                decideFailed.add(job.id);
                console.error(`[tasks] deciding copies task ${job.id} failed; the sweep tries again each minute until it is decided or expires:`, err);
              },
            );
      void done.finally(() => {
        gradingNow--;
        queued.delete(`${job.kind}:${job.id}`);
        pump();
        if (gradingNow === 0 && !gradeQueue.length) for (const resolve of drained.splice(0)) resolve();
      });
    }
  };

  // ── deciding copies (§7.6) ────────────────────────────────────────────
  /** `submit`'s decider for a type that compares by `equal`: the decision
   *  in the answer's own transaction. A step comparator decides outside it
   *  (undefined): the task then waits in the queue, and since every lease it
   *  wants is answered, none is handed out meanwhile. */
  const inlineDecider = (kind: TaskType) => {
    const rule = decidingRule(kind.copies);
    if (rule.compare !== "equal") return undefined;
    return (answers: unknown[], copies: number) => decideCopies(groupsOf(answers.length, (i, j) => sameJson(answers[i], answers[j])), rule, copies);
  };
  /** A step comparator's verdict on two answers, in the grader's contract:
   *  the later as `answer`, the earlier as `expected`. Throws when it cannot
   *  give one, which leaves the task undecided for the sweep. */
  const compared = async (rule: Exclude<GradeRule, "equal">, t: TaskRecord, kind: TaskType | undefined, later: unknown, earlier: unknown): Promise<boolean> => {
    const problem = graderProblem(rule.step);
    if (problem) throw new Error(problem);
    if (!deps.grade) throw new Error(`this server runs no step comparator (${rule.step})`);
    const principal = deps.principal ?? kind?.changedBy;
    if (!principal) throw new Error(`nobody to bill ${rule.step} to: set the deployment's grading principal (tasks.principal), or save the type as an admin`);
    const v = await deps.grade({
      step: rule.step,
      ...(rule.config ? { config: rule.config } : {}),
      input: { answer: later, expected: earlier, show: t.show, type: t.type },
      principal,
      maxCostUsd: kind?.tests?.gradeCapUsd ?? DEFAULT_TEST_RULES.gradeCapUsd,
      timeoutMs: deps.gradeTimeoutMs ?? GRADE_TIMEOUT_MS,
    });
    if (!v || typeof v.supports !== "boolean") throw new Error(`${rule.step} returned no verdict`);
    return v.supports;
  };
  /** A copies task with every answer it wants and no decision: decided now
   *  — a step's comparisons outside any transaction — and written guarded,
   *  so a task cancelled, expired or decided meanwhile is left as it is. */
  const decideOne = async (id: string) => {
    const s = await stores();
    const t = await s.tasks.task(id);
    if (!t || t.test !== undefined || t.status !== "open" || t.copies <= 1) return;
    const answers = answersOf(await s.tasks.leasesOf([id]));
    if (answers.length < t.copies) return;
    const kind = await s.tasks.type(t.type);
    const rule = decidingRule(kind?.copies);
    const cmp = rule.compare;
    const groups =
      cmp === "equal"
        ? groupsOf(answers.length, (i, j) => sameJson(answers[i]!.answer, answers[j]!.answer))
        : await groupsOfAsync(answers.length, (i, j) => compared(cmp, t, kind, answers[i]!.answer, answers[j]!.answer));
    if (closing) return;
    const decision = decideCopies(groups, rule, t.copies);
    const after = await s.tasks.decide({ task: id, copies: t.copies, decision, now: now() });
    if (after) decided(after, answers, decision);
  };
  /** A decision landed: one more worker is wanted, or the task left `open`
   *  — its run wakes, and `onAgreed` hears it (§7.9). */
  const decided = (t: TaskRecord, answers: Lease[], d: CopiesDecision) => {
    if (d.outcome === "more") {
      wakeFor(t.type);
      return;
    }
    tell([settledOf(t)]);
    const agreed: AgreedTask = {
      task: t.id,
      type: t.type,
      agreed: d.outcome === "agreed",
      answers: answers.map((a, i) => ({ lease: a.id, worker: a.worker, agrees: d.outcome === "agreed" && d.agrees[i] === true })),
      at: t.settledAt ?? now(),
    };
    for (const fn of agreedListeners) {
      try {
        fn(agreed);
      } catch (err) {
        console.error(`[tasks] an agreed listener threw:`, err);
      }
    }
  };
  /** The verdict on an answered instance: `equal` here, a step through
   *  `deps.grade`. A grader that cannot run, or gives no verdict, is
   *  `error`, which never moves standing (§7.4). */
  const verdictOf = async (t: TaskRecord, test: TestRecord | undefined, kind: TaskType | undefined): Promise<{ result: GradeResult; note: string }> => {
    if (!test) return { result: "error", note: `test ${t.test} is gone` };
    const rule = test.grade ?? kind?.tests?.grade ?? DEFAULT_TEST_RULES.grade;
    if (rule === "equal") {
      return sameJson(t.answer, test.expected) ? { result: "pass", note: "the answer equals the expected one" } : { result: "fail", note: "the answer differs from the expected one" };
    }
    // Asked again at each grading: the registry changes (§7.4).
    const problem = graderProblem(rule.step);
    if (problem) return { result: "error", note: problem };
    if (!deps.grade) return { result: "error", note: `this server runs no step grader (${rule.step})` };
    const principal = deps.principal ?? kind?.changedBy;
    if (!principal) {
      return { result: "error", note: `nobody to bill ${rule.step} to: set the deployment's grading principal (tasks.principal), or save the type as an admin (plans/human-steps.md §7.12)` };
    }
    try {
      const v = await deps.grade({
        step: rule.step,
        ...(rule.config ? { config: rule.config } : {}),
        input: { answer: t.answer, expected: test.expected, show: t.show, type: t.type },
        principal,
        maxCostUsd: kind?.tests?.gradeCapUsd ?? DEFAULT_TEST_RULES.gradeCapUsd,
        timeoutMs: deps.gradeTimeoutMs ?? GRADE_TIMEOUT_MS,
      });
      if (!v || typeof v.supports !== "boolean") return { result: "error", note: `${rule.step} returned no verdict` };
      return { result: v.supports ? "pass" : "fail", note: String(v.content ?? "") };
    } catch (err) {
      return { result: "error", note: err instanceof Error ? err.message : String(err) };
    }
  };
  const gradeOne = async (id: string) => {
    const s = await stores();
    const t = await s.tasks.task(id);
    if (!t || t.test === undefined || t.status !== "settled" || t.grade !== undefined) return;
    const [test, kind] = await Promise.all([s.tasks.test(t.test), s.tasks.type(t.type)]);
    const v = await verdictOf(t, test, kind);
    if (closing) return;
    const at = now();
    if (!(await s.tasks.grade({ task: id, grade: v.result, note: v.note, at }))) return;
    const worker = t.servedTo!;
    if (v.result === "error") {
      const n = (errorsInARow.get(t.type) ?? 0) + 1;
      errorsInARow.set(t.type, n);
      if (n === GRADE_ERRORS_LOGGED) console.warn(`[tasks] the last ${n} grades of task type ${t.type}'s tests were errors (they count for nothing); the last: ${v.note}`);
    } else errorsInARow.delete(t.type);
    // §7.9: a `fail` inside the hold takes back what the answer earned; an
    // `error` does nothing.
    if (v.result === "fail") {
      await takeBack({ task: id, worker, why: "the answer to a test was graded fail", by: GRADING_ACTOR }).catch((err) =>
        console.error(`[tasks] taking back the earning of failed test answer ${id}:`, err),
      );
    }
    // §7.5: standing read after each grade; under the threshold, the grant goes.
    if (v.result !== "error" && kind?.tests) await standingCheck(s, worker, kind);
    const lease = (await s.tasks.leasesOf([id])).find((l) => l.worker === worker && l.status === "submitted");
    const graded: GradedTest = { lease: lease?.id ?? "", task: id, test: t.test, worker, type: t.type, result: v.result, answeredAt: t.settledAt ?? at, at };
    for (const fn of gradedListeners) {
      try {
        fn(graded);
      } catch (err) {
        console.error(`[tasks] a graded listener threw:`, err);
      }
    }
    // Qualifying may be over (or a grant gone): the worker's held wait hears it.
    wakeAll(worker);
  };
  const standingCheck = async (s: TaskStores, actor: string, kind: TaskType) => {
    const w = await s.workers.get(actor);
    const grant = w?.grants.find((g) => g.type === kind.name && g.revokedAt === undefined);
    if (!grant || !kind.tests) return;
    const [row] = await s.tasks.standings([{ worker: actor, type: kind.name, since: grant.at, window: kind.tests.window }]);
    const why = row && revokeWhy(row, grant, kind.tests, kind.name);
    if (!why) return;
    await capability.revoke(actor, kind.name, { by: STANDING_ACTOR, why });
    console.log(`[tasks] ${actor} lost task type ${kind.name}: ${why}`);
  };

  // ── authoring tests (§7.1): the test routes' alone ────────────────────
  const testViews = async (s: TaskStores, list: TestRecord[]): Promise<TestView[]> => {
    const counts = await s.tasks.testCounts(list.map((x) => x.id));
    return Promise.all(
      list.map(async (x) => {
        const missing = x.ready ? [] : await missingFiles(x);
        return { ...x, ...(counts[x.id] ?? { passed: 0, failed: 0, errors: 0 }), ...(missing.length ? { missing } : {}) };
      }),
    );
  };
  const missingFiles = async (x: Pick<TestRecord, "id" | "files">): Promise<string[]> => {
    const out: string[] = [];
    for (const p of x.files) if (!deps.testFiles || !(await deps.testFiles.has(x.id, p))) out.push(p);
    return out;
  };
  const showOk = (show: unknown) => {
    const bytes = jsonBytes(show);
    if (bytes === undefined) throw new TaskError("bad_request", "show must be JSON");
    if (bytes > SHOW_MAX_BYTES) throw new TaskError("bad_request", `show is ${bytes} bytes as JSON; at most ${SHOW_MAX_BYTES}`);
    return show;
  };
  const expectedOk = (kind: TaskType, expected: unknown) => {
    if (expected === undefined) throw new TaskError("bad_request", "expected is required: the answer the test expects");
    const problem = answerProblem(kind.answer, expected);
    if (problem) throw new TaskError("bad_answer", `expected: ${problem}`);
    return expected;
  };
  const fileOk = (bytes: Uint8Array, path: string) => {
    if (bytes.byteLength > TEST_FILE_MAX_BYTES) {
      throw new TaskError("bad_request", `${JSON.stringify(path)} is ${bytes.byteLength} bytes; a test's file is at most ${TEST_FILE_MAX_BYTES}, what task/file can hand a page`);
    }
  };
  const testOf = async (s: TaskStores, id: string): Promise<TestRecord> => {
    const x = typeof id === "string" && id ? await s.tasks.test(id) : undefined;
    if (!x) throw new TaskError("unknown_test", `no test ${id}`);
    return x;
  };
  const tests: TestAuthoring = {
    async list(q = {}) {
      const s = await storesIfAny();
      return s ? testViews(s, await s.tasks.tests(q)) : [];
    },
    async get(id) {
      const s = await storesIfAny();
      const x = s && typeof id === "string" ? await s.tasks.test(id) : undefined;
      return x ? { test: (await testViews(s!, [x]))[0]!, instances: await s!.tasks.testInstances(id) } : undefined;
    },
    async create(input, by) {
      const type = need("type", input?.type);
      const files = filesOf(input.files);
      if (files.length && !deps.testFiles) throw new TaskError("bad_request", "this server keeps no test files: a test here lists none");
      const show = showOk(input.show ?? null);
      const grade = input.grade === undefined ? undefined : ruled(() => gradeRuleOf(input.grade, graderProblem));
      const s = await stores();
      const kind = await s.tasks.type(type);
      if (!kind) throw new TaskError("unknown_type", `no task type ${type} here`);
      const expected = expectedOk(kind, input.expected);
      const x = await s.tasks.putTest({
        id: randomId(),
        type,
        show,
        files,
        expected,
        ...(grade ? { grade } : {}),
        ready: files.length === 0,
        created: now(),
        ...(by === undefined ? {} : { createdBy: by }),
      });
      // A ready test may be what a qualifying worker waits for.
      if (x.ready) wakeFor(type);
      return (await testViews(s, [x]))[0]!;
    },
    async fromTask(taskId, o = {}, by) {
      const s = await stores();
      const t = typeof taskId === "string" && taskId ? await s.tasks.task(taskId) : undefined;
      if (!t) throw new TaskError("unknown_task", `no task ${taskId}`);
      if (t.test !== undefined) throw new TaskError("bad_request", `task ${t.id} is a test's instance, not a real task`);
      const kind = await s.tasks.type(t.type);
      if (!kind) throw new TaskError("unknown_type", `task type ${t.type} is gone`);
      if (o.expected === undefined && t.status !== "settled") {
        throw new TaskError("bad_request", `task ${t.id} was ${t.status}, with no accepted answer: say what is expected`);
      }
      const expected = expectedOk(kind, o.expected === undefined ? t.answer : o.expected);
      const grade = o.grade === undefined ? undefined : ruled(() => gradeRuleOf(o.grade, graderProblem));
      if (t.files.length && (!deps.testFiles || !deps.bytes)) throw new TaskError("bad_request", "this server keeps no test files: a task with files cannot become a test here");
      const id = randomId();
      // The task's files copied: the run's may be removed later, and a
      // missing file would be a tell (§7.1). One gone already is left for
      // staff to put.
      for (const p of t.files) {
        const bytes = await deps.bytes!(t, p);
        if (!bytes) continue;
        fileOk(bytes, p);
        await deps.testFiles!.put(id, p, bytes);
      }
      const ready = (await missingFiles({ id, files: t.files })).length === 0;
      const x = await s.tasks.putTest({
        id,
        type: t.type,
        show: t.show,
        files: t.files,
        expected,
        ...(grade ? { grade } : {}),
        fromTask: t.id,
        ...(t.by !== undefined ? { fromWorker: t.by } : {}),
        ready,
        created: now(),
        ...(by === undefined ? {} : { createdBy: by }),
      });
      if (x.ready) wakeFor(x.type);
      return (await testViews(s, [x]))[0]!;
    },
    async update(id, change = {}) {
      const s = await stores();
      const x = await testOf(s, id);
      const kind = await s.tasks.type(x.type);
      const next: TestChange = {};
      if (change.show !== undefined) next.show = showOk(change.show);
      if (change.expected !== undefined) {
        if (!kind) throw new TaskError("unknown_type", `task type ${x.type} is gone`);
        next.expected = expectedOk(kind, change.expected);
      }
      if (change.grade === null) next.grade = null;
      else if (change.grade !== undefined) next.grade = ruled(() => gradeRuleOf(change.grade, graderProblem));
      const out = await s.tasks.editTest(x.id, next);
      if (out === "missing") throw new TaskError("unknown_test", `no test ${id}`);
      if (out === "in_use") {
        throw new TaskError("in_use", `test ${id} was served or retired: a served test is never edited, so every grade was against what its worker saw — retire it and make it again`);
      }
      return (await testViews(s, [(await s.tasks.test(x.id))!]))[0]!;
    },
    async putFile(id, path, bytes) {
      const s = await stores();
      const x = await testOf(s, id);
      if (x.served > 0 || x.retired !== undefined) throw new TaskError("in_use", `test ${id} was served or retired: its files are as they were`);
      if (!x.files.includes(path)) throw new TaskError("not_listed", `${JSON.stringify(path)} is not one of test ${id}'s files`);
      if (!deps.testFiles) throw new TaskError("bad_request", "this server keeps no test files");
      fileOk(bytes, path);
      await deps.testFiles.put(x.id, path, bytes);
      if (!x.ready && !(await missingFiles(x)).length && (await s.tasks.readyTest(x.id))) wakeFor(x.type);
      return (await testViews(s, [(await s.tasks.test(x.id))!]))[0]!;
    },
    async retire(id, by) {
      const s = await stores();
      await testOf(s, id);
      const x = (await s.tasks.retireTest(id, by, now()))!;
      return (await testViews(s, [x]))[0]!;
    },
  };

  const sweep = async () => {
    const s = await stores();
    const swept = await s.tasks.sweep(now());
    tell(swept.expired);
    // Dead leases let go of: their tasks are free, of types not known here.
    if (swept.leases) wakeAll();
    // §8.1's backstop: an accepted answer whose booking failed (or whose
    // process died between the answer and the booking) is booked now, once.
    let booked = 0;
    if (deps.ledger) {
      for (const l of await s.tasks.unbooked(BOOK_BATCH)) {
        try {
          if (await book(s, l.id)) booked++;
        } catch (err) {
          console.error(`[tasks] booking lease ${l.id}'s earning failed; the next sweep tries again:`, err);
          break;
        }
      }
    }
    // §7.4: an answered test not yet graded — its process died, or its
    // grading failed outright — is queued again.
    const ungraded = await s.tasks.ungraded(UNGRADED_BATCH);
    for (const t of ungraded) queueGrade(t.id);
    // §7.6: a copies task with every answer and no decision — its process
    // died while a step compared them, or the step failed — is queued again.
    const undecided = await s.tasks.undecided(UNDECIDED_BATCH);
    for (const t of undecided) queueDecide(t.id);
    return { ...swept, booked, grading: ungraded.length, deciding: undecided.length };
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  const sweepIfAny = async () => {
    if (!storesIfAny()) return;
    try {
      const swept = await sweep();
      if (swept.expired.length) console.log(`[tasks] ${swept.expired.length} task(s) past their time expired`);
      if (swept.booked) console.log(`[tasks] booked ${swept.booked} answer(s)' earnings the answers themselves did not`);
    } catch (err) {
      console.error(`[tasks] the sweep failed:`, err);
    }
  };

  const frozen = Object.freeze(capability);
  return {
    capability: frozen,
    human: Object.freeze({ ensure: frozen.ensure }),
    worker: Object.freeze({ next: frozen.next, submit: frozen.submit, skip: frozen.skip, file: frozen.file, me: frozen.me }),
    isActiveWorker: (actor) => active.has(actor),
    onSettle(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async settled(id) {
      const s = await storesIfAny();
      const t = s && (await s.tasks.task(id));
      return !t || t.status !== "open";
    },
    async cancel(id) {
      const s = await storesIfAny();
      if (!s) return [];
      const out = await s.tasks.cancel({ id }, now());
      tell(out);
      return out;
    },
    async cancelRun(workflow, runId) {
      const s = await storesIfAny();
      if (!s) return [];
      const out = await s.tasks.cancel({ workflow, runId }, now());
      tell(out);
      return out;
    },
    takeBack,
    review,
    tests,
    onGraded(listener) {
      gradedListeners.add(listener);
      return () => void gradedListeners.delete(listener);
    },
    onAgreed(listener) {
      agreedListeners.add(listener);
      return () => void agreedListeners.delete(listener);
    },
    grading: () => (gradingNow === 0 && !gradeQueue.length ? Promise.resolve() : new Promise<void>((resolve) => drained.push(resolve))),
    sweep,
    start() {
      if (timer) return;
      void sweepIfAny();
      timer = setInterval(() => void sweepIfAny(), deps.sweepEveryMs ?? SWEEP_EVERY_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    async close() {
      if (timer) clearInterval(timer);
      timer = undefined;
      // Every held wait answers "none" now, before the store goes; nothing
      // more is graded (the next boot's sweep grades what is left).
      closing = true;
      gradeQueue.length = 0;
      wakeAll();
      const open = opening;
      opening = undefined;
      if (open) await (await open.catch(() => null))?.close();
    },
  };
}

// ── checks ──────────────────────────────────────────────────────────────────

/** A worker's live grants, by type. */
function grantsOf(w: WorkerRecord): Map<string, Grant> {
  return new Map(w.grants.filter((g) => g.revokedAt === undefined).map((g) => [g.type, g]));
}

function randomId(): string {
  return randomBytes(16).toString("hex");
}

function need(name: string, v: unknown): string {
  if (typeof v !== "string" || !v) throw new TaskError("bad_request", `${name} is required`);
  return v;
}

function actorOk(actor: unknown): asserts actor is string {
  if (typeof actor !== "string" || !actor) throw new TaskError("bad_request", "a signed-in actor is required");
  if (actor.length > ACTOR_MAX || /[\r\n]/.test(actor)) throw new TaskError("bad_request", "not an actor");
}

function text(name: string, v: unknown): string {
  if (typeof v !== "string" || v.length > TEXT_MAX) throw new TaskError("bad_request", `${name} is text, at most ${TEXT_MAX} characters`);
  return v;
}

function hours(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > WITHIN_HOURS_MAX) {
    throw new TaskError("bad_request", `withinHours is a number of hours above 0, at most ${WITHIN_HOURS_MAX}`);
  }
  return v;
}

const HOUR_MS = 3_600_000;

/** A type's pay: sats to the msat, 0 to `PAY_SATS_MAX`; 0 (or none) is unpaid. */
function payOk(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > PAY_SATS_MAX || Math.abs(v * 1000 - Math.round(v * 1000)) > 1e-6) {
    throw new TaskError("bad_request", `paySats is a number of sats from 0 to ${PAY_SATS_MAX}, to the msat (at most three decimals)`);
  }
  return v > 0 ? Math.round(v * 1000) / 1000 : undefined;
}

/** A type's hold: hours from `HOLD_HOURS_MIN` to `HOLD_HOURS_MAX`, never 0. */
function holdOk(v: unknown): number {
  if (v === undefined || v === null) return DEFAULT_HOLD_HOURS;
  if (typeof v !== "number" || !Number.isFinite(v) || v < HOLD_HOURS_MIN || v > HOLD_HOURS_MAX) {
    throw new TaskError("bad_request", `holdHours is a number of hours from ${HOLD_HOURS_MIN} to ${HOLD_HOURS_MAX}: earnings wait before they can be withdrawn`);
  }
  return v;
}

function leaseEarning(e: Earning): LeaseEarning {
  return {
    msat: e.msat,
    at: e.at,
    releases: e.releases,
    ...(e.takenBack !== undefined ? { takenBack: e.takenBack } : {}),
    ...(e.takenBackWhy !== undefined ? { takenBackWhy: e.takenBackWhy } : {}),
    ...(e.takenBackBy !== undefined ? { takenBackBy: e.takenBackBy } : {}),
  };
}

function jsonBytes(v: unknown): number | undefined {
  try {
    const json = JSON.stringify(v);
    return json === undefined ? undefined : Buffer.byteLength(json);
  } catch {
    return undefined;
  }
}

/** A task's file list: relative paths, no `..`, at most 200, each once. */
function filesOf(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new TaskError("bad_request", "files is a list of paths");
  const out = [...new Set(raw)];
  if (out.length > FILES_MAX) throw new TaskError("bad_request", `a task names at most ${FILES_MAX} files (got ${out.length})`);
  for (const p of out) {
    if (typeof p !== "string" || !p || p.length > 1024 || p.startsWith("/") || p.includes("\\") || p.includes("\0") || p.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
      throw new TaskError("bad_request", `not a path under the run's files: ${JSON.stringify(p)}`);
    }
  }
  return out as string[];
}
