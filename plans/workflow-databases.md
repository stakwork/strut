# Workflow-owned databases — domain data a workflow keeps, in a database strut runs

> **Status (2026-11-26): proposed. Nothing is built.** Written after a read of
> strut `main` @fbc71eb: `src/apps/data.ts` and `src/steps/lib/sqlite/` (an
> app's own SQLite), `src/tasks/db.ts` (the task store), `src/payments/ledger-sqlite.ts`
> (the payments ledger), `src/step-lint.ts` (what a custom step may import and
> reach), `src/packages/` (what travels in a package) and stakwork/strut#906
> (task groups, open). Grounded in one real case: Book Scanning on a
> strut server (the prototype is job 673442ac, its plan job 74592ccb, both
> on that server, not in this repository). Companions: `human-steps.md` (§4 the
> task store; its "Rejected" list names the app's SQLite as the store),
> `apps.md` §4.4 (an app's own SQLite, built), `generic-storage.md` (one
> boundary per layer), `retention.md`, `moving.md` (hosts and backups).
> Decisions marked **proposed** are mine; none is the owner's yet.

## Problem

A workflow that does real work keeps domain data: who holds which book, which
photo counts for which page, which shop was visited. Strut has no place for
it that a workflow can use safely, so each one invents a store. Book Scanning
(task type `book-scan-page`, workflow `book-scan-page`, server-local steps
`book/ledger`, `book/ledger-v2`, `book/status`) kept it in append-only
`jsonl` files under `/data/workspace/book-scanning`, and the failures are the
ones a file gives:

| What happened or could | Why |
|---|---|
| Two workers interleave or lose rows | The Python scripts take one `flock`; the TypeScript steps take none, and `check` and `commit` release the lock between them |
| Two workers claim one book (one book, one owner) | No uniqueness: a check, then a later append, with nothing in between |
| One bad line breaks every read | Every read parses the whole file with no per-line guard |
| Reads slow as the file grows | No index: each request re-reads and re-parses everything |
| The backup is stale | One manual copy, a day old, on the same disk |
| Rules written twice | A Python and a TypeScript copy of "what is a legal move", which drift |

None of this is about books. Any task type with a ledger (a shop survey, a
labelling batch, an inventory) meets the same list. Strut already owns three
SQLite files and the know-how for each; what is missing is the same thing
offered to a workflow, so the next one does not rebuild a gateway, a lock, a
migration and a backup.

### What strut has today (read from source)

| Store | File | Mode | Who writes | What it teaches |
|---|---|---|---|---|
| Task store | `<dataDir>/tasks/tasks.db` (`src/tasks/db.ts`) | WAL; every write one `BEGIN IMMEDIATE`; `synchronous=FULL` on accepted answers; folder 0700, file 0600; additive `create table if not exists` | strut's own service, one process | The platform's generic state: tasks, leases, answers, pay, groups. Not the place for a workflow's tables (`human-steps.md` §4.1) |
| Payments ledger | `src/payments/ledger-sqlite.ts` | WAL, `synchronous=NORMAL`, `busy_timeout=10000`, `user_version` | strut's own service | Money wants its own file and its own durability setting |
| **An app's own SQLite** | `<dataDir>/apps/<app>/data.db` (`src/apps/data.ts`) | **Rollback journal, no WAL**; one connection kept open per file; `busy_timeout=5000`; owner-only | the app's page, its workflows, its steps, through `sqlite/query`, `sqlite/exec`, `sqlite/batch` (or `ctx.services.appDb.open`) | **Most of the answer already exists**: `db/*.sql` migrations applied once each and recorded with their sha256 (`_strut_migrations`), a statement checked by `sqlRefusal` (no `ATTACH`, `VACUUM INTO`, `load_extension`, PRAGMA allowlist), one statement per call, `:actor` bound by strut, `GET /apps/:name/data` exporting a `VACUUM INTO` copy |

So the question is not "should strut offer a SQL store to workflows". It does,
to apps. The questions are what is missing for a task type that has no app of
its own, and what must be added before a ledger of money-adjacent data can
live there.

Gaps, each seen in the Book Scanning work:

1. **The namespace is an app.** A workflow with no app passes `app: <name>`
   naming one that exists (`appDatabase`, `_shared.ts`); a task type that
   several apps draw, or a package with none, has no database to call its own.
2. **No WAL, one connection in one process.** Fine for one writer in strut's
   process; but the Book Scanning writers are separate Python processes
   (server-local steps shell out), which need the file safe across processes.
3. **No transaction with a read in the middle.** `sqlite/batch` is a list of
   independent statements. "Read the owner, decide, write" (claim a book) is
   not expressible except as one statement with `INSERT … ON CONFLICT` and a
   follow-up read, with no way to roll the whole back on a rule the SQL cannot say.
4. **Identity is `:actor` only**, a binding in a statement, not a check the
   platform makes (row-level ownership is a convention in the SQL).
5. **No backup.** `GET /apps/:name/data` is a download on request. Nothing
   schedules a copy, keeps several, copies it off the box or drills a restore.
6. **No way for a task type to say "this is my schema".** A migration is a file in an app's
   `db/`; a type saved by `task/set-type` has no such field.
7. **A visitor cannot call it.** `sqlite/*` is refused in the public view and
   a custom step that reaches `appDb` warns under `servicesPastVisitor`
   (`VISITOR_SERVICES`: `http, secrets, graph, runs, people, dataDir`): a worker who signs
   in through Peel runs as a visitor, so `book/ledger` on the shell failed
   for workers on 2026-11-19. Domain data a worker's page needs is read
   through a scoped route or a workflow, never by giving the worker SQL.

## Goals

1. A workflow or task type **declares** the tables it owns and gets a
   database for them, with no store, lock or backup of its own to write.
2. The **platform, not each user, guarantees** what files could not:
   serialised writes with real transactions, uniqueness and check
   constraints, one implementation of the rules, crash safety.
3. **Identity comes from `ctx`**, never from input: a step cannot write
   as another worker.
4. **Schema changes are additive, versioned and rehearsed**: a dry run that
   diffs before anything is cut over, and a way back.
5. **Backups are a platform feature**: scheduled, kept, copied off the box,
   restore-drilled.
6. Reuse what exists: the `sqlite/*` steps, `appDb`, the migrations
   runner, the app door's grants. **As simple as possible**: one more way to name a
   database, not a new subsystem.

## Non-goals

- **Replacing the task store or the payments ledger.** Tasks, leases,
  answers, pay and group status stay the platform's (below, "The boundary").
- **A general database server.** One box, one process family, no network
  clients, no replication in v1.
- **Raw SQL from untrusted input.** A worker's page never holds SQL; see
  "Access".
- **A query language over the graph.** The graph store is for knowledge,
  not transactions (Alternatives).
- **Cross-database joins or transactions** across two namespaces.
- **Porting the existing Book Scanning code in this plan.** It is the worked
  example; its own plan owns its migration.

## Decided

| Question | Decision |
|---|---|
| Engine | **proposed.** SQLite, one file per namespace, WAL, `node:sqlite`. No new service. Postgres is phase 3 and optional |
| Namespace | **proposed.** A database belongs to an **owner**: an app (as today), a task type, or a package. Its file is `<dataDir>/db/<kind>/<name>/data.db`. The existing `<dataDir>/apps/<app>/data.db` stays where it is and is the `app` owner's file |
| API | **proposed.** The existing `sqlite/*` steps stay the one door. Add a `db/transact` step for read-decide-write, and make `app` optional in favour of `database` (the namespace). No second SQL dialect or typed ORM in v1 |
| Writes | **proposed.** One writer: the gateway in strut's process takes turns (`BEGIN IMMEDIATE`); a separate process (a Python step) uses the same file in WAL, under SQLite's own locks, until it moves behind `db/*` |
| Identity | **proposed.** `:actor` stays; add `:role` and a per-table `owner` check in `db/transact`'s guards. Never an input |
| Schema | **proposed.** `db/*.sql` migrations, additive, applied once each, sha256 recorded: the app rule, extended to task types and packages |
| Backups | **proposed.** Strut schedules them for every namespace with data: online backup, integrity check, retention, and an off-box target the admin names. Phase 2 |
| The boundary | **proposed.** Platform generic state (tasks, answers, pay, groups) in the platform stores; domain data in a workflow-owned database. A database never holds an earning, a lease or a verdict |

## The boundary

| Belongs to the platform (`tasks.db`, `ledger`) | Belongs to the workflow's database |
|---|---|
| A task, its lease, its answer, its files | Who holds a book; which photo fills which slot; which shop was visited |
| Pay, earnings, holds, payouts | What a "count" means for a domain report (never the pay itself) |
| #906's group: status lifecycle, owner, history, `group_closed` refusal | Domain rows that *reference* a group by its id (`group_id text`), and their own domain facts |
| Worker status, standing, tests | Anything a worker's profile does not already say |

Rules that keep it clean:

- **The platform is the authority for what it records.** A database may
  mirror a platform fact (a group's status) for fast reads, with a column
  saying so (`status_source`), and a reconciliation that alerts on a
  difference. It never decides pay, a verdict or a lease.
- **No foreign key crosses a file.** A reference is a text id, checked by a
  step, not by SQLite.
- **If a feature is useful to every task type, it belongs in the platform**
  (#906's group owner and status are the example). A workflow database
  is for what only that workflow's domain needs. Book Scanning's "one book,
  one owner" is the test case: #906 gives an owner and a status lifecycle but
  admits a different worker to an open group; the open question is whether an
  `ownerOnly` option belongs on the type (platform) or the rule is a
  `unique` constraint in the book database (domain). Default: the
  constraint, since the book identity key is a domain normaliser; the
  platform option can follow if a second type asks.
- **Composition with #906.** A task type that manages groups and has a
  database: the run names the group (`task/reply { group }`), the database
  row carries `group_id`, and Finish is one step that does the database
  transaction and then `task/group-move`. If the move fails the row keeps a
  `group_sync = 'pending'` column and a retry step finishes it (an outbox).
  No distributed transaction is attempted.

## The user-facing model

### Declaring tables

A database is declared by files beside what owns it:

```
apps/<app>/db/001-init.sql              # today, built
workflows/<name>.db/001-init.sql        # a workflow-owned database (proposed)
task type: `database: { migrations: <package path or inline> }`  # on task/set-type
packages: db/<namespace>/*.sql          # in a package, next to steps/
```

- **Files, in name order, each applied once in its own transaction**,
  recorded in `_strut_migrations` with its sha256. Exactly `migrateDb`
  today. An edited applied file is a warning, never a re-run.
- **Additive only by rule**: `create table/index if not exists`, `add
  column` (nullable or with a default). A statement that drops a table or
  column, renames, or rewrites a type is refused by a lint at publish unless
  the file is marked `-- strut: breaking` and an admin accepts it on a card
  (the person's yes, as every strut change that cannot be undone).
- **Constraints are the point**: `UNIQUE`, `CHECK`, `NOT NULL`, `STRICT`
  tables, foreign keys within the file (`PRAGMA foreign_keys=ON` set by the
  gateway, not by the SQL), partial unique indexes. A guide page (a Concept,
  as strut keeps what a model is told) lists the patterns: idempotency key
  `unique`, one owner `unique`, status moves in a trigger or a `CHECK`.
- **A version number**: `PRAGMA user_version` is the number of the last
  applied migration; `GET` of a database says it with the file hashes.
- **Preview is free**: `check` already runs migrations on an empty
  in-memory database at build; the same runs at publish of a workflow that
  declares one.

### Naming

A step reaches a database by **namespace**, resolved from `ctx` before any
input is read: the app (`ctx.app`), else the workflow's own declared
database, else the task type of the run. An input may *narrow* to another
namespace only where the caller is the owner or an admin (today: `app`
names one that exists and may not be set beside `ctx.app`). This keeps the
rule "a page never reaches another's file".

## The API workflows and steps use

One door, the `sqlite/*` family already granted by `grants.sqlite` (apps)
and by a workflow's own declaration. Additions are small:

| Step | State | What it does |
|---|---|---|
| `sqlite/query { sql, params?, maxRows? }` | built | A read, `query_only`, capped rows and bytes |
| `sqlite/exec { sql, params? }` | built | One statement |
| `sqlite/batch { statements }` | built | Several, one transaction, no reads between |
| `sqlite/transact { steps }` (proposed; name chosen with the family) | new | **A read-decide-write in one transaction.** Statements run in order; a step may name `bind: { owner: "$.rows[0].owner" }` of an earlier read, and `guard: { expect: "rows == 0", else: "book_taken" }`; a guard that fails rolls the whole back and returns the code. No loops, no code: a list the runtime interprets, so no transaction ever spans an `await` of a step's own |
| Idempotency | new | `exec` and `transact` accept `idempotencyKey`; the gateway records `(namespace, key) → result` in `_strut_idempotency` in the same transaction and returns the first result on a replay. A run that is resumed (strut replays steps) is safe by default |
| Optimistic check | new | `exec { …, expectChanges: 1 }`: zero changed rows is a refusal `conflict`, so "update where version = ?" is one line |
| Typed `insert/upsert/select` | **not v1** | Sugar over the above; add when three users write the same SQL |

Always:

- **Parameters are bound, never spliced.** The statement is a string with
  `?` or `:name`; `sqlRefusal` strips strings and comments before checking,
  as today.
- **`:actor` and `:role`** are bound by strut from `ctx` (`withActor`).
  A value the caller names `actor` is replaced. A guard like `owner = :actor`
  is how "row-level ownership" is written: it is in SQL the owner of the
  database wrote and reviewed, and strut guarantees the binding, not the rule.
- **A statement is bounded**: today `node:sqlite` has no interrupt. Phase 1
  moves long reads to a worker thread with a deadline (a slow query is
  killed, logged and counted), since one slow read otherwise stalls every
  waiting write behind the one synchronous connection.
- **From TypeScript and Python custom steps**: a TypeScript step uses
  `ctx.services.appDb`'s successor (`ctx.services.db.open(namespace)`);
  a step that shells out (the Python scripts) gets the file path from
  `ctx.services.db.path(namespace)` where its owner may open it (below,
  concurrency). Phase 0 ships the shared gateway library; phase 1 makes
  both go through the step family so there is one implementation.

## Storage and concurrency

### Engine

**SQLite, one file per namespace, WAL.** Strut already ships `node:sqlite`
(Node 22+), has two WAL files in production use (tasks, payments) and an app
file in the rollback journal. A ledger of 1 to 100 writes a second (the
scale of crowd work here) is far inside what one SQLite writer does. Backup
is a file operation. No new service to run, secure or upgrade.

Pragmas set by the gateway on open (never by SQL): `journal_mode=WAL`,
`synchronous=FULL` by default (a declared database may ask `NORMAL`; the
payments ledger shows both are in use), `busy_timeout=10000`,
`foreign_keys=ON`, `trusted_schema=OFF`, `user_version` managed by migrations.
Moving an existing app file from the rollback journal to WAL is a one-time
`PRAGMA journal_mode=WAL` at the next open; **it changes the file at rest**
(`-wal` and `-shm` beside it), which the export (`VACUUM INTO`) and the
moving doc (§ "WAL is folded into its file") already treat, but is a reason
to make WAL opt-in per database in phase 1 and the default only for new ones.

### Files and size

- `<dataDir>/db/<kind>/<name>/data.db`, folder 0700, file 0600, as the
  task store. Not under the job-visible workspace tree and not under
  `tasks/`, so a task-store migration or a job's cleanup never touches it.
- **Photos and files stay files**; a row holds the path and the hash. A
  database that stores blobs is refused by a lint on `BLOB` columns above a
  size (default 64 KB a value).
- **Limits**: a file size cap per namespace (default 2 GB, an admin may
  raise it), row-count and statement-size caps (the query steps already cap
  1,000 rows by default, 10,000 and 4 MB at most), a write rate cap per
  caller. A namespace over its cap refuses writes, keeps reads, and shows in
  the staff app.

### Concurrency model

- **Inside strut's process**: one connection per file, kept open; every
  statement is synchronous, so callers take turns and no transaction
  interleaves (the app database's rule today). `sqlite/transact` runs wholly
  inside one such turn.
- **From another process (a Python step)**: SQLite's file locks make WAL
  safe across processes; each write is `BEGIN IMMEDIATE`, a waiting writer
  queues on `busy_timeout`. This is exactly the Book Scanning prototype's
  model (`bookdb.py`, 20 parallel writers and 10 workers racing for one
  book, 9 of 9 tests passing). It is a bridge: phase 1's goal is that no
  step opens the file itself.
- **The decision and the write are one transaction.** That is the whole fix
  for "check, then commit": the claim, the owner test, the closed-status
  test and the idempotency lookup are inside the same `BEGIN IMMEDIATE`.
- **Model calls and uploads happen outside a transaction.** A transaction
  holds no network wait. A photo is written to disk before the transaction;
  an orphan file after a rollback is swept.
- **Limits stated honestly**: one box; one writer at a time per file; a
  long read in the main process blocks writers (hence the deadline above);
  no multi-writer scale-out. If a second server must write the same data,
  that is the Postgres trigger (phase 3).

## Access control and tenancy

| Who | Reads | Writes | How |
|---|---|---|---|
| The owning workflow / task type / app | Yes | Yes | `ctx` resolves its namespace; no input needed |
| A step of another workflow | No | No | Naming another namespace is refused unless the caller is an admin |
| An admin app (first-party, `admin: true`, e.g. `strut/workers` or a staff view of a ledger) | Yes, through its own grant | No by default | `grants.sqlite` names the namespace read-only; `strut/` first-party apps already act with the viewer's rights (`jamie-app.md` §3) |
| A worker app (visitor through Peel) | Only through a **scoped read**: a step the owner wrote and granted (`hosts:` / `worker: true`), whose SQL is fixed, reads `:actor`'s rows | Only through an owner's step that writes as `:actor` | The worker never sends SQL. The existing rule for `task/*` steps (identity from the session, never input) is the model |
| A job agent / the builder | Read on request | A write only through a gated step (a proposal a person accepts), never `exec` of free SQL | Same as `sqlite/*` today (`llm`, `agent`, `exec` refused in app grants) |
| The public view | **Never** | **Never** | As `sqlite/*` today |

- **Secrets**: a database never stores a secret. A step that needs one
  reads `ctx.services.secrets`; a lint refuses a column named like one
  only as a warning (names are advice, not a check).
- **PII and photos**: worker ids are opaque text; an export removes or hashes
  them on request (`export { redact: [...] }`); a photo is a reference, its
  access is the artifact route's, not SQL's. A retention rule per table is a
  declared migration comment read by a sweep (phase 2; `retention.md`).
- **No raw SQL from untrusted input.** Input values are bound parameters.
  A step that builds SQL from input text (a table or column name) must
  take it from an enum in its input schema; the lint warns on string
  concatenation into `sql` in a custom step's source.
- **`ATTACH`, extensions, PRAGMA writes** stay refused (`sqlRefusal`).
  `VACUUM INTO` is the gateway's, for exports and backups only.

## Quotas and cost

Local files cost disk, not money, so quotas are protection, not billing:
file size, write rate and slow-query counts per namespace, shown in the
staff app with the warning style the app monitor already uses (`fanout`,
`volume`, `bytes`, `failing`). Backups cost storage at the off-box target:
retention is declared (default: every 15 minutes for 48 hours, hourly for
14 days, daily for 90), and a namespace's snapshots count toward a quota the
admin sees. No per-call price in v1; paid runs (`paid-runs.md`) already
price the workflow around it.

## Schema evolution and migration tooling

The worked example is Book Scanning's move from `jsonl` to a database; it is
a **migration pattern strut can offer to any workflow**, not a one-off.

1. **Import with a dry-run diff.** An importer replays the old files, in
   order, into a fresh database, idempotent by a unique `src` on the
   events table (`import:<file>:<line>`), so a rerun changes nothing. A
   `diff` op compares every read the workflow serves (per worker, per
   book, the list) as derived from the old store and from the database,
   and the cutover requires zero difference. A corrupt line is reported,
   not fatal.
2. **Dual-write, shadow-read.** A mode switch read per request
   (`jsonl | dual | db`). In `dual` the old file is still truth and the
   database is written in the same lock; every read computes both and
   logs a difference never shown to a user. Run it for days.
3. **Cutover.** Switch to `db`: the database is truth and the old file
   continues as a **mirror** for a period, so rollback is flipping the
   switch with every row since in the file.
4. **Rollback.** Mode switch first; after the mirror ends, restore from the
   last snapshot and replay the append-only events table (the events
   export has the same shape as the old file, so the old format remains a
   valid recovery format).
5. **Strut offers the pieces, not the migration.** Phase 1 ships the
   `dry-run` and `diff` as a reusable workflow over two named reads, and the
   mode switch as a documented convention (a small step that reads a
   per-workflow setting). The importer itself is the workflow author's.

**The append-only `events` pattern.** Every change writes one row to an
`events` table in the same transaction as the change (`seq`, `ts`, `kind`,
`actor`, `payload` JSON, `src`), with triggers that abort an update or a
delete. It gives an audit trail, a point-in-time rebuild (snapshot plus
events after it), and a status that can be recomputed and compared with the
stored one nightly. The guide page ships it as a copyable migration;
strut does not force it.

**Schema changes after launch** are new migration files: add a column,
backfill in a following statement, then (in a later release) add the
constraint. A change that cannot be additive is a new table and a copy
under the same dry-run/diff discipline.

## Backups and restore

Today there is none for a workflow's data, and `GET /apps/:name/data` only
downloads on request. The Book Scanning evidence: one manual copy, on the
same disk, a day old. A platform feature, so no task invents it:

- **Scheduled snapshots** of every namespace with data, using SQLite's online
  backup (`VACUUM INTO` is already in `copy`; the backup API is cheaper for
  large files) into `<dataDir>/backups/<kind>/<name>/<utc>.db`, each checked
  with `PRAGMA integrity_check` and recorded with its sha256. It uses the
  automations' scheduler (`automations.ts`); no new clock.
- **Retention** as above, per namespace, overridable.
- **Off-box copy**: an admin names a target (an S3-compatible bucket or an
  `rsync`/peer target) and its secret; strut copies each snapshot and says in
  the staff app when the newest off-box copy is older than its promise. With
  none named the backup goes to a second folder on the same disk and the
  staff app says plainly that it does not protect against losing the disk.
- **Point in time** = the last snapshot plus the `events` rows after it, for
  a database that keeps events. Continuous WAL shipping (Litestream) is the
  upgrade if a 15-minute gap is too long; it needs a binary and object
  storage, so it is deferred.
- **Restore drill**: `restore { namespace, snapshot, to: sandbox }` opens the
  snapshot as a throwaway namespace and runs the owner's declared check read
  against both; a scheduled drill (monthly default) records pass or fail.
  A backup that was never restored is not counted as a backup.
- **A restore over a live namespace** is an admin act on a card (it replaces
  data), drains writers first (`drain.ts` already exists for "an image
  update, a backup"), and keeps the replaced file.
- **The moving doc** (`moving.md`) lists what travels between hosts; this
  adds `<dataDir>/db/` and the backups' manifest.

## Observability

- **The events table** is the domain audit log; strut's own gateway adds a
  **call log** per namespace (statement kind, caller, ms, rows, error), kept
  as the app call log is (`app-calls.md`: in memory, an hour) plus a
  counters file per day for slow queries and failures.
- **Slow-query log**: any statement over a threshold (default 200 ms) is
  recorded with its text (parameters redacted) and the caller.
- **Health in the staff app**: per namespace, size, row counts per table,
  `user_version`, applied migrations, last backup and last off-box copy,
  last restore drill, quota use, warnings. Alerts are the app monitor's
  warning style; Support or Jamie surface them.
- **Integrity**: a nightly `PRAGMA quick_check` and, for a database that
  keeps events, the recompute-and-compare.

## Import and export

- **Export** `GET /db/<kind>/<name>/export?table=&format=jsonl|sqlite`:
  `jsonl` per table (one JSON object a line, the shape the old files had),
  or a `VACUUM INTO` copy; full scope only (as `GET /apps/:name/data`).
- **Import** `jsonl` into a table by a step with a declared mapping, always
  with `dryRun: true` available returning the would-be diff, and idempotent
  by a unique key the caller names.
- The same pair is how a database moves between servers, next to
  `moving.md`.

## Testing story

A reusable harness, so a user proves the same things we did for books:

- `db/test` helpers (a lib workflow and a node test utility) that, given a
  namespace and two operations, run N parallel writers and report: no lost
  row, no duplicate on a uniqueness rule, exactly one winner when M callers
  race for one key, idempotent replay, and a `kill -9` of a writer
  mid-transaction leaves no partial row and the next write works.
- Strut's own tests: the migration runner (exists in `data.test.ts`), the
  refusal list, `transact` guards and rollback, idempotency replay across a
  run resume, WAL across two processes, quota refusal, backup, restore and
  drill, the visitor and worker refusal matrix (as `worker-door.test.ts`
  does for tasks).
- The Book Scanning prototype's 9 tests (20 parallel writers, 10 workers
  racing for one book, crash mid-transaction) are the seed for the shared
  harness and the first acceptance test of phase 1.

## Packaging and publishing

**Schema travels; data does not.** A package may ship `db/<namespace>/*.sql`
(the migrations) beside its steps and workflows, so an install creates the
tables and a release adds a migration, as an app's `db/` is applied at
publish. It never ships rows (a database with a worker's ids is the box's,
not the package's); the same exclusion exists for an app's `data.db`
(`packageExcluded`). A package that needs seed rows ships them as a
migration `insert … on conflict do nothing`, reviewed like code.

An install that carries a `breaking` migration is refused unless an admin
accepts; an uninstall leaves the database and says so (as it leaves secret
values), since the data is the box's. `can` in the package page gains "keeps
data" so a person sees it before installing (`detail.ts`'s reading, not a
check).

## How it composes with task groups (#906)

See "The boundary". In short: #906's group is the platform's review and
status; the database holds the domain rows that point at it. Two rules
Book Scanning surfaced:

- **Who is allowed to join an open group** is a platform question only if
  every type wants it. #906 refuses new tasks in *closed* groups but admits a
  different worker to an *open* one. Where the rule is "one owner", the
  database's unique key is the wall; the platform option (`ownerOnly`) is
  an optional second wall, proposed to #906's author, not required here.
- **Reassign / take-over** is an owner change the platform has no event for
  (a `staff/group-owner-set` would add one). Until it exists the database
  owner is the truth for the domain and a reconciliation reports the
  difference.

## Security review notes

Things to check in each phase's PR:

1. A namespace name is validated (`validateAppName`'s segment rules) and
   never joins a path with `..`; the folder is made 0700.
2. `sqlRefusal` covers every entry (`query`, `exec`, `batch`, `transact`
   statements, a migration file at publish); `transact` interprets its own
   small language and must not `eval`.
3. `:actor` is bound from `ctx` after any input is merged; a test sends an
   input named `actor` and asserts it is replaced.
4. A visitor, a worker, a host and an `agent` step each fail on a database
   they do not own (the matrix test above).
5. A guard error returns a short code, not SQL text or file paths.
6. Backups and exports are as sensitive as the file: owner-only, off-box
   target credentials in the secret store, never in a log or an event.
7. WAL files (`-wal`, `-shm`) are inside the same 0700 folder and are
   included in "what moves" so a copy is never a bare `data.db` with a
   `-wal` left behind.
8. A resumed run replays `transact` through the idempotency record, never
   a second write.
9. Quotas stop a runaway workflow from filling the disk the task store shares.

## Phases

| Phase | What | Needs | Exit |
|---|---|---|---|
| 0 | **A documented convention and a shared gateway library.** A Concept page ("Workflow databases": layout, pragmas, `BEGIN IMMEDIATE`, idempotency, events pattern, additive migrations, what not to put in) and a small shared Python and TypeScript gateway that any server-local step can import. No strut code changes. Book Scanning's `bookdb.py` is the reference | Nothing | The page and library exist; Book Scanning uses them |
| 1 | **Strut-provided steps, SQLite per namespace.** `database` as a namespace beside `app`; `sqlite/transact`; idempotency and `expectChanges`; WAL for new databases; the guard against a slow read; a workflow's and a task type's `db/` migrations; the visitor/worker matrix; the shared test harness | Phase 0's lessons | A second task type (not books) runs on it; the Book Scanning concurrency suite passes against strut's own steps |
| 2 | **Managed backups and the admin view.** Scheduled snapshots, retention, off-box target, restore drill, health and quota in the staff app, `export`/`import` with dry run | 1 | A restore drill passes on a live namespace; the staff app shows its age |
| 3 | **Optional Postgres.** A namespace may declare `engine: postgres` against a configured server, behind the same steps; only if a second server must write or a database outgrows one file | A user who needs it | Decided then, not now |

### Work items

| # | Item | Size |
|---|---|---|
| 1 | "Workflow databases" Concept page + gateway library (Python, TypeScript) from `bookdb.py` | S (2 d) |
| 2 | Namespace resolution (`database` beside `app`), `<dataDir>/db/<kind>/<name>`, owner checks | M (3 d) |
| 3 | `sqlite/transact` with `bind`/`guard`, rollback codes, tests | M (3 d) |
| 4 | Idempotency record and `expectChanges` | S (1.5 d) |
| 5 | WAL on open for new files; a deadline for long reads (worker thread) | M (3 d) |
| 6 | `db/` migrations for a workflow and a task type; publish-time lint (additive, breaking marker) | M (3 d) |
| 7 | Visitor/worker/host matrix tests; a worker's scoped-read pattern documented with one example | S (2 d) |
| 8 | Shared concurrency/crash harness (`db/test`) | M (3 d) |
| 9 | Dry-run/diff workflow and mode-switch convention | S (2 d) |
| 10 | Scheduled snapshots, retention, integrity check | M (3 d) |
| 11 | Off-box target, freshness warning, restore drill | M (4 d) |
| 12 | Staff app: databases tab (size, rows, migrations, backups, quota) | M (4 d) |
| 13 | Export/import `jsonl` with dry run | S (2 d) |
| 14 | Package `db/` migrations and the `can` reading | S (2 d) |
| 15 | Postgres engine (phase 3) | L, not estimated |

Sizes are mine: S under 2 days, M 2 to 4, L more. Items 2 to 5 are one
PR each, never stacked, as `human-steps.md` §12 does it; each PR updates
`docs/apps.md` or the new area's doc and `specs/API.md` for routes.

## Risks

- **Two ways to name an app's file**, the old path and the new one, for a
  while. Mitigation: `app` keeps working; the new path only adds owners.
- **A synchronous connection in the main process** is a latency hazard for
  every other caller. The deadline in item 5 is the mitigation; until then a
  heavy read belongs in a workflow's own process.
- **WAL changes the file at rest.** Mitigated by opt-in for existing files
  and by treating `-wal` and `-shm` as part of the file in every copy.
- **A step language in `transact`** can grow into a second programming
  language. Rule: no loops or branches beyond `guard`; anything more is a
  custom step.
- **Backups with no off-box target** give false comfort. The staff app says
  so every time until one is set.
- **Boundary drift with the task store.** Domain data that really is
  generic (an owner, a status) will be written into a workflow database
  because it is quicker. Review rule: if two types want it, it moves into
  the platform (#906 is the case).

## Open questions

Each has a default; "go" takes them all.

1. **Namespace owner**: app only, or app, task type and package?
   Default: all three, resolved from `ctx` in that order.
2. **Extend `sqlite/*` or add `db/*`?** Default: extend `sqlite/*` (one
   family, existing grants and docs); a rename is a later alias.
3. **WAL for existing app databases?** Default: new databases only; an
   existing one opts in, since it changes the file at rest.
4. **May a Python step open the file directly?** Default: yes in phase 0
   (the gateway library), no after phase 1 (steps only).
5. **`synchronous` default?** Default: `FULL` for a database with
   `events` or money-adjacent rows, `NORMAL` otherwise, declared in the
   migration header.
6. **Where is the off-box target?** Default: unnamed until an admin sets one;
   the plan does not assume a provider.
7. **Is a database's file inside the box's regular backup/move?**
   Default: yes, `<dataDir>/db/` is added to `moving.md`'s list.
8. **`ownerOnly` on #906's groups?** Default: not required here; the
   database's unique key enforces one owner, and the platform option is
   proposed to #906's author separately.
9. **Postgres at all?** Default: not before a second writer exists.
10. **Who may accept a `breaking` migration?** Default: any admin on a card,
    the rule for other irreversible changes.

## Alternatives considered

- **Do nothing and harden the files.** The tonight-fix for Book Scanning
  (one lock for every writer, re-checking owner inside the lock, skipping bad
  lines) is worth doing and is what phase 0 amounts to. It gives no
  uniqueness, no transactions, no indexes, and keeps a second implementation
  of the rules. Kept as the stopgap, not the answer.
- **Use the platform's task store only** (add columns to `tasks.db`,
  generalise `task_groups`). Right for what every type needs (and #906 does
  it), wrong for domain tables: every domain would migrate the platform's
  file, and the task store holds pay. `human-steps.md` §4.1 already rejected
  the app's SQLite as the store; this is the reverse, and the two boundaries
  agree.
- **An external database service** (Postgres, a hosted DB). More than
  the load needs; adds credentials, a network path, upgrades and its own
  backups, and breaks "one box". Kept as phase 3.
- **The graph store.** Built for knowledge, not for unique constraints,
  `CHECK` rules and multi-statement transactions, and its backup is a graph
  snapshot. Wrong tool.
- **A new generic KV or document step** (`store/get`, `store/put`). Simple,
  but it moves every constraint into code again, which is the failure
  being fixed. SQL's constraints are the guarantee.

## Tests

| Item | What proves it |
|---|---|
| 2 | A step reaches its own namespace and is refused another's; a visitor and a worker are refused; `app` beside `ctx.app` still refused |
| 3 | A guard that fails rolls back every statement of the call and returns its code; 10 callers racing for one key: one winner, nine codes, no partial row |
| 4 | A replayed idempotency key returns the first result; a resumed run does not write twice |
| 5 | A write from a second process waits on `busy_timeout` and lands; a read past its deadline is killed and counted; `kill -9` mid-transaction leaves no partial row |
| 6 | An additive migration applies once; a `breaking` one is refused without the marker; an edited applied file warns |
| 10, 11 | A snapshot passes `integrity_check`; retention keeps the declared set; a restore into a sandbox equals the live file on the owner's check read |
| 13 | An import is idempotent and `dryRun` writes nothing |
