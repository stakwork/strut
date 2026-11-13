/**
 * The WORKER side of the task store (plans/human-steps.md §4.2, §4.6): who
 * may take tasks, and of which types. Two tables, `workers` and `grants`,
 * in the task store's file (`worker-store-sqlite.ts`) or memory (here). The
 * task side asks it "may this actor take this type?" through `liveGrants`;
 * it knows nothing of tasks, so it may one day move (ruling 5: Stakwork
 * manages the workers, a client's Stadeum its workflows).
 *
 * A worker's status:
 * - `new`: written by the worker's first call. May only ask who they are.
 * - `active`: set by the first grant. Takes tasks of the types granted.
 *   Revoking the last grant leaves them `active` with nothing to take.
 * - `suspended`, `banned`: set by staff. May only ask who they are. What
 *   that does to a lease held is the service's (`tasks.ts`).
 *
 * The rules are the service's; this module keeps the rows. Every method is
 * one step: the memory twin never awaits between its check and its write,
 * and the SQLite one is one transaction.
 */

export const WORKER_STATUSES = ["new", "active", "suspended", "banned"] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

/** A grant of one task type to one worker. One row per worker and type: a
 *  grant after a revoke makes it live again. */
export interface Grant {
  type: string;
  /** Who granted it, and when (epoch ms). */
  by?: string;
  at: number;
  /** Set while revoked. */
  revokedAt?: number;
  revokedBy?: string;
  why?: string;
  /** K, the tests the worker answers before any real task of the type
   *  (plans/human-steps.md §7.5), set when the grant was made: the type's
   *  then, or 0 (too few ready tests, `qualify: false`, or no tests). */
  qualify?: number;
}

export interface WorkerRecord {
  actor: string;
  status: WorkerStatus;
  /** Epoch ms: the first call, or the staff change that made the row. */
  firstSeen: number;
  /** Epoch ms, and who, of the last change to status or note. */
  changedAt: number;
  changedBy?: string;
  note?: string;
  grants: Grant[];
}

export interface WorkerChange {
  status?: WorkerStatus;
  /** `null` clears it. */
  note?: string | null;
}

export interface WorkerStore {
  /** The worker, written `new` when the store has not seen them. */
  seen(actor: string, now: number): Promise<WorkerRecord>;
  get(actor: string): Promise<WorkerRecord | undefined>;
  /** Every worker, newest first; of one status when asked. */
  list(q?: { status?: WorkerStatus }): Promise<WorkerRecord[]>;
  /** Staff's change; makes the row when there is none (`new` unless a
   *  status is given). */
  set(actor: string, change: WorkerChange, by: string | undefined, now: number): Promise<WorkerRecord>;
  /** Grants a type, live again if it was revoked (its `at` and `qualify`
   *  new); a live grant stays as it is. A worker with no row or `new`
   *  becomes `active`, any other status stays. */
  grant(actor: string, type: string, by: string | undefined, now: number, qualify?: number): Promise<WorkerRecord>;
  /** Revokes a live grant; the status stays. Undefined: no such worker. */
  revoke(actor: string, type: string, o: { by?: string; why?: string; now: number }): Promise<WorkerRecord | undefined>;
}

/** The types a worker holds a live grant for, by name. */
export function liveGrants(w: WorkerRecord): string[] {
  return w.grants.filter((g) => g.revokedAt === undefined).map((g) => g.type);
}

export class MemoryWorkerStore implements WorkerStore {
  private readonly rows = new Map<string, Omit<WorkerRecord, "grants">>();
  private readonly grants = new Map<string, Map<string, Grant>>();

  async seen(actor: string, now: number): Promise<WorkerRecord> {
    if (!this.rows.has(actor)) this.rows.set(actor, { actor, status: "new", firstSeen: now, changedAt: now });
    return this.record(actor)!;
  }

  async get(actor: string): Promise<WorkerRecord | undefined> {
    return this.record(actor);
  }

  async list(q: { status?: WorkerStatus } = {}): Promise<WorkerRecord[]> {
    return [...this.rows.values()]
      .filter((r) => !q.status || r.status === q.status)
      .reverse()
      .sort((a, b) => b.firstSeen - a.firstSeen)
      .map((r) => this.record(r.actor)!);
  }

  async set(actor: string, change: WorkerChange, by: string | undefined, now: number): Promise<WorkerRecord> {
    const row = this.rows.get(actor) ?? { actor, status: "new" as WorkerStatus, firstSeen: now, changedAt: now };
    if (change.status !== undefined) row.status = change.status;
    if (change.note === null) delete row.note;
    else if (change.note !== undefined) row.note = change.note;
    row.changedAt = now;
    if (by === undefined) delete row.changedBy;
    else row.changedBy = by;
    this.rows.set(actor, row);
    return this.record(actor)!;
  }

  async grant(actor: string, type: string, by: string | undefined, now: number, qualify = 0): Promise<WorkerRecord> {
    const row = this.rows.get(actor);
    if (!row) this.rows.set(actor, { actor, status: "active", firstSeen: now, changedAt: now, ...(by === undefined ? {} : { changedBy: by }) });
    else if (row.status === "new") Object.assign(row, { status: "active", changedAt: now, ...(by === undefined ? {} : { changedBy: by }) });
    const mine = this.grants.get(actor) ?? new Map<string, Grant>();
    const known = mine.get(type);
    if (!known || known.revokedAt !== undefined) mine.set(type, { type, at: now, ...(by === undefined ? {} : { by }), qualify });
    this.grants.set(actor, mine);
    return this.record(actor)!;
  }

  async revoke(actor: string, type: string, o: { by?: string; why?: string; now: number }): Promise<WorkerRecord | undefined> {
    if (!this.rows.has(actor)) return undefined;
    const g = this.grants.get(actor)?.get(type);
    if (g && g.revokedAt === undefined) {
      g.revokedAt = o.now;
      if (o.by !== undefined) g.revokedBy = o.by;
      if (o.why !== undefined) g.why = o.why;
    }
    return this.record(actor);
  }

  private record(actor: string): WorkerRecord | undefined {
    const row = this.rows.get(actor);
    if (!row) return undefined;
    const grants = [...(this.grants.get(actor)?.values() ?? [])].map((g) => ({ ...g })).sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
    return { ...row, grants };
  }
}
