/**
 * The task side on the task store's file (`task-store.ts`'s semantics; its
 * memory twin passes the same suite, tasks.test.ts): `task_types`, `tasks`
 * and `leases`. `take` is ONE guarded statement (rule 2), `settle` two
 * guarded updates in one transaction committed with `synchronous=full`.
 *
 * Pay (plans/human-steps.md §8.1) added four nullable columns —
 * `task_types.pay_msat`, `task_types.hold_hours`, `leases.pay_msat`,
 * `leases.booked_at` — each added with `ALTER TABLE … ADD COLUMN` when the
 * file lacks it, `user_version` still 1: a file from before opens as it is,
 * and a strut from before reads past them and writes them null.
 *
 * Schema version 2 (plans/human-steps.md §7.7, item 4) is whole here,
 * copies' columns too (item 4b uses them): `task_types.tests` and
 * `.copies` (JSON, null is off), the `tests` table, `tasks.test`,
 * `.served_to` (unique with `test`), `.copies`, `.grade`, `.graded_at`,
 * `.grade_note`, and `leases.answer`. The status CHECK gains `disputed` and
 * the root CHECK `test`; SQLite cannot change a CHECK, so a version 1
 * `tasks` table is rebuilt (made anew, copied, renamed), its `seq` kept.
 * `taskSchema` does it, inside the file's one migration transaction
 * (`TaskDb.migrate`).
 *
 * Copies (plans/human-steps.md §7.6, item 4b) use version 2's columns and
 * add one, `leases.agrees` (whether a copy's answer agreed, once its task
 * was decided), the way pay's were added: `ADD COLUMN` when the file lacks
 * it, `user_version` still 2.
 */
import type { StatementSync } from "node:sqlite";
import { opt, type Row, type TaskDb } from "./db.js";
import type { AnswerSchema } from "./answer-schema.js";
import {
  DEFAULT_HOLD_HOURS,
  DUE_SOON_MS,
  GRADE_NOTE_MAX,
  STATS_SAMPLE,
  STATS_WINDOWS,
  type QueueCounts,
  type StatsWindow,
  type WindowCounts,
  type WorkerWeek,
  pageLimit,
  payMsatOf,
  pickIn,
  type CopiesDecision,
  type CopiesRule,
  type GradeResult,
  type GradeRule,
  type Lease,
  type LeaseStatus,
  type NewTask,
  type SettleResult,
  type TaskListQuery,
  type TaskRecord,
  type TaskSettled,
  type TaskStatus,
  type TaskStore,
  type TaskType,
  type NewTest,
  type StandingQuery,
  type StandingRow,
  type TestChange,
  type TestCounts,
  type TestInstance,
  type TestRecord,
  type TestRules,
} from "./task-store.js";

/** The `tasks` table as version 2 has it: a new file's, and what a version 1
 *  table is rebuilt into. */
const TASKS_TABLE = (name: string) => `
create table if not exists ${name} (
  seq integer primary key autoincrement,
  id text not null unique,
  type text not null,
  workflow text not null,
  run_id text not null,
  path text not null,
  show text not null,
  files text not null,
  root text not null check (root in ('run', 'job', 'test')),
  job text,
  status text not null check (status in ('open', 'settled', 'expired', 'cancelled', 'disputed')),
  created integer not null,
  due integer not null,
  settled_at integer,
  answer text,
  by text,
  test text,
  served_to text,
  copies integer not null default 1,
  grade text check (grade in ('pass', 'fail', 'error')),
  graded_at integer,
  grade_note text,
  unique (workflow, run_id, path),
  unique (test, served_to)
) strict;`;

/** Version 1's columns of `tasks`: what a rebuild copies. */
const TASKS_V1_COLUMNS = "seq, id, type, workflow, run_id, path, show, files, root, job, status, created, due, settled_at, answer, by";

const SCHEMA = `
create table if not exists task_types (
  name text primary key,
  app text not null,
  answer text not null,
  lease_seconds integer not null,
  within_hours real not null,
  enabled integer not null,
  changed_at integer not null,
  changed_by text,
  pay_msat integer,
  hold_hours real,
  tests text,
  copies text
) strict;
${TASKS_TABLE("tasks")}

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
  pay_msat integer,
  booked_at integer,
  answer text,
  agrees integer,
  unique (task, worker)
) strict;

create table if not exists tests (
  id text primary key,
  type text not null,
  show text not null,
  files text not null,
  expected text not null,
  grade text,
  from_task text,
  from_worker text,
  ready integer not null,
  created integer not null,
  created_by text,
  retired integer,
  retired_by text,
  served integer not null default 0
) strict;
`;

/** Columns added to a table that has the rest: pay's (§8.1, #664, version 1
 *  still) and version 2's on the tables it does not rebuild. */
const ADDED: Array<[table: string, column: string, type: string]> = [
  ["task_types", "pay_msat", "integer"],
  ["task_types", "hold_hours", "real"],
  ["task_types", "tests", "text"],
  ["task_types", "copies", "text"],
  ["leases", "pay_msat", "integer"],
  ["leases", "booked_at", "integer"],
  ["leases", "answer", "text"],
  ["leases", "agrees", "integer"],
];

/** Every index, made once its table and columns are there (a rebuilt
 *  `tasks` lost its own). */
const INDEXES = `
create index if not exists tasks_open on tasks(type, seq) where status = 'open';
create index if not exists tasks_due on tasks(due) where status = 'open';
create index if not exists tasks_type on tasks(type, seq);
create index if not exists tasks_status on tasks(status, seq);
create index if not exists tasks_open_tests on tasks(seq) where status = 'open' and test is not null;
create index if not exists tasks_tested on tasks(served_to, type, settled_at) where test is not null;
create index if not exists tasks_ungraded on tasks(settled_at) where test is not null and status = 'settled' and grade is null;
create index if not exists tasks_open_copies on tasks(seq) where status = 'open' and copies > 1;
create index if not exists leases_open_task on leases(task) where status = 'open';
create index if not exists leases_open_worker on leases(worker) where status = 'open';
create index if not exists leases_open_expires on leases(expires) where status = 'open';
create index if not exists leases_unbooked on leases(closed) where status = 'submitted' and pay_msat is not null and booked_at is null;
create index if not exists leases_answered on leases(worker, type, closed) where status = 'submitted';
create index if not exists tests_type on tests(type, served) where retired is null;
create index if not exists tasks_settled on tasks(type, settled_at) where test is null;
create index if not exists leases_type_closed on leases(type, closed);
create index if not exists leases_worker_taken on leases(worker, taken);
`;

/** The task side's tables brought to version 2, inside the file's one
 *  migration transaction (`TaskDb.migrate`): made when missing, columns
 *  added, a version 1 `tasks` rebuilt for its CHECKs, then the indexes.
 *  Safe to run on a file already at 2. */
export function taskSchema(db: TaskDb): void {
  const old = (db.prepare("select sql from sqlite_master where type = 'table' and name = 'tasks'").get() as Row | undefined)?.sql as string | undefined;
  if (old !== undefined && !old.includes("'disputed'")) {
    db.exec(TASKS_TABLE("tasks_v2"));
    db.exec(`insert into tasks_v2 (${TASKS_V1_COLUMNS}) select ${TASKS_V1_COLUMNS} from tasks`);
    db.exec("drop table tasks");
    db.exec("alter table tasks_v2 rename to tasks");
  }
  db.exec(SCHEMA);
  for (const [table, column, type] of ADDED) {
    const has = (db.prepare(`pragma table_info(${table})`).all() as Row[]).some((r) => r.name === column);
    if (!has) db.exec(`alter table ${table} add column ${column} ${type}`);
  }
  db.exec(INDEXES);
}

/** Rule 2's guard over `t` (a task) and `ty` (its type), for worker ?2 at
 *  ?3 among the types ?4: shared by `take` and `peek`. A task is takeable
 *  while its live and submitted leases are fewer than the answers it wants
 *  (`copies`, §7.6): one copy, while nobody holds it. */
const TAKEABLE = `t.status = 'open' and t.due > ?3 and ty.enabled = 1 and t.test is null
            and t.type in (select value from json_each(?4))
            and not exists (select 1 from leases l where l.task = t.id and l.worker = ?2)
            and (select count(*) from leases l where l.task = t.id
                  and (l.status = 'submitted' or (l.status = 'open' and l.expires > ?3))) < t.copies
            and not exists (select 1 from leases l where l.worker = ?2 and l.status = 'open' and l.expires > ?3)`;

export class SqliteTaskStore implements TaskStore {
  private readonly s: Record<string, StatementSync>;

  /** On a file `taskSchema` brought to version 2. */
  constructor(private readonly db: TaskDb) {
    const p = (sql: string) => db.prepare(sql);
    this.s = {
      types: p("select * from task_types order by name"),
      type: p("select * from task_types where name = ?"),
      putType: p(
        `insert into task_types (name, app, answer, lease_seconds, within_hours, enabled, changed_at, changed_by, pay_msat, hold_hours, tests, copies)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (name) do update set app = excluded.app, answer = excluded.answer, lease_seconds = excluded.lease_seconds,
           within_hours = excluded.within_hours, enabled = excluded.enabled, changed_at = excluded.changed_at, changed_by = excluded.changed_by,
           pay_msat = excluded.pay_msat, hold_hours = excluded.hold_hours, tests = excluded.tests, copies = excluded.copies`,
      ),
      deleteType: p("delete from task_types where name = ?"),
      openOfType: p("select 1 from tasks where type = ? and status = 'open' limit 1"),
      insertTask: p(
        `insert into tasks (id, type, workflow, run_id, path, show, files, root, job, status, created, due, copies)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
         on conflict (workflow, run_id, path) do nothing`,
      ),
      byKey: p("select * from tasks where workflow = ? and run_id = ? and path = ?"),
      task: p("select * from tasks where id = ?"),
      lease: p("select * from leases where id = ?"),
      heldBy: p("select * from leases where worker = ? and status = 'open' and expires > ? order by taken limit 1"),
      // Rule 2 in one statement: the oldest open task not past due, of a
      // type asked for and enabled, that this worker never held and nobody
      // holds now — while this worker holds nothing live — and never a test
      // instance (§7.1). The type's pay is stamped on the lease (§8.1): what
      // the answer earns, whatever the type's pay becomes after.
      take: p(
        `insert into leases (id, task, worker, type, taken, expires, status, pay_msat)
         select ?1, t.id, ?2, t.type, ?3, ?3 + ty.lease_seconds * 1000, 'open', case when ty.pay_msat > 0 then ty.pay_msat end
           from tasks t join task_types ty on ty.name = t.type
          where ${TAKEABLE}
          order by t.seq
          limit 1`,
      ),
      // The same guard, read only: the type `take` would hand out (§7.2).
      peek: p(`select t.type from tasks t join task_types ty on ty.name = t.type where ${TAKEABLE} order by t.seq limit 1`),
      submit: p("update leases set status = 'submitted', closed = ?1, answer = ?4 where id = ?2 and worker = ?3 and status = 'open' and expires > ?1"),
      settle: p("update tasks set status = 'settled', settled_at = ?1, answer = ?2, by = ?3 where id = ?4 and status = 'open' and due > ?1"),
      // Copies (§7.6): the answers in the order given; a decision, each
      // guarded by the task still open and wanting the answers decided on.
      answers: p("select * from leases where task = ? and status = 'submitted' order by closed, taken, rowid"),
      agreed: p("update tasks set status = 'settled', settled_at = ?1, answer = ?2, by = ?3 where id = ?4 and status = 'open' and copies = ?5"),
      disputed: p("update tasks set status = 'disputed', settled_at = ?1 where id = ?2 and status = 'open' and copies = ?3"),
      more: p("update tasks set copies = copies + 1 where id = ?1 and status = 'open' and copies = ?2"),
      agrees: p("update leases set agrees = ? where id = ?"),
      undecided: p(
        `select * from tasks t where t.status = 'open' and t.copies > 1 and t.test is null
           and (select count(*) from leases l where l.task = t.id and l.status = 'submitted') >= t.copies
         order by t.seq limit ?`,
      ),
      skip: p("update leases set status = 'skipped', closed = ?1, reason = ?2 where id = ?3 and worker = ?4 and status = 'open' and expires > ?1"),
      release: p(
        `update leases set status = 'expired', closed = ?1, reason = ?2
          where worker = ?3 and status = 'open' and (?4 is null or type in (select value from json_each(?4)))`,
      ),
      openById: p("select * from tasks where id = ? and status = 'open' and test is null"),
      openByRun: p("select * from tasks where workflow = ? and run_id = ? and status = 'open' and test is null order by seq"),
      due: p("select * from tasks where status = 'open' and due <= ? and test is null order by seq"),
      close: p("update tasks set status = ?, settled_at = ? where id = ? and status = 'open'"),
      closeLeases: p("update leases set status = 'expired', closed = ?, reason = ? where task = ? and status = 'open'"),
      staleLeases: p("update leases set status = 'expired', closed = ?1 where status = 'open' and expires <= ?1"),
      leasesOf: p("select * from leases where task in (select value from json_each(?)) order by taken, rowid"),
      // §9.4's reads: a worker's leases, and each type's queue.
      byIds: p("select * from tasks where id in (select value from json_each(?))"),
      recentLeases: p("select * from leases where worker = ? order by taken desc, rowid desc limit ?"),
      answeredSince: p("select worker, count(*) n from leases where status = 'submitted' and closed >= ? group by worker"),
      holdingNow: p("select worker, type from leases where status = 'open' and expires > ?"),
      workerWeek: p(
        `select type, sum(status = 'submitted') answered, sum(status = 'skipped') skipped,
                sum((status = 'expired' and reason is null) or (status = 'open' and expires <= ?3)) lost
           from leases where worker = ?1 and taken >= ?2 group by type`,
      ),
      queueOpen: p(
        `select count(*) open,
                sum(not exists (select 1 from leases l where l.task = t.id and l.status = 'open' and l.expires > ?2)) waiting,
                min(case when not exists (select 1 from leases l where l.task = t.id and l.status = 'open' and l.expires > ?2) then t.created end) oldest,
                sum(t.due <= ?3) due_soon, sum(t.due <= ?4) due_hour
           from tasks t where t.type = ?1 and t.status = 'open' and t.test is null and t.due > ?2`,
      ),
      queueHolding: p("select count(*) n from leases where type = ?1 and status = 'open' and expires > ?2"),
      holdingAll: p("select count(*) n from leases where status = 'open' and expires > ?"),
      // Each window as a sum over the week's rows: ?2 the hour's start, ?3
      // the day's, ?4 the week's, ?5 now.
      queueLeft: p(
        `select status, sum(settled_at >= ?2) hour, sum(settled_at >= ?3) day, count(*) week
           from tasks where type = ?1 and test is null and status in ('expired', 'cancelled', 'disputed') and settled_at >= ?4
          group by status`,
      ),
      queuePastDue: p(
        `select sum(due >= ?2) hour, sum(due >= ?3) day, count(*) week
           from tasks where type = ?1 and status = 'open' and test is null and due <= ?5 and due >= ?4`,
      ),
      queueLeases: p(
        `select case when l.status = 'expired' and l.reason is null then 'lost' else l.status end kind,
                sum(l.closed >= ?2) hour, sum(l.closed >= ?3) day, count(*) week
           from leases l join tasks t on t.id = l.task and t.test is null
          where l.type = ?1 and l.closed >= ?4 and (l.status in ('submitted', 'skipped') or (l.status = 'expired' and l.reason is null))
          group by kind`,
      ),
      queueLeasesOut: p(
        `select sum(l.expires >= ?2) hour, sum(l.expires >= ?3) day, count(*) week
           from leases l join tasks t on t.id = l.task and t.test is null
          where l.type = ?1 and l.status = 'open' and l.expires <= ?5 and l.expires >= ?4`,
      ),
      // The newest answers of the week: the newest of an hour or a day are
      // among them, so one read serves all three windows.
      queueToAnswer: p(
        "select settled_at at, settled_at - created ms from tasks where type = ?1 and test is null and status = 'settled' and settled_at >= ?2 order by settled_at desc limit ?3",
      ),
      queueWork: p(
        `select l.closed at, l.closed - l.taken ms from leases l join tasks t on t.id = l.task and t.test is null
          where l.type = ?1 and l.status = 'submitted' and l.closed >= ?2 order by l.closed desc limit ?3`,
      ),
      booked: p("update leases set booked_at = ? where id = ? and booked_at is null"),
      unbooked: p("select * from leases where status = 'submitted' and pay_msat is not null and booked_at is null order by closed limit ?"),
      // An open instance whose lease is no longer live closes (§7.1).
      deadInstances: p(
        `select id from tasks where test is not null and status = 'open'
          and not exists (select 1 from leases l where l.task = tasks.id and l.status = 'open' and l.expires > ?1)`,
      ),
      // §7.2's takeTest: the tests this worker may be served, least-served first.
      servable: p(
        `select * from tests x
          where x.type = ?1 and x.ready = 1 and x.retired is null
            and (x.from_worker is null or x.from_worker <> ?2)
            and (x.from_task is null or not exists (select 1 from leases l where l.task = x.from_task and l.worker = ?2 and l.status = 'submitted'))
            and not exists (select 1 from tasks t where t.test = x.id and t.served_to = ?2)
          order by x.served, x.rowid
          limit 1000`,
      ),
      insertInstance: p(
        `insert into tasks (id, type, workflow, run_id, path, show, files, root, status, created, due, test, served_to)
         values (?1, ?2, '', ?1, '', ?3, ?4, 'test', 'open', ?5, ?6, ?7, ?8)`,
      ),
      insertLease: p(
        `insert into leases (id, task, worker, type, taken, expires, status, pay_msat)
         values (?, ?, ?, ?, ?, ?, 'open', ?)`,
      ),
      served: p("update tests set served = served + 1 where id = ?"),
      insertTest: p(
        `insert into tests (id, type, show, files, expected, grade, from_task, from_worker, ready, created, created_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      test: p("select * from tests where id = ?"),
      editTest: p("update tests set show = ?, expected = ?, grade = ? where id = ? and served = 0 and retired is null"),
      readyTest: p("update tests set ready = 1 where id = ? and ready = 0"),
      retireTest: p("update tests set retired = ?, retired_by = ? where id = ? and retired is null"),
      retireTestsOf: p("update tests set retired = ?, retired_by = ? where type = ? and retired is null"),
      readyTests: p("select count(*) as n from tests where type = ? and ready = 1 and retired is null"),
      testCounts: p(
        `select test, sum(grade = 'pass') as passed, sum(grade = 'fail') as failed, sum(grade = 'error') as errors
           from tasks where test in (select value from json_each(?)) group by test`,
      ),
      testInstances: p(
        `select t.*, l.id as lease_id from tasks t left join leases l on l.task = t.id and l.worker = t.served_to
          where t.test = ? order by t.seq desc`,
      ),
      grade: p("update tasks set grade = ?, graded_at = ?, grade_note = ? where id = ? and test is not null and status = 'settled' and grade is null"),
      ungraded: p("select * from tasks where test is not null and status = 'settled' and grade is null order by settled_at limit ?"),
      // §7.5: per worker and type since the grant, the newest `window`
      // graded instances, every pass and fail, errors, pending, and the real
      // tasks answered.
      standingGraded: p(
        `with p as (select json_extract(value, '$.worker') as worker, json_extract(value, '$.type') as type,
                           json_extract(value, '$.since') as since, json_extract(value, '$.window') as win from json_each(?1)),
              g as (select t.served_to as worker, t.type as type, t.grade as grade, p.win as win,
                           row_number() over (partition by t.served_to, t.type order by t.settled_at desc, t.seq desc) as rn
                      from tasks t join p on t.served_to = p.worker and t.type = p.type
                     where t.test is not null and t.status = 'settled' and t.settled_at >= p.since and t.grade in ('pass', 'fail'))
         select worker, type, sum(rn <= win) as graded, sum(rn <= win and grade = 'pass') as passed, count(*) as graded_all
           from g group by worker, type`,
      ),
      standingOther: p(
        `with p as (select json_extract(value, '$.worker') as worker, json_extract(value, '$.type') as type,
                           json_extract(value, '$.since') as since from json_each(?1))
         select t.served_to as worker, t.type as type, sum(t.grade = 'error') as errors, sum(t.grade is null) as pending
           from tasks t join p on t.served_to = p.worker and t.type = p.type
          where t.test is not null and t.status = 'settled' and t.settled_at >= p.since
          group by t.served_to, t.type`,
      ),
      standingReal: p(
        `with p as (select json_extract(value, '$.worker') as worker, json_extract(value, '$.type') as type,
                           json_extract(value, '$.since') as since from json_each(?1))
         select l.worker as worker, l.type as type, count(*) as real
           from leases l join p on l.worker = p.worker and l.type = p.type join tasks t on t.id = l.task
          where l.status = 'submitted' and l.closed >= p.since and t.test is null
          group by l.worker, l.type`,
      ),
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
      this.s.putType.run(
        t.name,
        t.app,
        JSON.stringify(t.answer),
        t.leaseSeconds,
        t.withinHours,
        t.enabled ? 1 : 0,
        t.changedAt,
        t.changedBy ?? null,
        payMsatOf(t) ?? null,
        t.holdHours,
        t.tests ? JSON.stringify(t.tests) : null,
        t.copies ? JSON.stringify(t.copies) : null,
      );
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
        t.copies ?? 1,
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
    if (q.test !== undefined) where.push(q.test ? "test is not null" : "test is null");
    if (q.by) {
      // Any answer of theirs, a copy's too (`leases_answered`).
      where.push("id in (select task from leases where worker = ? and status = 'submitted')");
      args.push(q.by);
    }
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

  async byIds(ids: string[]): Promise<TaskRecord[]> {
    if (!ids.length) return [];
    return (this.s.byIds.all(JSON.stringify(ids)) as Row[]).map(taskOf);
  }

  async recentLeases(worker: string, limit: number): Promise<Lease[]> {
    return (this.s.recentLeases.all(worker, Math.max(0, Math.floor(limit))) as Row[]).map(leaseOf);
  }

  async workersNow(since: number, now: number): Promise<{ answered: Record<string, number>; holding: Record<string, string> }> {
    const answered: Record<string, number> = {};
    for (const r of this.s.answeredSince.all(since) as Row[]) answered[r.worker as string] = Number(r.n);
    const holding: Record<string, string> = {};
    for (const r of this.s.holdingNow.all(now) as Row[]) holding[r.worker as string] = r.type as string;
    return { answered, holding };
  }

  async workerWeek(worker: string, since: number, now: number): Promise<Record<string, WorkerWeek>> {
    const out: Record<string, WorkerWeek> = {};
    for (const r of this.s.workerWeek.all(worker, since, now) as Row[]) {
      out[r.type as string] = { answered: Number(r.answered ?? 0), skipped: Number(r.skipped ?? 0), lost: Number(r.lost ?? 0) };
    }
    return out;
  }

  async stats(o: { types: string[]; now: number }): Promise<{ types: QueueCounts[]; holding: number }> {
    const { now } = o;
    const hour = now - STATS_WINDOWS.hour;
    const day = now - STATS_WINDOWS.day;
    const week = now - STATS_WINDOWS.week;
    const n = (v: unknown) => Number(v ?? 0);
    // Synchronous on the one connection, so the counts are of one moment.
    const types = o.types.map((type): QueueCounts => {
        const open = this.s.queueOpen.get(type, now, now + DUE_SOON_MS, now + STATS_WINDOWS.hour) as Row;
        const windows = {} as Record<StatsWindow, WindowCounts>;
        for (const w of Object.keys(STATS_WINDOWS) as StatsWindow[]) {
          windows[w] = { answered: 0, expired: 0, cancelled: 0, disputed: 0, skipped: 0, leasesLost: 0, toAnswer: [], work: [] };
        }
        const add = (rows: Row[], key: (r: Row) => keyof WindowCounts | undefined) => {
          for (const r of rows) {
            const k = key(r);
            if (!k) continue;
            for (const w of Object.keys(STATS_WINDOWS) as StatsWindow[]) (windows[w][k] as number) += n(r[w]);
          }
        };
        add(this.s.queueLeft.all(type, hour, day, week) as Row[], (r) => r.status as "expired" | "cancelled" | "disputed");
        add(this.s.queuePastDue.all(type, hour, day, week, now) as Row[], () => "expired");
        add(this.s.queueLeases.all(type, hour, day, week) as Row[], (r) => (r.kind === "submitted" ? "answered" : r.kind === "skipped" ? "skipped" : "leasesLost"));
        add(this.s.queueLeasesOut.all(type, hour, day, week, now) as Row[], () => "leasesLost");
        const times = (rows: Row[], k: "toAnswer" | "work") => {
          for (const r of rows) {
            for (const w of Object.keys(STATS_WINDOWS) as StatsWindow[]) if (n(r.at) >= now - STATS_WINDOWS[w]) windows[w][k].push(n(r.ms));
          }
        };
        times(this.s.queueToAnswer.all(type, week, STATS_SAMPLE) as Row[], "toAnswer");
        times(this.s.queueWork.all(type, week, STATS_SAMPLE) as Row[], "work");
        const oldest = opt<number>(open.oldest);
        return {
          type,
          waiting: n(open.waiting),
          working: n(open.open) - n(open.waiting),
          ...(oldest !== undefined ? { oldestCreated: oldest } : {}),
          dueSoon: n(open.due_soon),
          dueHour: n(open.due_hour),
          holding: n((this.s.queueHolding.get(type, now) as Row).n),
          windows,
        };
      });
    return { types, holding: n((this.s.holdingAll.get(now) as Row).n) };
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

  async settle(o: Parameters<TaskStore["settle"]>[0]): Promise<SettleResult | undefined> {
    try {
      return this.db.tx(() => {
        const l = this.s.lease.get(o.lease) as Row | undefined;
        if (!l) return undefined;
        const t = this.s.task.get(l.task as string) as Row | undefined;
        const many = !!t && (t.copies as number) > 1 && t.test === null;
        // A copies task's answer stays on its lease (§7.6); one copy's is the task's.
        if (Number(this.s.submit.run(o.now, o.lease, o.worker, many ? JSON.stringify(o.answer) : null).changes) !== 1) return undefined;
        if (!many) {
          // The task left `open` (or ran past due) while the lease was live:
          // nothing is written, the lease included.
          if (Number(this.s.settle.run(o.now, JSON.stringify(o.answer), o.worker, l.task as string).changes) !== 1) throw new Unsettled();
          return { task: taskOf(this.s.task.get(l.task as string) as Row) };
        }
        if (t!.status !== "open" || (t!.due as number) <= o.now) throw new Unsettled();
        const copies = t!.copies as number;
        const answers = (this.s.answers.all(t!.id as string) as Row[]).map(leaseOf);
        if (answers.length < copies) return { task: taskOf(t!) };
        const decision = o.decide?.(answers.map((a) => a.answer), copies);
        if (!decision) return { task: taskOf(t!), answers };
        if (!this.apply(t!.id as string, copies, answers, decision, o.now)) throw new Unsettled();
        return { task: taskOf(this.s.task.get(t!.id as string) as Row), answers: (this.s.answers.all(t!.id as string) as Row[]).map(leaseOf), decision };
      }, true);
    } catch (e) {
      if (e instanceof Unsettled) return undefined;
      throw e;
    }
  }

  async decide(o: { task: string; copies: number; decision: CopiesDecision; now: number }): Promise<TaskRecord | undefined> {
    return this.db.tx(() => {
      const t = this.s.task.get(o.task) as Row | undefined;
      if (!t || t.status !== "open" || t.copies !== o.copies || t.test !== null) return undefined;
      const answers = (this.s.answers.all(o.task) as Row[]).map(leaseOf);
      if (answers.length !== o.copies) return undefined;
      return this.apply(o.task, o.copies, answers, o.decision, o.now) ? taskOf(this.s.task.get(o.task) as Row) : undefined;
    }, true);
  }

  async undecided(limit: number): Promise<TaskRecord[]> {
    return (this.s.undecided.all(Math.max(0, Math.floor(limit))) as Row[]).map(taskOf);
  }

  /** Inside a transaction: a copies task's decision written (§7.6), guarded
   *  by the task still open and wanting `copies`. False when it was not. */
  private apply(task: string, copies: number, answers: Lease[], d: CopiesDecision, now: number): boolean {
    if (d.outcome === "more") return Number(this.s.more.run(task, copies).changes) === 1;
    if (d.outcome === "agreed") {
      const won = answers[d.index]!;
      if (Number(this.s.agreed.run(now, JSON.stringify(won.answer ?? null), won.worker, task, copies).changes) !== 1) return false;
    } else if (Number(this.s.disputed.run(now, task, copies).changes) !== 1) return false;
    answers.forEach((a, i) => this.s.agrees.run(d.outcome === "agreed" && d.agrees[i] === true ? 1 : 0, a.id));
    return true;
  }

  async skip(o: { lease: string; worker: string; reason?: string; now: number }): Promise<boolean> {
    return this.db.tx(() => {
      const ok = Number(this.s.skip.run(o.now, o.reason ?? null, o.lease, o.worker).changes) === 1;
      if (ok) this.closeInstances(o.now);
      return ok;
    });
  }

  async release(o: { worker: string; types?: string[]; reason: string; now: number }): Promise<number> {
    return this.db.tx(() => {
      const n = Number(this.s.release.run(o.now, o.reason, o.worker, o.types ? JSON.stringify(o.types) : null).changes);
      if (n) this.closeInstances(o.now);
      return n;
    });
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
      this.closeInstances(now);
      return { leases, expired };
    });
  }

  async booked(lease: string, at: number): Promise<void> {
    this.db.tx(() => this.s.booked.run(at, lease));
  }

  async unbooked(limit: number): Promise<Lease[]> {
    return (this.s.unbooked.all(Math.max(0, Math.floor(limit))) as Row[]).map(leaseOf);
  }

  // ── tests (§7) ────────────────────────────────────────────────────────

  async peek(o: { worker: string; types: string[]; now: number }): Promise<string | undefined> {
    if (!o.types.length) return undefined;
    // `TAKEABLE` numbers its parameters from ?2, as `take`'s does: ?1 is unused here.
    return (this.s.peek.get(null, o.worker, o.now, JSON.stringify(o.types)) as Row | undefined)?.type as string | undefined;
  }

  async takeTest(o: { worker: string; type: string; lease: string; task: string; now: number; pick: (n: number) => number }): Promise<Lease | undefined> {
    return this.db.tx(() => {
      if (this.s.heldBy.get(o.worker, o.now)) return undefined;
      const kind = this.s.type.get(o.type) as Row | undefined;
      if (!kind || kind.enabled !== 1) return undefined;
      const open = this.s.servable.all(o.type, o.worker) as Row[];
      if (!open.length) return undefined;
      const ties = open.filter((x) => x.served === open[0]!.served);
      const test = ties[pickIn(o.pick, ties.length)]!;
      const expires = o.now + (kind.lease_seconds as number) * 1000;
      // An instance lives as long as its one lease.
      this.s.insertInstance.run(o.task, o.type, test.show as string, test.files as string, o.now, expires, test.id as string, o.worker);
      const pay = opt<number>(kind.pay_msat);
      this.s.insertLease.run(o.lease, o.task, o.worker, o.type, o.now, expires, pay !== undefined && pay > 0 ? pay : null);
      this.s.served.run(test.id as string);
      return leaseOf(this.s.lease.get(o.lease) as Row);
    });
  }

  async putTest(t: NewTest): Promise<TestRecord> {
    return this.db.tx(() => {
      this.s.insertTest.run(
        t.id,
        t.type,
        JSON.stringify(t.show ?? null),
        JSON.stringify(t.files),
        JSON.stringify(t.expected ?? null),
        t.grade === undefined ? null : JSON.stringify(t.grade),
        t.fromTask ?? null,
        t.fromWorker ?? null,
        t.ready ? 1 : 0,
        t.created,
        t.createdBy ?? null,
      );
      return testOf(this.s.test.get(t.id) as Row);
    });
  }

  async test(id: string): Promise<TestRecord | undefined> {
    const row = this.s.test.get(id) as Row | undefined;
    return row ? testOf(row) : undefined;
  }

  async tests(q: { type?: string; retired?: boolean } = {}): Promise<TestRecord[]> {
    const where: string[] = [];
    const args: string[] = [];
    if (q.type) {
      where.push("type = ?");
      args.push(q.type);
    }
    if (q.retired !== undefined) where.push(q.retired ? "retired is not null" : "retired is null");
    const sql = `select * from tests ${where.length ? `where ${where.join(" and ")}` : ""} order by rowid`;
    return (this.db.prepare(sql).all(...args) as Row[]).map(testOf);
  }

  async editTest(id: string, change: TestChange): Promise<"edited" | "missing" | "in_use"> {
    return this.db.tx(() => {
      const row = this.s.test.get(id) as Row | undefined;
      if (!row) return "missing";
      const grade = change.grade === null ? null : change.grade === undefined ? (row.grade as string | null) : JSON.stringify(change.grade);
      const changed = this.s.editTest.run(
        change.show === undefined ? (row.show as string) : JSON.stringify(change.show),
        change.expected === undefined ? (row.expected as string) : JSON.stringify(change.expected),
        grade,
        id,
      ).changes;
      return Number(changed) === 1 ? "edited" : "in_use";
    });
  }

  async readyTest(id: string): Promise<boolean> {
    return this.db.tx(() => Number(this.s.readyTest.run(id).changes) === 1);
  }

  async retireTest(id: string, by: string | undefined, at: number): Promise<TestRecord | undefined> {
    return this.db.tx(() => {
      this.s.retireTest.run(at, by ?? null, id);
      const row = this.s.test.get(id) as Row | undefined;
      return row ? testOf(row) : undefined;
    });
  }

  async retireTestsOf(type: string, by: string | undefined, at: number): Promise<number> {
    return this.db.tx(() => Number(this.s.retireTestsOf.run(at, by ?? null, type).changes));
  }

  async readyTests(type: string): Promise<number> {
    return (this.s.readyTests.get(type) as Row).n as number;
  }

  async testCounts(ids: string[]): Promise<Record<string, TestCounts>> {
    const out: Record<string, TestCounts> = {};
    for (const id of ids) out[id] = { passed: 0, failed: 0, errors: 0 };
    if (!ids.length) return out;
    for (const r of this.s.testCounts.all(JSON.stringify(ids)) as Row[]) {
      out[r.test as string] = { passed: Number(r.passed ?? 0), failed: Number(r.failed ?? 0), errors: Number(r.errors ?? 0) };
    }
    return out;
  }

  async testInstances(id: string): Promise<TestInstance[]> {
    return (this.s.testInstances.all(id) as Row[]).map((r) => {
      const t = taskOf(r);
      const note = opt<string>(r.grade_note);
      const lease = opt<string>(r.lease_id);
      return {
        task: t.id,
        ...(lease !== undefined ? { lease } : {}),
        worker: t.servedTo!,
        status: t.status,
        served: t.created,
        ...(t.status === "settled" ? { answer: t.answer, answeredAt: t.settledAt! } : {}),
        ...(t.grade ? { grade: t.grade, gradedAt: t.gradedAt! } : {}),
        ...(note !== undefined ? { note } : {}),
      };
    });
  }

  async grade(o: { task: string; grade: GradeResult; note: string; at: number }): Promise<boolean> {
    return this.db.tx(() => Number(this.s.grade.run(o.grade, o.at, o.note.slice(0, GRADE_NOTE_MAX), o.task).changes) === 1);
  }

  async ungraded(limit: number): Promise<TaskRecord[]> {
    return (this.s.ungraded.all(Math.max(0, Math.floor(limit))) as Row[]).map(taskOf);
  }

  async standings(q: StandingQuery[]): Promise<StandingRow[]> {
    if (!q.length) return [];
    const arg = JSON.stringify(q);
    const key = (w: unknown, t: unknown) => `${w}\0${t}`;
    const graded = new Map((this.s.standingGraded.all(arg) as Row[]).map((r) => [key(r.worker, r.type), r]));
    const other = new Map((this.s.standingOther.all(arg) as Row[]).map((r) => [key(r.worker, r.type), r]));
    const real = new Map((this.s.standingReal.all(arg) as Row[]).map((r) => [key(r.worker, r.type), r]));
    return q.map((p) => {
      const k = key(p.worker, p.type);
      const g = graded.get(k);
      const o = other.get(k);
      return {
        worker: p.worker,
        type: p.type,
        graded: Number(g?.graded ?? 0),
        passed: Number(g?.passed ?? 0),
        gradedAll: Number(g?.graded_all ?? 0),
        errors: Number(o?.errors ?? 0),
        pending: Number(o?.pending ?? 0),
        real: Number(real.get(k)?.real ?? 0),
      };
    });
  }

  /** Inside a transaction: an open instance whose lease is no longer live
   *  closes as `expired`, its open lease with it (§7.1). Never heard by
   *  `onSettle`: no run waits on an instance. */
  private closeInstances(now: number): void {
    for (const r of this.s.deadInstances.all(now) as Row[]) {
      this.s.close.run("expired", now, r.id as string);
      this.s.closeLeases.run(now, "task expired", r.id as string);
    }
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
    holdHours: opt<number>(r.hold_hours) ?? DEFAULT_HOLD_HOURS,
    changedAt: r.changed_at as number,
  };
  const pay = opt<number>(r.pay_msat);
  if (pay !== undefined && pay > 0) t.paySats = pay / 1000;
  const tests = opt<string>(r.tests);
  if (tests !== undefined) t.tests = JSON.parse(tests) as TestRules;
  const copies = opt<string>(r.copies);
  if (copies !== undefined) t.copies = JSON.parse(copies) as CopiesRule;
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
    root: r.root as TaskRecord["root"],
    status: r.status as TaskStatus,
    created: r.created as number,
    due: r.due as number,
    copies: (r.copies as number | undefined) ?? 1,
  };
  const job = opt<string>(r.job);
  if (job !== undefined) t.job = job;
  const settledAt = opt<number>(r.settled_at);
  if (settledAt !== undefined) t.settledAt = settledAt;
  const answer = opt<string>(r.answer);
  if (answer !== undefined) t.answer = JSON.parse(answer);
  const by = opt<string>(r.by);
  if (by !== undefined) t.by = by;
  const test = opt<string>(r.test);
  if (test !== undefined) t.test = test;
  const servedTo = opt<string>(r.served_to);
  if (servedTo !== undefined) t.servedTo = servedTo;
  const grade = opt<GradeResult>(r.grade);
  if (grade !== undefined) t.grade = grade;
  const gradedAt = opt<number>(r.graded_at);
  if (gradedAt !== undefined) t.gradedAt = gradedAt;
  return t;
}

function testOf(r: Row): TestRecord {
  const x: TestRecord = {
    id: r.id as string,
    type: r.type as string,
    show: JSON.parse(r.show as string),
    files: JSON.parse(r.files as string) as string[],
    expected: JSON.parse(r.expected as string),
    ready: r.ready === 1,
    created: r.created as number,
    served: r.served as number,
  };
  const grade = opt<string>(r.grade);
  if (grade !== undefined) x.grade = JSON.parse(grade) as GradeRule;
  const fields: Array<[string, keyof TestRecord]> = [
    ["from_task", "fromTask"],
    ["from_worker", "fromWorker"],
    ["created_by", "createdBy"],
    ["retired", "retired"],
    ["retired_by", "retiredBy"],
  ];
  for (const [col, k] of fields) {
    const v = opt(r[col]);
    if (v !== undefined) (x as unknown as Record<string, unknown>)[k] = v;
  }
  return x;
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
  const pay = opt<number>(r.pay_msat);
  if (pay !== undefined && pay > 0) l.payMsat = pay;
  const booked = opt<number>(r.booked_at);
  if (booked !== undefined) l.bookedAt = booked;
  const answer = opt<string>(r.answer);
  if (answer !== undefined) l.answer = JSON.parse(answer);
  const agrees = opt<number>(r.agrees);
  if (agrees !== undefined) l.agrees = agrees === 1;
  return l;
}
