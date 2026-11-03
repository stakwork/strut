/**
 * The LadybugDB handle (plans/ladybug-backend.md §3.2): one embedded
 * database file holding the graph layer strut owns — the `Node` table (its
 * ontology among the rows, as `Schema` nodes: `ontology.ts`), one rel table
 * per edge type, the migration ledger — opened once per absolute path per
 * process.
 *
 * The generalization of `steps/lib/memory/_db.ts`'s `connection()`: a
 * registry on `globalThis` (a re-imported module shares the handle), the
 * folder created owner-only, the addon imported on first use with the
 * install hint on failure, a read connection and a write connection with a
 * queue — `withWrite(fn)` runs `fn` under BEGIN TRANSACTION … COMMIT /
 * ROLLBACK, one writer at a time — and `readOnly()` for the model's own
 * Cypher: a connection of its own whose every statement runs inside
 * `BEGIN TRANSACTION READ ONLY`, which the engine refuses writes in. (Not a
 * second `Database` opened read-only, as first planned: one reserves
 * `ladybugMaxDbSize()` of address space (max-size.ts) and `close()` never returns it — at the
 * addon's default of 8 TB the ninth open in a process failed with "Mmap for
 * size 8796093022208 failed".) On open: the
 * `vector` and `fts` extensions (REQUIRED, ruling 4:
 * an open without them fails with the hint), the DDL (§3.1; every column
 * `ALTER TABLE ADD IF NOT EXISTS`, so a new attribute in the seed lands on
 * the next open), the two indexes, the append-only `MIGRATIONS` and the
 * one-time ones (`renameCoreColumns`, `addSchemaRuleColumns`,
 * `moveToNamespaces`, `writeEdgeRows`), then the
 * ontology seed (`registry.ts`), add-only, once per version of the seed
 * (its `Migration` stamp).
 *
 * A failed statement inside a transaction ENDS it (the engine rolls back
 * and the next statement would run auto-commit), so a transaction that saw
 * one error refuses every later statement with that error.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { GraphTx, Params, Row } from "../engine.js";
import { EDGE_COLUMNS, EDGE_CORE_COLUMNS, LADYBUG_EDGE_TYPES, edgeColumnsOf, nodeColumns, type ColumnType } from "./registry.js";
import { PRIVATE_NAMESPACE } from "./namespaces.js";
import { DEFAULT_NAMESPACE } from "../bolt.js";
import { bootEnv } from "../../env.js";
import { ladybugMaxDbSize } from "./max-size.js";
import { SCHEMA_EDGE, SCHEMA_EDGE_DDL, SCHEMA_EDGE_RULE_COLUMNS, readCatalog, seedOntology } from "./ontology.js";
import { writeMissingEdgeRows } from "./temporal.js";
import { SCHEMA_TYPE, ontologySeed } from "./registry.js";
import { OWN_CREATED_AT } from "../strut-schemas.js";
import { nodeTitleFor } from "../title.js";
import { EXTENSION_NAMES, LADYBUG_EXTENSION_PINS, pinnedExtensions, type ExtensionName, type PinnedExtensions, type PinnedOptions } from "./extensions.js";

export type Query = (cypher: string, params?: Params) => Promise<Row[]>;

export interface ReadOnlyHandle {
  query: Query;
  /** One statement with its column names and a row cap: the rows are read
   *  one at a time and the rest left unfetched once `maxRows` are in —
   *  what the model's `graph_query` needs (query.ts). */
  run(cypher: string, params?: Params, opts?: { maxRows?: number }): Promise<{ columns: string[]; rows: Row[]; truncated: boolean }>;
  close(): Promise<void>;
}

export interface ReadOnlyOptions {
  /** `Connection.setQueryTimeout`: a statement running longer is cancelled. */
  queryTimeoutMs?: number;
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
  /** The model's Cypher (query.ts): a connection of its own on the same
   *  database, every statement inside a READ ONLY transaction — the engine
   *  refuses writes and catalog changes in it, and each statement sees
   *  what was committed before it began. Cheap: open one per call. */
  readOnly(opts?: ReadOnlyOptions): Promise<ReadOnlyHandle>;
  close(): Promise<void>;
}

export interface OpenOptions {
  /** Folder holding `libvector.lbug_extension` + `libfts.lbug_extension`
   *  (flat, or in `vector/` + `fts/` as the ladybug cache lays them out).
   *  Default `STRUT_LADYBUG_EXTENSION_DIR`; unset → strut's pinned copies,
   *  downloaded and verified on first use (extensions.ts), and with no pin
   *  for the loaded core or this platform, `INSTALL` (the download into
   *  `~/.lbdb`). */
  extensionDir?: string;
  /** Where the pinned copies come from and go (tests). */
  pinned?: PinnedOptions;
}

export const REQUIRED_EXTENSIONS = EXTENSION_NAMES;

let warnedUnpinned = false;
/** Once per process: INSTALL takes whatever extension.ladybugdb.com serves
 *  under the extension version today, which may not load into this core. */
function warnUnpinned(why: string): void {
  if (warnedUnpinned) return;
  warnedUnpinned = true;
  console.warn(`[graph] ${why}: INSTALLing vector + fts from extension.ladybugdb.com, whose files change under the same version`);
}


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
    out.push(`CREATE REL TABLE IF NOT EXISTS ${q(edge)}(FROM Node TO Node, ${cols(edgeColumnsOf(edge))})`);
    for (const [k, t] of Object.entries(edgeColumnsOf(edge))) out.push(`ALTER TABLE ${q(edge)} ADD IF NOT EXISTS ${q(k)} ${t}`);
  }
  // The ontology's own edges (`ontology.ts`), apart from the data's.
  out.push(SCHEMA_EDGE_DDL);
  return out;
}

/** Changes to what the DDL above once created, in order: each safe to run
 *  again, all run on every open. Append, never edit one that has shipped. */
export const MIGRATIONS: readonly string[] = [];

/** The core attributes' old column names (plans/graph-memory-plan.md "Core
 *  attributes"): `date_added_to_graph` → `created_at`, `Data_Bank` →
 *  `search_text`, `node_key` → `key` (a Schema row's → `key_spec`). */
export const CORE_RENAME_MIGRATION = "core_attribute_names_v1";

/** The migrations an older strut cannot read back from, in order: a file
 *  that holds data and lacks one of their stamps is copied aside before
 *  the open changes it (`backUp`). Add a one-way migration's stamp here. */
/** The namespaces migration's stamp (`moveToNamespaces`). */
export const NAMESPACES_MIGRATION = "namespaces_v1";

export const ONE_WAY_MIGRATIONS: readonly string[] = [CORE_RENAME_MIGRATION, NAMESPACES_MIGRATION];

/** The copy of `path` taken before the one-way migration `stamp`. */
export const backupPath = (path: string, stamp: string): string => `${path}.before-${stamp}.bak`;

/** The first one-way migration this file still needs, when it holds data:
 *  an empty or new file has nothing to keep. */
async function pendingOneWayMigration(read: Query): Promise<string | undefined> {
  const tables = new Set((await read("CALL show_tables() RETURN name")).map((r) => String(r["name"])));
  if (!tables.has("Node") || !Number((await read("MATCH (n:Node) RETURN count(n) AS c"))[0]?.["c"])) return undefined;
  const done = tables.has("Migration") ? new Set((await read("MATCH (m:Migration) RETURN m.migration_id AS id")).map((r) => String(r["id"]))) : new Set<string>();
  return ONE_WAY_MIGRATIONS.find((id) => !done.has(id));
}

/** Copies the file (and a WAL an unclean exit left) to its backup
 *  path, owner-only, so a rollback to an older strut has the file it wrote. */
function backUp(path: string, stamp: string): void {
  const to = backupPath(path, stamp);
  if (existsSync(`${path}.wal`)) copyFileSync(`${path}.wal`, `${to}.wal`);
  copyFileSync(path, to);
  chmodSync(to, 0o600);
  console.warn(`[graph] ${path} needs a one-way migration (${stamp}); copied it to ${to} first`);
}
const TITLE_PAGE = 1000;

/**
 * The rename, once per file (its `Migration` stamp), on a file an older
 * build wrote: `MIGRATIONS` runs every open after the DDL has added the new
 * columns, where a RENAME would fail. In order:
 *
 *   1. the FTS index over the old columns is dropped (derived data: the
 *      open's index step builds it again over `search_text` + `title`);
 *   2. every rel table gets `created_at`;
 *   3. one transaction copies old → new: `search_text`, `key` (`key_spec` on
 *      a Schema row), the version / chat / job types' own `created_at` to
 *      `published_at` / `started_at`, then the row's `created_at` from
 *      `date_added_to_graph` (a value still in seconds — a Check's own —
 *      made ms), edges' `created_at`, every data row's `title`
 *      (`nodeTitleFor`, as the writer fills it), and `created_at` out of
 *      every Schema's attributes — and the old columns are cleared.
 *
 * The old columns stay in the table, empty: Ladybug 0.21 has `ALTER TABLE …
 * DROP`, but a file that dropped a column before its last one fails its next
 * open (a segfault while the vector index is there, "Miss cached column"
 * without it). Nothing reads them. Every copy is guarded (only where the
 * old value is set and the new one unset), so a process that dies part way
 * is finished by the next open; the stamp comes last.
 */
async function renameCoreColumns(read: Query, write: Query): Promise<void> {
  if (Number((await read("MATCH (m:Migration {migration_id: $id}) RETURN count(m) AS c", { id: CORE_RENAME_MIGRATION }))[0]?.["c"]) > 0) return;
  const { columns, edges } = await readCatalog(read);
  const has = (c: string) => c in columns;
  const relCols = new Map<string, Set<string>>();
  for (const e of edges) relCols.set(e, new Set((await read(`CALL table_info('${e}') RETURN name`)).map((r) => String(r["name"]))));
  const old = has("date_added_to_graph") || has("Data_Bank") || has("node_key") || [...relCols.values()].some((c) => c.has("date_added_to_graph"));
  if (old) {
    const indexes = new Set((await read(`CALL SHOW_INDEXES() RETURN index_name`)).map((r) => String(r["index_name"])));
    if (indexes.has("node_fts")) await write(`CALL DROP_FTS_INDEX('Node', 'node_fts')`);
    for (const [e, cols] of relCols) if (!cols.has("created_at")) await write(`ALTER TABLE ${q(e)} ADD IF NOT EXISTS ${q("created_at")} INT64`);

    await write("BEGIN TRANSACTION");
    try {
      if (has("Data_Bank")) await write("MATCH (n:Node) WHERE n.search_text IS NULL AND n.Data_Bank IS NOT NULL SET n.search_text = n.Data_Bank");
      if (has("node_key")) {
        await write(`MATCH (n:Node) WHERE n.node_type = '${SCHEMA_TYPE}' AND n.key_spec IS NULL AND n.node_key IS NOT NULL SET n.key_spec = n.node_key`);
        await write(`MATCH (n:Node) WHERE n.node_type <> '${SCHEMA_TYPE}' AND n.key IS NULL AND n.node_key IS NOT NULL SET n.key = n.node_key`);
      }
      if (has("date_added_to_graph")) {
        // The types' own seconds move before the row's ms take the column.
        for (const [type, to] of Object.entries(OWN_CREATED_AT)) {
          await write(`MATCH (n:Node) WHERE n.node_type = $type AND n.${q(to)} IS NULL AND n.created_at IS NOT NULL AND n.date_added_to_graph IS NOT NULL SET n.${q(to)} = n.created_at`, { type });
        }
        await write("MATCH (n:Node) WHERE n.date_added_to_graph IS NOT NULL SET n.created_at = n.date_added_to_graph");
      }
      // Below 10^11 a stamp is seconds (ms passed it in 1973).
      await write("MATCH (n:Node) WHERE n.created_at IS NOT NULL AND n.created_at < 100000000000 SET n.created_at = n.created_at * 1000");
      for (const [e, cols] of relCols) {
        if (cols.has("date_added_to_graph")) await write(`MATCH ()-[r:${q(e)}]->() WHERE r.date_added_to_graph IS NOT NULL SET r.created_at = r.date_added_to_graph`);
      }
      await fillTitles(write, columns);
      for (const r of await write(`MATCH (n:Node {node_type: '${SCHEMA_TYPE}'}) WHERE n.attributes CONTAINS '"created_at"' RETURN n.ref_id AS id, n.attributes AS a`)) {
        const attrs = JSON.parse(String(r["a"])) as Record<string, unknown>;
        delete attrs["created_at"];
        await write("MATCH (n:Node {ref_id: $id}) SET n.attributes = $a", { id: r["id"], a: JSON.stringify(attrs) });
      }
      const cleared = ["date_added_to_graph", "Data_Bank", "node_key"].filter(has);
      if (cleared.length) await write(`MATCH (n:Node) SET ${cleared.map((c) => `n.${q(c)} = NULL`).join(", ")}`);
      for (const [e, cols] of relCols) if (cols.has("date_added_to_graph")) await write(`MATCH ()-[r:${q(e)}]->() SET r.date_added_to_graph = NULL`);
      await write("COMMIT");
    } catch (err) {
      await write("ROLLBACK").catch(() => undefined);
      throw err;
    }
  }
  await write("MERGE (m:Migration {migration_id: $id}) ON CREATE SET m.executed_at = $now", { id: CORE_RENAME_MIGRATION, now: Date.now() });
}

/** The schema rules (plans/graph-memory-plan.md step 2): an edge rule
 *  carries its edge type's `temporal` and `cardinality`. A file an older
 *  build made gets the two `SCHEMA_EDGE` columns, once (its `Migration`
 *  stamp); a new file has them from `SCHEMA_EDGE_DDL`. The Schema rows'
 *  `identifiers` column is a Node column, added by the DDL like any other.
 *  The claim-only edge columns (`EDGE_TYPE_COLUMNS`) stay on the rel
 *  tables an older build gave them to, empty: a column is never dropped. */
export const SCHEMA_RULES_MIGRATION = "schema_rules_v1";

async function addSchemaRuleColumns(read: Query, write: Query): Promise<void> {
  if (Number((await read("MATCH (m:Migration {migration_id: $id}) RETURN count(m) AS c", { id: SCHEMA_RULES_MIGRATION }))[0]?.["c"]) > 0) return;
  for (const [k, t] of Object.entries(SCHEMA_EDGE_RULE_COLUMNS)) await write(`ALTER TABLE ${q(SCHEMA_EDGE)} ADD IF NOT EXISTS ${q(k)} ${t}`);
  await write("MERGE (m:Migration {migration_id: $id}) ON CREATE SET m.executed_at = $now", { id: SCHEMA_RULES_MIGRATION, now: Date.now() });
}

/** Namespaces and `created_by` (plans/graph-memory-plan.md step 2;
 *  `namespaces.ts`), once per file (its `Migration` stamp). A file held
 *  `default` alone, and it was one person's graph, so its data is theirs:
 *  every data row in `default` (or none) moves to `private`, Strut's own
 *  records included. A Schema row is the file's type definition, outside
 *  namespace scoping, so it holds none: its `default` is cleared. Every rel
 *  table gets the edge core columns (a new file has them from the DDL),
 *  and an edge without a namespace takes its source node's, the rule a new
 *  edge follows. The Node table's `created_by` comes from the DDL like any
 *  generic column; the one type that declared its own (StrutJob, the same
 *  column) keeps its values, and the declaration leaves the Schema rows.
 *  The columns go first (DDL, outside the transaction); the rows move in
 *  one transaction, guarded (only rows without a namespace of their own),
 *  so a process that dies part way is finished by the next open; the stamp
 *  comes last. One-way (`ONE_WAY_MIGRATIONS`): an older strut refuses any
 *  namespace but `default`. */

async function moveToNamespaces(read: Query, write: Query): Promise<void> {
  if (Number((await read("MATCH (m:Migration {migration_id: $id}) RETURN count(m) AS c", { id: NAMESPACES_MIGRATION }))[0]?.["c"]) > 0) return;
  const { edges } = await readCatalog(read);
  const rels = [...new Set([...edges, SCHEMA_EDGE])];
  const added = Object.entries(EDGE_COLUMNS).filter(([k]) => EDGE_CORE_COLUMNS.includes(k));
  for (const e of rels) for (const [k, t] of added) await write(`ALTER TABLE ${q(e)} ADD IF NOT EXISTS ${q(k)} ${t}`);
  await write("BEGIN TRANSACTION");
  try {
    await write(`MATCH (n:Node) WHERE n.node_type <> '${SCHEMA_TYPE}' AND (n.namespace IS NULL OR n.namespace = '${DEFAULT_NAMESPACE}') SET n.namespace = '${PRIVATE_NAMESPACE}'`);
    await write(`MATCH (n:Node {node_type: '${SCHEMA_TYPE}'}) WHERE n.namespace IS NOT NULL SET n.namespace = NULL`);
    for (const e of edges) {
      await write(`MATCH (s:Node)-[r:${q(e)}]->(:Node) WHERE r.namespace IS NULL AND s.namespace IS NOT NULL SET r.namespace = s.namespace, r.updated_at = coalesce(r.updated_at, r.created_at)`);
    }
    for (const r of await write(`MATCH (n:Node {node_type: '${SCHEMA_TYPE}'}) WHERE n.attributes CONTAINS '"created_by"' RETURN n.ref_id AS id, n.attributes AS a`)) {
      const attrs = JSON.parse(String(r["a"])) as Record<string, unknown>;
      delete attrs["created_by"];
      await write("MATCH (n:Node {ref_id: $id}) SET n.attributes = $a", { id: r["id"], a: JSON.stringify(attrs) });
    }
    await write("COMMIT");
  } catch (err) {
    await write("ROLLBACK").catch(() => undefined);
    throw err;
  }
  await write("MERGE (m:Migration {migration_id: $id}) ON CREATE SET m.executed_at = $now", { id: NAMESPACES_MIGRATION, now: Date.now() });
}

/** The temporal edges' search rows (plans/graph-edge-search.md), once per
 *  file (its `Migration` stamp): a row for every temporal edge that has
 *  `text` and none, keyword-only (the vectors are filled after). Rows are
 *  derived from the edge and its ends, so this only adds: no backup
 *  (`ONE_WAY_MIGRATIONS`). Guarded, not one transaction: it writes only the
 *  rows that are missing, so a process that dies part way is finished by
 *  the next open, and the stamp comes last. */
export const EDGE_ROWS_MIGRATION = "edge_text_rows_v1";

async function writeEdgeRows(read: Query, write: Query): Promise<void> {
  if (Number((await read("MATCH (m:Migration {migration_id: $id}) RETURN count(m) AS c", { id: EDGE_ROWS_MIGRATION }))[0]?.["c"]) > 0) return;
  await writeMissingEdgeRows(write, Date.now());
  await write("MERGE (m:Migration {migration_id: $id}) ON CREATE SET m.executed_at = $now", { id: EDGE_ROWS_MIGRATION, now: Date.now() });
}

/** Every data row without a `title` gets the one the writer would give it:
 *  its type's `title_key`, else the first line of its text or search text.
 *  A type that declares `title` itself keeps what it has. By page, on the
 *  caller's transaction. */
async function fillTitles(run: Query, columns: Record<string, string>): Promise<void> {
  const types = new Map<string, { title_key: string; owns: boolean }>();
  for (const r of await run(`MATCH (n:Node {node_type: '${SCHEMA_TYPE}'}) RETURN n.type AS type, n.title_key AS k, n.attributes AS a`)) {
    let owns = false;
    try {
      owns = "title" in (JSON.parse(String(r["a"] ?? "{}")) as Record<string, unknown>);
    } catch {
      // An unreadable declaration: the title comes from the title_key.
    }
    types.set(String(r["type"]), { title_key: typeof r["k"] === "string" && r["k"] ? r["k"] : "name", owns });
  }
  const fields = Object.keys(columns).filter((c) => c !== "text_embeddings" && columns[c] === "STRING");
  const projection = `{${[...new Set(["ref_id", "node_type", "search_text", ...fields])].map((c) => `${q(c)}: n.${q(c)}`).join(", ")}}`;
  let after = "";
  for (;;) {
    const page = await run(
      `MATCH (n:Node) WHERE n.node_type <> '${SCHEMA_TYPE}' AND n.title IS NULL AND n.ref_id > $after RETURN ${projection} AS n ORDER BY n.ref_id LIMIT ${TITLE_PAGE}`,
      { after },
    );
    const rows: Array<{ id: string; title: string }> = [];
    for (const r of page) {
      const n = r["n"] as Record<string, unknown>;
      const t = types.get(String(n["node_type"]));
      if (t?.owns) continue;
      const title = nodeTitleFor({ title_key: t?.title_key ?? "name" }, n, typeof n["search_text"] === "string" ? n["search_text"] : null);
      if (title) rows.push({ id: String(n["ref_id"]), title });
    }
    if (rows.length) await run("UNWIND $rows AS r MATCH (n:Node {ref_id: r.id}) SET n.title = r.title", { rows });
    if (page.length < TITLE_PAGE) return;
    after = String((page[page.length - 1]!["n"] as Record<string, unknown>)["ref_id"]);
  }
}

/** The two indexes, `[name, call]`: one HNSW over `text_embeddings`, one FTS
 *  over the search text and the title. */
export function indexCalls(): Array<[string, string]> {
  return [
    ["node_vec", `CALL CREATE_VECTOR_INDEX('Node', 'node_vec', 'text_embeddings', metric := 'cosine')`],
    ["node_fts", `CALL CREATE_FTS_INDEX('Node', 'node_fts', ['search_text', 'title'], stemmer := 'porter')`],
  ];
}

/** The ontology seed (`ontology.ts`), in one transaction, when this version
 *  of it has not been stamped: a file seeded by an older version gets the
 *  seed's types as they are now, and keeps every type created at runtime.
 *  A seed type the file cannot take (a runtime type holds its name or one
 *  of its columns) is skipped with a warning, never a failed open. */
async function seedOnce(read: Query, write: Query): Promise<void> {
  const { id } = ontologySeed();
  if (Number((await read("MATCH (m:Migration {migration_id: $id}) RETURN count(m) AS c", { id }))[0]?.["c"]) > 0) return;
  await write("BEGIN TRANSACTION");
  try {
    const report = await seedOntology(write);
    for (const why of report.skipped) console.warn(`[graph] ontology seed: skipped ${why}`);
    await write("MERGE (m:Migration {migration_id: $id}) ON CREATE SET m.executed_at = $now", { id, now: Date.now() });
    await write("COMMIT");
  } catch (err) {
    await write("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

/** After an exit without `close()` Ladybug replays its WAL but not the FTS
 *  index: a later SET or DELETE of an older node fails "FTS index 'node_fts'
 *  is inconsistent". A SET of every node, rolled back, finds that (a LIMIT
 *  would miss it: only nodes written before the kill are affected), and the
 *  index, being derived data, is dropped and built again. It costs a rewrite
 *  of every node, so it runs when a WAL was left (an unclean exit) and once
 *  per file otherwise, for files an older build left broken. A check that
 *  fails any other way is skipped: it never keeps a healthy file from opening. */
async function rebuildBrokenFts(read: Query, write: Query, unclean: boolean): Promise<void> {
  const marker = "fts-probed";
  const probed = (await read("MATCH (m:Migration {migration_id: $id}) RETURN count(m) AS c", { id: marker }))[0]?.["c"];
  if (!unclean && Number(probed) > 0) return;
  let broken = false;
  try {
    await write("BEGIN TRANSACTION");
    await write("MATCH (n:Node) SET n.title = n.title");
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (!/FTS index '[^']*' is inconsistent/.test(why)) return console.warn(`[graph] full-text index check skipped: ${why.split("\n")[0]}`);
    broken = true;
  } finally {
    await write("ROLLBACK").catch(() => undefined);
  }
  if (broken) {
    console.warn("[graph] the full-text index did not survive the last exit; building it again");
    const [name, call] = indexCalls().find(([n]) => n === "node_fts")!;
    await write(`CALL DROP_FTS_INDEX('Node', '${name}')`);
    await write(call);
  }
  await write("MERGE (m:Migration {migration_id: $id}) ON CREATE SET m.executed_at = $now", { id: marker, now: Date.now() });
}

let shuttingDown = false;
/** Closes in flight, so a shutdown waits for a `close()` someone else began. */
const closing = new Set<Promise<void>>();

/** Closes every open handle, and refuses new ones: what `desktop.js` calls
 *  before it exits. */
export async function closeAllLadybug(): Promise<void> {
  shuttingDown = true;
  const open = [...registry().values()];
  await Promise.allSettled([...open.map(async (h) => (await h).close()), ...closing]);
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

type Conn = import("@ladybugdb/core").Connection;
type QueryResult = import("@ladybugdb/core").QueryResult;

function plainRow(r: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) out[k] = plain(v);
  return out;
}

/** The last result of a statement (a multi-statement string yields one per
 *  statement). */
async function execute(conn: Conn, cypher: string, params: Params): Promise<QueryResult> {
  const result = Object.keys(params).length
    ? await conn.execute(await conn.prepare(cypher), clean(params) as Record<string, never>)
    : await conn.query(cypher);
  return Array.isArray(result) ? result[result.length - 1]! : result;
}

function queryOn(conn: Conn): Query {
  return async (cypher, params = {}) => {
    const rows = (await (await execute(conn, cypher, params)).getAll()) as Row[];
    return rows.map(plainRow);
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
  // A WAL still here means the last process did not close the file.
  const unclean = existsSync(`${path}.wal`);
  const existed = existsSync(path);

  const lbug = await loadLadybug();
  const db = new lbug.Database(path, 0, true, false, ladybugMaxDbSize());
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
    // Copied before this open writes anything (the DDL, the migrations):
    // the file is as the last close left it.
    const pending = existed ? await pendingOneWayMigration(read) : undefined;
    if (pending && !existsSync(backupPath(path, pending))) backUp(path, pending);
    // Extensions: by path from the given folder, else strut's pinned copies
    // (extensions.ts), else — no pin for this core or platform — the ladybug download.
    const dir = opts.extensionDir ?? bootEnv()["STRUT_LADYBUG_EXTENSION_DIR"];
    let pinned: PinnedExtensions | undefined;
    const loadPath = (query: Query, path: string) => query(`LOAD EXTENSION '${path.replace(/'/g, "''")}'`);
    const load = async (query: Query, name: ExtensionName) => {
      if (dir) return loadPath(query, extensionPath(dir, name));
      pinned ??= await pinnedExtensions(lbug.Database.getVersion(), opts.pinned);
      if ("files" in pinned) return loadPath(query, pinned.files[name]);
      warnUnpinned(pinned.none);
      await query(`INSTALL ${name}`);
      await query(`LOAD EXTENSION ${name}`);
    };
    for (const name of REQUIRED_EXTENSIONS) {
      try {
        await load(read, name);
      } catch (err) {
        throw new Error(
          `the graph backend needs ladybug's ${name} extension and it did not load: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}. ` +
            `Set STRUT_LADYBUG_EXTENSION_DIR to a folder holding libvector.lbug_extension and libfts.lbug_extension for ladybug ${lbug.Database.getVersion()}, ` +
            `or let strut download its pinned copies (needs network access to ${new URL(LADYBUG_EXTENSION_PINS.baseUrl).host}).`,
        );
      }
    }
    for (const ddl of [...ddlStatements(), ...MIGRATIONS]) await write(ddl);
    await renameCoreColumns(read, write);
    await addSchemaRuleColumns(read, write);
    await moveToNamespaces(read, write);
    await writeEdgeRows(read, write);
    const have = new Set((await read(`CALL SHOW_INDEXES() RETURN index_name`)).map((r) => String(r["index_name"]))); // `_PK` rows included; harmless
    for (const [name, call] of indexCalls()) if (!have.has(name)) await write(call);
    await rebuildBrokenFts(read, write, unclean);
    await seedOnce(read, write);

    let queue: Promise<unknown> = Promise.resolve();
    let closed = false;
    const exclusive = <T>(fn: (w: Query) => Promise<T>): Promise<T> => {
      if (closed) return Promise.reject(new Error("the graph is closing"));
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
      readOnly: async (ro_opts = {}) => {
        // Its own connection, so the transaction never wraps the handle's
        // other reads; the extensions are the Database's, already loaded.
        const conn = new lbug.Connection(db);
        if (ro_opts.queryTimeoutMs) conn.setQueryTimeout(ro_opts.queryTimeoutMs);
        const raw = queryOn(conn);
        const readOnlyTx = async <T>(fn: () => Promise<T>): Promise<T> => {
          await raw("BEGIN TRANSACTION READ ONLY");
          try {
            const out = await fn();
            await raw("COMMIT");
            return out;
          } catch (err) {
            // A refused statement may already have ended the transaction.
            await raw("ROLLBACK").catch(() => undefined);
            throw err;
          }
        };
        return {
          query: (cypher, params) => readOnlyTx(() => raw(cypher, params)),
          run: (cypher, params = {}, { maxRows = Infinity } = {}) =>
            readOnlyTx(async () => {
              const result = await execute(conn, cypher, params);
              try {
                const columns = await result.getColumnNames();
                const rows: Row[] = [];
                let truncated = false;
                while (result.hasNext()) {
                  if (rows.length >= maxRows) {
                    truncated = true;
                    break;
                  }
                  const r = await result.getNext();
                  if (!r) break;
                  rows.push(plainRow(r));
                }
                return { columns, rows, truncated };
              } finally {
                result.close();
              }
            }),
          close: () => conn.close().catch(() => undefined),
        };
      },
      close: () => {
        closed = true;
        const done = (async () => {
          registry().delete(path);
          await queue.catch(() => undefined);
          // Folds the WAL into the file, so the next open replays nothing.
          await write("CHECKPOINT").catch((err) => console.warn(`[graph] checkpoint failed: ${String(err).split("\n")[0]}`));
          await closeAll();
        })();
        closing.add(done);
        void done.finally(() => closing.delete(done));
        return done;
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
  if (shuttingDown) return Promise.reject(new Error("strut is shutting down"));
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
