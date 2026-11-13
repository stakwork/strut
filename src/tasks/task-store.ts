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
 */
import type { AnswerSchema } from "./answer-schema.js";

export const TASK_STATUSES = ["open", "settled", "expired", "cancelled"] as const;
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

/** The admin's record for a kind of task (§4.2), its pay (§8.1) and its
 *  tests (§7). */
export interface TaskType {
  name: string;
  /** The app that draws it. */
  app: string;
  /** The answer's shape (§4.5), checked when the type was saved. */
  answer: AnswerSchema;
  /** How long a lease lasts. */
  leaseSeconds: number;
  /** How long a task may stay unanswered, unless its step says otherwise. */
  withinHours: number;
  enabled: boolean;
  /** What one accepted answer earns, in sats to the msat (§8.1); absent:
   *  unpaid. Stamped on a lease when it is taken. */
  paySats?: number;
  /** How long an earning waits before it can be withdrawn, in hours. */
  holdHours: number;
  /** Its test rules (§7); absent: off, and the type works as without. */
  tests?: TestRules;
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
  /** The accepted answer, and the worker who gave it. */
  answer?: unknown;
  by?: string;
  /** A test INSTANCE (§7.1): the test, and the worker it was served to.
   *  Absent on a real task. Staff's to see; never on a worker's view. */
  test?: string;
  servedTo?: string;
  /** An answered instance's grade and when (§7.4); absent while pending.
   *  What the grader said is the test routes' alone (`TestInstance.note`). */
  grade?: GradeResult;
  gradedAt?: number;
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
}

export interface TaskListQuery {
  type?: string;
  status?: TaskStatus;
  workflow?: string;
  runId?: string;
  /** True: test instances only; false: real tasks only. */
  test?: boolean;
  /** A `seq`: tasks made before it. */
  before?: number;
  limit?: number;
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
   *  how many passed. */
  graded: number;
  passed: number;
  /** Every pass and fail since the grant. */
  gradedAll: number;
  /** Answered and graded `error`, or not graded yet. */
  errors: number;
  pending: number;
  /** Real tasks of the type the worker answered since the grant. */
  real: number;
}

/** The most of a grader's `content` kept on an instance (§7.4). */
export const GRADE_NOTE_MAX = 2000;

/** §8.1: an earning waits this long by default before it can be withdrawn. */
export const DEFAULT_HOLD_HOURS = 72;

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
  /** Every lease on these tasks, oldest first. */
  leasesOf(taskIds: string[]): Promise<Lease[]>;
  lease(id: string): Promise<Lease | undefined>;
  /** The worker's live lease, if any. */
  heldBy(worker: string, now: number): Promise<Lease | undefined>;
  /** Rule 2, one guarded write: the oldest open task, not past due, of one
   *  of `types` (and enabled), that `worker` never held and nobody holds
   *  now, while `worker` holds no live lease — leased to them as `id`.
   *  Undefined when there is none. */
  take(o: { worker: string; types: string[]; id: string; now: number }): Promise<Lease | undefined>;
  /** Rules 4 and 7, one guarded write: the lease, `worker`'s, live, becomes
   *  `submitted` and its task, open and not past due, `settled` with the
   *  answer. Undefined when the guard failed: nothing was written. */
  settle(o: { lease: string; worker: string; answer: unknown; now: number }): Promise<TaskRecord | undefined>;
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
  /** Submitted leases with pay whose earning is not booked yet, oldest
   *  answer first, at most `limit`: what the sweep books. */
  unbooked(limit: number): Promise<Lease[]>;

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
const live = (l: Lease, now: number) => l.status === "open" && l.expires > now;
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
      if (q.test !== undefined && (t.test !== undefined) !== q.test) continue;
      out.push(clone(t));
      if (out.length >= limit) break;
    }
    return out;
  }

  async leasesOf(taskIds: string[]): Promise<Lease[]> {
    const ids = new Set(taskIds);
    return [...this.leases.values()].filter((l) => ids.has(l.task)).map(clone);
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
    const types = new Set(o.types);
    for (const t of this.tasks.values()) {
      if (t.test !== undefined || t.status !== "open" || t.due <= o.now || !types.has(t.type)) continue;
      if (!this.kinds.get(t.type)?.enabled) continue;
      if (leases.some((l) => l.task === t.id && (l.worker === o.worker || live(l, o.now)))) continue;
      return t;
    }
    return undefined;
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

  async settle(o: { lease: string; worker: string; answer: unknown; now: number }): Promise<TaskRecord | undefined> {
    const l = this.leases.get(o.lease);
    if (!l || l.worker !== o.worker || !live(l, o.now)) return undefined;
    const t = this.tasks.get(l.task);
    if (!t || t.status !== "open" || t.due <= o.now) return undefined;
    Object.assign(l, { status: "submitted", closed: o.now });
    Object.assign(t, { status: "settled", settledAt: o.now, answer: clone(o.answer), by: o.worker });
    return clone(t);
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
      (t) => t.status === "open" && t.test === undefined && ("id" in which ? t.id === which.id : t.workflow === which.workflow && t.runId === which.runId),
    );
    return hit.map((t) => this.close(t, "cancelled", now));
  }

  async sweep(now: number): Promise<{ leases: number; expired: TaskSettled[] }> {
    const expired = [...this.tasks.values()].filter((t) => t.status === "open" && t.test === undefined && t.due <= now).map((t) => this.close(t, "expired", now));
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
      .filter((l) => l.status === "submitted" && l.payMsat !== undefined && l.bookedAt === undefined)
      .sort((a, b) => (a.closed ?? 0) - (b.closed ?? 0))
      .slice(0, Math.max(0, limit))
      .map(clone);
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
    const open = [...this.testRows.values()].filter((x) => x.type === o.type && x.ready && x.retired === undefined && x.fromWorker !== o.worker && !served.has(x.id));
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
      test: test.id,
      servedTo: o.worker,
    };
    this.tasks.set(rec.id, rec);
    this.byKeys.set(keyOf("", rec.runId, ""), rec.id);
    test.served += 1;
    return clone(this.lease_(o.lease, rec, o.worker, o.now));
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
      const window = graded.slice(0, Math.max(0, p.window));
      const real = [...this.leases.values()].filter(
        (l) => l.worker === p.worker && l.type === p.type && l.status === "submitted" && (l.closed ?? 0) >= p.since && this.tasks.get(l.task)?.test === undefined,
      ).length;
      return {
        worker: p.worker,
        type: p.type,
        graded: window.length,
        passed: window.filter((t) => t.grade === "pass").length,
        gradedAll: graded.length,
        errors: mine.filter((t) => t.grade === "error").length,
        pending: mine.filter((t) => t.grade === undefined).length,
        real,
      };
    });
  }

  /** An open instance whose lease is no longer live closes as `expired`
   *  (§7.1): it never reopens for anyone. */
  private closeInstances(now: number): void {
    for (const t of this.tasks.values()) {
      if (t.test === undefined || t.status !== "open") continue;
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
