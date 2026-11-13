/**
 * The task side on the task store's file (`task-store.ts`'s semantics; its
 * memory twin passes the same suite, tasks.test.ts): `task_types`, `tasks`
 * and `leases`. `take` is ONE guarded statement (rule 2), `settle` two
 * guarded updates in one transaction committed with `synchronous=full`.
 */
import type { StatementSync } from "node:sqlite";
import { opt, type Row, type TaskDb } from "./db.js";
import type { AnswerSchema } from "./answer-schema.js";
import {
  pageLimit,
  type Lease,
  type LeaseStatus,
  type NewTask,
  type TaskListQuery,
  type TaskRecord,
  type TaskSettled,
  type TaskStatus,
  type TaskStore,
  type TaskType,
} from "./task-store.js";

const SCHEMA = `
create table if not exists task_types (
  name text primary key,
  app text not null,
  answer text not null,
  lease_seconds integer not null,
  within_hours real not null,
  enabled integer not null,
  changed_at integer not null,
  changed_by text
) strict;

create table if not exists tasks (
  seq integer primary key autoincrement,
  id text not null unique,
  type text not null,
  workflow text not null,
  run_id text not null,
  path text not null,
  show text not null,
  files text not null,
  root text not null check (root in ('run', 'job')),
  job text,
  status text not null check (status in ('open', 'settled', 'expired', 'cancelled')),
  created integer not null,
  due integer not null,
  settled_at integer,
  answer text,
  by text,
  unique (workflow, run_id, path)
) strict;
create index if not exists tasks_open on tasks(type, seq) where status = 'open';
create index if not exists tasks_due on tasks(due) where status = 'open';
create index if not exists tasks_type on tasks(type, seq);
create index if not exists tasks_status on tasks(status, seq);

create table if not exists leases (
  id text primary key,
  task text not null,
  worker text not null,
  type text not null,
  taken integer not null,
  expires integer not null,
  status text not null check (status in ('open', 'submitted', 'expired', 'skipped')),
  closed integer,
  reason text,
  unique (task, worker)
) strict;
create index if not exists leases_open_task on leases(task) where status = 'open';
create index if not exists leases_open_worker on leases(worker) where status = 'open';
create index if not exists leases_open_expires on leases(expires) where status = 'open';
`;

export class SqliteTaskStore implements TaskStore {
  private readonly s: Record<string, StatementSync>;

  constructor(private readonly db: TaskDb) {
    db.exec(SCHEMA);
    const p = (sql: string) => db.prepare(sql);
    this.s = {
      types: p("select * from task_types order by name"),
      type: p("select * from task_types where name = ?"),
      putType: p(
        `insert into task_types (name, app, answer, lease_seconds, within_hours, enabled, changed_at, changed_by)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (name) do update set app = excluded.app, answer = excluded.answer, lease_seconds = excluded.lease_seconds,
           within_hours = excluded.within_hours, enabled = excluded.enabled, changed_at = excluded.changed_at, changed_by = excluded.changed_by`,
      ),
      deleteType: p("delete from task_types where name = ?"),
      openOfType: p("select 1 from tasks where type = ? and status = 'open' limit 1"),
      insertTask: p(
        `insert into tasks (id, type, workflow, run_id, path, show, files, root, job, status, created, due)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
         on conflict (workflow, run_id, path) do nothing`,
      ),
      byKey: p("select * from tasks where workflow = ? and run_id = ? and path = ?"),
      task: p("select * from tasks where id = ?"),
      lease: p("select * from leases where id = ?"),
      heldBy: p("select * from leases where worker = ? and status = 'open' and expires > ? order by taken limit 1"),
      // Rule 2 in one statement: the oldest open task not past due, of a
      // type asked for and enabled, that this worker never held and nobody
      // holds now — while this worker holds nothing live.
      take: p(
        `insert into leases (id, task, worker, type, taken, expires, status)
         select ?1, t.id, ?2, t.type, ?3, ?3 + ty.lease_seconds * 1000, 'open'
           from tasks t join task_types ty on ty.name = t.type
          where t.status = 'open' and t.due > ?3 and ty.enabled = 1
            and t.type in (select value from json_each(?4))
            and not exists (select 1 from leases l where l.task = t.id and l.worker = ?2)
            and not exists (select 1 from leases l where l.task = t.id and l.status = 'open' and l.expires > ?3)
            and not exists (select 1 from leases l where l.worker = ?2 and l.status = 'open' and l.expires > ?3)
          order by t.seq
          limit 1`,
      ),
      submit: p("update leases set status = 'submitted', closed = ?1 where id = ?2 and worker = ?3 and status = 'open' and expires > ?1"),
      settle: p("update tasks set status = 'settled', settled_at = ?1, answer = ?2, by = ?3 where id = ?4 and status = 'open' and due > ?1"),
      skip: p("update leases set status = 'skipped', closed = ?1, reason = ?2 where id = ?3 and worker = ?4 and status = 'open' and expires > ?1"),
      release: p(
        `update leases set status = 'expired', closed = ?1, reason = ?2
          where worker = ?3 and status = 'open' and (?4 is null or type in (select value from json_each(?4)))`,
      ),
      openById: p("select * from tasks where id = ? and status = 'open'"),
      openByRun: p("select * from tasks where workflow = ? and run_id = ? and status = 'open' order by seq"),
      due: p("select * from tasks where status = 'open' and due <= ? order by seq"),
      close: p("update tasks set status = ?, settled_at = ? where id = ? and status = 'open'"),
      closeLeases: p("update leases set status = 'expired', closed = ?, reason = ? where task = ? and status = 'open'"),
      staleLeases: p("update leases set status = 'expired', closed = ?1 where status = 'open' and expires <= ?1"),
      leasesOf: p("select * from leases where task in (select value from json_each(?)) order by taken, rowid"),
    };
  }

  async types(): Promise<TaskType[]> {
    return (this.s.types.all() as Row[]).map(typeOf);
  }

  async type(name: string): Promise<TaskType | undefined> {
    const row = this.s.type.get(name) as Row | undefined;
    return row ? typeOf(row) : undefined;
  }

  async putType(t: TaskType): Promise<TaskType> {
    return this.db.tx(() => {
      this.s.putType.run(t.name, t.app, JSON.stringify(t.answer), t.leaseSeconds, t.withinHours, t.enabled ? 1 : 0, t.changedAt, t.changedBy ?? null);
      return typeOf(this.s.type.get(t.name) as Row);
    });
  }

  async deleteType(name: string): Promise<"deleted" | "missing" | "in_use"> {
    return this.db.tx(() => {
      if (!this.s.type.get(name)) return "missing";
      if (this.s.openOfType.get(name)) return "in_use";
      this.s.deleteType.run(name);
      return "deleted";
    });
  }

  async ensure(t: NewTask): Promise<{ task: TaskRecord; created: boolean }> {
    return this.db.tx(() => {
      const changed = this.s.insertTask.run(
        t.id,
        t.type,
        t.workflow,
        t.runId,
        t.path,
        JSON.stringify(t.show ?? null),
        JSON.stringify(t.files),
        t.job === undefined ? "run" : "job",
        t.job ?? null,
        t.created,
        t.due,
      ).changes;
      return { task: taskOf(this.s.byKey.get(t.workflow, t.runId, t.path) as Row), created: Number(changed) === 1 };
    });
  }

  async task(id: string): Promise<TaskRecord | undefined> {
    const row = this.s.task.get(id) as Row | undefined;
    return row ? taskOf(row) : undefined;
  }

  async byKey(workflow: string, runId: string, path: string): Promise<TaskRecord | undefined> {
    const row = this.s.byKey.get(workflow, runId, path) as Row | undefined;
    return row ? taskOf(row) : undefined;
  }

  async list(q: TaskListQuery = {}): Promise<TaskRecord[]> {
    const where: string[] = [];
    const args: Array<string | number> = [];
    const eq = (col: string, v: string | undefined) => {
      if (v === undefined || v === "") return;
      where.push(`${col} = ?`);
      args.push(v);
    };
    eq("type", q.type);
    eq("status", q.status);
    eq("workflow", q.workflow);
    eq("run_id", q.runId);
    if (q.before !== undefined) {
      where.push("seq < ?");
      args.push(q.before);
    }
    const sql = `select * from tasks ${where.length ? `where ${where.join(" and ")}` : ""} order by seq desc limit ?`;
    return (this.db.prepare(sql).all(...args, pageLimit(q.limit)) as Row[]).map(taskOf);
  }

  async leasesOf(taskIds: string[]): Promise<Lease[]> {
    if (!taskIds.length) return [];
    return (this.s.leasesOf.all(JSON.stringify(taskIds)) as Row[]).map(leaseOf);
  }

  async lease(id: string): Promise<Lease | undefined> {
    const row = this.s.lease.get(id) as Row | undefined;
    return row ? leaseOf(row) : undefined;
  }

  async heldBy(worker: string, now: number): Promise<Lease | undefined> {
    const row = this.s.heldBy.get(worker, now) as Row | undefined;
    return row ? leaseOf(row) : undefined;
  }

  async take(o: { worker: string; types: string[]; id: string; now: number }): Promise<Lease | undefined> {
    if (!o.types.length) return undefined;
    return this.db.tx(() => {
      const changed = this.s.take.run(o.id, o.worker, o.now, JSON.stringify(o.types)).changes;
      return Number(changed) === 1 ? leaseOf(this.s.lease.get(o.id) as Row) : undefined;
    });
  }

  async settle(o: { lease: string; worker: string; answer: unknown; now: number }): Promise<TaskRecord | undefined> {
    try {
      return this.db.tx(() => {
        const l = this.s.lease.get(o.lease) as Row | undefined;
        if (!l) return undefined;
        if (Number(this.s.submit.run(o.now, o.lease, o.worker).changes) !== 1) return undefined;
        // The task left `open` (or ran past due) while the lease was live:
        // nothing is written, the lease included.
        if (Number(this.s.settle.run(o.now, JSON.stringify(o.answer), o.worker, l.task as string).changes) !== 1) throw new Unsettled();
        return taskOf(this.s.task.get(l.task as string) as Row);
      }, true);
    } catch (e) {
      if (e instanceof Unsettled) return undefined;
      throw e;
    }
  }

  async skip(o: { lease: string; worker: string; reason?: string; now: number }): Promise<boolean> {
    return this.db.tx(() => Number(this.s.skip.run(o.now, o.reason ?? null, o.lease, o.worker).changes) === 1);
  }

  async release(o: { worker: string; types?: string[]; reason: string; now: number }): Promise<number> {
    return this.db.tx(() => Number(this.s.release.run(o.now, o.reason, o.worker, o.types ? JSON.stringify(o.types) : null).changes));
  }

  async cancel(which: { id: string } | { workflow: string; runId: string }, now: number): Promise<TaskSettled[]> {
    return this.db.tx(() => {
      const rows = ("id" in which ? [this.s.openById.get(which.id)].filter(Boolean) : this.s.openByRun.all(which.workflow, which.runId)) as Row[];
      return rows.map((r) => this.close(r, "cancelled", now));
    });
  }

  async sweep(now: number): Promise<{ leases: number; expired: TaskSettled[] }> {
    return this.db.tx(() => {
      const expired = (this.s.due.all(now) as Row[]).map((r) => this.close(r, "expired", now));
      const leases = Number(this.s.staleLeases.run(now).changes);
      return { leases, expired };
    });
  }

  /** Inside a transaction: a task leaves `open`, its open leases expire. */
  private close(r: Row, status: "expired" | "cancelled", now: number): TaskSettled {
    this.s.close.run(status, now, r.id as string);
    this.s.closeLeases.run(now, `task ${status}`, r.id as string);
    return { id: r.id as string, type: r.type as string, workflow: r.workflow as string, runId: r.run_id as string, path: r.path as string, status };
  }
}

class Unsettled extends Error {}

function typeOf(r: Row): TaskType {
  const t: TaskType = {
    name: r.name as string,
    app: r.app as string,
    answer: JSON.parse(r.answer as string) as AnswerSchema,
    leaseSeconds: r.lease_seconds as number,
    withinHours: r.within_hours as number,
    enabled: r.enabled === 1,
    changedAt: r.changed_at as number,
  };
  const by = opt<string>(r.changed_by);
  if (by !== undefined) t.changedBy = by;
  return t;
}

function taskOf(r: Row): TaskRecord {
  const t: TaskRecord = {
    id: r.id as string,
    seq: r.seq as number,
    type: r.type as string,
    workflow: r.workflow as string,
    runId: r.run_id as string,
    path: r.path as string,
    show: JSON.parse(r.show as string),
    files: JSON.parse(r.files as string) as string[],
    root: r.root as "run" | "job",
    status: r.status as TaskStatus,
    created: r.created as number,
    due: r.due as number,
  };
  const job = opt<string>(r.job);
  if (job !== undefined) t.job = job;
  const settledAt = opt<number>(r.settled_at);
  if (settledAt !== undefined) t.settledAt = settledAt;
  const answer = opt<string>(r.answer);
  if (answer !== undefined) t.answer = JSON.parse(answer);
  const by = opt<string>(r.by);
  if (by !== undefined) t.by = by;
  return t;
}

function leaseOf(r: Row): Lease {
  const l: Lease = {
    id: r.id as string,
    task: r.task as string,
    worker: r.worker as string,
    type: r.type as string,
    taken: r.taken as number,
    expires: r.expires as number,
    status: r.status as LeaseStatus,
  };
  const closed = opt<number>(r.closed);
  if (closed !== undefined) l.closed = closed;
  const reason = opt<string>(r.reason);
  if (reason !== undefined) l.reason = reason;
  return l;
}
