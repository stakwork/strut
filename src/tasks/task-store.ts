/**
 * The TASK side of the task store (plans/human-steps.md §4.2, §4.3): task
 * types, tasks, leases. Three tables in `<dataDir>/tasks/tasks.db`
 * (`task-store-sqlite.ts`) or memory (here); the worker tables are
 * `worker-store.ts`'s, and the rules that need both are the service's
 * (`tasks.ts`).
 *
 * A TASK is keyed by the workflow, run id and step path that made it, so a
 * step that runs again after a wake finds the task it made (rule 1). It is
 * `open` until an answer settles it, its `withinHours` runs out (`expired`)
 * or its run is cancelled (`cancelled`); a task being worked on is still
 * `open`, with a live lease.
 *
 * A LEASE is one worker's hold on one task until `expires`: the only way a
 * worker reaches a task (rule 3). One per task and worker, ever: a worker
 * whose lease expired or who skipped is never handed that task again. A
 * lease is LIVE while `open` and before its expiry; one past it is dead
 * even before the sweep marks it `expired`, so nothing here waits on the
 * sweep to be right.
 *
 * Every write is one step: guarded, so two calls never both win. `take`
 * (rule 2) and `settle` (rules 4, 7) are the guarded statements.
 *
 * TESTS (plans/human-steps.md §7.1–§7.5, item 4): a TEST is staff's — a
 * `show`, its files, the EXPECTED answer and how to grade it — for one task
 * type, in a `tests` table no worker call reads. What a worker is served is
 * an INSTANCE: a row in `tasks` (`workflow` and `path` empty, `run_id` its
 * own id, `test` the test, `root: "test"`, `served_to` the worker) with one
 * lease, written together by `takeTest`. From then on it is a task like any
 * other: the same lease, answer and expiry. `take` never hands one out, and
 * one whose lease is no longer live closes as `expired` (skip, release, the
 * sweep). An answered instance waits for its GRADE (`pass`, `fail`, `error`).
 *
 * COPIES (plans/human-steps.md §7.6, item 4b): a task may want several
 * answers (`copies`), each from another worker on its own lease, the
 * answer kept on the lease. `take` hands one out while its live and
 * submitted leases are fewer than `copies`. When the last answer asked for
 * is in, the task is DECIDED (`CopiesDecision`): settled with the first
 * answer of the agreeing group, one more copy asked for, or `disputed` — in
 * `settle`'s own transaction when the service hands it a decider (`equal`),
 * else later by `decide`, guarded, while no lease can be taken.
 */
import type { AnswerSchema } from "./answer-schema.js";
import type { AttachmentRule } from "./answer-files.js";
import type { RunAttachment } from "../core.js";

export const TASK_STATUSES = ["open", "settled", "expired", "cancelled", "disputed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const LEASE_STATUSES = ["open", "submitted", "expired", "skipped"] as const;
export type LeaseStatus = (typeof LEASE_STATUSES)[number];

/** How a test is graded (§7.4): `equal` (the answer equals the expected one
 *  as JSON), or a SEALED registry step answering in the claims check
 *  contract, `{ supports, content }`. */
export type GradeRule = "equal" | { step: string; config?: Record<string, unknown> };
export const GRADE_RESULTS = ["pass", "fail", "error"] as const;
export type GradeResult = (typeof GRADE_RESULTS)[number];

/** A task type's test rules (§7.2, §7.5, §7.8): on when the type has them.
 *  Saved whole, every field set (`DEFAULT_TEST_RULES` fills what staff
 *  leave out). */
export interface TestRules {
  /** The chance a real task is replaced by a test, and while a worker has
   *  answered fewer than `newTasks` real tasks of the type since the grant,
   *  `newRate` instead. */
  rate: number;
  newRate: number;
  newTasks: number;
  /** K: the tests a worker answers before any real task (0: none). A grant
   *  records it when made. */
  qualify: number;
  /** N: standing is the newest `window` graded tests since the grant, read
   *  once at least `minGraded` are graded; under `threshold` (a share
   *  passed) revokes the grant. */
  window: number;
  minGraded: number;
  threshold: number;
  /** A test's own `grade`, else this. */
  grade: GradeRule;
  /** A step grader's cost cap, dollars a grading. */
  gradeCapUsd: number;
}

/** A task type's copies rule (§7.6, §7.8): on when the type has it, saved
 *  whole (`DEFAULT_COPIES_RULE`, task-copies.ts, fills what staff leave
 *  out). Off, a step asks one worker. */
export interface CopiesRule {
  /** The most copies a step may ask for, and the most `more` may reach. */
  max: number;
  /** How many answers must match to settle; at most the copies a task wants. */
  agree: number;
  /** `equal`, or a SEALED step comparing two answers in the grader's
   *  contract (the later as `answer`, the earlier as `expected`). */
  compare: GradeRule;
  /** `more`: ask one more worker, up to `max`; `fail`: the task is disputed. */
  onDisagree: "more" | "fail";
}

/** What a copies task's answers decided (§7.6): settled with the answer at
 *  `index` (in the order given), `agrees` saying which joined it; one more
 *  copy; or disputed. */
export type CopiesDecision = { outcome: "agreed"; index: number; agrees: boolean[] } | { outcome: "more" } | { outcome: "disputed" };

/** What `settle` did with one answer. */
export interface SettleResult {
  /** The task after it: settled (one copy, or decided), disputed, or still
   *  open (answers missing, more asked for, or a decision to make outside). */
  task: TaskRecord;
  /** A copies task's answers, in the order given, once the last asked for
   *  is in. */
  answers?: Lease[];
  /** What was decided in the same transaction; absent with `answers`, the
   *  decision is the caller's to make (`decide`). */
  decision?: CopiesDecision;
}

/** §7.8's defaults, ruled. */
export const DEFAULT_TEST_RULES: Readonly<TestRules> = Object.freeze({
  rate: 0.05,
  newRate: 0.25,
  newTasks: 50,
  qualify: 10,
  window: 20,
  minGraded: 10,
  threshold: 0.8,
  grade: "equal",
  gradeCapUsd: 0.05,
});

/** A standing type's rule (§5.7): the workflow each answer launches. */
export interface StandingRule {
  workflow: string;
}

/** A ROUND type: the workflow whose run makes one task of it for each item
 *  (a `human` step of the type, in a `foreach`), started from Tasks and
 *  workers' Send a round. The twin of `StandingRule`; a type is never both. */
export interface RoundRule {
  workflow: string;
}

/** A type's CHECK (plans/human-steps.md §5.6.7, option c): a SEALED registry
 *  step in the grader's contract that `submit` runs on each answer and its
 *  files before it is accepted. A fail refuses the answer: the worker keeps
 *  the task, and nothing is saved or earned. */
export interface CheckRule {
  step: string;
  config?: Record<string, unknown>;
}

/** A type's LIMITS, checked by the server whenever it hands out a task of
 *  it (`next`): `budgetSats`, the most the type pays in all (what its
 *  answers earned, plus the pay of the leases being worked, plus the one
 *  the next take would stamp); `perWorkerDay`, the most tasks of it one
 *  worker takes in a UTC day (answered, plus the one being worked). Either
 *  absent: no such limit. */
export interface LimitRule {
  budgetSats?: number;
  perWorkerDay?: number;
}

/** What leases of one type and one worker came to since a time: tasks
 *  answered, live ones, time spent on the answered ones (taken → answered,
 *  ms), what the answered earned and what the live ones would (msat). */
export interface LeaseTotals {
  type: string;
  worker: string;
  answered: number;
  open: number;
  workMs: number;
  payMsat: number;
  openPayMsat: number;
}

/** The admin's record for a kind of task (§4.2), its pay (§8.1) and its
 *  tests (§7). */
export interface TaskType {
  name: string;
  /** What workers call it, in their own words and language (plans/i18n.md):
   *  "Revisión de recibo" for `shops/receipt-check`, whose name is ASCII.
   *  Absent: the name's last segment, words spaced. */
  title?: string;
  /** The app that draws it. */
  app: string;
  /** The answer's shape (§4.5), checked when the type was saved. */
  answer: AnswerSchema;
  /** How long a lease lasts. */
  leaseSeconds: number;
  /** How long a task may stay unanswered, unless its step says otherwise. */
  withinHours: number;
  enabled: boolean;
  /** Open to any signed-in worker who is not suspended or banned, with no
   *  grant from staff (ruling 9): their first ask records one, by
   *  `OPEN_GRANT_BY`. False: invite-only, a worker takes it only with a
   *  staff grant. A type saved before the field existed is open. */
  open: boolean;
  /** What one accepted answer earns, in sats to the msat (§8.1); absent:
   *  unpaid. Stamped on a lease when it is taken. */
  paySats?: number;
  /** How long an earning waits before it can be withdrawn, in hours. */
  holdHours: number;
  /** When an answer earns (`PAY_ON`): `"ok"`, only once a verdict says
   *  `ok` — staff's review, or the run that asked (`task/reply`'s
   *  `verdict`); a test's answer once graded `pass` or `error` — and a
   *  rejected answer earns nothing. Absent: as it is answered. */
  payOn?: "ok";
  /** Its budget and per-worker daily cap (`LimitRule`); absent: none. */
  limits?: LimitRule;
  /** Its test rules (§7); absent: off, and the type works as without. */
  tests?: TestRules;
  /** Its copies rule (§7.6); absent: off, a step asks one worker. */
  copies?: CopiesRule;
  /** The files an answer carries (§5.6); absent: none. */
  attachments?: AttachmentRule;
  /** A STANDING type (§5.7): a worker's ask makes its task, and each answer
   *  launches this workflow, whose first step is the type's `human` step.
   *  Absent: a `human` step makes its tasks. */
  standing?: StandingRule;
  /** A ROUND type: its tasks come from this workflow's runs, one for each
   *  item, and staff send a round of it (`POST /tasks/types/:name/round`).
   *  Absent: no workflow named (a `human` step anywhere makes its tasks). */
  round?: RoundRule;
  /** Its check before an answer is accepted (§5.6.7 c); absent: none, every
   *  answer that fits the schema and the files rule is accepted. */
  check?: CheckRule;
  /** Epoch ms, and who, of the last save. */
  changedAt: number;
  changedBy?: string;
}

export interface TaskRecord {
  id: string;
  /** Creation order, for paging. */
  seq: number;
  type: string;
  workflow: string;
  runId: string;
  path: string;
  /** What the worker's app is handed. */
  show: unknown;
  /** The files a worker may open, relative to `root`: the run's artifacts,
   *  `job`'s directory on a job run, or a test instance's test's own. */
  files: string[];
  root: "run" | "job" | "test";
  job?: string;
  status: TaskStatus;
  /** Epoch ms. */
  created: number;
  /** When it expires unanswered. */
  due: number;
  /** When it left `open`. */
  settledAt?: number;
  /** The accepted answer, and the worker who gave it: with copies, the
   *  first answer of the group that agreed. */
  answer?: unknown;
  by?: string;
  /** How many answers it wants (§7.6): 1, or the step's `copies`, raised
   *  by one for each `more`. */
  copies: number;
  /** A test INSTANCE (§7.1): the test, and the worker it was served to.
   *  Absent on a real task. Staff's to see; never on a worker's view. */
  test?: string;
  servedTo?: string;
  /** An answered instance's grade and when (§7.4); absent while pending.
   *  What the grader said is the test routes' alone (`TestInstance.note`). */
  grade?: GradeResult;
  gradedAt?: number;
  /** A STANDING type's task (§5.7): made by a worker's ask with their
   *  lease, closed with it, its run launched only once it is answered —
   *  `launchedAt` when it was. */
  standing?: true;
  launchedAt?: number;
  /** What the run that asked told the workers who answered, after their
   *  answer (`task/reply`): only on a settled real task, replaced whole by
   *  a later reply. */
  reply?: TaskReply;
  /** The deliverable it is part of, as the run that asked named it with
   *  `task/reply`'s `group` (a book's pages, a batch's ballots): staff read
   *  and review a group together, a worker reads theirs. */
  group?: string;
}

/** The most characters a task's `group` holds. */
export const GROUP_MAX = 200;

/** One group of tasks (`TaskRecord.group`) of one type, as it stands: its
 *  real tasks, their answers and how those were reviewed (§9.6). A worker's
 *  read counts only their own answers, on the tasks they answered. */
export interface TaskGroup {
  group: string;
  type: string;
  tasks: number;
  answers: number;
  ok: number;
  rejected: number;
  /** Answers with no verdict yet. */
  unreviewed: number;
  /** Who answered: staff's read alone. */
  workers?: string[];
  /** When its oldest task was made, and when its newest was answered. */
  first: number;
  last: number;
}

/** Which groups: of these types, and only those `worker` answered in. */
export interface TaskGroupQuery {
  types?: string[];
  worker?: string;
  limit?: number;
}

/** A run's reply to the workers who answered its task (`task/reply`): a
 *  JSON object and files of the run (under its artifacts, the shape of an
 *  answer's `attachments`), and when it was made. */
export interface TaskReply {
  show?: Record<string, unknown>;
  files?: RunAttachment[];
  at: number;
}

export interface Lease {
  /** 128 random bits. */
  id: string;
  task: string;
  worker: string;
  type: string;
  /** Epoch ms. */
  taken: number;
  expires: number;
  status: LeaseStatus;
  /** When it left `open`. */
  closed?: number;
  /** Why it was skipped or expired early. */
  reason?: string;
  /** What an answer under it earns, msat: the type's pay when it was taken
   *  (§8.1). Absent: it earns nothing. */
  payMsat?: number;
  /** When its earning was booked in the ledger: a submitted lease with pay
   *  and none is booked by the next sweep. */
  bookedAt?: number;
  /** A copies task's answer under it (§7.6), and once the task was decided
   *  whether it agreed with the answer the task settled with (false on a
   *  disputed task). A one-copy task's answer is the task's alone. */
  answer?: unknown;
  agrees?: boolean;
  /** The files its answer carried (§5.6), saved under the task's run's
   *  artifacts; absent with none, and on a test instance (dropped). */
  attachments?: RunAttachment[];
}

/** A task that left `open`: what its run's wake needs. */
export interface TaskSettled {
  id: string;
  type: string;
  workflow: string;
  runId: string;
  path: string;
  status: Exclude<TaskStatus, "open">;
}

export interface NewTask {
  id: string;
  type: string;
  workflow: string;
  runId: string;
  path: string;
  show: unknown;
  files: string[];
  job?: string;
  created: number;
  due: number;
  /** How many answers it wants; 1 when left out. */
  copies?: number;
}

export interface TaskListQuery {
  type?: string;
  status?: TaskStatus;
  workflow?: string;
  runId?: string;
  /** True: test instances only; false: real tasks only. */
  test?: boolean;
  /** Tasks this actor answered (a submitted lease of theirs: with copies,
   *  any of the answers, not only the task's `by`). */
  by?: string;
  /** §9.6: real tasks with an answer no verdict was given on (`none`), or
   *  with an answer marked `ok` or `rejected`. With `by`, that actor's
   *  answer. */
  review?: "none" | Verdict;
  /** The tasks of one group (`TaskRecord.group`). */
  group?: string;
  /** A `seq`: tasks made before it. */
  before?: number;
  limit?: number;
}

/** The windows the queue's counts are read over (plans/human-steps.md §9.4). */
export const STATS_WINDOWS = { hour: 60 * 60 * 1000, day: 24 * 60 * 60 * 1000, week: 7 * 24 * 60 * 60 * 1000 } as const;
export type StatsWindow = keyof typeof STATS_WINDOWS;
/** The newest answers a window's times are read over. */
export const STATS_SAMPLE = 1000;
/** "Due soon": open tasks due within this. */
export const DUE_SOON_MS = 24 * 60 * 60 * 1000;

/** One window of one type's real tasks (§9.4): what left `open` in it, the
 *  answers given, the leases skipped and run out, and the newest
 *  `STATS_SAMPLE` times, in ms — made to answered (`toAnswer`, a settled
 *  task's) and taken to answered (`work`, an answer's). */
export interface WindowCounts {
  answered: number;
  expired: number;
  cancelled: number;
  disputed: number;
  skipped: number;
  leasesLost: number;
  toAnswer: number[];
  work: number[];
}

/** One type's queue now, from the task side (§9.4). Test instances are
 *  not the queue: none is counted. */
export interface QueueCounts {
  type: string;
  /** Open, not past due: with no live lease, and with one. */
  waiting: number;
  working: number;
  /** When the oldest waiting task was made. */
  oldestCreated?: number;
  /** Open, not past due, due within `DUE_SOON_MS`, and within the hour. */
  dueSoon: number;
  dueHour: number;
  /** Live leases of the type, an instance's too: a worker holds one at most. */
  holding: number;
  /** §9.6: its real tasks' answers no verdict was given on, of any age:
   *  the review queue's size. */
  unreviewed: number;
  windows: Record<StatsWindow, WindowCounts>;
}

/** What one worker did of one type in a window (§9.4): answers given,
 *  leases skipped, leases that ran out. */
export interface WorkerWeek {
  answered: number;
  skipped: number;
  lost: number;
}

/** A test (§7.1): staff's, sealed — no worker call reads this. */
export interface TestRecord {
  id: string;
  type: string;
  /** What an instance shows, and the files it lists (under the test's own
   *  folder). */
  show: unknown;
  files: string[];
  /** The expected answer, checked against the type's schema when saved. */
  expected: unknown;
  /** Its own grade; absent: the type's. */
  grade?: GradeRule;
  /** The real task it was made from, and that task's worker: never served
   *  this test. */
  fromTask?: string;
  fromWorker?: string;
  /** Every listed file is there: served only then. */
  ready: boolean;
  created: number;
  createdBy?: string;
  /** Retired: never served again, kept for the grades that name it. */
  retired?: number;
  retiredBy?: string;
  /** How many instances were served. */
  served: number;
}

export type NewTest = Omit<TestRecord, "served" | "retired" | "retiredBy">;

/** A test's change before it is first served (§7.1); `grade: null` is the
 *  type's again. */
export interface TestChange {
  show?: unknown;
  expected?: unknown;
  grade?: GradeRule | null;
}

/** A test's instances graded each way. */
export interface TestCounts {
  passed: number;
  failed: number;
  errors: number;
}

/** One instance of a test, as the test routes show it. */
export interface TestInstance {
  task: string;
  lease?: string;
  worker: string;
  status: TaskStatus;
  served: number;
  answer?: unknown;
  answeredAt?: number;
  grade?: GradeResult;
  gradedAt?: number;
  /** What the grader said, cut to `GRADE_NOTE_MAX`. */
  note?: string;
}

/** A person's verdict on an answer (plans/human-steps.md §9.6). */
export const VERDICTS = ["ok", "rejected"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** When a paid answer earns (`TaskType.payOn`): `answer`, as it is answered
 *  (the default, never stored), or `ok`, once a verdict says ok. */
export const PAY_ON = ["answer", "ok"] as const;
export type PayOn = (typeof PAY_ON)[number];

/** Whether a submitted, paid answer earns now, so may be booked: never once
 *  rejected (a type that paid as answered books before it rejects, so this
 *  holds back only what a type that paid on `ok` left unbooked); on a type
 *  that pays on `ok`, once a verdict says ok, or a test's answer graded
 *  `pass` or `error` (a grader that could not run is not the worker's
 *  fault). Both stores' `unbooked` and the service's `book` read it. */
export function earnsNow(kind: Pick<TaskType, "payOn"> | undefined, verdict: Verdict | undefined, grade: GradeResult | undefined): boolean {
  if (verdict === "rejected") return false;
  if (kind?.payOn !== "ok") return true;
  return verdict === "ok" || grade === "pass" || grade === "error";
}

/** The verdict on one ANSWER: the task and the worker who gave it, so a
 *  copies task's answers are reviewed apart (§9.6, built per answer). A
 *  mark: it changes nothing in the run. */
export interface ReviewRecord {
  task: string;
  worker: string;
  verdict: Verdict;
  /** Why; a rejection always says. */
  why?: string;
  /** Who gave it, and when it was given or last changed, epoch ms. */
  by?: string;
  at: number;
}

/** One worker's tests of one type since their grant (§7.5): what standing
 *  and qualifying read. */
export interface StandingQuery {
  worker: string;
  type: string;
  /** The grant's `at`: instances answered before it count for nothing. */
  since: number;
  window: number;
}

export interface StandingRow {
  worker: string;
  type: string;
  /** Of the newest `window` graded (pass or fail) instances, how many, and
   *  how many passed. An answer to a real task rejected in review (§9.6) is
   *  among them as a fail, by when it was answered. */
  graded: number;
  passed: number;
  /** Of those `graded`, the rejected answers. */
  rejected: number;
  /** Every test's pass and fail since the grant (what qualifying counts);
   *  no rejection. */
  gradedAll: number;
  /** Answered and graded `error`, or not graded yet. */
  errors: number;
  pending: number;
  /** Real tasks of the type the worker answered since the grant. */
  real: number;
}

/** The most of a grader's `content` kept on an instance (§7.4). */
export const GRADE_NOTE_MAX = 2000;

/** §8.1: how long an earning waits by default before it can be withdrawn:
 *  none, so it is withdrawable at once. A type that wants a window for a
 *  take-back or a failed test to cost the earning sets its own. */
export const DEFAULT_HOLD_HOURS = 0;

export const TASK_LIST_PAGE = 100;
export const TASK_LIST_MAX = 1000;

export interface TaskStore {
  types(): Promise<TaskType[]>;
  type(name: string): Promise<TaskType | undefined>;
  putType(t: TaskType): Promise<TaskType>;
  /** Removes the type, in one step, unless an open task is of it
   *  (`in_use`); `missing` when there is no such type. Its tasks on file
   *  keep its name. */
  deleteType(name: string): Promise<"deleted" | "missing" | "in_use">;
  /** The task keyed by `t`'s workflow, run id and path, written from `t`
   *  when there is none (rule 1). */
  ensure(t: NewTask): Promise<{ task: TaskRecord; created: boolean }>;
  task(id: string): Promise<TaskRecord | undefined>;
  byKey(workflow: string, runId: string, path: string): Promise<TaskRecord | undefined>;
  /** Newest first, `TASK_LIST_PAGE` at a time. */
  list(q?: TaskListQuery): Promise<TaskRecord[]>;
  /** These tasks, in no order; an id not on file left out. */
  byIds(ids: string[]): Promise<TaskRecord[]>;
  /** Every lease on these tasks, oldest first. */
  leasesOf(taskIds: string[]): Promise<Lease[]>;
  /** §9.4: one worker's newest leases, by when taken, at most `limit`. */
  recentLeases(worker: string, limit: number): Promise<Lease[]>;
  /** §9.5's Workers list, one grouped read: each worker's answers since
   *  `since`, and the type of the live lease each holds now. */
  workersNow(since: number, now: number): Promise<{ answered: Record<string, number>; holding: Record<string, string> }>;
  /** §9.4: what one worker did, by type, of the leases taken since `since`:
   *  a lease past its expiry is lost before the sweep marks it. */
  workerWeek(worker: string, since: number, now: number): Promise<Record<string, WorkerWeek>>;
  /** What the leases of `types` (one worker's when given) taken since
   *  `since` came to, one row per type and worker (`LeaseTotals`); a lease
   *  is live while open and unexpired at `now`. */
  totals(q: { types: string[]; worker?: string; since: number; now: number }): Promise<LeaseTotals[]>;
  /** §9.4: each type's queue now and over `STATS_WINDOWS` back from `now`,
   *  computed on read (one type when asked). A lease past its expiry is
   *  waiting and lost, and a task past due expired at its due, before the
   *  sweep marks them. */
  stats(o: { types: string[]; now: number }): Promise<{ types: QueueCounts[]; holding: number }>;
  lease(id: string): Promise<Lease | undefined>;
  /** The worker's live lease, if any. */
  heldBy(worker: string, now: number): Promise<Lease | undefined>;
  /** Rule 2, one guarded write: the oldest open task, not past due, of one
   *  of `types` (and enabled), that `worker` never held and nobody holds
   *  now, while `worker` holds no live lease — leased to them as `id`.
   *  Undefined when there is none. */
  take(o: { worker: string; types: string[]; id: string; now: number }): Promise<Lease | undefined>;
  /** What `take` could hand `worker`, counted by type: the open tasks, not
   *  past due, of `types` (enabled) that they never held and that want
   *  another answer — whatever they hold now. A type with none is left out.
   *  The worker's dashboard (`task/me`'s `waiting`). */
  waitingFor(o: { worker: string; types: string[]; now: number }): Promise<Record<string, number>>;
  /** Rules 4 and 7, one guarded write: the lease, `worker`'s, live, becomes
   *  `submitted` and its task, open and not past due, `settled` with the
   *  answer. Undefined when the guard failed: nothing was written.
   *
   *  A copies task (§7.6) keeps the answer on the lease and stays open
   *  until the last answer asked for; that one is decided in the same
   *  transaction by `decide(answers, copies)` when it answers, and left to
   *  the caller (`decide` below) when it answers undefined or is left out. */
  settle(o: {
    lease: string;
    worker: string;
    answer: unknown;
    /** The answer's files, saved already (§5.6.3): kept on the lease. */
    attachments?: RunAttachment[];
    now: number;
    decide?: (answers: unknown[], copies: number) => CopiesDecision | undefined;
  }): Promise<SettleResult | undefined>;
  /** §7.6, one guarded write: a copies task decided outside `settle` —
   *  only while it is open, still wants `copies` answers and has them all.
   *  The task after it, or undefined when the guard failed. */
  decide(o: { task: string; copies: number; decision: CopiesDecision; now: number }): Promise<TaskRecord | undefined>;
  /** Open copies tasks with every answer asked for and no decision, oldest
   *  first, at most `limit`: what the sweep decides (a restart between the
   *  last answer and a step comparator's decision). */
  undecided(limit: number): Promise<TaskRecord[]>;
  /** The lease, `worker`'s and live, becomes `skipped`; its task stays open
   *  for someone else. False when the guard failed. */
  skip(o: { lease: string; worker: string; reason?: string; now: number }): Promise<boolean>;
  /** Every open lease of `worker` (of `types`, when given) expires now, and
   *  its task is free again. How many. */
  release(o: { worker: string; types?: string[]; reason: string; now: number }): Promise<number>;
  /** The open task (by id) or the open tasks of a run become `cancelled`,
   *  their open leases expired. */
  cancel(which: { id: string } | { workflow: string; runId: string }, now: number): Promise<TaskSettled[]>;
  /** Rule 8: open leases past their expiry become `expired`; open tasks
   *  past due become `expired`, their open leases with them. */
  sweep(now: number): Promise<{ leases: number; expired: TaskSettled[] }>;
  /** §8.1: a submitted lease's earning was booked in the ledger. Once. */
  booked(lease: string, at: number): Promise<void>;
  /** Submitted leases with pay whose earning is not booked yet and that
   *  earn now (`earnsNow`), oldest answer first, at most `limit`: what the
   *  sweep books. */
  unbooked(limit: number): Promise<Lease[]>;
  /** What `worker`'s answers on types that pay on ok wait for an ok to
   *  earn, msat: submitted, paid and not booked, neither rejected nor a
   *  test graded fail. */
  pendingPay(worker: string): Promise<number>;

  // ── tests (§7) ────────────────────────────────────────────────────────
  /** The type of the task `take` would hand `worker` now, without taking
   *  it (§7.2, step 3); undefined when there is none. */
  peek(o: { worker: string; types: string[]; now: number }): Promise<string | undefined>;
  /** §7.2's `takeTest`, one guarded write: while `worker` holds no live
   *  lease and the type is enabled, the least-served ready test of `type`
   *  that is not retired, was never served to them and was not made from a
   *  task they answered (ties: `pick(n)` chooses) — its instance written as
   *  task `task`, leased to them as `lease`, the test's `served` counted.
   *  Undefined when there is none. */
  takeTest(o: { worker: string; type: string; lease: string; task: string; now: number; pick: (n: number) => number }): Promise<Lease | undefined>;

  // ── standing types (§5.7) ─────────────────────────────────────────────
  /** One guarded write: while `worker` holds no live lease and the type is
   *  enabled and standing, a task of it made as `task` — keyed by
   *  `workflow`, `runId` and `path`, with `show`, no files, one copy, due
   *  when its lease ends — and leased to them as `lease`, the type's pay
   *  stamped. Undefined when the guard failed. It lives as long as that
   *  lease: skipped or run out, it closes `expired` (never heard by
   *  `onSettle`: no run waits on it). */
  takeStanding(o: { worker: string; type: string; lease: string; task: string; workflow: string; runId: string; path: string; show: unknown; now: number }): Promise<Lease | undefined>;
  /** A settled standing task's run was launched. Once. */
  launched(task: string, at: number): Promise<void>;
  /** Settled standing tasks whose run is not launched yet, oldest answer
   *  first, at most `limit`: what the sweep launches. */
  unlaunched(limit: number): Promise<TaskRecord[]>;

  /** A run's reply on its task (`task/reply`), replacing any before, and
   *  the group it names (kept when none is given): only while it is settled
   *  and a real task, never a test instance. False when the guard failed. */
  reply(task: string, o: { reply?: TaskReply; group?: string }): Promise<boolean>;
  /** The groups of tasks (`TaskRecord.group`), the one with the newest task
   *  first, `TASK_LIST_PAGE` at a time. Never a test instance. */
  groups(q?: TaskGroupQuery): Promise<TaskGroup[]>;

  putTest(t: NewTest): Promise<TestRecord>;
  test(id: string): Promise<TestRecord | undefined>;
  /** Oldest first; of one type, retired or not, when asked. */
  tests(q?: { type?: string; retired?: boolean }): Promise<TestRecord[]>;
  /** Only before it was first served and while not retired. */
  editTest(id: string, change: TestChange): Promise<"edited" | "missing" | "in_use">;
  /** Marks it ready; true when it was not. */
  readyTest(id: string): Promise<boolean>;
  retireTest(id: string, by: string | undefined, at: number): Promise<TestRecord | undefined>;
  /** Every live test of `type` retired: how many. */
  retireTestsOf(type: string, by: string | undefined, at: number): Promise<number>;
  /** Ready tests of `type` not retired. */
  readyTests(type: string): Promise<number>;
  testCounts(ids: string[]): Promise<Record<string, TestCounts>>;
  /** Newest first. */
  testInstances(id: string): Promise<TestInstance[]>;
  /** An answered instance's grade, once: false when it had one, or is not
   *  an answered instance. */
  grade(o: { task: string; grade: GradeResult; note: string; at: number }): Promise<boolean>;
  /** Answered instances with no grade yet, oldest answer first. */
  ungraded(limit: number): Promise<TaskRecord[]>;
  standings(q: StandingQuery[]): Promise<StandingRow[]>;
  /** §9.6: the verdict on one answer (its task and worker), written or
   *  replaced whole. */
  putReview(r: ReviewRecord): Promise<ReviewRecord>;
  /** §9.6: the verdicts on these tasks' answers. */
  reviewsOf(taskIds: string[]): Promise<ReviewRecord[]>;
}

/** A copies task's answers, in the order given: its submitted leases by when
 *  they were answered. */
export function answersOf(leases: Lease[]): Lease[] {
  return leases.filter((l) => l.status === "submitted").sort((a, b) => (a.closed ?? 0) - (b.closed ?? 0) || a.taken - b.taken);
}

export function settledOf(t: TaskRecord): TaskSettled {
  return { id: t.id, type: t.type, workflow: t.workflow, runId: t.runId, path: t.path, status: t.status as TaskSettled["status"] };
}

/** A type's pay as a lease stamps it: whole msat, or undefined when unpaid. */
export function payMsatOf(t: Pick<TaskType, "paySats"> | undefined): number | undefined {
  const msat = t?.paySats ? Math.round(t.paySats * 1000) : 0;
  return msat > 0 ? msat : undefined;
}

export function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return TASK_LIST_PAGE;
  return Math.max(1, Math.min(TASK_LIST_MAX, Math.floor(limit)));
}

// ── memory ────────────────────────────────────────────────────────────────

const keyOf = (workflow: string, runId: string, path: string) => `${workflow}\0${runId}\0${path}`;
const reviewKey = (task: string, worker: string) => `${task}\0${worker}`;
const live = (l: Lease, now: number) => l.status === "open" && l.expires > now;
/** A lease that ran out (§9.4): swept as `expired` with no reason (one closed
 *  early has one), or open past its expiry before the sweep. */
const ranOut = (l: Lease, now: number) => (l.status === "expired" && l.reason === undefined) || (l.status === "open" && l.expires <= now);
const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

export class MemoryTaskStore implements TaskStore {
  private readonly kinds = new Map<string, TaskType>();
  /** In creation order. */
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly byKeys = new Map<string, string>();
  private readonly leases = new Map<string, Lease>();
  /** In creation order. */
  private readonly testRows = new Map<string, TestRecord>();
  /** What each instance's grader said. */
  private readonly notes = new Map<string, string>();
  /** The verdicts (§9.6), by task and worker. */
  private readonly reviewRows = new Map<string, ReviewRecord>();
  private seq = 0;

  async types(): Promise<TaskType[]> {
    return [...this.kinds.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(clone);
  }

  async type(name: string): Promise<TaskType | undefined> {
    return clone(this.kinds.get(name));
  }

  async putType(t: TaskType): Promise<TaskType> {
    this.kinds.set(t.name, clone(t));
    return clone(t);
  }

  async deleteType(name: string): Promise<"deleted" | "missing" | "in_use"> {
    if (!this.kinds.has(name)) return "missing";
    for (const t of this.tasks.values()) if (t.type === name && t.status === "open") return "in_use";
    this.kinds.delete(name);
    return "deleted";
  }

  async ensure(t: NewTask): Promise<{ task: TaskRecord; created: boolean }> {
    const key = keyOf(t.workflow, t.runId, t.path);
    const known = this.byKeys.get(key);
    if (known) return { task: clone(this.tasks.get(known)!), created: false };
    const rec: TaskRecord = {
      id: t.id,
      seq: ++this.seq,
      type: t.type,
      workflow: t.workflow,
      runId: t.runId,
      path: t.path,
      show: clone(t.show),
      files: [...t.files],
      root: t.job === undefined ? "run" : "job",
      ...(t.job === undefined ? {} : { job: t.job }),
      status: "open",
      created: t.created,
      due: t.due,
      copies: t.copies ?? 1,
    };
    this.tasks.set(rec.id, rec);
    this.byKeys.set(key, rec.id);
    return { task: clone(rec), created: true };
  }

  async task(id: string): Promise<TaskRecord | undefined> {
    return clone(this.tasks.get(id));
  }

  async byKey(workflow: string, runId: string, path: string): Promise<TaskRecord | undefined> {
    const id = this.byKeys.get(keyOf(workflow, runId, path));
    return id === undefined ? undefined : clone(this.tasks.get(id));
  }

  async list(q: TaskListQuery = {}): Promise<TaskRecord[]> {
    const limit = pageLimit(q.limit);
    const out: TaskRecord[] = [];
    for (const t of [...this.tasks.values()].reverse()) {
      if (q.before !== undefined && t.seq >= q.before) continue;
      if (q.type && t.type !== q.type) continue;
      if (q.status && t.status !== q.status) continue;
      if (q.workflow && t.workflow !== q.workflow) continue;
      if (q.runId && t.runId !== q.runId) continue;
      if (q.group && t.group !== q.group) continue;
      if (q.test !== undefined && (t.test !== undefined) !== q.test) continue;
      if (q.by && ![...this.leases.values()].some((l) => l.task === t.id && l.worker === q.by && l.status === "submitted")) continue;
      if (q.review !== undefined) {
        const answers = [...this.leases.values()].filter((l) => l.task === t.id && l.status === "submitted" && (!q.by || l.worker === q.by));
        const verdicts = answers.map((l) => this.reviewRows.get(reviewKey(l.task, l.worker))?.verdict ?? "none");
        if (t.test !== undefined || !verdicts.includes(q.review)) continue;
      }
      out.push(clone(t));
      if (out.length >= limit) break;
    }
    return out;
  }

  async byIds(ids: string[]): Promise<TaskRecord[]> {
    return ids.flatMap((id) => (this.tasks.has(id) ? [clone(this.tasks.get(id)!)] : []));
  }

  async leasesOf(taskIds: string[]): Promise<Lease[]> {
    const ids = new Set(taskIds);
    return [...this.leases.values()].filter((l) => ids.has(l.task)).map(clone);
  }

  async recentLeases(worker: string, limit: number): Promise<Lease[]> {
    return [...this.leases.values()]
      .filter((l) => l.worker === worker)
      .reverse()
      .sort((a, b) => b.taken - a.taken)
      .slice(0, Math.max(0, limit))
      .map(clone);
  }

  async workersNow(since: number, now: number): Promise<{ answered: Record<string, number>; holding: Record<string, string> }> {
    const answered: Record<string, number> = {};
    const holding: Record<string, string> = {};
    for (const l of this.leases.values()) {
      if (l.status === "submitted" && (l.closed ?? 0) >= since) answered[l.worker] = (answered[l.worker] ?? 0) + 1;
      if (live(l, now)) holding[l.worker] = l.type;
    }
    return { answered, holding };
  }

  async totals(q: { types: string[]; worker?: string; since: number; now: number }): Promise<LeaseTotals[]> {
    const types = new Set(q.types);
    const rows = new Map<string, LeaseTotals>();
    for (const l of this.leases.values()) {
      if (!types.has(l.type) || l.taken < q.since || (q.worker !== undefined && l.worker !== q.worker)) continue;
      const key = `${l.type}\u0000${l.worker}`;
      let r = rows.get(key);
      if (!r) rows.set(key, (r = { type: l.type, worker: l.worker, answered: 0, open: 0, workMs: 0, payMsat: 0, openPayMsat: 0 }));
      if (l.status === "submitted") {
        r.answered++;
        r.workMs += Math.max(0, (l.closed ?? l.taken) - l.taken);
        r.payMsat += l.payMsat ?? 0;
      } else if (l.status === "open" && l.expires > q.now) {
        r.open++;
        r.openPayMsat += l.payMsat ?? 0;
      }
    }
    return [...rows.values()];
  }

  async workerWeek(worker: string, since: number, now: number): Promise<Record<string, WorkerWeek>> {
    const out: Record<string, WorkerWeek> = {};
    for (const l of this.leases.values()) {
      if (l.worker !== worker || l.taken < since) continue;
      const w = (out[l.type] ??= { answered: 0, skipped: 0, lost: 0 });
      if (l.status === "submitted") w.answered++;
      else if (l.status === "skipped") w.skipped++;
      else if (ranOut(l, now)) w.lost++;
    }
    return out;
  }

  async stats(o: { types: string[]; now: number }): Promise<{ types: QueueCounts[]; holding: number }> {
    const leases = [...this.leases.values()];
    const holding = leases.filter((l) => live(l, o.now)).length;
    const types = o.types.map((type): QueueCounts => {
      const real = [...this.tasks.values()].filter((t) => t.type === type && t.test === undefined);
      // A standing task (§5.7) ends with its lease: counted as a skipped or
      // lost lease, never an expired task.
      const runMade = real.filter((t) => !t.standing);
      const ids = new Set(real.map((t) => t.id));
      const mine = leases.filter((l) => l.type === type);
      const held = new Set(mine.filter((l) => live(l, o.now)).map((l) => l.task));
      const open = real.filter((t) => t.status === "open" && t.due > o.now);
      const waiting = open.filter((t) => !held.has(t.id));
      const answers = mine.filter((l) => ids.has(l.task));
      const windows = {} as Record<StatsWindow, WindowCounts>;
      for (const [w, ms] of Object.entries(STATS_WINDOWS) as Array<[StatsWindow, number]>) {
        const from = o.now - ms;
        const left = (status: TaskStatus) => real.filter((t) => t.status === status && (t.settledAt ?? 0) >= from).length;
        const given = answers.filter((l) => l.status === "submitted" && (l.closed ?? 0) >= from).sort((a, b) => b.closed! - a.closed!);
        windows[w] = {
          answered: given.length,
          // A task past due counts as expired at its due before the sweep marks it.
          expired: runMade.filter((t) => t.status === "expired" && (t.settledAt ?? 0) >= from).length + runMade.filter((t) => t.status === "open" && t.due <= o.now && t.due >= from).length,
          cancelled: left("cancelled"),
          disputed: left("disputed"),
          skipped: answers.filter((l) => l.status === "skipped" && (l.closed ?? 0) >= from).length,
          leasesLost: answers.filter((l) => ranOut(l, o.now) && (l.closed ?? l.expires) >= from).length,
          toAnswer: real
            .filter((t) => t.status === "settled" && (t.settledAt ?? 0) >= from)
            .sort((a, b) => b.settledAt! - a.settledAt!)
            .slice(0, STATS_SAMPLE)
            .map((t) => t.settledAt! - t.created),
          work: given.slice(0, STATS_SAMPLE).map((l) => l.closed! - l.taken),
        };
      }
      const oldest = waiting.reduce<number | undefined>((m, t) => (m === undefined || t.created < m ? t.created : m), undefined);
      return {
        type,
        waiting: waiting.length,
        working: open.length - waiting.length,
        ...(oldest !== undefined ? { oldestCreated: oldest } : {}),
        dueSoon: open.filter((t) => t.due <= o.now + DUE_SOON_MS).length,
        dueHour: open.filter((t) => t.due <= o.now + STATS_WINDOWS.hour).length,
        holding: mine.filter((l) => live(l, o.now)).length,
        unreviewed: answers.filter((l) => l.status === "submitted" && !this.reviewRows.has(reviewKey(l.task, l.worker))).length,
        windows,
      };
    });
    return { types, holding };
  }

  async lease(id: string): Promise<Lease | undefined> {
    return clone(this.leases.get(id));
  }

  async heldBy(worker: string, now: number): Promise<Lease | undefined> {
    for (const l of this.leases.values()) if (l.worker === worker && live(l, now)) return clone(l);
    return undefined;
  }

  /** Rule 2's guard: the oldest task `worker` may take now, never an instance. */
  private takeable(o: { worker: string; types: string[]; now: number }): TaskRecord | undefined {
    const leases = [...this.leases.values()];
    if (leases.some((l) => l.worker === o.worker && live(l, o.now))) return undefined;
    return this.open_(o, leases).next().value ?? undefined;
  }

  /** The tasks `take` could hand `worker` were they holding nothing, oldest first. */
  private *open_(o: { worker: string; types: string[]; now: number }, leases: Lease[]): Generator<TaskRecord> {
    const types = new Set(o.types);
    for (const t of this.tasks.values()) {
      if (t.test !== undefined || t.standing || t.status !== "open" || t.due <= o.now || !types.has(t.type)) continue;
      if (!this.kinds.get(t.type)?.enabled) continue;
      const mine = leases.filter((l) => l.task === t.id);
      if (mine.some((l) => l.worker === o.worker)) continue;
      // Fewer live and submitted leases than the answers it wants (§7.6).
      if (mine.filter((l) => l.status === "submitted" || live(l, o.now)).length >= t.copies) continue;
      yield t;
    }
  }

  async waitingFor(o: { worker: string; types: string[]; now: number }): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of this.open_(o, [...this.leases.values()])) out[t.type] = (out[t.type] ?? 0) + 1;
    return out;
  }

  async take(o: { worker: string; types: string[]; id: string; now: number }): Promise<Lease | undefined> {
    const t = this.takeable(o);
    return t ? clone(this.lease_(o.id, t, o.worker, o.now)) : undefined;
  }

  /** A lease on `t` for `worker`, the type's pay stamped (§8.1). */
  private lease_(id: string, t: TaskRecord, worker: string, now: number): Lease {
    const kind = this.kinds.get(t.type)!;
    const pay = payMsatOf(kind);
    const lease: Lease = {
      id,
      task: t.id,
      worker,
      type: t.type,
      taken: now,
      expires: now + kind.leaseSeconds * 1000,
      status: "open",
      ...(pay ? { payMsat: pay } : {}),
    };
    this.leases.set(lease.id, lease);
    return lease;
  }

  async settle(o: Parameters<TaskStore["settle"]>[0]): Promise<SettleResult | undefined> {
    const l = this.leases.get(o.lease);
    if (!l || l.worker !== o.worker || !live(l, o.now)) return undefined;
    const t = this.tasks.get(l.task);
    if (!t || t.status !== "open" || t.due <= o.now) return undefined;
    if (o.attachments?.length) l.attachments = clone(o.attachments);
    if (t.copies <= 1) {
      Object.assign(l, { status: "submitted", closed: o.now });
      Object.assign(t, { status: "settled", settledAt: o.now, answer: clone(o.answer), by: o.worker });
      return { task: clone(t) };
    }
    // A copies task: the answer stays on its lease until the last is in.
    Object.assign(l, { status: "submitted", closed: o.now, answer: clone(o.answer) });
    const answers = answersOf([...this.leases.values()].filter((x) => x.task === t.id));
    if (answers.length < t.copies) return { task: clone(t) };
    const decision = o.decide?.(answers.map((x) => clone(x.answer)), t.copies);
    if (!decision) return { task: clone(t), answers: answers.map(clone) };
    this.apply(t, answers, decision, o.now);
    return { task: clone(t), answers: answers.map(clone), decision };
  }

  async decide(o: { task: string; copies: number; decision: CopiesDecision; now: number }): Promise<TaskRecord | undefined> {
    const t = this.tasks.get(o.task);
    if (!t || t.status !== "open" || t.copies !== o.copies || t.test !== undefined) return undefined;
    const answers = answersOf([...this.leases.values()].filter((x) => x.task === t.id));
    if (answers.length !== t.copies) return undefined;
    this.apply(t, answers, o.decision, o.now);
    return clone(t);
  }

  async undecided(limit: number): Promise<TaskRecord[]> {
    const out: TaskRecord[] = [];
    for (const t of this.tasks.values()) {
      if (out.length >= limit) break;
      if (t.status !== "open" || t.copies <= 1 || t.test !== undefined) continue;
      if ([...this.leases.values()].filter((l) => l.task === t.id && l.status === "submitted").length >= t.copies) out.push(clone(t));
    }
    return out;
  }

  /** A copies task's decision written (§7.6). */
  private apply(t: TaskRecord, answers: Lease[], d: CopiesDecision, now: number): void {
    if (d.outcome === "more") {
      t.copies += 1;
      return;
    }
    if (d.outcome === "agreed") {
      const won = answers[d.index]!;
      Object.assign(t, { status: "settled", settledAt: now, answer: clone(won.answer), by: won.worker });
    } else Object.assign(t, { status: "disputed", settledAt: now });
    answers.forEach((a, i) => {
      this.leases.get(a.id)!.agrees = d.outcome === "agreed" && d.agrees[i] === true;
    });
  }

  async skip(o: { lease: string; worker: string; reason?: string; now: number }): Promise<boolean> {
    const l = this.leases.get(o.lease);
    if (!l || l.worker !== o.worker || !live(l, o.now)) return false;
    Object.assign(l, { status: "skipped", closed: o.now, ...(o.reason === undefined ? {} : { reason: o.reason }) });
    this.closeInstances(o.now);
    return true;
  }

  async release(o: { worker: string; types?: string[]; reason: string; now: number }): Promise<number> {
    let n = 0;
    for (const l of this.leases.values()) {
      if (l.worker !== o.worker || l.status !== "open" || (o.types && !o.types.includes(l.type))) continue;
      Object.assign(l, { status: "expired", closed: o.now, reason: o.reason });
      n++;
    }
    this.closeInstances(o.now);
    return n;
  }

  async cancel(which: { id: string } | { workflow: string; runId: string }, now: number): Promise<TaskSettled[]> {
    const hit = [...this.tasks.values()].filter(
      (t) => t.status === "open" && t.test === undefined && !t.standing && ("id" in which ? t.id === which.id : t.workflow === which.workflow && t.runId === which.runId),
    );
    return hit.map((t) => this.close(t, "cancelled", now));
  }

  async sweep(now: number): Promise<{ leases: number; expired: TaskSettled[] }> {
    const expired = [...this.tasks.values()].filter((t) => t.status === "open" && t.test === undefined && !t.standing && t.due <= now).map((t) => this.close(t, "expired", now));
    let leases = 0;
    for (const l of this.leases.values()) {
      if (l.status === "open" && l.expires <= now) {
        Object.assign(l, { status: "expired", closed: now });
        leases++;
      }
    }
    this.closeInstances(now);
    return { leases, expired };
  }

  async booked(lease: string, at: number): Promise<void> {
    const l = this.leases.get(lease);
    if (l && l.bookedAt === undefined) l.bookedAt = at;
  }

  async unbooked(limit: number): Promise<Lease[]> {
    return [...this.leases.values()]
      .filter(
        (l) =>
          l.status === "submitted" &&
          l.payMsat !== undefined &&
          l.bookedAt === undefined &&
          earnsNow(this.kinds.get(l.type), this.reviewRows.get(reviewKey(l.task, l.worker))?.verdict, this.tasks.get(l.task)?.grade),
      )
      .sort((a, b) => (a.closed ?? 0) - (b.closed ?? 0))
      .slice(0, Math.max(0, limit))
      .map(clone);
  }

  async pendingPay(worker: string): Promise<number> {
    let msat = 0;
    for (const l of this.leases.values()) {
      if (l.worker !== worker || l.status !== "submitted" || l.payMsat === undefined || l.bookedAt !== undefined) continue;
      if (this.kinds.get(l.type)?.payOn !== "ok") continue;
      if (this.reviewRows.get(reviewKey(l.task, l.worker))?.verdict === "rejected" || this.tasks.get(l.task)?.grade === "fail") continue;
      msat += l.payMsat;
    }
    return msat;
  }

  // ── tests ───────────────────────────────────────────────────────────

  async peek(o: { worker: string; types: string[]; now: number }): Promise<string | undefined> {
    return this.takeable(o)?.type;
  }

  async takeTest(o: { worker: string; type: string; lease: string; task: string; now: number; pick: (n: number) => number }): Promise<Lease | undefined> {
    if ([...this.leases.values()].some((l) => l.worker === o.worker && live(l, o.now))) return undefined;
    const kind = this.kinds.get(o.type);
    if (!kind?.enabled) return undefined;
    const served = new Set([...this.tasks.values()].filter((t) => t.servedTo === o.worker && t.test !== undefined).map((t) => t.test));
    // Never one made from a task this worker answered: with copies, any of
    // its answers (§7.6).
    const answered = new Set([...this.leases.values()].filter((l) => l.worker === o.worker && l.status === "submitted").map((l) => l.task));
    const open = [...this.testRows.values()].filter(
      (x) => x.type === o.type && x.ready && x.retired === undefined && x.fromWorker !== o.worker && !(x.fromTask !== undefined && answered.has(x.fromTask)) && !served.has(x.id),
    );
    if (!open.length) return undefined;
    const least = Math.min(...open.map((x) => x.served));
    const ties = open.filter((x) => x.served === least);
    const test = ties[pickIn(o.pick, ties.length)]!;
    const expires = o.now + kind.leaseSeconds * 1000;
    const rec: TaskRecord = {
      id: o.task,
      seq: ++this.seq,
      type: o.type,
      workflow: "",
      runId: o.task,
      path: "",
      show: clone(test.show),
      files: [...test.files],
      root: "test",
      status: "open",
      created: o.now,
      // An instance lives as long as its one lease.
      due: expires,
      copies: 1,
      test: test.id,
      servedTo: o.worker,
    };
    this.tasks.set(rec.id, rec);
    this.byKeys.set(keyOf("", rec.runId, ""), rec.id);
    test.served += 1;
    return clone(this.lease_(o.lease, rec, o.worker, o.now));
  }

  // ── standing types (§5.7) ─────────────────────────────────────────────

  async takeStanding(o: Parameters<TaskStore["takeStanding"]>[0]): Promise<Lease | undefined> {
    if ([...this.leases.values()].some((l) => l.worker === o.worker && live(l, o.now))) return undefined;
    const kind = this.kinds.get(o.type);
    if (!kind?.enabled || !kind.standing) return undefined;
    const key = keyOf(o.workflow, o.runId, o.path);
    if (this.byKeys.has(key)) return undefined;
    const rec: TaskRecord = {
      id: o.task,
      seq: ++this.seq,
      type: o.type,
      workflow: o.workflow,
      runId: o.runId,
      path: o.path,
      show: clone(o.show),
      files: [],
      root: "run",
      status: "open",
      created: o.now,
      // It lives as long as its one lease.
      due: o.now + kind.leaseSeconds * 1000,
      copies: 1,
      standing: true,
    };
    this.tasks.set(rec.id, rec);
    this.byKeys.set(key, rec.id);
    return clone(this.lease_(o.lease, rec, o.worker, o.now));
  }

  async launched(task: string, at: number): Promise<void> {
    const t = this.tasks.get(task);
    if (t?.standing && t.launchedAt === undefined) t.launchedAt = at;
  }

  async unlaunched(limit: number): Promise<TaskRecord[]> {
    return [...this.tasks.values()]
      .filter((t) => t.standing && t.status === "settled" && t.launchedAt === undefined)
      .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0))
      .slice(0, Math.max(0, limit))
      .map(clone);
  }

  async reply(task: string, o: { reply?: TaskReply; group?: string }): Promise<boolean> {
    const t = this.tasks.get(task);
    if (!t || t.status !== "settled" || t.test !== undefined) return false;
    if (o.reply) t.reply = clone(o.reply);
    if (o.group !== undefined) t.group = o.group;
    return true;
  }

  async groups(q: TaskGroupQuery = {}): Promise<TaskGroup[]> {
    const types = q.types ? new Set(q.types) : undefined;
    const rows = new Map<string, TaskGroup & { seq: number; who: Set<string> }>();
    for (const t of this.tasks.values()) {
      if (t.group === undefined || t.test !== undefined || (types && !types.has(t.type))) continue;
      const answers = [...this.leases.values()].filter((l) => l.task === t.id && l.status === "submitted" && (!q.worker || l.worker === q.worker));
      if (q.worker && !answers.length) continue;
      const key = `${t.type}\0${t.group}`;
      let g = rows.get(key);
      if (!g) rows.set(key, (g = { group: t.group, type: t.type, tasks: 0, answers: 0, ok: 0, rejected: 0, unreviewed: 0, first: t.created, last: 0, seq: t.seq, who: new Set() }));
      g.tasks++;
      g.first = Math.min(g.first, t.created);
      g.last = Math.max(g.last, t.settledAt ?? t.created);
      g.seq = Math.max(g.seq, t.seq);
      for (const l of answers) {
        g.answers++;
        g.who.add(l.worker);
        const v = this.reviewRows.get(reviewKey(l.task, l.worker))?.verdict;
        if (v === "ok") g.ok++;
        else if (v === "rejected") g.rejected++;
        else g.unreviewed++;
      }
    }
    return [...rows.values()]
      .sort((a, b) => b.seq - a.seq)
      .slice(0, pageLimit(q.limit))
      .map(({ seq: _seq, who, ...g }) => ({ ...g, workers: [...who] }));
  }

  async putTest(t: NewTest): Promise<TestRecord> {
    const rec: TestRecord = { ...clone(t), served: 0 };
    this.testRows.set(rec.id, rec);
    return clone(rec);
  }

  async test(id: string): Promise<TestRecord | undefined> {
    return clone(this.testRows.get(id));
  }

  async tests(q: { type?: string; retired?: boolean } = {}): Promise<TestRecord[]> {
    return [...this.testRows.values()].filter((x) => (!q.type || x.type === q.type) && (q.retired === undefined || (x.retired !== undefined) === q.retired)).map(clone);
  }

  async editTest(id: string, change: TestChange): Promise<"edited" | "missing" | "in_use"> {
    const x = this.testRows.get(id);
    if (!x) return "missing";
    if (x.served > 0 || x.retired !== undefined) return "in_use";
    if (change.show !== undefined) x.show = clone(change.show);
    if (change.expected !== undefined) x.expected = clone(change.expected);
    if (change.grade === null) delete x.grade;
    else if (change.grade !== undefined) x.grade = clone(change.grade);
    return "edited";
  }

  async readyTest(id: string): Promise<boolean> {
    const x = this.testRows.get(id);
    if (!x || x.ready) return false;
    x.ready = true;
    return true;
  }

  async retireTest(id: string, by: string | undefined, at: number): Promise<TestRecord | undefined> {
    const x = this.testRows.get(id);
    if (!x) return undefined;
    if (x.retired === undefined) Object.assign(x, { retired: at, ...(by === undefined ? {} : { retiredBy: by }) });
    return clone(x);
  }

  async retireTestsOf(type: string, by: string | undefined, at: number): Promise<number> {
    let n = 0;
    for (const x of this.testRows.values()) {
      if (x.type !== type || x.retired !== undefined) continue;
      Object.assign(x, { retired: at, ...(by === undefined ? {} : { retiredBy: by }) });
      n++;
    }
    return n;
  }

  async readyTests(type: string): Promise<number> {
    return [...this.testRows.values()].filter((x) => x.type === type && x.ready && x.retired === undefined).length;
  }

  async testCounts(ids: string[]): Promise<Record<string, TestCounts>> {
    const out: Record<string, TestCounts> = {};
    for (const id of ids) out[id] = { passed: 0, failed: 0, errors: 0 };
    for (const t of this.tasks.values()) {
      const c = t.test !== undefined ? out[t.test] : undefined;
      if (!c || !t.grade) continue;
      if (t.grade === "pass") c.passed++;
      else if (t.grade === "fail") c.failed++;
      else c.errors++;
    }
    return out;
  }

  async testInstances(id: string): Promise<TestInstance[]> {
    const out: TestInstance[] = [];
    for (const t of [...this.tasks.values()].reverse()) {
      if (t.test !== id) continue;
      const l = [...this.leases.values()].find((x) => x.task === t.id && x.worker === t.servedTo);
      const note = this.notes.get(t.id);
      out.push({
        task: t.id,
        ...(l ? { lease: l.id } : {}),
        worker: t.servedTo!,
        status: t.status,
        served: t.created,
        ...(t.status === "settled" ? { answer: clone(t.answer), answeredAt: t.settledAt! } : {}),
        ...(t.grade ? { grade: t.grade, gradedAt: t.gradedAt! } : {}),
        ...(note !== undefined ? { note } : {}),
      });
    }
    return out;
  }

  async grade(o: { task: string; grade: GradeResult; note: string; at: number }): Promise<boolean> {
    const t = this.tasks.get(o.task);
    if (!t || t.test === undefined || t.status !== "settled" || t.grade !== undefined) return false;
    Object.assign(t, { grade: o.grade, gradedAt: o.at });
    this.notes.set(t.id, o.note.slice(0, GRADE_NOTE_MAX));
    return true;
  }

  async ungraded(limit: number): Promise<TaskRecord[]> {
    return [...this.tasks.values()]
      .filter((t) => t.test !== undefined && t.status === "settled" && t.grade === undefined)
      .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0))
      .slice(0, Math.max(0, limit))
      .map(clone);
  }

  async standings(q: StandingQuery[]): Promise<StandingRow[]> {
    return q.map((p) => {
      const mine = [...this.tasks.values()]
        .filter((t) => t.test !== undefined && t.servedTo === p.worker && t.type === p.type && t.status === "settled" && t.settledAt! >= p.since)
        .sort((a, b) => b.settledAt! - a.settledAt! || b.seq - a.seq);
      const graded = mine.filter((t) => t.grade === "pass" || t.grade === "fail");
      // §9.6: an answer to a real task rejected in review counts as a fail,
      // by when it was answered.
      const rejected = [...this.reviewRows.values()].flatMap((r) => {
        if (r.verdict !== "rejected" || r.worker !== p.worker) return [];
        const l = [...this.leases.values()].find((x) => x.task === r.task && x.worker === r.worker && x.status === "submitted");
        const t = this.tasks.get(r.task);
        return l && t && t.test === undefined && l.type === p.type && (l.closed ?? 0) >= p.since ? [{ at: l.closed!, seq: t.seq, grade: "fail" as const, review: true }] : [];
      });
      const window = [...graded.map((t) => ({ at: t.settledAt!, seq: t.seq, grade: t.grade, review: false })), ...rejected]
        .sort((a, b) => b.at - a.at || b.seq - a.seq)
        .slice(0, Math.max(0, p.window));
      const real = [...this.leases.values()].filter(
        (l) => l.worker === p.worker && l.type === p.type && l.status === "submitted" && (l.closed ?? 0) >= p.since && this.tasks.get(l.task)?.test === undefined,
      ).length;
      return {
        worker: p.worker,
        type: p.type,
        graded: window.length,
        passed: window.filter((t) => t.grade === "pass").length,
        rejected: window.filter((t) => t.review).length,
        gradedAll: graded.length,
        errors: mine.filter((t) => t.grade === "error").length,
        pending: mine.filter((t) => t.grade === undefined).length,
        real,
      };
    });
  }

  async putReview(r: ReviewRecord): Promise<ReviewRecord> {
    const row = clone(r);
    this.reviewRows.set(reviewKey(r.task, r.worker), row);
    return clone(row);
  }

  async reviewsOf(taskIds: string[]): Promise<ReviewRecord[]> {
    const ids = new Set(taskIds);
    return [...this.reviewRows.values()].filter((r) => ids.has(r.task)).map(clone);
  }

  /** An open instance (§7.1) or standing task (§5.7) whose lease is no
   *  longer live closes as `expired`: it never reopens for anyone. */
  private closeInstances(now: number): void {
    for (const t of this.tasks.values()) {
      if ((t.test === undefined && !t.standing) || t.status !== "open") continue;
      if ([...this.leases.values()].some((l) => l.task === t.id && live(l, now))) continue;
      Object.assign(t, { status: "expired", settledAt: now });
      for (const l of this.leases.values()) if (l.task === t.id && l.status === "open") Object.assign(l, { status: "expired", closed: now, reason: "task expired" });
    }
  }

  private close(t: TaskRecord, status: "expired" | "cancelled", now: number): TaskSettled {
    Object.assign(t, { status, settledAt: now });
    for (const l of this.leases.values()) {
      if (l.task === t.id && l.status === "open") Object.assign(l, { status: "expired", closed: now, reason: `task ${status}` });
    }
    return settledOf(t);
  }
}

/** `pick(n)` held to an index of `n`. */
export function pickIn(pick: (n: number) => number, n: number): number {
  const i = Math.floor(pick(n));
  return Number.isFinite(i) && i >= 0 && i < n ? i : 0;
}
