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
 * take one back inside its hold (`takeBack`, the service's alone).
 *
 * WITHDRAW (§8.2, item 5b): the worker's own `withdraw { msat }` pays what
 * passed its hold to the Sphinx address their sign-in gave, through the
 * payer's third door (`deps.payouts`, src/payments/payouts.ts), counted
 * against their calls like every worker call. A worker's status stops new
 * work, never a withdrawal (ruled). `me` says whether withdrawing is open
 * (`payout`).
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
import { runLineage, type RunControl } from "../run-control.js";
import type { TaskDb } from "./db.js";
import type { RunFile } from "../runs.js";
import type { RunAttachment } from "../core.js";
import { generateRunId } from "../store.js";
import { ZERO_BALANCE, type Earning, type LedgerStore, type PayeeBalance } from "../payments/ledger.js";
import { PayoutError, type PayoutAnswer, type Payouts, type PayoutView } from "../payments/payouts.js";
import { answerProblem, answerSchemaProblem, type AnswerSchema } from "./answer-schema.js";
import {
  DEFAULT_HOLD_HOURS,
  DEFAULT_TEST_RULES,
  GROUP_MAX,
  GROUP_STATUSES,
  MemoryTaskStore,
  TASK_LIST_MAX,
  STATS_WINDOWS,
  VERDICTS,
  PAY_ON,
  answersOf,
  earnsNow,
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
  type RoundRule,
  type CheckRule,
  type StandingRule,
  type Verdict,
  type PayOn,
  type GroupStatus,
  type TaskGroup,
  type TaskListQuery,
  type TaskRecord,
  type TaskReply,
  type LeaseStatus,
  type TaskSettled,
  type TaskStore,
  type TaskType,
  type TestChange,
  type TestCounts,
  type TestInstance,
  type TestRecord,
  type TestRules,
  type LimitRule,
} from "./task-store.js";
import { checkRuleOf, gradeRuleOf, openPayProblem, phaseOf, revokeWhy, RuleProblem, sameJson, standingOf, testRulesOf, type Standing } from "./task-tests.js";
import { COPIES_MAX, copiesRuleOf, decideCopies, decidingRule, groupsOf, groupsOfAsync } from "./task-copies.js";
import { TEST_FILE_MAX_BYTES, type TestFiles } from "./test-files.js";
import { answerAttachments, attachmentRuleOf, type AttachmentRule } from "./answer-files.js";
import { levelOf, type Level } from "./levels.js";
import { MAX_ATTACHMENTS, type Attachment } from "../ai/attachments.js";
import { liveGrants, MemoryWorkerStore, noStatuses, WORKER_STATUSES, type Grant, type WorkerRecord, type WorkerStatus, type WorkerStore } from "./worker-store.js";

export type { AnswerSchema } from "./answer-schema.js";
export type { LimitRule, LeaseTotals } from "./task-store.js";
export type { CopiesRule, GradeResult, GradeRule, GroupStatus, Lease, PayOn, ReviewRecord, StatsWindow, TaskGroup, TaskRecord, TaskReply, TaskSettled, TaskStatus, TaskType, TestInstance, TestRecord, TestRules, Verdict, WorkerWeek } from "./task-store.js";
export type { PayeeBalance } from "../payments/ledger.js";
export type { AttachmentRule } from "./answer-files.js";
export type { Standing } from "./task-tests.js";
export { DEFAULT_HOLD_HOURS, DEFAULT_TEST_RULES, GROUP_MAX, GROUP_STATUSES, PAY_ON, TASK_STATUSES, VERDICTS } from "./task-store.js";
export { COPIES_MAX, DEFAULT_COPIES_RULE } from "./task-copies.js";
export type { Grant, WorkerRecord, WorkerStatus } from "./worker-store.js";
export { OPEN_GRANT_BY } from "./worker-store.js";

/** §4.2's defaults. */
export const DEFAULT_LEASE_SECONDS = 600;
export const DEFAULT_WITHIN_HOURS = 72;
export const LEASE_SECONDS_MAX = 24 * 60 * 60;
export const WITHIN_HOURS_MAX = 365 * 24;
/** §8.1: the most one answer may earn — a guard against a slip, not a
 *  policy — and the bounds of a type's hold, in hours (0: none, the
 *  default). */
export const PAY_SATS_MAX = 1_000_000;
export const HOLD_HOURS_MIN = 0;
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
/** §5.6.7 c: a type's check's time while the worker's page waits on
 *  `submit`, then force-cancelled — inside a host's 60 s tool-call timeout
 *  with the rest of the answer's writes. */
export const CHECK_TIMEOUT_MS = 30_000;
export const GRADE_CONCURRENCY = 4;
export const UNGRADED_BATCH = 100;
export const GRADE_ERRORS_LOGGED = 3;
/** §7.6: how many copies tasks left with all their answers and no decision
 *  one sweep queues. */
export const UNDECIDED_BATCH = 100;
/** §5.7: how many answered standing tasks with no run one sweep launches. */
export const UNLAUNCHED_BATCH = 100;
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
/** Text for workers in one or several languages: a plain string, or a map of
 *  language → text (`{ en: "Scan book", es: "Escanear libro" }`); the page
 *  picks the viewer's language (kit's `localText`). */
export type LocalText = string | Record<string, string>;

/** A `LocalText` as one plain line for the server's own messages: the
 *  English entry (else the first), or the string. */
export function plainText(v: LocalText | undefined): string | undefined {
  if (v === undefined) return undefined;
  return typeof v === "string" ? v : (v["en"] ?? Object.values(v)[0]);
}

/** The most characters a type's `title` takes (each language's, in a map). */
export const TYPE_TITLE_MAX = 80;
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
  const [db, { SqliteTaskStore }, { SqliteWorkerStore }] = await Promise.all([
    openTaskDb("file" in o ? o.file : tasksPath(o.dataDir)),
    import("./task-store-sqlite.js"),
    import("./worker-store-sqlite.js"),
  ]);
  return { tasks: new SqliteTaskStore(db), workers: new SqliteWorkerStore(db), close: async () => db.close() };
}

/** A task store file in memory (`openTaskDb`, `TaskDb.open`). */
export const TASKS_IN_MEMORY = ":memory:";

/** Support's tables as it was first built (plans/support-chat.md §4),
 *  dropped whenever the file is opened: Support is strut/workers's own now, in
 *  the app's SQLite, and nothing of these was copied
 *  (plans/people-and-hosts.md §5, ruling 7). */
export const DROPPED_SUPPORT_TABLES = ["support_messages", "support_conversations", "support_state"] as const;

/** The task store's file opened (`TASKS_IN_MEMORY`: one in memory) with every table
 *  made, or an older file's brought to version 2, in one transaction
 *  (plans/human-steps.md §7.7): both sides'. */
export async function openTaskDb(file: string): Promise<TaskDb> {
  const [{ TaskDb }, { taskSchema }, { workerSchema }] = await Promise.all([import("./db.js"), import("./task-store-sqlite.js"), import("./worker-store-sqlite.js")]);
  const db = TaskDb.open(file);
  try {
    db.migrate(() => {
      taskSchema(db);
      workerSchema(db);
      for (const t of DROPPED_SUPPORT_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
    });
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
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
  | "unknown_group"
  | "too_many"
  | "not_listed"
  | "no_file"
  | "in_use"
  | "unknown_test"
  | "bad_grader"
  | "no_answer"
  | "final"
  | "not_answered"
  | "limit_reached";

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
  /** What workers call it (plans/i18n.md), at most `TYPE_TITLE_MAX`
   *  characters; absent, empty or null: none, and they read its name. */
  title?: LocalText | null;
  /** The answer's schema (§4.5); refused when it uses what strut does not check. */
  answer: unknown;
  leaseSeconds?: number;
  withinHours?: number;
  enabled?: boolean;
  /** Open to any signed-in worker with no grant (ruling 9); true when left
   *  out. Whether a PAID open type qualifies newcomers on tests is the
   *  admin's (ruling 12): one that asks for K takes a newcomer only while K
   *  are ready (`openPayProblem`). */
  open?: boolean;
  /** What one accepted answer earns, in sats to the msat (§8.1), at most
   *  `PAY_SATS_MAX`; absent or 0: unpaid. */
  paySats?: number;
  /** How long an earning waits before it can be withdrawn: hours from 0 to
   *  720, 0 (none) by default. */
  holdHours?: number;
  /** When a paid answer earns (`PAY_ON`): `"ok"`, only once a verdict says
   *  ok (staff's, or the asking run's `task/reply { verdict }`), so a
   *  rejected answer earns nothing; `"answer"`, absent or null: as it is
   *  answered. */
  payOn?: PayOn | null;
  /** Its budget and per-worker daily cap (`LimitRule`), checked whenever a
   *  task of it is handed out; absent or null: none. */
  limits?: LimitRule | null;
  /** Its test rules (§7.2, §7.5): §7.8's defaults with these over them;
   *  absent or null: off. */
  tests?: Partial<TestRules> | null;
  /** Its copies rule (§7.6): §7.8's defaults (`max` 3, `agree` 2, `equal`,
   *  `more`) with these over them; absent or null: off, a step asks one
   *  worker. */
  copies?: Partial<CopiesRule> | null;
  /** The files an answer carries (§5.6): one, none required, images and
   *  PDFs, with these over them; absent or null: none. */
  attachments?: Partial<AttachmentRule> | null;
  /** A STANDING type (§5.7): a worker's ask makes the task, and each answer
   *  launches `workflow`, whose first step must be this type's `human`
   *  step (`deps.standing` checks it); absent or null: not standing. */
  standing?: { workflow: string } | null;
  /** A ROUND type: `workflow`'s runs make its tasks, one for each item, and
   *  staff send a round of it from Workers. The workflow must
   *  have a `human` step of this type (in a `foreach` too; `deps.round`
   *  checks it); never with `standing`. Absent or null: none named. */
  round?: { workflow: string } | null;
  /** Its CHECK (§5.6.7 c): a sealed step `submit` runs on each answer and
   *  its files before accepting it — a fail refuses it and the worker keeps
   *  the task. Absent or null: none. */
  check?: { step: string; config?: Record<string, unknown> } | null;
}

/** §5.7: what a standing type's pick-up is made of — its workflow's first
 *  step's path and its `show`, resolved with the workflow's defaults. */
export interface StandingTask {
  path: string;
  show: unknown;
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
  /** The files it carried (§5.6), under the run's artifacts. */
  attachments?: RunAttachment[];
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
  /** `ok`: the answer earns `payMsat` only once a verdict says ok (the
   *  type's `payOn`), as it is told when sent. Absent: as it is answered. */
  payOn?: "ok";
  /** The files an answer carries (§5.6): how many, and of what types.
   *  Absent: the type takes none. */
  attachments?: AttachmentRule;
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
  types: Array<WorkerTypeView>;
  /** The task in their hand now, of a type in `types`: what Continue opens
   *  (`task/next` refuses another type while they hold it), and its `lease`,
   *  which the dashboard's Let go skips (`skip` with `apps`). */
  holding?: { type: string; expires: number; lease: string };
  /** What they are owed here (§8.1): zeros with nothing earned. A payout
   *  on its way is no longer in it (§8.2). */
  balance: PayeeBalance;
  /** What their answers on types that pay on ok will earn once a verdict
   *  says ok, msat: not in `balance`, which holds only what was earned.
   *  Absent when nothing waits. */
  pendingMsat?: number;
  /** Whether they may withdraw now, and how much (§8.2): strut's own
   *  store's (the `task/me` step says `not_here` for a store without it). */
  payout?: PayoutView;
  /** Their XP and level (plans/worker-progress.md). Absent where there is
   *  no ledger to read it from. */
  xp?: WorkerXp;
}

/** XP is everything a worker ever earned here, in whole sats (the ledger's
 *  `payeeEarned`: accepted less taken back; withdrawing never lowers it),
 *  and their level a threshold on it (levels.ts). */
export interface WorkerXp extends Level {
  sats: number;
}

/** A type on the worker's dashboard: what an answer earns now, msat (0:
 *  unpaid); whether they are qualifying (§7.5, ruling 3); whether it is
 *  STANDING (§5.7: work whenever they ask, nothing waits); and how many of
 *  its tasks wait that they could take (`TaskStore.waitingFor`). */
export interface WorkerTypeView {
  name: string;
  /** What workers call it (`TaskType.title`); absent: its name. */
  title?: LocalText;
  app: string;
  payMsat: number;
  qualifying: boolean;
  standing: boolean;
  waiting: number;
}

/** One of a worker's tasks as THEY read it (`task/history`): the type, when
 *  they took it and when it left their hand, how it ended (`open`: in hand;
 *  `submitted`: answered; `skipped`; `expired`: ran out or was closed), and
 *  for a paid answer what it earned — when the hold ends and whether it was
 *  taken back. Never the run, the task's other answers, whether it was a
 *  test, or why anything was taken back (§7.2: a worker cannot tell a test). */
export interface WorkerHistoryItem {
  lease: string;
  type: string;
  /** What the task asked, as they saw it: its `show.ask`, else `show.title`,
   *  else a `show` that is itself a string; at most 200 characters. */
  ask?: LocalText;
  taken: number;
  closed?: number;
  status: LeaseStatus;
  earned?: { msat: number; releases: number; takenBack?: true };
  /** On a type that pays on ok (`TaskType.payOn`), what an answer earns
   *  once a verdict says ok, while none has: never with `earned`, and gone
   *  once rejected. */
  pending?: { msat: number };
  /** What the run told them after their answer (`task/reply`): on an
   *  answer of theirs alone, never a skipped or run-out lease. Its files
   *  are read through `task/file` with this lease. */
  reply?: TaskReply;
  /** The group the run put the task in (`task/reply`'s `group`). */
  group?: string;
  /** Staff's verdict on their answer (§9.6) and why: what to fix. Never who
   *  gave it. */
  review?: { verdict: Verdict; why?: string; at: number };
}

/** An answer's earning as staff read it (§8.1): booked in the ledger. */
export type LeaseEarning = Pick<Earning, "msat" | "at" | "releases" | "takenBack" | "takenBackWhy" | "takenBackBy">;
/** A verdict as staff read it, on its answer's lease (§9.6): `until` is when
 *  it can no longer change — the answer's earning's hold end, or for an
 *  unpaid answer the type's hold from when it was answered; absent while a
 *  type that pays on ok has booked nothing for it (no money moved, so it
 *  can always change) — and `final` whether that has passed. */
export type LeaseReview = Omit<ReviewRecord, "task" | "worker"> & { until?: number; final: boolean };
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

/** A file of an answer as a check sees it (§5.6.7 c): `data` base64. */
export interface CheckFile {
  name: string;
  mediaType: string;
  data: string;
}

/** What a step grader is handed (§7.4): a test's or a comparison's
 *  `expected`, or for a type's check (§5.6.7 c) none and the answer's
 *  `files`. */
export interface GradeCall {
  step: string;
  config?: Record<string, unknown>;
  input: { answer: unknown; expected?: unknown; show: unknown; type: string; files?: CheckFile[] };
  /** Who its model calls bill (`payerOf`); absent: nobody named, and the
   *  server's own model key pays. */
  principal?: string;
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
  /** Its ready tests, not retired (§7.1): what a paid open type's K is held
   *  to (ruling 9). */
  readyTests: number;
  /** §9.6: its real tasks' answers with no verdict yet, of any age: what
   *  `GET /tasks?review=none` lists, counted by answer. */
  toReview: number;
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

/** A type's numbers (`numbers`): what it has paid in all (`spentSats`,
 *  answered, and `workingSats` on the leases being worked) against its
 *  limits, and what each worker did of it in the last `days`. */
export interface TypeNumbers {
  type: string;
  title?: LocalText;
  enabled: boolean;
  open: boolean;
  paySats?: number;
  limits?: LimitRule;
  spentSats: number;
  workingSats: number;
  days: number;
  answered: number;
  workers: Array<{ worker: string; answered: number; workMinutes: number; perHour?: number; earnedSats: number }>;
}

export interface TasksCapability {
  /** The `human` step's: the task keyed by workflow, run and path, made
   *  when there is none (rule 1). A settled task comes with what its
   *  answers earned (`pay`, §8.1), when they earned anything, and a copies
   *  task's settled with every answer (`answers`, §7.6). */
  ensure(input: EnsureInput, o?: EnsureOptions): Promise<{ task: TaskRecord; created: boolean; pay?: TaskPay; answers?: CopyAnswer[]; attachments?: RunAttachment[] }>;
  /** The `task/reply` step's: what a run tells the workers who answered a
   *  task IT asked — the run `control` belongs to must be the task's (its
   *  id and workflow, never an input: `unknown_task` otherwise), and the
   *  task settled by an answer (`not_answered`). `show` a JSON object of at
   *  most 256 KB, `files` of the run's artifacts (at most 10, each at most
   *  what `task/file` can hand a page), `group` the deliverable the task is
   *  part of (at most `GROUP_MAX` characters); one of them at least. Replaces
   *  the reply before; a group stays until another is named. */
  reply(input: ReplyInput, o: { control?: RunControl }): Promise<{ task: string; at: number }>;

  // The worker's. `actor` is the caller's own (rule 5); `app`, the calling
  // app's name, when the call comes from one: a lease of a type another app
  // draws is refused (`wrong_app`). Every call counts against the worker's
  // `TASK_CALLS_PER_MINUTE` (`too_many`).
  /** The worker's live lease when it is of a type asked for, else a new one
   *  on the oldest open task they may take; `{ none: true }` when there is
   *  none. `type` narrows to one type, `app` to the types an app draws.
   *  `wait` (seconds, at most `NEXT_WAIT_MAX_S`) holds that long for a task
   *  to appear before answering `{ none: true }`; it counts as one call.
   *  `invite`: the token the worker's invite link opened `app` with
   *  (§5.8): first, it gives them the app's invite-only types. */
  next(actor: string, o?: { type?: string; app?: string; wait?: number; invite?: string; address?: string }): Promise<WorkerTask | { none: true }>;
  /** Answers the lease: `answer` in the type's answer schema, and the
   *  files its `attachments` rule takes (§5.6) — `[{ name, mediaType?,
   *  data }]`, the chat's shape and caps — saved in the task's run before
   *  it settles (a test instance's are checked and dropped). */
  submit(actor: string, o: { lease: string; answer: unknown; attachments?: unknown; app?: string }): Promise<{ ok: true }>;
  /** The task reopens for someone else; never handed to this worker again.
   *  With `apps` in place of `app` (the dashboard across apps, `task/me`'s
   *  `all`): a lease of a type any of those apps draws, the worker's own. */
  skip(actor: string, o: { lease: string; reason?: string; app?: string; apps?: string[] }): Promise<{ ok: true }>;
  /** One file the leased task names (`files`), as `run/files` answers one
   *  (§5.5): only a path on the task's list, only through the caller's own
   *  live lease, whether or not another path exists. Through a lease they
   *  ANSWERED, only a file the run's reply lists (`task/reply`), and
   *  nothing else of the run. */
  /** `all`: the call reads across apps (`apps`, or any when absent), as `history { all }` lists them: a reply's file is then read for any of those apps' tasks. */
  file(actor: string, o: { lease: string; path: string; app?: string; apps?: string[]; all?: boolean }): Promise<RunFile>;
  /** Who the worker is here, what they may take, what they are owed, and
   *  whether they may withdraw (`address`: the Sphinx address their session
   *  carries, §8.2); the first call writes them as `new`. `invite`, as on
   *  `next`, first — for `inviteApp`, the app its link opened, when the
   *  list spans `apps`. */
  me(actor: string, o?: { app?: string; apps?: string[]; address?: string; invite?: string; inviteApp?: string }): Promise<WorkerView>;
  /** The worker's own newest tasks here (of the app's types, or of the
   *  `apps`' types, when given), newest first, at most `RECENT_LEASES`:
   *  their dashboard's history. With `group`, every answer of theirs in
   *  that group instead (at most `TASK_LIST_MAX`); with `groups`, also
   *  their groups (`TaskGroup`, their own answers counted, no `workers`). */
  history(actor: string, o?: { app?: string; apps?: string[]; group?: string; groups?: boolean }): Promise<{ items: WorkerHistoryItem[]; groups?: TaskGroup[] }>;

  // Staff's.
  types(): Promise<TaskType[]>;
  /** Saves the whole type (a PUT: what is left out is the default — unpaid,
   *  a 72-hour hold). A change of pay reaches the next lease taken, never one
   *  in hand (§8.1). */
  /** `holders`: the people who made it — whoever asked for it and the
   *  admin who saved it. A NEW invite-only type is theirs from the start
   *  (granted, no qualifying), so they can try it at once. */
  setType(name: string, input: TaskTypeInput, by?: string, o?: { holders?: Array<string | undefined> }): Promise<TaskType>;
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
  /** The groups of tasks the runs named (`task/reply`'s `group`), of one
   *  type when asked, the one with the newest task first: each with its
   *  tasks, answers, verdicts, who answered and the status staff set; of
   *  one name or one status when asked. Strut's own store's; a host's may
   *  have none. */
  groups?(q?: { type?: string; group?: string; status?: GroupStatus; limit?: number }): Promise<TaskGroup[]>;
  task(id: string): Promise<TaskView | undefined>;
  /** One worker as staff read them, with their standing (§7.5). */
  worker(actor: string): Promise<StaffWorker | undefined>;
  /** §9.4: each type's queue (one type with `type`), and the workers across
   *  them. Computed on read. */
  stats(q?: { type?: string }): Promise<TaskStats>;
  /** Each type's (one with `type`) spend against its limits, and what each
   *  worker did of it in the last `days` (7 by default, at most 90):
   *  answered, time on them, earned. Computed on read. */
  numbers(q?: { type?: string; days?: number }): Promise<TypeNumbers[]>;
  /** §9.4: what one worker holds and did; undefined for nobody here. */
  activity(actor: string): Promise<WorkerActivity | undefined>;
  /** §9.4: one of a task's files, as `file` answers it, read by staff
   *  without a lease: only a path on the task's list, an answer's files or
   *  the reply's (`not_listed`). */
  taskFile(id: string, path: string): Promise<RunFile>;
}

export interface TasksService {
  /** The actors holding a grant made by `by` (`invite:<code>`), first
   *  first; none when the store was never opened. The invites list's "who
   *  took it", read without the staff worker view's cost. Never on a bag. */
  grantedBy(by: string): Promise<string[]>;
  /** Every task type drawn by app `from`, drawn by `to`, nothing else
   *  changed: a renamed app's boot step (src/apps/renamed-boot.ts). The
   *  names of the types changed; none when the store was never opened. */
  retypeApp(from: string, to: string): Promise<string[]>;
  /** Frozen: the whole store — the staff routes' (`src/tasks/routes.ts`),
   *  which hold it. Never on a services bag (plans/human-steps.md §9.2). */
  capability: TasksCapability;
  /** Frozen: `ensure` and `reply` alone, the `human` step's and
   *  `task/reply`'s — what every step's `ctx.services.tasks` is on the
   *  shared bag (§9.2). */
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
  /** §9.6 over a group: the same verdict on every answer in it (of one type
   *  when asked) that has none yet, one `review` each; a verdict given
   *  stays. At most `TASK_LIST_MAX` tasks a call: `more` when there may be
   *  others. A person's act (`POST /tasks/groups/review`); never on a
   *  capability. */
  reviewGroup(o: { group: string; type?: string; verdict: Verdict; why?: string; by?: string }): Promise<{ reviewed: number; more: boolean }>;
  /** A group's status, `open` or `done`, kept with who set it, when and
   *  why beside every change before; answers the group as it now stands.
   *  A person's act (`POST /tasks/groups/status`); never on a capability. */
  setGroupStatus(o: { type: string; group: string; status: GroupStatus; why?: string; by?: string }): Promise<TaskGroup>;
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
  sweep(): Promise<{ leases: number; expired: TaskSettled[]; booked: number; grading: number; deciding: number; launched: number }>;
  /** The sweep at once and every minute, while a store is open or on file. */
  start(): void;
  stop(): void;
  close(): Promise<void>;
}

/** The worker's calls of the capability (§5.1), and their withdrawal
 *  (§8.2): what passed its hold, keysent to `address`, the Sphinx address
 *  their session carries — the door's, never the page's. Absent on a host's
 *  own store (`task/withdraw` answers `not_here`). */
export type WorkerTasksCapability = Pick<TasksCapability, "next" | "submit" | "skip" | "file" | "me"> & {
  withdraw?(actor: string, o: { address?: string; msat: number }): Promise<PayoutAnswer>;
  /** Strut's own store's; a host's may have none (`task/history` answers no items). */
  history?: TasksCapability["history"];
};

/** What the shared services bag carries (§9.2): the `human` step's call,
 *  and `task/reply`'s, each held to the run that calls it. */
export type HumanTasksCapability = Pick<TasksCapability, "ensure"> & {
  /** Strut's own store's; a host's may have none (`task/reply` refuses). */
  reply?: TasksCapability["reply"];
};

/** What `task/reply` hands the store: the task, and what its workers see. */
export interface ReplyInput {
  task: string;
  show?: Record<string, unknown>;
  files?: RunAttachment[];
  /** The group the task is part of (`TaskRecord.group`): kept when absent. */
  group?: string;
  /** The run's verdict on the answer the task settled with (§9.6, as staff
   *  give one: `review`, by `workflow:<name>`): what a type that pays on ok
   *  pays by. A rejection says `why`, which the worker reads. */
  verdict?: Verdict;
  why?: string;
}

/** Who a run's verdict (`task/reply`'s `verdict`) is by: its workflow. */
export const RUN_REVIEWER_PREFIX = "workflow:";

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
  /** §8.2: the payer's third door, a worker's withdrawal (payouts.ts). Left
   *  out: nobody withdraws here (`me`'s `payout` says `not_here`). */
  payouts?: Pick<Payouts, "pay" | "view">;
  /** §7.1: tests' files. `file` reads an instance's (`root: "test"`) from
   *  here, as it reads a real task's from its run, so both come back alike.
   *  Left out: a test may list no files. */
  testFiles?: TestFiles;
  /** One of a real task's files' bytes, for a test made from it. */
  bytes?(task: TaskRecord, path: string): Promise<Uint8Array | null>;
  /** §5.6.3: an answer's files written into the task's run's artifacts
   *  (`saveAnswerAttachments`). Left out: no answer carries files here. */
  saveAttachments?(task: TaskRecord, files: Attachment[]): Promise<RunAttachment[]>;
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
  /** §5.7: what a pick-up of standing type `type`, whose rule names
   *  `workflow`, is made of — or why its workflow cannot be one now (it is
   *  missing or off, its first step is not this type's `human` step, its
   *  `show` reads more than `input` and `params`, it has nobody to bill).
   *  Asked when the type is saved and at each pick-up. Left out: no type
   *  may be standing here. */
  standing?(type: string, workflow: string): Promise<StandingTask | { problem: string }>;
  /** A round type's workflow checked at the save: why it cannot make tasks
   *  of `type`, or undefined. Left out: no round can be set. */
  round?(type: string, workflow: string): Promise<string | undefined>;
  /** §5.7: a settled standing task's run launched — its workflow under its
   *  run id — or nothing when a run is on file under that id already.
   *  Throws when it cannot be launched now; the sweep tries again. */
  launch?(task: TaskRecord): Promise<void>;
  /** A new run id (createStrut's `generateRunId`): a pick-up's. */
  runId?(): string;
  /** §5.8: an invite link's token — `read` checks it (auth.ts `inviteOf`:
   *  strut's, signed here, not expired) and names the daemon's invite, the
   *  worker app it opens and the task types it gives (left out: every
   *  invite-only type of that app); `live` asks the daemon whether that
   *  invite may still let someone in (not cancelled, not failed). Left out:
   *  an invite gives no task type. `spent` is told once the invite has made
   *  its grant, so the host can mark it used and, when an existing account
   *  (not a new signup) redeemed it, send its sats back. It runs after the
   *  grant, not waited for, and never undoes it: a failure is only logged. */
  invite?: { read(token: string): { code: string; app: string; types?: string[] } | undefined; live(code: string): Promise<boolean>; spent?(code: string): Promise<void> };
  /** A worker seen for the first time (`me` or `next`), with the Sphinx
   *  address their sign-in carries: the host may welcome them (Support's
   *  welcome, plans/support-chat.md §11). Not waited for; a failure is only
   *  logged. */
  newWorker?(w: { actor: string; address: string }): Promise<void>;
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

  /** Rules 5 and 6: the worker as they are now, written `new` on first
   *  sight — and then, with the Sphinx address their session carries, the
   *  host told (`newWorker`). */
  const worker = async (actor: string, address?: string): Promise<{ s: TaskStores; w: WorkerRecord }> => {
    actorOk(actor);
    const s = await stores();
    // Two first calls at once may both find no row: the host's welcome is once per worker.
    const fresh = !!address && !!deps.newWorker && !(await s.workers.get(actor));
    const w = note(await s.workers.seen(actor, now()));
    if (fresh) void deps.newWorker!({ actor, address: address! }).catch((err) => console.warn(`worker ${actor}: newWorker failed:`, err));
    return { s, w };
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
  const attempt = async (actor: string, o: { type?: string; app?: string; invite?: string; address?: string }): Promise<{ got?: WorkerTask; types: string[] }> => {
    const seen = await worker(actor, o.address);
    const s = seen.s;
    if (seen.w.status === "suspended" || seen.w.status === "banned") mayWork(seen.w);
    // §5.8: an invite's link gives its worker the app's invite-only types.
    const invited = await enterInvite(s, seen.w, o.app, o.invite);
    const kinds = new Map((await s.tasks.types()).map((t) => [t.name, t]));
    // Ruling 9: the open types this ask reaches, never held, are entered now.
    const reach = [...kinds.values()].filter((k) => (o.app === undefined || k.app === o.app) && (o.type === undefined || k.name === o.type));
    const { w, closed } = await enter(s, invited, reach);
    mayWork(w, closed);
    const held = liveGrants(w);
    if (o.type !== undefined) {
      const kind = kinds.get(o.type);
      if (!kind) throw new TaskError("unknown_type", `no task type ${o.type} here`);
      if (o.app !== undefined && kind.app !== o.app) throw new TaskError("wrong_app", `task type ${o.type} is drawn by another app`);
      if (!held.includes(o.type)) throw new TaskError("not_granted", closed[0] ?? notHeld(w, kind));
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
    // A type's limits (its budget, one worker's day) hold for every task
    // handed out: a type at one is left out, and when every type the ask
    // reaches is, the worker is told why.
    const limited = await limitsReached(s, actor, types.map((n) => kinds.get(n)!), at);
    const free = types.filter((n) => !limited.has(n));
    if (types.length && !free.length) throw new TaskError("limit_reached", [...limited.values()][0]!);
    // §7.2: a type with tests serves the worker by where they are with it —
    // a qualifying one only tests, oldest grant first; one waiting for its
    // qualifying grades nothing; a qualified one real tasks, a test drawn in
    // place of one at the type's rate.
    const { qualifying, open, rows } = await phases(s, w, free.map((n) => kinds.get(n)!));
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
      // §5.7: nothing a run made is waiting for them, so a standing type
      // they may take makes its task now — a test in its place at the
      // type's rate, as for any task.
      for (const name of open) {
        const kind = kinds.get(name)!;
        if (!kind.standing) continue;
        if (kind.tests) {
          const answered = rows.get(kind.name)?.real ?? 0;
          if (random() < (answered < kind.tests.newTasks ? kind.tests.newRate : kind.tests.rate)) {
            const got = await s.tasks.takeTest({ worker: actor, type: kind.name, lease: randomId(), task: randomId(), now: at, pick });
            if (got) return { got: await workerTask(s, got), types };
          }
        }
        const got = await pickUp(s, actor, kind, at);
        if (got) return { got: await workerTask(s, got), types };
      }
    }
    // Another call of the same worker may have taken one meanwhile.
    const raced = await s.tasks.heldBy(actor, at);
    return raced && types.includes(raced.type) ? { got: await workerTask(s, raced), types } : { types };
  };
  /** The types among `kinds` that `actor` may not be handed a task of now,
   *  each with why: its `perWorkerDay` done today (UTC), or its budget too
   *  small for one more answer's pay. */
  const limitsReached = async (s: TaskStores, actor: string, kinds: TaskType[], at: number): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    const capped = kinds.filter((k) => k.limits?.perWorkerDay !== undefined);
    if (capped.length) {
      const today = await s.tasks.totals({ types: capped.map((k) => k.name), worker: actor, since: at - (at % DAY_MS), now: at });
      for (const k of capped) {
        const r = today.find((x) => x.type === k.name);
        if (r && r.answered + r.open >= k.limits!.perWorkerDay!) out.set(k.name, `you have done today's ${k.limits!.perWorkerDay} of ${plainText(k.title) ?? k.name}; more tomorrow`);
      }
    }
    const budgeted = kinds.filter((k) => k.limits?.budgetSats !== undefined && k.paySats);
    if (budgeted.length) {
      const all = await s.tasks.totals({ types: budgeted.map((k) => k.name), since: 0, now: at });
      for (const k of budgeted) {
        const spent = all.filter((x) => x.type === k.name).reduce((n, x) => n + x.payMsat + x.openPayMsat, 0);
        if (spent + Math.round(k.paySats! * 1000) > Math.round(k.limits!.budgetSats! * 1000)) out.set(k.name, `${plainText(k.title) ?? k.name} has used its budget: there is no more of this work`);
      }
    }
    return out;
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
  /** Only an `active` worker takes, answers or skips a task; a `new` one
   *  becomes active by entering an open type (`enter`) or a staff grant.
   *  `closed`: why the open types this ask reached took no newcomer. */
  const mayWork = (w: WorkerRecord, closed: string[] = []) => {
    if (w.status === "new" && closed.length) throw new TaskError("not_active", `you have no task types yet: ${closed.join("; ")}`);
    if (w.status !== "active") {
      throw new TaskError("not_active", `${w.status === "new" ? "you have no task types yet" : `you are ${w.status}`}; an admin decides who takes tasks here`);
    }
  };
  /** Why `w` may not take `kind`, which they do not hold. */
  const notHeld = (w: WorkerRecord, kind: TaskType): string => {
    const g = w.grants.find((x) => x.type === kind.name);
    if (g) return `your grant of task type ${kind.name} was revoked${g.why ? ` (${g.why})` : ""}; only staff can grant it again`;
    return kind.open ? `task type ${kind.name} is off` : `you do not hold task type ${kind.name}: it is invite-only, and staff grant it`;
  };

  // ── open types (ruling 9) ─────────────────────────────────────────────
  /** Whether a worker who never held open type `k` may enter it now, with
   *  the K their grant records — as a staff grant records it (§7.5): the
   *  type's when it has that many ready tests, else 0 — or why not: a PAID
   *  open type that asks for K takes a newcomer only while K are ready
   *  (`openPayProblem`), so it never pays a stranger it meant to qualify.
   *  Whether it asks is the admin's (ruling 12): with its tests off or K 0,
   *  anyone enters. Its tests running short after it was saved (one
   *  retired) makes it invite-only for newcomers until they are back; a
   *  worker already in keeps their grant. */
  const entry = async (s: TaskStores, k: TaskType): Promise<{ qualify: number } | { why: string }> => {
    const want = k.tests?.qualify ?? 0;
    const ready = want > 0 ? await s.tasks.readyTests(k.name) : 0;
    if (openPayProblem(k, ready)) return { why: `task type ${k.name} takes new workers while it has ${want} ready tests to qualify them on, and has ${ready} now: ask again later` };
    return { qualify: ready >= want ? want : 0 };
  };
  /** Ruling 9: records the grant (`grantOpen`, by `OPEN_GRANT_BY`) of each
   *  open, enabled type among `reach` the worker has no row of — never one
   *  revoked, which only staff grant again — unless suspended or banned.
   *  The worker after, and why any open type took no newcomer. */
  const enter = async (s: TaskStores, w: WorkerRecord, reach: TaskType[]): Promise<{ w: WorkerRecord; closed: string[] }> => {
    const closed: string[] = [];
    if (w.status === "suspended" || w.status === "banned") return { w, closed };
    const known = new Set(w.grants.map((g) => g.type));
    for (const k of reach) {
      if (!k.open || !k.enabled || known.has(k.name)) continue;
      const e = await entry(s, k);
      if ("why" in e) closed.push(e.why);
      else w = note(await s.workers.grantOpen(w.actor, k.name, now(), e.qualify));
    }
    return { w, closed };
  };

  // ── invites (§5.8) ────────────────────────────────────────────────────
  /** An invite redeemed now, by code: two first asks with one link are
   *  taken one after the other, so only one worker gets it. */
  const redeeming = new Map<string, Promise<unknown>>();
  /** A worker opened `app` from an invite's link (`token`): they are given
   *  the INVITE-ONLY, enabled types the token names that they have no row
   *  of (a token from before invites named their work: every such type
   *  `app` draws), by `invite:<code>` — never one revoked, which only staff
   *  grant again, and never to a suspended or banned worker. One worker per
   *  invite: once another holds a grant it made, it gives nothing; nor once
   *  the daemon no longer has it (cancelled, failed). A token that is not
   *  strut's, or opened another app, is ignored: the ask goes on as without
   *  one. */
  const enterInvite = async (s: TaskStores, w: WorkerRecord, app: string | undefined, token: string | undefined): Promise<WorkerRecord> => {
    if (!token || !app || !deps.invite || w.status === "suspended" || w.status === "banned") return w;
    const inv = deps.invite.read(token);
    if (!inv || inv.app !== app) return w;
    const known = new Set(w.grants.map((g) => g.type));
    const named = (k: TaskType) => (inv.types ? inv.types.includes(k.name) : k.app === app);
    const todo = (await s.tasks.types()).filter((k) => named(k) && !k.open && k.enabled && !known.has(k.name));
    if (!todo.length) return w;
    const by = `invite:${inv.code}`;
    const before = redeeming.get(inv.code) ?? Promise.resolve();
    const turn = before.then(async () => {
      if ((await s.workers.grantedBy(by)).some((a) => a !== w.actor)) return w;
      if (!(await deps.invite!.live(inv.code).catch(() => false))) return w;
      let after = w;
      for (const k of todo) {
        // §7.5, as a staff grant: the type's K when it has that many ready tests.
        const want = k.tests?.qualify ?? 0;
        const ready = want > 0 ? await s.tasks.readyTests(k.name) : 0;
        after = note(await s.workers.grant(w.actor, k.name, by, now(), ready >= want ? want : 0));
      }
      // Not waited for: the host's cancel can take the daemon's 20 s, and this is the worker's
      // first look at Tasks. The grant is written, so a second ask finds it (`grantedBy`), and
      // a failed cancel never undoes it.
      void deps.invite!.spent?.(inv.code).catch((err) => console.warn(`invite ${inv.code}: spent failed:`, err));
      return after;
    });
    redeeming.set(inv.code, turn.catch(() => undefined));
    try {
      return await turn;
    } finally {
      if (redeeming.get(inv.code) === turn) redeeming.delete(inv.code);
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
      ...(l.payMsat && kind?.payOn === "ok" ? { payOn: "ok" as const } : {}),
      ...(kind?.attachments ? { attachments: kind.attachments } : {}),
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
   *  was answered (as booking would set it). Never (undefined) for a paid
   *  answer a type that pays on ok has not booked: nothing was paid, so
   *  nothing can be lost by changing it. */
  const holdEnd = (l: Lease, kind: TaskType | undefined, earning: Pick<Earning, "releases"> | undefined): number | undefined =>
    earning?.releases ?? (kind?.payOn === "ok" && l.payMsat ? undefined : (l.closed ?? l.taken) + Math.round((kind?.holdHours ?? DEFAULT_HOLD_HOURS) * HOUR_MS));
  const leaseReview = (r: ReviewRecord, until: number | undefined, at: number): LeaseReview => {
    const { task: _t, worker: _w, ...rest } = r;
    return { ...rest, ...(until === undefined ? {} : { until }), final: until !== undefined && at >= until };
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
    // A type that pays on ok books an answer once it earns (`earnsNow`):
    // its ok, or a test's grade. Until then it is owed nothing.
    if (kind?.payOn === "ok") {
      const verdict = (await s.tasks.reviewsOf([l.task])).find((r) => r.worker === l.worker)?.verdict;
      if (!earnsNow(kind, verdict, t?.grade)) return false;
    }
    // Earned when answered, or for a type that pays on ok when that came:
    // its hold runs from then.
    const at = kind?.payOn === "ok" ? now() : (l.closed ?? now());
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
  const settledExtras = async (s: TaskStores, t: TaskRecord): Promise<{ pay?: TaskPay; answers?: CopyAnswer[]; attachments?: RunAttachment[] }> => {
    if (t.status !== "settled") return {};
    const answered = answersOf(await s.tasks.leasesOf([t.id]));
    const answers = t.copies > 1
      ? answered.map((l) => ({ answer: l.answer ?? null, by: l.worker, agrees: l.agrees === true, ...(l.attachments?.length ? { attachments: l.attachments } : {}) }))
      : undefined;
    // The settled answer's files (§5.6.4): its worker's lease's.
    const sent = answered.find((l) => l.worker === t.by)?.attachments;
    const files = sent?.length ? { attachments: sent } : {};
    const msat = answered.reduce((n, l) => n + (l.payMsat ?? 0), 0);
    if (!msat) return { ...(answers ? { answers } : {}), ...files };
    let usd: number | undefined;
    try {
      const rate = await deps.usdPerBtc?.();
      if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) usd = Math.round(((msat * rate) / 1e11) * 1e6) / 1e6;
    } catch (err) {
      console.warn(`[tasks] no rate for task ${t.id}'s pay in dollars: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { pay: { msat, ...(usd !== undefined && usd > 0 ? { usd } : {}) }, ...(answers ? { answers } : {}), ...files };
  };
  const balanceOf = async (actor: string): Promise<PayeeBalance> => {
    const ledger = await deps.ledgerIfAny?.();
    return ledger ? ledger.payeeBalance(actor, { now: now() }) : { ...ZERO_BALANCE };
  };
  /** Their XP and level (plans/worker-progress.md): a ledger not opened yet
   *  is nothing earned, as the balance reads it; a host's own store, with no
   *  ledger at all, has none. */
  const xpOf = async (actor: string): Promise<WorkerXp | undefined> => {
    if (!deps.ledgerIfAny) return undefined;
    const ledger = await deps.ledgerIfAny();
    const sats = Math.floor((ledger ? await ledger.payeeEarned(actor) : 0) / 1000);
    return { sats, ...levelOf(sats) };
  };

  // ── tests and standing (§7) ───────────────────────────────────────────
  const graderProblem = (step: string): string | undefined =>
    deps.graderProblem ? deps.graderProblem(step) : `this server grades by "equal" alone: no step grader (${step})`;
  /** Who a type's step graders, comparators and check bill, picked for the
   *  admin (§7.12): the deployment's grading principal, else whoever last
   *  saved the type; with neither, nobody is named and the call runs on the
   *  server's own model key, as any unattributed call does. Never a reason
   *  not to run. */
  const payerOf = (kind: TaskType | undefined): { principal?: string } => {
    const principal = deps.principal ?? kind?.changedBy;
    return principal ? { principal } : {};
  };
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

  // ── standing types (§5.7) ─────────────────────────────────────────────
  /** A type's `standing` as saved, or null (off), or a `bad_request`
   *  naming why its workflow cannot be one. */
  const standingRuleOf = async (type: string, raw: TaskTypeInput["standing"]): Promise<StandingRule | null> => {
    if (raw === undefined || raw === null) return null;
    const keys = typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw) : [];
    const workflow = (raw as { workflow?: unknown }).workflow;
    if (typeof workflow !== "string" || !workflow || keys.some((k) => k !== "workflow")) {
      throw new TaskError("bad_request", "standing is { workflow }: the workflow each answer starts, or null");
    }
    if (!deps.standing) throw new TaskError("bad_request", "standing: this server starts no workflow from a task type");
    const r = await deps.standing(type, workflow);
    if ("problem" in r) throw new TaskError("bad_request", `standing: ${r.problem}`);
    return { workflow };
  };
  /** A round type's rule (`round`), checked against its workflow; null for none. */
  const roundRuleOf = async (type: string, raw: TaskTypeInput["round"]): Promise<RoundRule | null> => {
    if (raw === undefined || raw === null) return null;
    const keys = typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw) : [];
    const workflow = (raw as { workflow?: unknown }).workflow;
    if (typeof workflow !== "string" || !workflow || keys.some((k) => k !== "workflow")) {
      throw new TaskError("bad_request", "round is { workflow }: the workflow a round runs, or null");
    }
    if (!deps.round) throw new TaskError("bad_request", "round: this server sends no rounds of a task type");
    const problem = await deps.round(type, workflow);
    if (problem) throw new TaskError("bad_request", `round: ${problem}`);
    return { workflow };
  };
  /** Standing types whose pick-up failed, logged once each until one lands. */
  const pickUpFailing = new Set<string>();
  /** §5.7: a pick-up of standing type `kind` for `actor` — the task and
   *  their lease, one write — or undefined (they hold one, or its workflow
   *  cannot be one now: logged once). */
  const pickUp = async (s: TaskStores, actor: string, kind: TaskType, at: number): Promise<Lease | undefined> => {
    if (!kind.standing || !deps.standing) return undefined;
    let made: StandingTask | { problem: string };
    try {
      made = await deps.standing(kind.name, kind.standing.workflow);
    } catch (err) {
      made = { problem: err instanceof Error ? err.message : String(err) };
    }
    const bytes = "problem" in made ? undefined : jsonBytes(made.show);
    if (!("problem" in made) && (bytes === undefined || bytes > SHOW_MAX_BYTES)) made = { problem: `its human step's show is ${bytes ?? "not"} JSON; at most ${SHOW_MAX_BYTES} bytes` };
    if ("problem" in made) {
      if (!pickUpFailing.has(kind.name)) console.warn(`[tasks] standing type ${kind.name} hands out nothing: ${made.problem}`);
      pickUpFailing.add(kind.name);
      return undefined;
    }
    pickUpFailing.delete(kind.name);
    const runId = deps.runId?.() ?? generateRunId();
    return s.tasks.takeStanding({ worker: actor, type: kind.name, lease: randomId(), task: randomId(), workflow: kind.standing.workflow, runId, path: made.path, show: made.show, now: at });
  };
  /** Standing tasks whose launch is in flight, and those whose launch
   *  failed (logged once each). */
  const launching = new Set<string>();
  const launchFailed = new Set<string>();
  /** §5.7: a settled standing task's run launched, then recorded. True when
   *  it was; a failure is logged once and left for the sweep. */
  const launchStanding = async (s: TaskStores, t: TaskRecord): Promise<boolean> => {
    if (!deps.launch || launching.has(t.id)) return false;
    launching.add(t.id);
    try {
      await deps.launch(t);
      await s.tasks.launched(t.id, now());
      launchFailed.delete(t.id);
      return true;
    } catch (err) {
      if (!launchFailed.has(t.id)) console.error(`[tasks] standing task ${t.id}'s run (${t.workflow} ${t.runId}) did not launch; the sweep tries again each minute:`, err instanceof Error ? err.message : err);
      launchFailed.add(t.id);
      return false;
    } finally {
      launching.delete(t.id);
    }
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

    async reply(input, o) {
      const id = need("task", input?.task);
      const show = input.show;
      if (show !== undefined) {
        if (!show || typeof show !== "object" || Array.isArray(show)) throw new TaskError("bad_request", "show is a JSON object");
        const bytes = jsonBytes(show);
        if (bytes === undefined) throw new TaskError("bad_request", "show must be JSON");
        if (bytes > SHOW_MAX_BYTES) throw new TaskError("bad_request", `show is ${bytes} bytes as JSON; at most ${SHOW_MAX_BYTES} (send files instead of inlining them)`);
      }
      const files = input.files ?? [];
      if (!Array.isArray(files) || files.length > MAX_ATTACHMENTS) throw new TaskError("bad_request", `files is a list of at most ${MAX_ATTACHMENTS} of the run's files`);
      filesOf(files.map((f) => f?.path));
      for (const f of files) {
        if (typeof f.name !== "string" || typeof f.mediaType !== "string" || !Number.isSafeInteger(f.size)) throw new TaskError("bad_request", `files: ${JSON.stringify(f.path)} needs its name, mediaType and size`);
        // What `task/file` can hand a page (§5.5): a worker can read every file of a reply.
        if (f.size > TEST_FILE_MAX_BYTES) throw new TaskError("bad_request", `files: ${f.path} is ${f.size} bytes; a worker's page reads at most ${TEST_FILE_MAX_BYTES} a file`);
      }
      const group = input.group === undefined ? undefined : groupOf(input.group);
      const verdict = input.verdict;
      if (verdict !== undefined && !VERDICTS.includes(verdict)) throw new TaskError("bad_request", `verdict is ${VERDICTS.join(" or ")}`);
      if (input.why !== undefined && verdict === undefined) throw new TaskError("bad_request", "why goes with a verdict");
      if (show === undefined && !files.length && group === undefined && verdict === undefined) throw new TaskError("bad_request", "a reply has show, files, a group or a verdict");
      // The task's run is the CALLING run, read off its control — never an
      // input — so no other run, page or step names another run's task.
      const run = runLineage(o?.control)[0];
      const s = await storesIfAny();
      const t = s && run ? await s.tasks.task(id) : undefined;
      if (!t || t.test !== undefined || t.runId !== run!.runId || t.workflow !== run!.workflow) throw new TaskError("unknown_task", `no task ${id} asked by this run`);
      if (t.status !== "settled") throw new TaskError("not_answered", `task ${id} is ${t.status}: a reply goes only to a task its worker answered`);
      const at = now();
      // A group alone names the group and leaves the reply as it was.
      const reply: TaskReply | undefined =
        show !== undefined || files.length ? { ...(show !== undefined ? { show } : {}), ...(files.length ? { files: files.map((f) => ({ name: f.name, mediaType: f.mediaType, size: f.size, path: f.path })) } : {}), at } : undefined;
      if ((reply || group !== undefined) && !(await s!.tasks.reply(id, { ...(reply ? { reply } : {}), ...(group !== undefined ? { group } : {}) }))) {
        throw new TaskError("not_answered", `task ${id} is no longer answered`);
      }
      // The run judges the answer it asked for, as staff would: the one the
      // task settled with (a copies task's agreed answer), by its workflow.
      if (verdict !== undefined) {
        await review({ task: id, ...(t.by ? { worker: t.by } : {}), verdict, ...(input.why !== undefined ? { why: input.why } : {}), by: `${RUN_REVIEWER_PREFIX}${t.workflow}` });
      }
      return { task: id, at };
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
      // §5.6: the files the type takes, checked before anything is written,
      // then saved in the task's run BEFORE it settles, so the run wakes to
      // them. A test instance has no run: a page cannot tell it from a task,
      // so its files are checked alike and dropped (§5.6.5).
      let files: Attachment[];
      try {
        files = answerAttachments(l.type, kind.attachments, o.attachments);
      } catch (err) {
        throw new TaskError("bad_answer", err instanceof Error ? err.message : String(err));
      }
      // §5.6.7 c: the type's check, on the answer and its files, before
      // anything is written — a test instance's too, which a page cannot
      // tell from a task. A fail refuses the answer: the task is still the
      // worker's, and nothing is saved or earned.
      const t = kind.check || files.length ? (await s.tasks.task(l.task))! : undefined;
      if (kind.check) await checked(kind, kind.check, t!, o.answer, files);
      let attachments: RunAttachment[] | undefined;
      if (files.length) {
        if (t!.root !== "test") {
          if (!deps.saveAttachments) throw new TaskError("bad_request", "this server keeps no files from workers");
          attachments = await deps.saveAttachments(t!, files);
        }
      }
      const r = await s.tasks.settle({ lease: l.id, worker: actor, answer: o.answer, ...(attachments ? { attachments } : {}), now: now(), decide: inlineDecider(kind) });
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
      // §5.7: no run waits on a standing task: its answer starts one.
      else if (settled.standing) await launchStanding(s, settled);
      else if (settled.status !== "open") tell([settledOf(settled)]);
      return { ok: true };
    },

    async skip(actor, o) {
      count(actor);
      const { s, w } = await worker(actor);
      mayWork(w);
      const l = await ownLease(s, w, o?.lease);
      // The dashboard's Let go (`apps`): a task any app it lists draws.
      if (o.apps) {
        const k = await s.tasks.type(l.type);
        if (!k || !drawnBy(k, o)) throw new TaskError("wrong_app", `task type ${l.type} is drawn by an app you can't open here`);
      } else await appOk(s, l, o.app);
      const reason = o.reason === undefined ? undefined : text("reason", o.reason);
      if (!(await s.tasks.skip({ lease: l.id, worker: actor, ...(reason === undefined ? {} : { reason }), now: now() }))) return whyNot(s, w, l.id);
      // The task is open for someone else.
      wakeFor(l.type);
      return { ok: true };
    },

    async file(actor, o) {
      count(actor);
      const { s, w } = await worker(actor);
      const path = o?.path;
      if (typeof path !== "string" || !path) throw new TaskError("bad_request", "path is required");
      // A lease they ANSWERED, on a task its run replied to, reads the
      // reply's files alone — whatever their status now, as their history
      // shows it — and nothing else of the run.
      const answered = typeof o.lease === "string" && o.lease ? await s.tasks.lease(o.lease) : undefined;
      const replied = answered?.worker === w.actor && answered.status === "submitted" ? await s.tasks.task(answered.task) : undefined;
      if (replied?.reply) {
        // Their own answered lease alone (checked above), so a call that lists
        // across apps (the dashboard) may read a reply of any app it lists:
        // the calling app task/file names beside `all` doesn't narrow it.
        if (o.all) {
          const k = await s.tasks.type(answered!.type);
          if (!k || !drawnBy(k, o.apps ? { apps: o.apps } : {})) throw new TaskError("wrong_app", `task type ${answered!.type} is drawn by an app you can't open here`);
        } else await appOk(s, answered!, o.app);
        if (!replied.reply.files?.some((f) => f.path === path)) throw new TaskError("not_listed", `${JSON.stringify(path)} is not one of the files the run replied with`);
        const f = deps.file ? await deps.file({ ...replied, root: "run" }, path) : null;
        if (!f) throw new TaskError("no_file", `${JSON.stringify(path)} is no longer there`);
        return f;
      }
      mayWork(w);
      const l = await ownLease(s, w, o?.lease);
      await appOk(s, l, o.app);
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
      const seen = await worker(actor, o.address);
      const s = seen.s;
      // §5.8: an invite's link gives its worker the app's invite-only types.
      const w = await enterInvite(s, seen.w, o.app ?? o.inviteApp, o.invite);
      const kinds = new Map((await s.tasks.types()).map((t) => [t.name, t]));
      const inApp = (k: TaskType | undefined): k is TaskType => !!k && k.enabled && drawnBy(k, o);
      const held = liveGrants(w).map((name) => kinds.get(name)).filter(inApp);
      // Ruling 3: a qualifying type is marked, with no score.
      const grants = grantsOf(w);
      const rows = await standingRows(s, w.actor, held, grants);
      const at = now();
      const shown = (k: TaskType, qualifying: boolean): WorkerTypeView => ({
        name: k.name,
        ...(k.title ? { title: k.title } : {}),
        app: k.app,
        payMsat: payMsatOf(k) ?? 0,
        qualifying,
        standing: !!k.standing,
        waiting: 0,
      });
      const types = held.map((k) => {
        const row = rows.get(k.name);
        return shown(k, !!(k.tests && row) && phaseOf(row!, grants.get(k.name)!) !== "qualified");
      });
      // Ruling 9: the open types they may enter, as their first ask would —
      // qualifying first when the grant would record a K. Read, not entered.
      if (w.status === "new" || w.status === "active") {
        const known = new Set(w.grants.map((g) => g.type));
        for (const k of [...kinds.values()].filter(inApp)) {
          if (!k.open || known.has(k.name)) continue;
          const e = await entry(s, k);
          if ("qualify" in e) types.push(shown(k, e.qualify > 0));
        }
      }
      // The dashboard: what waits for them of each, and the task in hand.
      const waiting = types.length ? await s.tasks.waitingFor({ worker: w.actor, types: types.map((t) => t.name), now: at }) : {};
      for (const t of types) t.waiting = waiting[t.name] ?? 0;
      const live = await s.tasks.heldBy(w.actor, at);
      const holding = live && types.some((t) => t.name === live.type) ? { type: live.type, expires: live.expires, lease: live.id } : undefined;
      // A worker's status touches no earning (§8.1): a suspended worker
      // still sees what they are owed, and may withdraw what passed its
      // hold (§8.2).
      const balance = await balanceOf(w.actor);
      const pendingMsat = await s.tasks.pendingPay(w.actor);
      const payout = deps.payouts ? await deps.payouts.view(w.actor, { balance, ...(o.address ? { address: o.address } : {}) }) : undefined;
      const xp = await xpOf(w.actor);
      return { actor: w.actor, status: w.status, types, ...(holding ? { holding } : {}), balance, ...(pendingMsat > 0 ? { pendingMsat } : {}), ...(payout ? { payout } : {}), ...(xp ? { xp } : {}) };
    },

    async history(actor, o = {}) {
      count(actor);
      if (o.group !== undefined && typeof o.group !== "string") throw new TaskError("bad_request", "group is a group's name");
      const { s, w } = await worker(actor);
      const kinds = new Map((await s.tasks.types()).map((t) => [t.name, t]));
      // A type gone, or drawn by another app, is not this app's to show.
      const mine = (type: string) => {
        const k = kinds.get(type);
        return !!k && drawnBy(k, o);
      };
      // One group's answers, all of them; else the newest leases.
      const grouped = o.group ? await s.tasks.list({ group: o.group, by: w.actor, test: false, limit: TASK_LIST_MAX }) : undefined;
      const leases = (
        grouped
          ? (await s.tasks.leasesOf(grouped.map((t) => t.id))).filter((l) => l.worker === w.actor).sort((a, b) => b.taken - a.taken)
          : await s.tasks.recentLeases(w.actor, RECENT_LEASES)
      ).filter((l) => mine(l.type));
      const byId = new Map((grouped ?? (await s.tasks.byIds([...new Set(leases.map((l) => l.task))]))).map((t) => [t.id, t]));
      const paid = leases.filter((l) => l.status === "submitted" && l.payMsat);
      const ledger = paid.length ? await deps.ledgerIfAny?.() : undefined;
      const earned = ledger ? new Map((await ledger.payFor([...new Set(paid.map((l) => l.task))])).map((e) => [e.lease, e])) : new Map<string, Earning>();
      // Staff's verdict on each answer of theirs (§9.6): what to fix, and why.
      const answered = leases.filter((l) => l.status === "submitted");
      const verdicts = answered.length ? new Map((await s.tasks.reviewsOf([...new Set(answered.map((l) => l.task))])).filter((r) => r.worker === w.actor).map((r) => [r.task, r])) : new Map<string, ReviewRecord>();
      const groups = o.groups ? (await s.tasks.groups({ worker: w.actor, types: [...kinds.keys()].filter(mine) })).map(({ workers: _w, statusBy: _b, ...g }) => g) : undefined;
      return {
        items: leases.map((l): WorkerHistoryItem => {
          const e = earned.get(l.id);
          const t = byId.get(l.task);
          // An answer not booked yet is booked by the next sweep: its hold
          // runs from when it was answered, as booking will set it. One a
          // type that pays on ok has not booked waits for its ok, and a
          // rejected one (or a test graded fail) earns nothing.
          const waits = !e && kinds.get(l.type)?.payOn === "ok";
          const until = holdEnd(l, kinds.get(l.type), e);
          const pay = l.status === "submitted" && l.payMsat && !waits && until !== undefined ? { msat: e?.msat ?? l.payMsat, releases: until, ...(e?.takenBack !== undefined ? { takenBack: true as const } : {}) } : undefined;
          const pending =
            l.status === "submitted" && l.payMsat && waits && verdicts.get(l.task)?.verdict !== "rejected" && t?.grade !== "fail" ? { msat: l.payMsat } : undefined;
          const ask = askOf(t?.show);
          // The run's reply reaches those who answered, never a skip or a lease run out.
          const reply = l.status === "submitted" ? t?.reply : undefined;
          const r = l.status === "submitted" ? verdicts.get(l.task) : undefined;
          const review = r ? { verdict: r.verdict, ...(r.why ? { why: r.why } : {}), at: r.at } : undefined;
          return {
            lease: l.id,
            type: l.type,
            ...(ask ? { ask } : {}),
            taken: l.taken,
            ...(l.closed !== undefined ? { closed: l.closed } : {}),
            status: l.status,
            ...(pay ? { earned: pay } : {}),
            ...(pending ? { pending } : {}),
            ...(reply ? { reply } : {}),
            ...(t?.group !== undefined && l.status === "submitted" ? { group: t.group } : {}),
            ...(review ? { review } : {}),
          };
        }),
        ...(groups ? { groups } : {}),
      };
    },

    async types() {
      const s = await storesIfAny();
      return s ? s.tasks.types() : [];
    },

    async setType(name, input, by, o = {}) {
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
      if (input.open !== undefined && typeof input.open !== "boolean") throw new TaskError("bad_request", "open is true or false");
      const open = input.open ?? true;
      const paySats = payOk(input.paySats);
      const holdHours = holdOk(input.holdHours);
      const payOn = payOnOk(input.payOn);
      const limits = limitsOk(input.limits);
      const title = titleOk(input.title);
      const tests = ruled(() => testRulesOf(input.tests, graderProblem));
      const copies = ruled(() => copiesRuleOf(input.copies, graderProblem));
      const attachments = ruled(() => attachmentRuleOf(input.attachments));
      const standing = await standingRuleOf(name, input.standing);
      const round = await roundRuleOf(name, input.round);
      const check = ruled(() => checkRuleOf(input.check, graderProblem));
      if (standing && round) throw new TaskError("bad_request", "a task type is standing (a worker's ask makes its task) or sent in rounds (a workflow makes one for each item), never both");
      const s = await stores();
      const existed = await s.tasks.type(name);
      const changedBy = by ?? existed?.changedBy;
      // Ruling 12: whether a paid open type qualifies newcomers is the
      // admin's; nothing here refuses one for want of tests.
      const saved = await s.tasks.putType({
        name,
        ...(title ? { title } : {}),
        app,
        answer: input.answer as TaskType["answer"],
        leaseSeconds,
        withinHours,
        enabled: input.enabled ?? true,
        open,
        ...(paySats ? { paySats } : {}),
        holdHours,
        ...(payOn === "ok" ? { payOn } : {}),
        ...(limits ? { limits } : {}),
        ...(tests ? { tests } : {}),
        ...(copies ? { copies } : {}),
        ...(attachments ? { attachments } : {}),
        ...(standing ? { standing } : {}),
        ...(round ? { round } : {}),
        ...(check ? { check } : {}),
        changedAt: now(),
        // A save that names nobody (a script's, on the API key alone) keeps
        // the last person who saved it: they still pay for its graders.
        ...(changedBy === undefined ? {} : { changedBy }),
      });
      // A new invite-only type is its makers' from the start, so "try it"
      // works the moment it is saved (an open one needs no grant).
      if (!existed && !open) {
        const at = now();
        for (const actor of new Set(o.holders ?? [])) {
          if (typeof actor !== "string" || !actor || actor.length > 200) continue;
          await s.workers.grant(actor, name, by ?? actor, at, 0);
        }
      }
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

    async groups(q = {}) {
      if (q.type !== undefined && typeof q.type !== "string") throw new TaskError("bad_request", "type is a task type's name");
      if (q.status !== undefined && !GROUP_STATUSES.includes(q.status)) throw new TaskError("bad_request", `status is ${GROUP_STATUSES.join(" or ")}`);
      const group = q.group === undefined ? undefined : groupOf(q.group);
      const s = await storesIfAny();
      return s
        ? s.tasks.groups({ ...(q.type ? { types: [q.type] } : {}), ...(group !== undefined ? { group } : {}), ...(q.status ? { status: q.status } : {}), ...(q.limit !== undefined ? { limit: q.limit } : {}) })
        : [];
    },

    async task(id) {
      const s = await storesIfAny();
      const t = s && (await s.tasks.task(id));
      return t ? (await views(s, [t]))[0] : undefined;
    },

    async numbers(q = {}) {
      if (q.type !== undefined && typeof q.type !== "string") throw new TaskError("bad_request", "type is a task type's name");
      const days = q.days ?? 7;
      if (!Number.isSafeInteger(days) || days < 1 || days > 90) throw new TaskError("bad_request", "days is a whole number from 1 to 90");
      const at = now();
      const s = await storesIfAny();
      const kinds = s ? (await s.tasks.types()).filter((k) => q.type === undefined || k.name === q.type) : [];
      if (q.type !== undefined && !kinds.length) throw new TaskError("unknown_type", `no task type ${q.type} here`);
      if (!s || !kinds.length) return [];
      const names = kinds.map((k) => k.name);
      const [all, recent] = await Promise.all([s.tasks.totals({ types: names, since: 0, now: at }), s.tasks.totals({ types: names, since: at - days * DAY_MS, now: at })]);
      const sats = (msat: number) => Math.round(msat) / 1000;
      return kinds.map((k): TypeNumbers => {
        const mine = recent.filter((r) => r.type === k.name && r.answered > 0);
        const ofAll = all.filter((r) => r.type === k.name);
        return {
          type: k.name,
          ...(k.title ? { title: k.title } : {}),
          enabled: k.enabled,
          open: k.open,
          ...(k.paySats ? { paySats: k.paySats } : {}),
          ...(k.limits ? { limits: k.limits } : {}),
          spentSats: sats(ofAll.reduce((n, r) => n + r.payMsat, 0)),
          workingSats: sats(ofAll.reduce((n, r) => n + r.openPayMsat, 0)),
          days,
          answered: mine.reduce((n, r) => n + r.answered, 0),
          workers: mine
            .map((r) => {
              const workMinutes = Math.round(r.workMs / 60_000);
              return { worker: r.worker, answered: r.answered, workMinutes, ...(r.workMs >= 60_000 ? { perHour: Math.round((r.answered * HOUR_MS) / r.workMs) } : {}), earnedSats: sats(r.payMsat) };
            })
            .sort((a, b) => b.answered - a.answered),
        };
      });
    },

    async stats(q = {}) {
      if (q.type !== undefined && typeof q.type !== "string") throw new TaskError("bad_request", "type is a task type's name");
      const at = now();
      const s = await storesIfAny();
      const kinds = s ? (await s.tasks.types()).filter((k) => q.type === undefined || k.name === q.type) : [];
      if (q.type !== undefined && !kinds.length) throw new TaskError("unknown_type", `no task type ${q.type} here`);
      const counted = s ? await s.tasks.stats({ types: kinds.map((k) => k.name), now: at }) : { types: [], holding: 0 };
      const people = s ? await s.workers.counts() : { statuses: noStatuses(), granted: {} };
      const ready = s ? await Promise.all(kinds.map((k) => s.tasks.readyTests(k.name))) : [];
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
          readyTests: ready[i] ?? 0,
          toReview: c.unreviewed,
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
      // A path not on the list is refused whether or not it exists (§5.5) —
      // the task's own, or one its answers carried (§5.6.4) or its run's
      // reply lists, which are in the run's artifacts whatever the task's root.
      const sent =
        !t.files.includes(path) &&
        (!!t.reply?.files?.some((f) => f.path === path) || (await s!.tasks.leasesOf([t.id])).some((l) => l.attachments?.some((a) => a.path === path)));
      if (!sent && !t.files.includes(path)) throw new TaskError("not_listed", `${JSON.stringify(path)} is not one of this task's files`);
      const f = deps.file ? await deps.file(sent ? { ...t, root: "run" } : t, path) : null;
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
    const kind = await s.tasks.type(l.type);
    // A type that pays on ok books an answer when its ok comes (below);
    // until then nothing is owed, so nothing is booked here.
    const onOk = kind?.payOn === "ok";
    // A paid answer not booked yet is booked first, so its hold is the
    // ledger's (as a take-back does).
    let earning: Earning | undefined;
    if (l.payMsat && deps.ledger) {
      if (!onOk) await book(s, l.id);
      earning = await (await deps.ledger()).payOf(l.id);
    }
    let until = holdEnd(l, kind, earning);
    const before = (await s.tasks.reviewsOf([t.id])).find((r) => r.worker === l.worker);
    if (before && until !== undefined && at >= until) {
      throw new TaskError("final", `final: the hold on ${l.worker}'s answer to task ${t.id} ended at ${new Date(until).toISOString()}, so its verdict (${before.verdict}) can no longer change`);
    }
    // The money (§9.6, ruled 2026-11-13: option A): inside the hold a
    // rejection takes the earning back, and `ok` undoes a take-back a
    // rejection made (its why begins `REVIEW_TAKE_BACK`), never a staff or a
    // grading one. Past the hold nothing moves: paid money never moves back.
    if (earning && until !== undefined && at < until && deps.ledger) {
      const ledger = await deps.ledger();
      if (o.verdict === "rejected") {
        earning = (await ledger.takeBack({ lease: l.id, why: `${REVIEW_TAKE_BACK}${why}`, ...(o.by ? { by: o.by } : {}), at })).earning ?? earning;
      } else if (earning.takenBack !== undefined && earning.takenBackWhy?.startsWith(REVIEW_TAKE_BACK)) {
        earning = (await ledger.restore({ lease: l.id, ...(o.by ? { by: o.by } : {}), at })).earning ?? earning;
      }
    }
    const row = await s.tasks.putReview({ task: t.id, worker: l.worker, verdict: o.verdict, ...(why ? { why } : {}), ...(o.by ? { by: o.by } : {}), at });
    // Paid on ok: the ok just written is what it earns by, booked now (its
    // hold from now). A booking that fails is the sweep's, never the worker's.
    if (onOk && o.verdict === "ok" && !earning && l.payMsat && deps.ledger) {
      try {
        if (await book(s, l.id)) earning = await (await deps.ledger()).payOf(l.id);
      } catch (err) {
        console.error(`[tasks] booking lease ${l.id}'s earning on its ok failed; the next sweep books it:`, err);
      }
      until = holdEnd(l, kind, earning);
    }
    // §7.5: a rejection counts against standing as a failed test does, so
    // the check runs as after a grade; `ok` takes it out of the window.
    if (o.verdict === "rejected" && kind?.tests) await standingCheck(s, l.worker, kind);
    return { task: t.id, worker: l.worker, lease: l.id, review: leaseReview(row, until, at), ...(earning ? { earning: leaseEarning(earning) } : {}) };
  };

  const reviewGroup: TasksService["reviewGroup"] = async (o) => {
    if (!o || typeof o !== "object") throw new TaskError("bad_request", "a group's review is { group, type?, verdict, why? }");
    const group = groupOf(o.group);
    if (o.type !== undefined && typeof o.type !== "string") throw new TaskError("bad_request", "type is a task type's name");
    if (!VERDICTS.includes(o.verdict)) throw new TaskError("bad_request", `verdict is ${VERDICTS.join(" or ")}`);
    if (o.verdict === "rejected" && !(typeof o.why === "string" && o.why.trim())) throw new TaskError("bad_request", "a rejection says why");
    const s = await storesIfAny();
    if (!s) return { reviewed: 0, more: false };
    const tasks = await s.tasks.list({ group, ...(o.type ? { type: o.type } : {}), review: "none", limit: TASK_LIST_MAX });
    const ids = tasks.map((t) => t.id);
    const leases = await s.tasks.leasesOf(ids);
    const given = new Set((await s.tasks.reviewsOf(ids)).map((r) => `${r.task}\0${r.worker}`));
    let reviewed = 0;
    // Oldest first, as the answers were given.
    for (const t of [...tasks].reverse()) {
      const answers = answersOf(leases.filter((l) => l.task === t.id));
      for (const l of answers) {
        if (given.has(`${t.id}\0${l.worker}`)) continue;
        await review({ task: t.id, ...(answers.length > 1 ? { worker: l.worker } : {}), verdict: o.verdict, ...(o.why !== undefined ? { why: o.why } : {}), ...(o.by !== undefined ? { by: o.by } : {}) });
        reviewed++;
      }
    }
    return { reviewed, more: tasks.length >= TASK_LIST_MAX };
  };

  const setGroupStatus: TasksService["setGroupStatus"] = async (o) => {
    if (!o || typeof o !== "object") throw new TaskError("bad_request", "a group's status is { type, group, status, why? }");
    const type = need("type", o.type);
    const group = groupOf(o.group);
    if (!GROUP_STATUSES.includes(o.status)) throw new TaskError("bad_request", `status is ${GROUP_STATUSES.join(" or ")}`);
    const why = o.why === undefined || o.why === null ? undefined : text("why", o.why).trim() || undefined;
    const s = await storesIfAny();
    const one = async () => (s ? (await s.tasks.groups({ types: [type], group, limit: 1 }))[0] : undefined);
    if (!(await one())) throw new TaskError("unknown_group", `no task of ${type} is in the group ${group}`);
    await s!.tasks.setGroupStatus({ type, group, status: o.status, ...(why ? { why } : {}), ...(o.by !== undefined ? { by: o.by } : {}), at: now() });
    return (await one())!;
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

  // ── the check before an answer is accepted (§5.6.7 c) ─────────────────
  /** Types whose check could not run, logged once each until one runs. */
  const checkFailing = new Set<string>();
  /** A type's check on one answer and its files: its sealed step, in the
   *  grader's contract with no expected answer, billed as grading is, while
   *  the worker's page waits. Throws `bad_answer` with the step's reason on
   *  a fail. One that cannot run (gone, no longer sealed, past its time, no
   *  verdict, its model refused) refuses the answer too, logged: nothing is
   *  accepted, and so earned, unchecked. */
  const checked = async (kind: TaskType, rule: CheckRule, t: TaskRecord, answer: unknown, files: Attachment[]): Promise<void> => {
    let v: GradeVerdict;
    try {
      // Asked again at each answer: the registry changes (§7.4).
      const problem = graderProblem(rule.step);
      if (problem) throw new Error(problem);
      if (!deps.grade) throw new Error(`this server runs no step check (${rule.step})`);
      v = await deps.grade({
        step: rule.step,
        ...(rule.config ? { config: rule.config } : {}),
        input: {
          answer,
          show: t.show,
          type: kind.name,
          ...(files.length ? { files: files.map((f) => ({ name: f.name, mediaType: f.mediaType, data: f.bytes.toString("base64") })) } : {}),
        },
        ...payerOf(kind),
        maxCostUsd: kind.tests?.gradeCapUsd ?? DEFAULT_TEST_RULES.gradeCapUsd,
        timeoutMs: CHECK_TIMEOUT_MS,
      });
      if (!v || typeof v.supports !== "boolean") throw new Error(`${rule.step} returned no verdict`);
    } catch (err) {
      if (!checkFailing.has(kind.name)) {
        checkFailing.add(kind.name);
        console.warn(`[tasks] task type ${kind.name}'s check ${rule.step} could not run, so its answers are refused until it does:`, err instanceof Error ? err.message : err);
      }
      throw new TaskError("bad_answer", "this answer could not be checked just now: send it again in a moment");
    }
    checkFailing.delete(kind.name);
    if (!v.supports) throw new TaskError("bad_answer", String(v.content ?? "").trim() || `${rule.step} refused this answer`);
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
    const v = await deps.grade({
      step: rule.step,
      ...(rule.config ? { config: rule.config } : {}),
      input: { answer: later, expected: earlier, show: t.show, type: t.type },
      ...payerOf(kind),
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
    try {
      const v = await deps.grade({
        step: rule.step,
        ...(rule.config ? { config: rule.config } : {}),
        input: { answer: t.answer, expected: test.expected, show: t.show, type: t.type },
        ...payerOf(kind),
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
    // `error` does nothing. On a type that pays on ok a test's answer earns
    // by its grade (`earnsNow`), as a real one does by its verdict, so a
    // page cannot tell them apart: a `fail` booked nothing, and a `pass` or
    // an `error` is booked now.
    if (v.result === "fail") {
      await takeBack({ task: id, worker, why: "the answer to a test was graded fail", by: GRADING_ACTOR }).catch((err) =>
        console.error(`[tasks] taking back the earning of failed test answer ${id}:`, err),
      );
    } else if (kind?.payOn === "ok" && deps.ledger) {
      const answered = (await s.tasks.leasesOf([id])).find((l) => l.worker === worker && l.status === "submitted");
      if (answered?.payMsat) await book(s, answered.id).catch((err) => console.error(`[tasks] booking lease ${answered.id}'s earning on its grade failed; the next sweep books it:`, err));
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
    // §5.7: an answered standing task whose run did not launch — its
    // launch failed, or its process died between the answer and the launch.
    let launched = 0;
    if (deps.launch) for (const t of await s.tasks.unlaunched(UNLAUNCHED_BATCH)) if (await launchStanding(s, t)) launched++;
    return { ...swept, booked, grading: ungraded.length, deciding: undecided.length, launched };
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
  /** §8.2: the worker's withdrawal — any status, a ban included (ruled) —
   *  counted against their calls; the payer's door decides the rest. */
  const withdraw = async (actor: string, o: { address?: string; msat: number }): Promise<PayoutAnswer> => {
    count(actor);
    if (!deps.payouts) throw new PayoutError("not_here", "this server's task store pays no worker");
    return deps.payouts.pay(actor, o);
  };
  return {
    grantedBy: async (by) => {
      const s = await storesIfAny();
      return s ? s.workers.grantedBy(by) : [];
    },
    retypeApp: async (from, to) => {
      const s = await storesIfAny();
      if (!s) return [];
      const types = (await s.tasks.types()).filter((t) => t.app === from);
      for (const t of types) await s.tasks.putType({ ...t, app: to });
      return types.map((t) => t.name);
    },
    capability: frozen,
    human: Object.freeze({ ensure: frozen.ensure, reply: frozen.reply }),
    worker: Object.freeze({ next: frozen.next, submit: frozen.submit, skip: frozen.skip, file: frozen.file, me: frozen.me, history: frozen.history, withdraw }),
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
    reviewGroup,
    setGroupStatus,
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

/** A group's name (`TaskRecord.group`): trimmed, 1 to `GROUP_MAX`
 *  characters on one line. */
function groupOf(v: unknown): string {
  const g = typeof v === "string" ? v.trim() : "";
  if (!g || g.length > GROUP_MAX || /[\r\n]/.test(g)) throw new TaskError("bad_request", `group is a name of 1 to ${GROUP_MAX} characters on one line`);
  return g;
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
const DAY_MS = 24 * HOUR_MS;

/** A type's pay: sats to the msat, 0 to `PAY_SATS_MAX`; 0 (or none) is unpaid. */
function payOk(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > PAY_SATS_MAX || Math.abs(v * 1000 - Math.round(v * 1000)) > 1e-6) {
    throw new TaskError("bad_request", `paySats is a number of sats from 0 to ${PAY_SATS_MAX}, to the msat (at most three decimals)`);
  }
  return v > 0 ? Math.round(v * 1000) / 1000 : undefined;
}

/** A type's title, trimmed: a string, or a map of language → string (each
 *  at most `TYPE_TITLE_MAX`); undefined for none. */
function titleOk(v: unknown): LocalText | undefined {
  if (v === undefined || v === null) return undefined;
  const one = (x: unknown): string | undefined => {
    if (typeof x !== "string") throw new TaskError("bad_request", "title is what workers call the type, in words: a string, or { en, es } texts");
    const t = x.trim().replace(/\s+/g, " ");
    if (t.length > TYPE_TITLE_MAX) throw new TaskError("bad_request", `title is at most ${TYPE_TITLE_MAX} characters`);
    return t || undefined;
  };
  if (typeof v === "object" && !Array.isArray(v)) {
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v)) {
      if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(k)) throw new TaskError("bad_request", `title's languages are codes like "en" and "es", not ${JSON.stringify(k)}`);
      const t = one(x);
      if (t) out[k] = t;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return one(v);
}

/** When a type's paid answer earns (`PAY_ON`): `answer` when left out. */
function payOnOk(v: unknown): PayOn {
  if (v === undefined || v === null) return "answer";
  if (typeof v !== "string" || !(PAY_ON as readonly string[]).includes(v)) {
    throw new TaskError("bad_request", `payOn is ${PAY_ON.map((p) => JSON.stringify(p)).join(" or ")}: an answer earns as it is answered, or only once a verdict says ok`);
  }
  return v as PayOn;
}

/** A type's hold: hours from `HOLD_HOURS_MIN` to `HOLD_HOURS_MAX` (0: none). */
function holdOk(v: unknown): number {
  if (v === undefined || v === null) return DEFAULT_HOLD_HOURS;
  if (typeof v !== "number" || !Number.isFinite(v) || v < HOLD_HOURS_MIN || v > HOLD_HOURS_MAX) {
    throw new TaskError("bad_request", `holdHours is a number of hours from ${HOLD_HOURS_MIN} to ${HOLD_HOURS_MAX}: how long earnings wait before they can be withdrawn`);
  }
  return v;
}

/** A type's limits: `budgetSats` 0 to `BUDGET_SATS_MAX` (sats to the
 *  msat), `perWorkerDay` a whole number from 1; neither: none. */
export const BUDGET_SATS_MAX = 1_000_000_000;
export const PER_WORKER_DAY_MAX = 100_000;
function limitsOk(v: unknown): LimitRule | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new TaskError("bad_request", "limits is { budgetSats?, perWorkerDay? }, or null for none");
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== "budgetSats" && k !== "perWorkerDay") throw new TaskError("bad_request", `limits has budgetSats and perWorkerDay, not ${k}`);
  const out: LimitRule = {};
  if (o["budgetSats"] !== undefined && o["budgetSats"] !== null) {
    const b = o["budgetSats"];
    if (typeof b !== "number" || !Number.isFinite(b) || b < 0 || b > BUDGET_SATS_MAX || Math.abs(b * 1000 - Math.round(b * 1000)) > 1e-6) {
      throw new TaskError("bad_request", `limits.budgetSats is sats to the msat, from 0 to ${BUDGET_SATS_MAX}: the most the type pays in all`);
    }
    out.budgetSats = b;
  }
  if (o["perWorkerDay"] !== undefined && o["perWorkerDay"] !== null) {
    const d = o["perWorkerDay"];
    if (!Number.isSafeInteger(d) || (d as number) < 1 || (d as number) > PER_WORKER_DAY_MAX) {
      throw new TaskError("bad_request", `limits.perWorkerDay is a whole number from 1 to ${PER_WORKER_DAY_MAX}: the most tasks of the type one worker takes in a UTC day`);
    }
    out.perWorkerDay = d as number;
  }
  return Object.keys(out).length ? out : undefined;
}

/** What a task asks, in words, as a worker's page draws it (strut/views'
 *  `taskAsk`): `show.ask`, else `show.title`, else a `show` that is a string;
 *  each a string or a language map; at most `ASK_CHARS`. */
const ASK_CHARS = 200;
function askOf(show: unknown): LocalText | undefined {
  const o = show && typeof show === "object" && !Array.isArray(show) ? (show as Record<string, unknown>) : undefined;
  const cut = (v: string) => (v.length > ASK_CHARS ? `${v.slice(0, ASK_CHARS - 1)}…` : v);
  const text = (v: unknown): LocalText | undefined => {
    if (typeof v === "string") return v.trim() ? cut(v.trim()) : undefined;
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v)) if (typeof x === "string" && x.trim()) out[k] = cut(x.trim());
    return Object.keys(out).length ? out : undefined;
  };
  return (typeof show === "string" ? text(show) : undefined) ?? (o ? (text(o["ask"]) ?? text(o["title"])) : undefined);
}

/** Whether type `k` is one a worker call reads: drawn by `app` when it names
 *  one, and by one of `apps` when it lists them. */
function drawnBy(k: TaskType, o: { app?: string; apps?: string[] }): boolean {
  return (o.app === undefined || k.app === o.app) && (o.apps === undefined || o.apps.includes(k.app));
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
