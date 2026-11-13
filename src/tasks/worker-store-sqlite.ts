/**
 * The worker side on the task store's file (`worker-store.ts`'s semantics;
 * its memory twin passes the same suite, tasks.test.ts): `workers` and
 * `grants`, every write one transaction. Schema version 2 adds
 * `grants.qualify` (plans/human-steps.md §7.7), in `workerSchema`.
 */
import type { StatementSync } from "node:sqlite";
import { opt, type Row, type TaskDb } from "./db.js";
import { noStatuses, type Grant, type WorkerChange, type WorkerCounts, type WorkerRecord, type WorkerStatus, type WorkerStore } from "./worker-store.js";

const SCHEMA = `
create table if not exists workers (
  actor text primary key,
  status text not null check (status in ('new', 'active', 'suspended', 'banned')),
  first_seen integer not null,
  changed_at integer not null,
  changed_by text,
  note text
) strict;
create index if not exists workers_status on workers(status);

create table if not exists grants (
  actor text not null,
  type text not null,
  granted_by text,
  granted_at integer not null,
  revoked_at integer,
  revoked_by text,
  revoked_why text,
  qualify integer,
  primary key (actor, type)
) strict, without rowid;
`;

/** The worker side's tables brought to version 2, inside the file's one
 *  migration transaction (`TaskDb.migrate`). Safe to run again. */
export function workerSchema(db: TaskDb): void {
  db.exec(SCHEMA);
  const has = (db.prepare("pragma table_info(grants)").all() as Row[]).some((r) => r.name === "qualify");
  if (!has) db.exec("alter table grants add column qualify integer");
}

export class SqliteWorkerStore implements WorkerStore {
  private readonly s: Record<string, StatementSync>;

  /** On a file `workerSchema` brought to version 2. */
  constructor(private readonly db: TaskDb) {
    const p = (sql: string) => db.prepare(sql);
    this.s = {
      worker: p("select * from workers where actor = ?"),
      grants: p("select * from grants where actor = ? order by type"),
      insertNew: p("insert or ignore into workers (actor, status, first_seen, changed_at) values (?, 'new', ?, ?)"),
      insert: p("insert into workers (actor, status, first_seen, changed_at, changed_by, note) values (?, ?, ?, ?, ?, ?)"),
      update: p("update workers set status = ?, note = ?, changed_at = ?, changed_by = ? where actor = ?"),
      activate: p("update workers set status = 'active', changed_at = ?, changed_by = ? where actor = ? and status = 'new'"),
      grant: p(
        `insert into grants (actor, type, granted_by, granted_at, qualify) values (?, ?, ?, ?, ?)
         on conflict (actor, type) do update set granted_by = excluded.granted_by, granted_at = excluded.granted_at,
           revoked_at = null, revoked_by = null, revoked_why = null, qualify = excluded.qualify
         where grants.revoked_at is not null`,
      ),
      revoke: p("update grants set revoked_at = ?, revoked_by = ?, revoked_why = ? where actor = ? and type = ? and revoked_at is null"),
      all: p("select * from workers order by first_seen desc, rowid desc"),
      byStatus: p("select * from workers where status = ? order by first_seen desc, rowid desc"),
      statusCounts: p("select status, count(*) n from workers group by status"),
      grantCounts: p("select type, count(*) n from grants where revoked_at is null group by type"),
    };
  }

  async counts(): Promise<WorkerCounts> {
    const statuses = noStatuses();
    for (const r of this.s.statusCounts.all() as Row[]) statuses[r.status as WorkerStatus] = Number(r.n);
    const granted: Record<string, number> = {};
    for (const r of this.s.grantCounts.all() as Row[]) granted[r.type as string] = Number(r.n);
    return { statuses, granted };
  }

  async seen(actor: string, now: number): Promise<WorkerRecord> {
    return this.db.tx(() => {
      this.s.insertNew.run(actor, now, now);
      return this.record(actor)!;
    });
  }

  async get(actor: string): Promise<WorkerRecord | undefined> {
    return this.record(actor);
  }

  async list(q: { status?: WorkerStatus } = {}): Promise<WorkerRecord[]> {
    const rows = (q.status ? this.s.byStatus.all(q.status) : this.s.all.all()) as Row[];
    return rows.map((r) => this.withGrants(r));
  }

  async set(actor: string, change: WorkerChange, by: string | undefined, now: number): Promise<WorkerRecord> {
    return this.db.tx(() => {
      const row = this.s.worker.get(actor) as Row | undefined;
      if (!row) {
        this.s.insert.run(actor, change.status ?? "new", now, now, by ?? null, change.note ?? null);
      } else {
        const note = change.note === undefined ? row.note : change.note;
        this.s.update.run(change.status ?? (row.status as string), (note as string | null) ?? null, now, by ?? null, actor);
      }
      return this.record(actor)!;
    });
  }

  async grant(actor: string, type: string, by: string | undefined, now: number, qualify = 0): Promise<WorkerRecord> {
    return this.db.tx(() => {
      if (!this.s.worker.get(actor)) this.s.insert.run(actor, "active", now, now, by ?? null, null);
      else this.s.activate.run(now, by ?? null, actor);
      this.s.grant.run(actor, type, by ?? null, now, qualify);
      return this.record(actor)!;
    });
  }

  async revoke(actor: string, type: string, o: { by?: string; why?: string; now: number }): Promise<WorkerRecord | undefined> {
    return this.db.tx(() => {
      if (!this.s.worker.get(actor)) return undefined;
      this.s.revoke.run(o.now, o.by ?? null, o.why ?? null, actor, type);
      return this.record(actor);
    });
  }

  private record(actor: string): WorkerRecord | undefined {
    const row = this.s.worker.get(actor) as Row | undefined;
    return row ? this.withGrants(row) : undefined;
  }

  private withGrants(r: Row): WorkerRecord {
    const w: WorkerRecord = {
      actor: r.actor as string,
      status: r.status as WorkerStatus,
      firstSeen: r.first_seen as number,
      changedAt: r.changed_at as number,
      grants: (this.s.grants.all(r.actor as string) as Row[]).map(grantOf),
    };
    const by = opt<string>(r.changed_by);
    if (by !== undefined) w.changedBy = by;
    const note = opt<string>(r.note);
    if (note !== undefined) w.note = note;
    return w;
  }
}

function grantOf(r: Row): Grant {
  const g: Grant = { type: r.type as string, at: r.granted_at as number };
  const fields: Array<[string, keyof Grant]> = [
    ["granted_by", "by"],
    ["revoked_at", "revokedAt"],
    ["revoked_by", "revokedBy"],
    ["revoked_why", "why"],
    ["qualify", "qualify"],
  ];
  for (const [col, key] of fields) {
    const v = opt(r[col]);
    if (v !== undefined) (g as unknown as Record<string, unknown>)[key] = v;
  }
  return g;
}
