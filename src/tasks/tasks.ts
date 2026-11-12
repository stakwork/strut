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
 * Nothing is made until something is asked of it: no file on a strut that
 * never runs a `human` step, and a staff READ on such a strut answers empty.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { answerProblem, answerSchemaProblem } from "./answer-schema.js";
import { MemoryTaskStore, type Lease, type TaskListQuery, type TaskRecord, type TaskSettled, type TaskStore, type TaskType } from "./task-store.js";
import { liveGrants, MemoryWorkerStore, WORKER_STATUSES, type WorkerRecord, type WorkerStatus, type WorkerStore } from "./worker-store.js";

export type { AnswerSchema } from "./answer-schema.js";
export type { Lease, TaskRecord, TaskSettled, TaskStatus, TaskType } from "./task-store.js";
export type { Grant, WorkerRecord, WorkerStatus } from "./worker-store.js";

/** §4.2's defaults. */
export const DEFAULT_LEASE_SECONDS = 600;
export const DEFAULT_WITHIN_HOURS = 72;
export const LEASE_SECONDS_MAX = 24 * 60 * 60;
export const WITHIN_HOURS_MAX = 365 * 24;
/** §3: what a task may show, and how many files it may name. */
export const SHOW_MAX_BYTES = 256 * 1024;
export const FILES_MAX = 200;
/** Rule 8: how often the sweep runs. */
export const SWEEP_EVERY_MS = 60_000;

const TYPE_NAME_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*$/;
const NAME_MAX = 128;
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
  const [{ TaskDb }, { SqliteTaskStore }, { SqliteWorkerStore }] = await Promise.all([
    import("./db.js"),
    import("./task-store-sqlite.js"),
    import("./worker-store-sqlite.js"),
  ]);
  const db = TaskDb.open("file" in o ? o.file : tasksPath(o.dataDir));
  return { tasks: new SqliteTaskStore(db), workers: new SqliteWorkerStore(db), close: async () => db.close() };
}

export function memoryTaskStores(): TaskStores {
  return { tasks: new MemoryTaskStore(), workers: new MemoryWorkerStore(), close: async () => {} };
}

// ── errors ──────────────────────────────────────────────────────────────────

export type TaskErrorCode =
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
  | "unknown_worker";

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

/** What a `human` step asks for (§3; item 2b resolves `files` first). */
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
   *  else the run's artifacts. At most 200. */
  files?: string[];
  job?: string;
  /** Overrides the type's. */
  withinHours?: number;
}

export interface TaskTypeInput {
  app: string;
  /** The answer's schema (§4.5); refused when it uses what strut does not check. */
  answer: unknown;
  leaseSeconds?: number;
  withinHours?: number;
  enabled?: boolean;
}

/** One task as its worker sees it: what to show, and the lease to answer by. */
export interface WorkerTask {
  lease: string;
  type: string;
  show: unknown;
  files: string[];
  /** Epoch ms. */
  expires: number;
}

/** A worker as they see themselves (`task/me`). */
export interface WorkerView {
  actor: string;
  status: WorkerStatus;
  /** The enabled types they hold a live grant for (of the app asked about,
   *  when given); what they may take while `active`. */
  types: Array<{ name: string; app: string }>;
}

export type TaskView = TaskRecord & { leases: Lease[] };

export interface TasksCapability {
  /** The `human` step's: the task keyed by workflow, run and path, made
   *  when there is none (rule 1). */
  ensure(input: EnsureInput): Promise<{ task: TaskRecord; created: boolean }>;

  // The worker's. `actor` is the caller's own (rule 5).
  /** The worker's live lease when it is of a type asked for, else a new one
   *  on the oldest open task they may take; `{ none: true }` when there is
   *  none. `type` narrows to one type, `app` to the types an app draws. */
  next(actor: string, o?: { type?: string; app?: string }): Promise<WorkerTask | { none: true }>;
  submit(actor: string, o: { lease: string; answer: unknown }): Promise<{ ok: true }>;
  /** The task reopens for someone else; never handed to this worker again. */
  skip(actor: string, o: { lease: string; reason?: string }): Promise<{ ok: true }>;
  /** Who the worker is here, and what they may take; the first call writes
   *  them as `new`. */
  me(actor: string, o?: { app?: string }): Promise<WorkerView>;

  // Staff's.
  types(): Promise<TaskType[]>;
  /** Saves the whole type (a PUT: what is left out is the default). */
  setType(name: string, input: TaskTypeInput, by?: string): Promise<TaskType>;
  workers(q?: { status?: WorkerStatus }): Promise<WorkerRecord[]>;
  /** `suspended` or `banned` expires the worker's live lease at once. */
  setWorker(actor: string, change: { status?: WorkerStatus; note?: string | null }, by?: string): Promise<WorkerRecord>;
  grant(actor: string, type: string, by?: string): Promise<WorkerRecord>;
  /** Expires the worker's live lease of that type at once; the status stays. */
  revoke(actor: string, type: string, o?: { by?: string; why?: string }): Promise<WorkerRecord>;
  /** Tasks newest first, with their leases. */
  list(q?: TaskListQuery): Promise<TaskView[]>;
  task(id: string): Promise<TaskView | undefined>;
}

export interface TasksService {
  /** Frozen: what `ctx.services.tasks` is. */
  capability: TasksCapability;
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
  /** Rule 8, now. Opens the store. */
  sweep(): Promise<{ leases: number; expired: TaskSettled[] }>;
  /** The sweep at once and every minute, while a store is open or on file. */
  start(): void;
  stop(): void;
  close(): Promise<void>;
}

export interface TasksDeps {
  /** The stores, opened on first use. */
  open(): Promise<TaskStores>;
  /** Whether a store is on file already, so a read or the timer opens one
   *  only then. Left out: never (memory). */
  exists?(): boolean;
  now?(): number;
  sweepEveryMs?: number;
}

export function createTasks(deps: TasksDeps): TasksService {
  const now = deps.now ?? Date.now;
  let opening: Promise<TaskStores> | undefined;
  const stores = (): Promise<TaskStores> => {
    opening ??= deps.open();
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

  /** Rules 5 and 6: the worker as they are now, written `new` on first sight. */
  const worker = async (actor: string): Promise<{ s: TaskStores; w: WorkerRecord }> => {
    actorOk(actor);
    const s = await stores();
    return { s, w: await s.workers.seen(actor, now()) };
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
    const t = (await s.tasks.task(l.task))!;
    return { lease: l.id, type: l.type, show: t.show, files: t.files, expires: l.expires };
  };

  const views = async (s: TaskStores, tasks: TaskRecord[]): Promise<TaskView[]> => {
    const leases = await s.tasks.leasesOf(tasks.map((t) => t.id));
    return tasks.map((t) => ({ ...t, leases: leases.filter((l) => l.task === t.id) }));
  };

  const capability: TasksCapability = {
    async ensure(input) {
      const type = need("type", input?.type);
      const workflow = need("workflow", input.workflow);
      const runId = need("runId", input.runId);
      const path = need("path", input.path);
      const files = filesOf(input.files);
      const show = input.show ?? null;
      const showBytes = jsonBytes(show);
      if (showBytes === undefined) throw new TaskError("bad_request", "show must be JSON");
      if (showBytes > SHOW_MAX_BYTES) throw new TaskError("bad_request", `show is ${showBytes} bytes as JSON; at most ${SHOW_MAX_BYTES} (name files instead of inlining them)`);
      if (input.job !== undefined) need("job", input.job);
      if (input.withinHours !== undefined) hours(input.withinHours);
      const s = await stores();
      // A task already made is the step's, whatever its type became since.
      const known = await s.tasks.byKey(workflow, runId, path);
      if (known) return { task: known, created: false };
      const kind = await s.tasks.type(type);
      if (!kind) throw new TaskError("unknown_type", `no task type ${type} here; an admin adds it`);
      if (!kind.enabled) throw new TaskError("type_disabled", `task type ${type} is turned off`);
      const at = now();
      return s.tasks.ensure({
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
      });
    },

    async next(actor, o = {}) {
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
        if (types.includes(live.type)) return workerTask(s, live);
        throw new TaskError("lease_held", `you hold a task of type ${live.type}; answer or skip it first`);
      }
      const taken = await s.tasks.take({ worker: actor, types, id: randomId(), now: at });
      if (taken) return workerTask(s, taken);
      // Another call of the same worker may have taken one meanwhile.
      const raced = await s.tasks.heldBy(actor, at);
      return raced && types.includes(raced.type) ? workerTask(s, raced) : { none: true };
    },

    async submit(actor, o) {
      const { s, w } = await worker(actor);
      mayWork(w);
      const l = await ownLease(s, w, o?.lease);
      const kind = await s.tasks.type(l.type);
      if (!kind) throw new TaskError("unknown_type", `task type ${l.type} is gone`);
      const problem = answerProblem(kind.answer, o.answer);
      if (problem) throw new TaskError("bad_answer", problem);
      const settled = await s.tasks.settle({ lease: l.id, worker: actor, answer: o.answer, now: now() });
      if (!settled) return whyNot(s, w, l.id);
      tell([{ id: settled.id, type: settled.type, workflow: settled.workflow, runId: settled.runId, path: settled.path, status: "settled" }]);
      return { ok: true };
    },

    async skip(actor, o) {
      const { s, w } = await worker(actor);
      mayWork(w);
      const l = await ownLease(s, w, o?.lease);
      const reason = o.reason === undefined ? undefined : text("reason", o.reason);
      if (!(await s.tasks.skip({ lease: l.id, worker: actor, ...(reason === undefined ? {} : { reason }), now: now() }))) return whyNot(s, w, l.id);
      return { ok: true };
    },

    async me(actor, o = {}) {
      const { s, w } = await worker(actor);
      const kinds = new Map((await s.tasks.types()).map((t) => [t.name, t]));
      const types = liveGrants(w)
        .map((name) => kinds.get(name))
        .filter((k): k is TaskType => !!k && k.enabled && (o.app === undefined || k.app === o.app))
        .map((k) => ({ name: k.name, app: k.app }));
      return { actor: w.actor, status: w.status, types };
    },

    async types() {
      const s = await storesIfAny();
      return s ? s.tasks.types() : [];
    },

    async setType(name, input, by) {
      if (typeof name !== "string" || name.length > NAME_MAX || !TYPE_NAME_RE.test(name)) {
        throw new TaskError("bad_request", `a task type's name is lowercase letters, digits, ".", "_" and "-", segments joined by "/", at most ${NAME_MAX} characters (got ${JSON.stringify(name)})`);
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
      const s = await stores();
      return s.tasks.putType({
        name,
        app,
        answer: input.answer as TaskType["answer"],
        leaseSeconds,
        withinHours,
        enabled: input.enabled ?? true,
        changedAt: now(),
        ...(by === undefined ? {} : { changedBy: by }),
      });
    },

    async workers(q = {}) {
      if (q.status !== undefined && !WORKER_STATUSES.includes(q.status)) throw new TaskError("bad_request", `status is one of ${WORKER_STATUSES.join(", ")}`);
      const s = await storesIfAny();
      return s ? s.workers.list(q) : [];
    },

    async setWorker(actor, change = {}, by) {
      actorOk(actor);
      if (change.status !== undefined && !WORKER_STATUSES.includes(change.status)) throw new TaskError("bad_request", `status is one of ${WORKER_STATUSES.join(", ")}`);
      if (change.note !== undefined && change.note !== null) text("note", change.note);
      const s = await stores();
      const at = now();
      const w = await s.workers.set(actor, change, by, at);
      // A worker who may no longer work lets go of what they hold, now: the
      // task is free for someone else (§4.6).
      if (w.status === "suspended" || w.status === "banned") await s.tasks.release({ worker: actor, reason: `worker ${w.status}`, now: at });
      return w;
    },

    async grant(actor, type, by) {
      actorOk(actor);
      const s = await stores();
      if (!(await s.tasks.type(type))) throw new TaskError("unknown_type", `no task type ${type} here`);
      return s.workers.grant(actor, type, by, now());
    },

    async revoke(actor, type, o = {}) {
      actorOk(actor);
      if (o.why !== undefined) text("why", o.why);
      const s = await stores();
      const at = now();
      const w = await s.workers.revoke(actor, type, { ...o, now: at });
      if (!w) throw new TaskError("unknown_worker", `no worker ${actor} here`);
      await s.tasks.release({ worker: actor, types: [type], reason: "grant revoked", now: at });
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
  };

  const sweep = async () => {
    const s = await stores();
    const swept = await s.tasks.sweep(now());
    tell(swept.expired);
    return swept;
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  const sweepIfAny = async () => {
    if (!storesIfAny()) return;
    try {
      const swept = await sweep();
      if (swept.expired.length) console.log(`[tasks] ${swept.expired.length} task(s) past their time expired`);
    } catch (err) {
      console.error(`[tasks] the sweep failed:`, err);
    }
  };

  return {
    capability: Object.freeze(capability),
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
      const open = opening;
      opening = undefined;
      if (open) await (await open.catch(() => null))?.close();
    },
  };
}

// ── checks ──────────────────────────────────────────────────────────────────

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
