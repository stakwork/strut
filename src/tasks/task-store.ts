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
 */
import type { AnswerSchema } from "./answer-schema.js";

export const TASK_STATUSES = ["open", "settled", "expired", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const LEASE_STATUSES = ["open", "submitted", "expired", "skipped"] as const;
export type LeaseStatus = (typeof LEASE_STATUSES)[number];

/** The admin's record for a kind of task (§4.2). Later: pay, test rate,
 *  threshold, hold. */
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
   *  or `job`'s directory on a job run. */
  files: string[];
  root: "run" | "job";
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
  /** A `seq`: tasks made before it. */
  before?: number;
  limit?: number;
}

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
}

export function settledOf(t: TaskRecord): TaskSettled {
  return { id: t.id, type: t.type, workflow: t.workflow, runId: t.runId, path: t.path, status: t.status as TaskSettled["status"] };
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

  async take(o: { worker: string; types: string[]; id: string; now: number }): Promise<Lease | undefined> {
    const leases = [...this.leases.values()];
    if (leases.some((l) => l.worker === o.worker && live(l, o.now))) return undefined;
    const types = new Set(o.types);
    for (const t of this.tasks.values()) {
      if (t.status !== "open" || t.due <= o.now || !types.has(t.type)) continue;
      const kind = this.kinds.get(t.type);
      if (!kind?.enabled) continue;
      if (leases.some((l) => l.task === t.id && (l.worker === o.worker || live(l, o.now)))) continue;
      const lease: Lease = { id: o.id, task: t.id, worker: o.worker, type: t.type, taken: o.now, expires: o.now + kind.leaseSeconds * 1000, status: "open" };
      this.leases.set(lease.id, lease);
      return clone(lease);
    }
    return undefined;
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
    return true;
  }

  async release(o: { worker: string; types?: string[]; reason: string; now: number }): Promise<number> {
    let n = 0;
    for (const l of this.leases.values()) {
      if (l.worker !== o.worker || l.status !== "open" || (o.types && !o.types.includes(l.type))) continue;
      Object.assign(l, { status: "expired", closed: o.now, reason: o.reason });
      n++;
    }
    return n;
  }

  async cancel(which: { id: string } | { workflow: string; runId: string }, now: number): Promise<TaskSettled[]> {
    const hit = [...this.tasks.values()].filter(
      (t) => t.status === "open" && ("id" in which ? t.id === which.id : t.workflow === which.workflow && t.runId === which.runId),
    );
    return hit.map((t) => this.close(t, "cancelled", now));
  }

  async sweep(now: number): Promise<{ leases: number; expired: TaskSettled[] }> {
    const expired = [...this.tasks.values()].filter((t) => t.status === "open" && t.due <= now).map((t) => this.close(t, "expired", now));
    let leases = 0;
    for (const l of this.leases.values()) {
      if (l.status === "open" && l.expires <= now) {
        Object.assign(l, { status: "expired", closed: now });
        leases++;
      }
    }
    return { leases, expired };
  }

  private close(t: TaskRecord, status: "expired" | "cancelled", now: number): TaskSettled {
    Object.assign(t, { status, settledAt: now });
    for (const l of this.leases.values()) {
      if (l.task === t.id && l.status === "open") Object.assign(l, { status: "expired", closed: now, reason: `task ${status}` });
    }
    return settledOf(t);
  }
}
