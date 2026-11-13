/**
 * The task store's FILE (plans/human-steps.md §4.2): `<dataDir>/tasks/tasks.db`
 * on `node:sqlite`, in the ledger's pattern (`src/payments/ledger-sqlite.ts`):
 * an owner-only folder, WAL, every write one `BEGIN IMMEDIATE` transaction (a
 * second process on the file waits its turn instead of failing), an accepted
 * answer committed with `synchronous=full`, and `close()` folding the WAL
 * into the file. The two sides keep their own tables in it
 * (`task-store-sqlite.ts`, `worker-store-sqlite.ts`). Imported on first use
 * (`openTaskStores`, tasks.ts), never at boot.
 *
 * Schema version 2 (plans/human-steps.md §7.7): tests and copies. A file of
 * version 1 (#655's tables, with or without #664's pay columns) is brought
 * to 2 when it is opened, in ONE transaction (`migrate`), its rows kept.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** The schema this strut writes: 2 since tests (plans/human-steps.md §7.7). */
export const SCHEMA_VERSION = 2;
const warned = new Set<string>();

export type Row = Record<string, unknown>;

export class TaskDb {
  private closed = false;

  /** Opens (and makes) the file; its folder is created owner-only. */
  static open(file: string): TaskDb {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    else if ((statSync(dir).mode & 0o077) !== 0 && !warned.has(dir)) {
      warned.add(dir);
      console.warn(`[tasks] ${dir} is readable by other users; the task store expects an owner-only folder (chmod 700)`);
    }
    const fresh = !existsSync(file);
    const db = new TaskDb(new DatabaseSync(file), file);
    if (fresh) chmodSync(file, 0o600);
    return db;
  }

  private constructor(
    private readonly db: DatabaseSync,
    readonly file: string,
  ) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 10000");
    const version = (db.prepare("PRAGMA user_version").get() as Row).user_version as number;
    if (version > SCHEMA_VERSION) {
      db.close();
      throw new Error(`${file}: task store schema ${version} is newer than this strut's (${SCHEMA_VERSION})`);
    }
    this.version = version;
  }

  /** The schema version the file was opened at: 0 for a new file. */
  readonly version: number;

  /** Brings the file to `SCHEMA_VERSION` in ONE transaction: `fn` makes the
   *  tables a new file lacks and changes an older file's (each step safe to
   *  run again), then `user_version` is written. A failure leaves the file as
   *  it was. */
  migrate(fn: (from: number) => void): void {
    this.tx(() => {
      fn(this.version);
      if (this.version < SCHEMA_VERSION) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }, true);
  }

  exec(sql: string): void {
    this.live().db.exec(sql);
  }

  prepare(sql: string): StatementSync {
    return this.live().db.prepare(sql);
  }

  /** One `BEGIN IMMEDIATE` transaction; `full` commits it with `synchronous=full`. */
  tx<T>(fn: () => T, full = false): T {
    const db = this.live().db;
    if (full) db.exec("PRAGMA synchronous = FULL");
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // no transaction left to roll back
        }
        throw e;
      }
    } finally {
      if (full) db.exec("PRAGMA synchronous = NORMAL");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
  }

  private live(): this {
    if (this.closed) throw new Error(`task store ${this.file} is closed`);
    return this;
  }
}

/** A column that may be NULL, as an optional field. */
export function opt<T>(v: unknown): T | undefined {
  return v === null || v === undefined ? undefined : (v as T);
}
