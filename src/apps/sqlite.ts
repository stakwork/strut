/**
 * An app's own SQLite file (plans/apps.md §4.4, work item 3): one database
 * per workspace app, `<dataDir>/apps/<name>/data.db`, shared by all its
 * versions and never by another app. `node:sqlite` (built into Node ≥ 22.13,
 * imported on first use), owner-only like the memory file, WAL, foreign
 * keys on, extensions never enabled.
 *
 * - **Migrations** are the version's `db/*.sql`, applied at publish before
 *   the version is recorded (`migrate`): in name order, each once, each in
 *   its own transaction, recorded in `_strut_migrations` with its sha256. A
 *   failing one rolls back and fails the publish. A file applied before
 *   whose text has changed is refused — a migration runs once, and a change
 *   is a new file — and nothing rolls back with a version, so migrations
 *   are additive.
 * - **The reads and writes** are `query` (a READ-ONLY connection, so a read
 *   cannot write whatever its text), `exec` (one statement) and `batch`
 *   (several, in one transaction) — the `sqlite/*` steps are thin over them.
 *   Calls are synchronous, so a batch or a migration runs whole before
 *   anything else touches the file.
 * - **`sqlProblem`** is the keyword pre-check every statement passes first,
 *   the way `graph/query.ts` checks Cypher: no `ATTACH` / `DETACH`, no
 *   `VACUUM INTO`, no `load_extension`, a PRAGMA only from a short read
 *   allowlist, one statement per call. Raw SQL is otherwise fine: the worst
 *   a page can do is damage its own tables.
 */
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { chmod, readdir, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { appDir } from "./files.js";

/** The database's file name in the app's folder (never an app name segment, files.ts). */
export const APP_DB_FILE = "data.db";
/** The migrations' folder in an app directory. */
export const MIGRATIONS_DIR = "db";
/** The table that records which migrations ran. */
export const MIGRATIONS_TABLE = "_strut_migrations";

/** A query's rows past this many are left out (`truncated`). */
export const QUERY_ROWS_MAX = 5000;
/** …and past this many characters of JSON. */
export const QUERY_CHARS_MAX = 2 * 1024 * 1024;
/** Statements in one batch. */
export const BATCH_MAX = 500;

/** PRAGMAs a statement may READ (never set): the schema, the checks. */
const READ_PRAGMAS = new Set(["table_info", "table_xinfo", "table_list", "index_list", "index_info", "index_xinfo", "foreign_key_list", "foreign_key_check", "integrity_check", "quick_check", "user_version"]);

/** The statement with comments, string literals and quoted names blanked
 *  out, so a keyword inside one is no keyword. */
function bare(sql: string): string {
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?(\*\/|$)|'(?:[^']|'')*'?|"(?:[^"]|"")*"?|`[^`]*`?|\[[^\]]*\]?/g, (m) => " ".repeat(m.length));
}

/** Why a statement is refused, or null. `many` allows several (a batch item never; a migration does). */
export function sqlProblem(sql: string, opts: { many?: boolean } = {}): string | null {
  if (typeof sql !== "string" || !sql.trim()) return "an empty statement";
  const text = bare(sql);
  if (/\bATTACH\b/i.test(text)) return "ATTACH is refused: an app's database is its own (plans/apps.md §4.4)";
  if (/\bDETACH\b/i.test(text)) return "DETACH is refused: an app's database is its own";
  if (/\bVACUUM\s+INTO\b/i.test(text)) return "VACUUM INTO is refused: the database stays one file (GET /apps/:name/data exports it)";
  if (/\bload_extension\b/i.test(text)) return "load_extension is refused: extensions are never enabled";
  for (const m of text.matchAll(/\bPRAGMA\s+(?:\w+\s*\.\s*)?(\w+)\s*(=)?/gi)) {
    const name = m[1]!.toLowerCase();
    if (m[2] || !READ_PRAGMAS.has(name)) return `PRAGMA ${name}${m[2] ? " = …" : ""} is refused: a statement may read ${[...READ_PRAGMAS].join(", ")}`;
  }
  if (!opts.many) {
    const semi = text.indexOf(";");
    if (semi >= 0 && text.slice(semi + 1).trim()) return "one statement per call — several in one transaction is sqlite/batch";
  }
  return null;
}

/** A parameter value as SQLite binds it: booleans as 1 / 0, `{ base64 }` as
 *  bytes, any other object or list as JSON text. */
function bindValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v !== null && typeof v === "object" && !(v instanceof Uint8Array)) {
    const b64 = (v as { base64?: unknown }).base64;
    if (typeof b64 === "string" && Object.keys(v).length === 1) return Buffer.from(b64, "base64");
    return JSON.stringify(v);
  }
  return v;
}

export type SqlParams = unknown[] | Record<string, unknown> | undefined;

function bind(params: SqlParams): unknown[] {
  if (params === undefined || params === null) return [];
  if (Array.isArray(params)) return params.map(bindValue);
  if (typeof params === "object") return [Object.fromEntries(Object.entries(params).map(([k, v]) => [k, bindValue(v)]))];
  throw new Error("params is a list (for ?) or an object (for :name)");
}

/** A value read back as JSON can carry it: bytes as `{ base64 }`, a big integer as a string. */
function readValue(v: unknown): unknown {
  if (v instanceof Uint8Array) return { base64: Buffer.from(v).toString("base64") };
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  return v;
}

export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  /** Rows were left out past `QUERY_ROWS_MAX` or `QUERY_CHARS_MAX`. */
  truncated?: true;
}

export interface ExecResult {
  changes: number;
  lastInsertRowid: number;
}

export interface MigrationRecord {
  name: string;
  sha256: string;
  appliedAt: string;
}

export interface AppDatabase {
  /** The file on this host. */
  readonly path: string;
  query(sql: string, params?: SqlParams): QueryResult;
  exec(sql: string, params?: SqlParams): ExecResult;
  batch(statements: Array<{ sql: string; params?: SqlParams }>): { results: ExecResult[] };
  migrations(): MigrationRecord[];
}

export type MigrateResult = { ok: true; applied: string[] } | { ok: false; errors: string[] };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** One app's two connections: the writer, and a read-only one for queries. */
interface Open {
  write: DatabaseSync;
  read: DatabaseSync;
}

/**
 * The app databases of one strut, under `<dataDir>/apps`. A connection
 * pair per app, opened on first use and kept until `close`.
 */
export class AppDatabases {
  private readonly open = new Map<string, Open>();
  private sqlite: typeof import("node:sqlite") | undefined;

  constructor(readonly root: string) {}

  /** The database's path, whether or not it exists. */
  pathOf(name: string): string {
    return join(appDir(this.root, name), APP_DB_FILE);
  }

  exists(name: string): boolean {
    return existsSync(this.pathOf(name));
  }

  private async connect(name: string): Promise<Open> {
    const had = this.open.get(name);
    if (had) return had;
    this.sqlite ??= await import("node:sqlite");
    const again = this.open.get(name);
    if (again) return again;
    const file = this.pathOf(name);
    mkdirSync(appDir(this.root, name), { recursive: true });
    // Owner-only from the first byte: SQLite gives its -wal and -shm files
    // the database file's mode.
    closeSync(openSync(file, "a", 0o600));
    await chmod(file, 0o600);
    const write = new this.sqlite.DatabaseSync(file, { enableForeignKeyConstraints: true, allowExtension: false });
    write.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    const read = new this.sqlite.DatabaseSync(file, { readOnly: true, allowExtension: false });
    read.exec("PRAGMA busy_timeout = 5000;");
    const pair = { write, read };
    this.open.set(name, pair);
    return pair;
  }

  /** The app's database, created on first use. */
  async database(name: string): Promise<AppDatabase> {
    const db = await this.connect(name);
    const path = this.pathOf(name);
    const prepare = (conn: DatabaseSync, sql: string, opts?: { many?: boolean }): StatementSync => {
      const problem = sqlProblem(sql, opts);
      if (problem) throw new Error(`sqlite: ${problem}`);
      return conn.prepare(sql);
    };
    const run = (stmt: StatementSync, params: SqlParams): ExecResult => {
      const r = stmt.run(...(bind(params) as []));
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    };
    return {
      path,
      query(sql, params) {
        const stmt = prepare(db.read, sql);
        const columns = stmt.columns().map((c) => c.name);
        const rows: Array<Record<string, unknown>> = [];
        let chars = 0;
        let truncated = false;
        for (const raw of stmt.iterate(...(bind(params) as []))) {
          const row: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) row[k] = readValue(v);
          chars += JSON.stringify(row).length;
          if (rows.length >= QUERY_ROWS_MAX || chars > QUERY_CHARS_MAX) {
            truncated = true;
            break;
          }
          rows.push(row);
        }
        return { columns, rows, ...(truncated ? { truncated: true as const } : {}) };
      },
      exec(sql, params) {
        return run(prepare(db.write, sql), params);
      },
      batch(statements) {
        if (!Array.isArray(statements) || !statements.length) throw new Error("sqlite: a batch needs at least one statement");
        if (statements.length > BATCH_MAX) throw new Error(`sqlite: at most ${BATCH_MAX} statements in one batch`);
        // Checked and compiled first: a refused statement runs nothing.
        const prepared = statements.map((s, i) => {
          try {
            return prepare(db.write, s?.sql);
          } catch (err) {
            throw new Error(`sqlite: statements[${i}]: ${(err as Error).message.replace(/^sqlite: /, "")}`);
          }
        });
        db.write.exec("BEGIN IMMEDIATE");
        try {
          const results = prepared.map((stmt, i) => {
            try {
              return run(stmt, statements[i]!.params);
            } catch (err) {
              throw new Error(`sqlite: statements[${i}]: ${(err as Error).message}`);
            }
          });
          db.write.exec("COMMIT");
          return { results };
        } catch (err) {
          rollback(db.write);
          throw err;
        }
      },
      migrations() {
        return readMigrations(db.write);
      },
    };
  }

  /**
   * Apply an app directory's `db/*.sql` to the app's database: the files not
   * applied yet, in name order, each in its own transaction. Nothing to do,
   * and no file made, when the directory has none.
   */
  async migrate(name: string, dir: string): Promise<MigrateResult> {
    const files = await migrationFiles(dir);
    if (!files.length) return { ok: true, applied: [] };
    const texts = await Promise.all(files.map(async (f) => ({ name: f, text: await readFile(join(dir, MIGRATIONS_DIR, f), "utf8") })));
    const errors: string[] = [];
    for (const { name: f, text } of texts) {
      const problem = sqlProblem(text, { many: true });
      if (problem) errors.push(`${MIGRATIONS_DIR}/${f}: ${problem}`);
    }
    if (errors.length) return { ok: false, errors };
    const db = (await this.connect(name)).write;
    db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    const done = new Map(readMigrations(db).map((m) => [m.name, m]));
    for (const { name: f, text } of texts) {
      const was = done.get(f);
      if (was && was.sha256 !== sha256(text)) {
        errors.push(`${MIGRATIONS_DIR}/${f}: applied on ${was.appliedAt} and changed since — a migration runs once, so a change is a new file (a later name)`);
      }
    }
    if (errors.length) return { ok: false, errors };
    const applied: string[] = [];
    for (const { name: f, text } of texts) {
      if (done.has(f)) continue;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(text);
        db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name, sha256, applied_at) VALUES (?, ?, ?)`).run(f, sha256(text), new Date().toISOString());
        db.exec("COMMIT");
      } catch (err) {
        rollback(db);
        const msg = (err as Error).message;
        const hint = /within a transaction|no transaction is active/i.test(msg) ? " (each migration already runs in its own transaction: leave out BEGIN and COMMIT)" : "";
        return { ok: false, errors: [`${MIGRATIONS_DIR}/${f}: ${msg}${hint} — nothing from it was applied${applied.length ? `; ${applied.join(", ")} were` : ""}`] };
      }
      applied.push(f);
    }
    return { ok: true, applied };
  }

  /** A consistent copy of the database at `to` (the export), or false when there is none. */
  async exportTo(name: string, to: string): Promise<boolean> {
    if (!this.exists(name)) return false;
    const db = (await this.connect(name)).write;
    await rm(to, { force: true });
    db.prepare("VACUUM INTO ?").run(to);
    return true;
  }

  /** The database's size in bytes (its WAL included), or null when there is none. */
  async size(name: string): Promise<number | null> {
    const file = this.pathOf(name);
    let total = 0;
    for (const f of [file, `${file}-wal`]) {
      try {
        total += (await stat(f)).size;
      } catch {
        if (f === file) return null;
      }
    }
    return total;
  }

  /** Close one app's connections (a deleted app), or every one. */
  close(name?: string): void {
    for (const [n, db] of this.open) {
      if (name !== undefined && n !== name) continue;
      try {
        db.read.close();
        db.write.close();
      } catch {
        // already closed
      }
      this.open.delete(n);
    }
  }
}

/** Roll back the open transaction, if a failed statement left one. */
function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // no transaction was open
  }
}

function readMigrations(db: DatabaseSync): MigrationRecord[] {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(MIGRATIONS_TABLE);
  if (!has) return [];
  return db
    .prepare(`SELECT name, sha256, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY name`)
    .all()
    .map((r) => ({ name: String(r["name"]), sha256: String(r["sha256"]), appliedAt: String(r["applied_at"]) }));
}

/** The directory's `db/*.sql`, in name order. */
export async function migrationFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, MIGRATIONS_DIR), { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith(".sql"))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
