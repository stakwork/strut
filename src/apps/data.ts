/**
 * An APP'S OWN SQLITE (plans/apps.md §4.4; plans/people-and-hosts.md item 4):
 * one file per app, `<dataDir>/apps/<name>/data.db`, shared by all its
 * versions and kept beside them. Owner-only (the file 600, its folder made
 * 700), on `node:sqlite`, imported on the first open; extensions are never
 * enabled. A strut whose run store is in memory keeps them in memory.
 *
 * Opened once and kept: every statement is synchronous, so one connection
 * per file serves every caller in turn and no transaction is ever
 * interleaved with another call. The rollback journal (no WAL): the file at
 * rest is the whole database, with nothing beside it.
 *
 * - **Migrations** (`migrate`): `db/*.sql` in the app's directory, applied
 *   in name order, each once, each in its own transaction, recorded in
 *   `_strut_migrations` with its sha256. A workspace app's publish applies
 *   them before the version is recorded, and a failing one fails the publish
 *   (src/apps/apps.ts); strut's seeded apps get theirs at boot
 *   (createStrut). `check` runs them on an empty database in memory: what a
 *   build reports. Migrations must be additive — a rollback of the app never
 *   rolls its schema back.
 * - **Statements** (`runQuery`, `runExec`, `runBatch`): what the `sqlite/*`
 *   steps run (src/steps/lib/sqlite/), ONE statement each (a second one in
 *   the text is refused, never silently dropped), after `sqlRefusal`, the
 *   keyword pre-check: `ATTACH`, `DETACH`, `VACUUM INTO`, `load_extension`
 *   and any PRAGMA outside a short read allowlist, so an app's SQL reaches
 *   its own file alone. Raw SQL is fine otherwise: the worst a page can do is
 *   damage its own tables. A query runs under `PRAGMA query_only`, so a read
 *   never writes. Values go in as `params`; a blob goes in and comes out as
 *   `{ base64 }`, an integer past 2^53 comes out as a string.
 *
 * Not bounded: how long one statement runs. `node:sqlite` has no progress
 * handler or interrupt, so a statement that never ends (a recursive query
 * with no stop) holds the server's event loop, as in the task store.
 */
import { createHash } from "node:crypto";
import { createReadStream, chmodSync, existsSync, mkdirSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { appDir, appsRoot, validateAppName } from "./files.js";

/** The file's name, in the app's folder (and never a version's: files.ts). */
export const APP_DB_FILE = "data.db";
/** Where an app keeps its migrations, in its directory. */
export const MIGRATIONS_DIR = "db";
/** Which migrations a database has had: `name`, `sha256`, `applied_at`. */
export const MIGRATIONS_TABLE = "_strut_migrations";
/** A query's rows: by default, and at most. */
export const QUERY_ROWS_DEFAULT = 1000;
export const QUERY_ROWS_MAX = 10_000;
/** A query's rows stop here (as JSON), under `step_run`'s 5 MB. */
export const QUERY_BYTES_MAX = 4 * 1024 * 1024;
/** A batch's most statements. */
export const BATCH_MAX = 1000;

/** `<dataDir>/apps/<name segments>/data.db`. A name that is no app name
 *  (`..`, a version label, `data.db`) throws. */
export function appDbPath(dataDir: string, app: string): string {
  validateAppName(app);
  return join(appDir(appsRoot(dataDir), app), APP_DB_FILE);
}

// ── The pre-check ────────────────────────────────────────────────────────

/** PRAGMAs a statement may name: reads of the schema and the file. These
 *  take an argument (a table, an index, a limit)… */
const PRAGMA_WITH_ARG = new Set(["table_info", "table_xinfo", "table_list", "index_list", "index_info", "index_xinfo", "foreign_key_list", "foreign_key_check", "integrity_check", "quick_check"]);
/** …and these none: `= x` or `(x)` would set them. */
const PRAGMA_BARE = new Set(["user_version", "page_count", "page_size", "freelist_count"]);

/** `sql` with its comments gone, its strings as `''` and its quoted
 *  identifiers as `_`, so a keyword check sees SQL's own words alone. */
export function stripSql(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const n = sql[i + 1];
    if (c === "-" && n === "-") {
      const e = sql.indexOf("\n", i);
      i = e < 0 ? sql.length : e;
      out += " ";
      continue;
    }
    if (c === "/" && n === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? sql.length : e + 2;
      out += " ";
      continue;
    }
    const close = c === "'" || c === '"' || c === "`" ? c : c === "[" ? "]" : null;
    if (!close) {
      out += c;
      i++;
      continue;
    }
    let j = i + 1;
    for (;;) {
      const e = sql.indexOf(close, j);
      if (e < 0) {
        j = sql.length;
        break;
      }
      // A doubled quote is one quote inside the text.
      if (close !== "]" && sql[e + 1] === close) {
        j = e + 2;
        continue;
      }
      j = e + 1;
      break;
    }
    out += c === "'" ? " '' " : " _ ";
    i = j;
  }
  return out;
}

const WHY = "an app's SQL reaches its own database alone (plans/apps.md §4.4)";

/** Why `sql` is refused, or null: the keyword pre-check, the way
 *  graph/query.ts checks Cypher. */
export function sqlRefusal(sql: string): string | null {
  const bare = stripSql(sql);
  if (/\bATTACH\b/i.test(bare)) return `ATTACH is refused: ${WHY}`;
  if (/\bDETACH\b/i.test(bare)) return `DETACH is refused: ${WHY}`;
  if (/\bVACUUM\b[^;]*\bINTO\b/i.test(bare)) return `VACUUM INTO is refused: it writes a copy of the database to another file — ${WHY}`;
  if (/\bload_extension\b/i.test(bare)) return "load_extension is refused: extensions are never enabled";
  const allowed = [...PRAGMA_WITH_ARG, ...PRAGMA_BARE].join(", ");
  for (const m of bare.matchAll(/\bPRAGMA\s+(?:\w+\s*\.\s*)?(\w+)\s*(=|\()?/gi)) {
    const name = m[1]!.toLowerCase();
    if (!PRAGMA_WITH_ARG.has(name) && !PRAGMA_BARE.has(name)) return `PRAGMA ${name} is refused: an app reads ${allowed}`;
    if (m[2] === "=" || (m[2] === "(" && PRAGMA_BARE.has(name))) return `PRAGMA ${name} is read here, never set`;
  }
  for (const m of bare.matchAll(/\bpragma_(\w+)/gi)) {
    const name = m[1]!.toLowerCase();
    if (!PRAGMA_WITH_ARG.has(name) && !PRAGMA_BARE.has(name)) return `pragma_${name} is refused: an app reads ${allowed}`;
  }
  return null;
}

/** A statement that opens or ends a transaction: refused from a caller, whose
 *  call is one statement (or one batch) on a connection every caller shares. */
const TX_CONTROL = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

// ── Values ───────────────────────────────────────────────────────────────

/** Parameters: positional (`?`) as a list, named (`:name`, `@name`, `$name`)
 *  as an object. */
export type SqlParams = unknown[] | Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);

/** A JSON value as SQLite takes it: a whole number as an INTEGER (node binds
 *  every number as a REAL, which a TEXT column keeps as `5.0`), a boolean as
 *  1 or 0, `{ base64 }` as a blob, any other object or list as its JSON text. */
function bindValue(v: unknown): SQLInputValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1n : 0n;
  if (typeof v === "number") return Number.isSafeInteger(v) ? BigInt(v) : v;
  if (typeof v === "string" || typeof v === "bigint" || v instanceof Uint8Array) return v;
  if (isRecord(v) && Object.keys(v).length === 1 && typeof v["base64"] === "string") return Buffer.from(v["base64"], "base64");
  return JSON.stringify(v);
}

function bound(params: SqlParams | undefined): SQLInputValue[] | [Record<string, SQLInputValue>] {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params.map(bindValue);
  return [Object.fromEntries(Object.entries(params).map(([k, v]) => [k, bindValue(v)]))];
}

/** A value read back as JSON carries it: a blob as `{ base64 }`, an integer
 *  past 2^53 as its decimal text. */
function readValue(v: unknown): unknown {
  if (typeof v === "bigint") return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  if (v instanceof Uint8Array) return { base64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") };
  return v;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The first statement of `sql`, prepared — refused when the text holds
 *  another (SQLite would run the first alone), or opens or ends a
 *  transaction. */
function prepareOne(db: DatabaseSync, sql: string): StatementSync {
  const refused = sqlRefusal(sql);
  if (refused) throw new Error(refused);
  // Read from the text, never from what `prepare` makes of it: Node 22 hands
  // back a finalized statement for comments alone where Node 24 throws.
  if (isEmptySql(sql)) throw new Error("no statement: the SQL holds only comments or semicolons");
  if (TX_CONTROL.test(stripSql(sql))) throw new Error("a statement may not open or end a transaction: sqlite/batch runs several statements in one");
  const stmt = db.prepare(sql);
  // What SQLite left after the first statement: comments, or another.
  const tail = sql.startsWith(stmt.sourceSQL) ? sql.slice(stmt.sourceSQL.length) : "";
  if (!isEmptySql(tail)) throw new Error("one statement per call: sqlite/batch runs several in one transaction");
  stmt.setReadBigInts(true);
  return stmt;
}

/** Nothing but whitespace, comments and semicolons. */
const isEmptySql = (sql: string): boolean => !stripSql(sql).replace(/[\s;]/g, "");

// ── Statements ───────────────────────────────────────────────────────────

export interface QueryResult {
  /** The result's columns, in order. */
  columns: string[];
  /** One object per row, keyed by column. */
  rows: Array<Record<string, unknown>>;
  /** There were more rows than `maxRows` (or than fit in 4 MB). */
  truncated: boolean;
}

export interface ExecResult {
  changes: number;
  /** The rowid of the last row inserted (as text past 2^53). */
  lastInsertRowid: number | string;
}

/** ONE statement that reads, its rows capped at `maxRows` and at 4 MB. It
 *  runs under `query_only`, so a write in it fails. */
export function runQuery(db: DatabaseSync, sql: string, params?: SqlParams, maxRows = QUERY_ROWS_DEFAULT): QueryResult {
  const cap = Math.max(1, Math.min(QUERY_ROWS_MAX, Math.floor(maxRows)));
  db.exec("PRAGMA query_only = 1");
  try {
    const stmt = prepareOne(db, sql);
    const rows: Array<Record<string, unknown>> = [];
    let bytes = 2;
    let truncated = false;
    for (const row of stmt.iterate(...(bound(params) as SQLInputValue[]))) {
      if (rows.length >= cap) {
        truncated = true;
        break;
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row as Record<string, unknown>)) out[k] = readValue(v);
      bytes += JSON.stringify(out).length + 1;
      if (bytes > QUERY_BYTES_MAX) {
        if (!rows.length) throw new Error(`one row is over ${QUERY_BYTES_MAX / 1024 / 1024} MB: select fewer columns, or a blob in pieces (substr(col, start, n))`);
        truncated = true;
        break;
      }
      rows.push(out);
    }
    const columns = typeof stmt.columns === "function" ? stmt.columns().map((c) => c.name) : Object.keys(rows[0] ?? {});
    return { columns, rows, truncated };
  } catch (e) {
    if (/readonly database/i.test(message(e))) throw new Error("sqlite/query only reads: a write goes through sqlite/exec or sqlite/batch");
    throw e;
  } finally {
    db.exec("PRAGMA query_only = 0");
  }
}

const count = (v: number | bigint): number | string => readValue(v) as number | string;

/** ONE statement, its changes and the last rowid it inserted. */
export function runExec(db: DatabaseSync, sql: string, params?: SqlParams): ExecResult {
  const r = prepareOne(db, sql).run(...(bound(params) as SQLInputValue[]));
  return { changes: Number(r.changes), lastInsertRowid: count(r.lastInsertRowid) };
}

export type BatchStatement = string | { sql: string; params?: SqlParams };

/** Several statements in ONE transaction: all of them, or none. */
export function runBatch(db: DatabaseSync, statements: readonly BatchStatement[]): { results: ExecResult[] } {
  if (!statements.length) throw new Error("a batch needs at least one statement");
  if (statements.length > BATCH_MAX) throw new Error(`at most ${BATCH_MAX} statements in a batch, not ${statements.length}`);
  const list = statements.map((s) => (typeof s === "string" ? { sql: s } : s));
  // Every statement refused or not before any runs.
  list.forEach((s, i) => {
    const refused = sqlRefusal(s.sql);
    if (refused) throw new Error(`statement ${i + 1}: ${refused}`);
  });
  db.exec("BEGIN IMMEDIATE");
  try {
    const results = list.map((s, i) => {
      try {
        return runExec(db, s.sql, s.params);
      } catch (e) {
        throw new Error(`statement ${i + 1}: ${message(e)} — nothing in the batch was kept`);
      }
    });
    db.exec("COMMIT");
    return { results };
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // SQLite rolled it back itself.
    }
    throw e;
  }
}

// ── Migrations ───────────────────────────────────────────────────────────

export interface Migration {
  /** The file's name in `db/`. */
  name: string;
  sql: string;
  sha256: string;
}

/** `dir/db/*.sql`, in name order. None when there is no `db/`. */
export async function readMigrations(dir: string): Promise<Migration[]> {
  const at = join(dir, MIGRATIONS_DIR);
  const names = (await readdir(at, { withFileTypes: true }).catch(() => [])).filter((e) => e.isFile() && e.name.endsWith(".sql")).map((e) => e.name).sort();
  const out: Migration[] = [];
  for (const name of names) {
    const bytes = await readFile(join(at, name));
    out.push({ name, sql: bytes.toString("utf8"), sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return out;
}

export type MigrateResult =
  | { ok: true; applied: string[]; warnings: string[] }
  | { ok: false; errors: string[]; applied: string[]; warnings: string[] };

/** Applies the migrations `db` has not had, each in its own transaction and
 *  recorded with it. The first that fails rolls back and stops the rest; the
 *  ones before it stay applied. One applied before whose file changed since
 *  is a warning: it never runs again. */
export function migrateDb(db: DatabaseSync, migrations: readonly Migration[], now: () => Date = () => new Date()): MigrateResult {
  const applied: string[] = [];
  const warnings: string[] = [];
  db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const had = new Map((db.prepare(`SELECT name, sha256 FROM ${MIGRATIONS_TABLE}`).all() as Array<{ name: string; sha256: string }>).map((r) => [r.name, r.sha256]));
  for (const m of migrations) {
    const was = had.get(m.name);
    if (was !== undefined) {
      if (was !== m.sha256) warnings.push(`db/${m.name} changed since it was applied, and a migration runs once: put the change in a new file after it`);
      continue;
    }
    const refused = sqlRefusal(m.sql);
    if (refused) return { ok: false, errors: [`db/${m.name}: ${refused}`], applied, warnings };
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      if (db.isTransaction === false) throw new Error("it ends the transaction strut runs it in (COMMIT, END or ROLLBACK): a migration is one transaction, strut's");
      db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name, sha256, applied_at) VALUES (?, ?, ?)`).run(m.name, m.sha256, now().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      return { ok: false, errors: [`db/${m.name} failed, and nothing of it was kept: ${message(e)}`], applied, warnings };
    }
    applied.push(m.name);
  }
  return { ok: true, applied, warnings };
}

// ── The files ────────────────────────────────────────────────────────────

/** Every app's database (`ctx.services.appDb`). */
export interface AppDatabases {
  /** The app's database, made on the first call (owner-only) and kept open.
   *  The caller names an app that exists: the file is made for any name. */
  open(app: string): Promise<DatabaseSync>;
  /** Does the app have a database yet? Nothing is made. */
  has(app: string): boolean;
  /** Applies `dir`'s migrations (`db/*.sql`) to the app's database. With
   *  none, nothing is opened or made. */
  migrate(app: string, dir: string): Promise<MigrateResult>;
  /** Runs `dir`'s migrations on an empty database in memory, thrown away:
   *  whether they apply, for a build to say. */
  check(dir: string): Promise<MigrateResult>;
  /** A copy of the app's database as it is now (`VACUUM INTO`), streamed;
   *  the copy is removed once the stream ends. Null when it has none. */
  copy(app: string): Promise<{ stream: Readable; bytes: number } | null>;
  /** Closes every file. */
  close(): void;
}

let sqliteModule: Promise<typeof import("node:sqlite")> | undefined;
const sqlite = () => (sqliteModule ??= import("node:sqlite"));

async function openFile(file: string): Promise<DatabaseSync> {
  const { DatabaseSync } = await sqlite();
  if (file === ":memory:") return new DatabaseSync(file);
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fresh = !existsSync(file);
  const db = new DatabaseSync(file);
  if (fresh) chmodSync(file, 0o600);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** The apps' databases: files under `dataDir`, or with `memory`, in memory. */
export function createAppDatabases(opts: { dataDir?: string; memory?: boolean; now?: () => Date }): AppDatabases {
  if (!opts.memory && !opts.dataDir) throw new Error("an app's database needs the server's dataDir (or memory: true)");
  const open = new Map<string, Promise<DatabaseSync>>();
  const fileOf = (app: string) => {
    validateAppName(app);
    return opts.memory ? ":memory:" : appDbPath(opts.dataDir!, app);
  };
  const dbOf = (app: string): Promise<DatabaseSync> => {
    let db = open.get(app);
    if (!db) {
      const file = fileOf(app);
      db = openFile(file);
      open.set(app, db);
      db.catch(() => open.delete(app));
    }
    return db;
  };
  return {
    // A bad name is a rejection, as every other failure to open is.
    open: async (app) => dbOf(app),
    has: (app) => open.has(app) || (!opts.memory && existsSync(fileOf(app))),
    async migrate(app, dir) {
      const migrations = await readMigrations(dir);
      if (!migrations.length) return { ok: true, applied: [], warnings: [] };
      return migrateDb(await dbOf(app), migrations, opts.now);
    },
    async check(dir) {
      const migrations = await readMigrations(dir);
      if (!migrations.length) return { ok: true, applied: [], warnings: [] };
      const db = await openFile(":memory:");
      try {
        return migrateDb(db, migrations, opts.now);
      } finally {
        db.close();
      }
    },
    async copy(app) {
      if (!open.has(app) && (opts.memory || !existsSync(fileOf(app)))) return null;
      const db = await dbOf(app);
      // Owner-only (mkdtemp makes it 700), and gone with the stream.
      const dir = await mkdtemp(join(tmpdir(), "strut-app-data-"));
      const file = join(dir, APP_DB_FILE);
      try {
        db.prepare("VACUUM INTO ?").run(file);
      } catch (e) {
        await rm(dir, { recursive: true, force: true });
        throw e;
      }
      const { size } = await stat(file);
      const stream = createReadStream(file);
      stream.once("close", () => void rm(dir, { recursive: true, force: true }));
      return { stream, bytes: size };
    },
    close() {
      for (const db of open.values()) {
        void db
          .then((d) => {
            if (d.isOpen) d.close();
          })
          .catch(() => {});
      }
      open.clear();
    },
  };
}
