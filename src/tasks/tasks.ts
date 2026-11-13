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
 * Nothing is made until something is asked of it: no file on a strut that
 * never runs a `human` step, and a staff READ on such a strut answers empty.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { RunControl } from "../run-control.js";
import type { RunFile } from "../runs.js";
import { answerProblem, answerSchemaProblem, type AnswerSchema } from "./answer-schema.js";
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
/** §5.2: requests to `/public/*` a minute counted under an ACTIVE worker
 *  (`isActiveWorker`) in place of their address's budget, so a room of
 *  workers behind one address is not one budget. */
export const TASK_REQUESTS_PER_MINUTE = 240;

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
  | "too_many"
  | "not_listed"
  | "no_file"
  | "in_use";

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
  ensure(input: EnsureInput, o?: EnsureOptions): Promise<{ task: TaskRecord; created: boolean }>;

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
  /** Who the worker is here, and what they may take; the first call writes
   *  them as `new`. */
  me(actor: string, o?: { app?: string }): Promise<WorkerView>;

  // Staff's.
  types(): Promise<TaskType[]>;
  /** Saves the whole type (a PUT: what is left out is the default). */
  setType(name: string, input: TaskTypeInput, by?: string): Promise<TaskType>;
  /** Removes a type no open task is of (`in_use` otherwise: turn it off
   *  and let them settle), and revokes its live grants. Its tasks on file
   *  keep its name. */
  deleteType(name: string, by?: string): Promise<{ name: string; revoked: number }>;
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
  /** Frozen: the worker's calls alone — what a signed-in visitor's bag
   *  carries (plans/human-steps.md §5.2), never the staff's. */
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
  /** Rule 8, now. Opens the store. */
  sweep(): Promise<{ leases: number; expired: TaskSettled[] }>;
  /** The sweep at once and every minute, while a store is open or on file. */
  start(): void;
  stop(): void;
  close(): Promise<void>;
}

/** The worker's calls of the capability (§5.1). */
export type WorkerTasksCapability = Pick<TasksCapability, "next" | "submit" | "skip" | "file" | "me">;

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
  now?(): number;
  sweepEveryMs?: number;
}

export function createTasks(deps: TasksDeps): TasksService {
  const now = deps.now ?? Date.now;
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
    const taken = await s.tasks.take({ worker: actor, types, id: randomId(), now: at });
    if (taken) return { got: await workerTask(s, taken), types };
    // Another call of the same worker may have taken one meanwhile.
    const raced = await s.tasks.heldBy(actor, at);
    return raced && types.includes(raced.type) ? { got: await workerTask(s, raced), types } : { types };
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
    return { lease: l.id, type: l.type, show: t!.show, files: t!.files, expires: l.expires, answer: kind?.answer ?? ({ type: "object", properties: {} } as AnswerSchema) };
  };

  const views = async (s: TaskStores, tasks: TaskRecord[]): Promise<TaskView[]> => {
    const leases = await s.tasks.leasesOf(tasks.map((t) => t.id));
    return tasks.map((t) => ({ ...t, leases: leases.filter((l) => l.task === t.id) }));
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
      const s = await stores();
      // A task already made is the step's, whatever its type became since.
      const known = await s.tasks.byKey(workflow, runId, path);
      if (known) return { task: known, created: false };
      const kind = await s.tasks.type(type);
      if (!kind) throw new TaskError("unknown_type", `no task type ${type} here; an admin adds it`);
      if (!kind.enabled) throw new TaskError("type_disabled", `task type ${type} is turned off`);
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
      });
      if (made.created) wakeFor(made.task.type);
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
      const settled = await s.tasks.settle({ lease: l.id, worker: actor, answer: o.answer, now: now() });
      if (!settled) return whyNot(s, w, l.id);
      tell([{ id: settled.id, type: settled.type, workflow: settled.workflow, runId: settled.runId, path: settled.path, status: "settled" }]);
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
      const saved = await s.tasks.putType({
        name,
        app,
        answer: input.answer as TaskType["answer"],
        leaseSeconds,
        withinHours,
        enabled: input.enabled ?? true,
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
      // A type made again under this name later starts with no workers.
      const at = now();
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
      return s ? s.workers.list(q) : [];
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

    async grant(actor, type, by) {
      actorOk(actor);
      const s = await stores();
      if (!(await s.tasks.type(type))) throw new TaskError("unknown_type", `no task type ${type} here`);
      const w = note(await s.workers.grant(actor, type, by, now()));
      wakeAll(actor);
      return w;
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
  };

  const sweep = async () => {
    const s = await stores();
    const swept = await s.tasks.sweep(now());
    tell(swept.expired);
    // Dead leases let go of: their tasks are free, of types not known here.
    if (swept.leases) wakeAll();
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

  const frozen = Object.freeze(capability);
  return {
    capability: frozen,
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
      // Every held wait answers "none" now, before the store goes.
      closing = true;
      wakeAll();
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
