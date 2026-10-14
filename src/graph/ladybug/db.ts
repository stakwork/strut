/**
 * The LadybugDB handle (plans/ladybug-backend.md §3.2): one embedded
 * database file holding the graph layer strut owns — the `Node` table, one
 * rel table per edge type in the registry, the migration ledger — opened
 * once per absolute path per process.
 *
 * The generalization of `steps/lib/memory/_db.ts`'s `connection()`: a
 * registry on `globalThis` (a re-imported module shares the handle), the
 * folder created owner-only, the addon imported on first use with the
 * install hint on failure, a read connection and a write connection with a
 * queue — `withWrite(fn)` runs `fn` under BEGIN TRANSACTION … COMMIT /
 * ROLLBACK, one writer at a time — and `readOnly()` for the model's own
 * Cypher. On open: the `vector` and `fts` extensions (REQUIRED, ruling 4:
 * an open without them fails with the hint), the DDL (§3.1; every column
 * `ALTER TABLE ADD IF NOT EXISTS`, so a new attribute in the registry
 * lands on the next open), the two indexes, then the append-only
 * `MIGRATIONS`.
 *
 * A failed statement inside a transaction ENDS it (the engine rolls back
 * and the next statement would run auto-commit), so a transaction that saw
 * one error refuses every later statement with that error.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { GraphTx, Params, Row } from "../engine.js";
import { EDGE_COLUMNS, LADYBUG_EDGE_TYPES, nodeColumns, type ColumnType } from "./registry.js";

export type Query = (cypher: string, params?: Params) => Promise<Row[]>;

export interface ReadOnlyHandle {
  query: Query;
  close(): Promise<void>;
}

export interface LadybugHandle {
  readonly path: string;
  /** `Database.getVersion()`. */
  readonly version: string;
  /** One auto-commit statement on the read connection. */
  query: Query;
  /** One write transaction, in the writes' queue. Must not nest: a call
   *  from inside `fn` waits on the queue `fn` holds. */
  withWrite<T>(fn: (tx: GraphTx) => Promise<T>): Promise<T>;
  /** The writes' queue with no transaction around it: auto-commit writes,
   *  and what cannot run inside one (an index build, CHECKPOINT). Must not
   *  nest, as `withWrite`. */
  exclusive<T>(fn: (write: Query) => Promise<T>): Promise<T>;
  /** A second `Database` on the same file, read-only (the model's Cypher). */
  readOnly(): Promise<ReadOnlyHandle>;
  close(): Promise<void>;
}

export interface OpenOptions {
  /** Folder holding `libvector.lbug_extension` + `libfts.lbug_extension`
   *  (flat, or in `vector/` + `fts/` as the ladybug cache lays them out).
   *  Default `STRUT_LADYBUG_EXTENSION_DIR`; unset → `INSTALL` (the dev
   *  download into `~/.lbdb`). */
  extensionDir?: string;
}

export const REQUIRED_EXTENSIONS = ["vector", "fts"] as const;

// ── DDL ─────────────────────────────────────────────────────────────────────

const q = (s: string) => `\`${s}\``;
const cols = (map: Readonly<Record<string, ColumnType>>) =>
  Object.entries(map)
    .map(([k, t]) => `${q(k)} ${t}`)
    .join(", ");

/** The DDL, every statement idempotent: the tables with their primary keys
 *  and the columns the first version had, then one `ALTER TABLE ADD IF NOT
 *  EXISTS` per column, so a column added later lands on an older file. */
export function ddlStatements(): string[] {
  const out: string[] = [
    `CREATE NODE TABLE IF NOT EXISTS Node(${q("ref_id")} STRING PRIMARY KEY)`,
    `CREATE NODE TABLE IF NOT EXISTS Migration(${q("migration_id")} STRING PRIMARY KEY, ${q("executed_at")} INT64)`,
  ];
  for (const [k, t] of Object.entries(nodeColumns())) if (k !== "ref_id") out.push(`ALTER TABLE Node ADD IF NOT EXISTS ${q(k)} ${t}`);
  for (const edge of LADYBUG_EDGE_TYPES) {
    out.push(`CREATE REL TABLE IF NOT EXISTS ${q(edge)}(FROM Node TO Node, ${cols(EDGE_COLUMNS)})`);
    for (const [k, t] of Object.entries(EDGE_COLUMNS)) out.push(`ALTER TABLE ${q(edge)} ADD IF NOT EXISTS ${q(k)} ${t}`);
  }
  return out;
}

/** Changes to what the DDL above once created, in order: each safe to run
 *  again, all run on every open. Append, never edit one that has shipped. */
export const MIGRATIONS: readonly string[] = [];

/** The two indexes, `[name, call]`: one HNSW over `text_embeddings`, one FTS
 *  over the search text and the name. */
export function indexCalls(): Array<[string, string]> {
  return [
    ["node_vec", `CALL CREATE_VECTOR_INDEX('Node', 'node_vec', 'text_embeddings', metric := 'cosine')`],
    ["node_fts", `CALL CREATE_FTS_INDEX('Node', 'node_fts', ['Data_Bank', 'name'], stemmer := 'porter')`],
  ];
}

// ── The handle ──────────────────────────────────────────────────────────────

const HANDLES = Symbol.for("strut.graph.ladybug");
type Registry = Map<string, Promise<LadybugHandle>>;
const registry = (): Registry => {
  const g = globalThis as Record<symbol, Registry | undefined>;
  return (g[HANDLES] ??= new Map());
};

/** The addon: `@ladybugdb/core`, or the platform package it is a shim
 *  over — that one carries the binary itself, so an install with scripts
 *  blocked (CI's `--ignore-scripts`) still loads. */
export async function loadLadybug(): Promise<typeof import("@ladybugdb/core")> {
  const names = ["@ladybugdb/core", `@ladybugdb/core-${process.platform}-${process.arch}`];
  let last: unknown;
  for (const name of names) {
    try {
      return (await import(name)) as typeof import("@ladybugdb/core");
    } catch (err) {
      last = err;
    }
  }
  throw new Error(
    `the graph backend needs @ladybugdb/core, an optional dependency that did not load here ` +
      `(${last instanceof Error ? last.message.split("\n")[0] : String(last)}). Install it with: npm install @ladybugdb/core`,
  );
}

/** Makes `folder` owner-only (0700, whatever the umask) when it creates it; true when it did. */
function ownerOnly(folder: string): boolean {
  if (!mkdirSync(folder, { recursive: true, mode: 0o700 })) return false;
  chmodSync(folder, 0o700);
  return true;
}

/** Ladybug returns INT64 as a number; a struct (`{a: n.a}`, `RETURN n`)
 *  carries every field, null or not, plus `_label` / `_id` on a node. Rows
 *  come back the way Neo4j's do: a struct's null fields and the engine's
 *  own keys dropped, so an absent property is absent. A null COLUMN of a
 *  row stays null (`RETURN n.deleted_at AS gone`). */
function plain(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "_label" || k === "_id" || k === "_src" || k === "_dst") continue;
      if (x === null || x === undefined) continue;
      out[k] = plain(x);
    }
    return out;
  }
  return v;
}

/** Params as the addon wants them: no `undefined` (null instead). */
function clean(v: unknown): unknown {
  if (v === undefined) return null;
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = clean(x);
    return out;
  }
  return v;
}

function queryOn(conn: import("@ladybugdb/core").Connection): Query {
  return async (cypher, params = {}) => {
    const result = Object.keys(params).length
      ? await conn.execute(await conn.prepare(cypher), clean(params) as Record<string, never>)
      : await conn.query(cypher);
    const last = Array.isArray(result) ? result[result.length - 1]! : result;
    const rows = (await last.getAll()) as Row[];
    return rows.map((r) => {
      const out: Row = {};
      for (const [k, v] of Object.entries(r)) out[k] = plain(v);
      return out;
    });
  };
}

function extensionPath(dir: string, name: string): string {
  const file = `lib${name}.lbug_extension`;
  for (const candidate of [join(dir, file), join(dir, name, file)]) if (existsSync(candidate)) return candidate;
  throw new Error(`${file} is not under ${dir} (STRUT_LADYBUG_EXTENSION_DIR)`);
}

async function openFresh(path: string, opts: OpenOptions): Promise<LadybugHandle> {
  const folder = dirname(path);
  if (!ownerOnly(folder) && statSync(folder).mode & 0o077) {
    console.warn(`[graph] ${folder} is readable by other users; chmod 700 it to keep the graph private`);
  }
  // A WAL left beside a file that is gone fails every query on the new
  // file ("Database ID … does not match"): it belongs to nothing now.
  if (!existsSync(path) && existsSync(`${path}.wal`)) rmSync(`${path}.wal`, { force: true });

  const lbug = await loadLadybug();
  const db = new lbug.Database(path);
  const readConn = new lbug.Connection(db);
  const writeConn = new lbug.Connection(db);
  const read = queryOn(readConn);
  const write = queryOn(writeConn);
  const closeAll = async () => {
    await readConn.close().catch(() => undefined);
    await writeConn.close().catch(() => undefined);
    await db.close().catch(() => undefined);
  };

  try {
    // Extensions: by path from the given folder, else the ladybug download.
    const dir = opts.extensionDir ?? process.env["STRUT_LADYBUG_EXTENSION_DIR"];
    const load = async (query: Query, name: string) => {
      if (dir) await query(`LOAD EXTENSION '${extensionPath(dir, name).replace(/'/g, "''")}'`);
      else {
        await query(`INSTALL ${name}`);
        await query(`LOAD EXTENSION ${name}`);
      }
    };
    for (const name of REQUIRED_EXTENSIONS) {
      try {
        await load(read, name);
      } catch (err) {
        throw new Error(
          `the graph backend needs ladybug's ${name} extension and it did not load: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}. ` +
            `Set STRUT_LADYBUG_EXTENSION_DIR to a folder holding libvector.lbug_extension and libfts.lbug_extension for ladybug ${lbug.Database.getVersion()}, ` +
            `or let strut INSTALL them (needs network access to extension.ladybugdb.com).`,
        );
      }
    }
    for (const ddl of [...ddlStatements(), ...MIGRATIONS]) await write(ddl);
    const have = new Set((await read(`CALL SHOW_INDEXES() RETURN index_name`)).map((r) => String(r["index_name"]))); // `_PK` rows included; harmless
    for (const [name, call] of indexCalls()) if (!have.has(name)) await write(call);

    let queue: Promise<unknown> = Promise.resolve();
    const exclusive = <T>(fn: (w: Query) => Promise<T>): Promise<T> => {
      const run = () => fn(write);
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    };
    const handle: LadybugHandle = {
      path,
      version: lbug.Database.getVersion(),
      query: read,
      exclusive,
      withWrite: (fn) =>
        exclusive(async (w) => {
          // A failed statement rolls the transaction back, so every later
          // one, and the commit, fails with it — even when `fn` caught the first.
          let dead: { err: unknown } | undefined;
          const tx: GraphTx = {
            run: async (cypher, params) => {
              if (dead) throw dead.err;
              try {
                return await w(cypher, params);
              } catch (err) {
                dead = { err };
                throw err;
              }
            },
          };
          await w("BEGIN TRANSACTION");
          try {
            const out = await fn(tx);
            await tx.run("COMMIT");
            return out;
          } catch (err) {
            if (!dead) await w("ROLLBACK").catch(() => undefined);
            throw err;
          }
        }),
      readOnly: async () => {
        const ro = new lbug.Database(path, 0, true, true);
        const conn = new lbug.Connection(ro);
        const query = queryOn(conn);
        for (const name of REQUIRED_EXTENSIONS) await load(query, name).catch(() => undefined);
        return {
          query,
          close: async () => {
            await conn.close().catch(() => undefined);
            await ro.close().catch(() => undefined);
          },
        };
      },
      close: async () => {
        registry().delete(path);
        await queue.catch(() => undefined);
        await closeAll();
      },
    };
    return handle;
  } catch (err) {
    await closeAll();
    throw err;
  }
}

/** The handle for `path` (made absolute): opened once per process, shared
 *  by every caller until `close()`. A failed open is not cached. */
export function openLadybug(path: string, opts: OpenOptions = {}): Promise<LadybugHandle> {
  const abs = resolve(path);
  const handles = registry();
  let h = handles.get(abs);
  if (!h) {
    h = openFresh(abs, opts);
    handles.set(abs, h);
    h.catch(() => handles.delete(abs));
  }
  return h;
}
