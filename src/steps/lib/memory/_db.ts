// A reader of the old memory database (the retired memory/* steps' own
// Ladybug file), kept for graph/import-memory alone: the one-time move of a
// user's old memories onto the workspace graph. Leading underscore: imported
// by siblings, skipped by registry discovery.
//
// It never opens the old file itself. The file and its WAL are copied to a
// folder of their own, and the copy is opened, brought up to the last schema
// the old memory had and read, so the original stays as it was.
//
// The old memory: an Episode is what was said, an Entity what it was about,
// a Fact one sentence linking them, with valid / invalid / expired times.
// Its vocabulary (entity types, predicates) is the Ontology table
// (_ontology.ts).
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { loadLadybug } from "../../../graph/ladybug/db.js";
import { ladybugMaxDbSize } from "../../../graph/ladybug/max-size.js";
import { foldText } from "../../../graph/world-time.js";
import { ONTOLOGY_DDL, seed } from "./_ontology.js";
import { SEED } from "./_ontology-seed.js";

const SCHEMA = [
  `CREATE NODE TABLE IF NOT EXISTS Entity(ref_id STRING PRIMARY KEY, type STRING, name STRING, summary STRING,
     attributes STRING, aliases STRING[], created_by STRING, created_at INT64, updated_at INT64, deleted_at INT64)`,
  `CREATE NODE TABLE IF NOT EXISTS Fact(ref_id STRING PRIMARY KEY, predicate STRING, text STRING, confidence DOUBLE,
     valid_at INT64, invalid_at INT64, expired_at INT64, created_by STRING, created_at INT64, updated_at INT64, deleted_at INT64)`,
  `CREATE NODE TABLE IF NOT EXISTS Episode(ref_id STRING PRIMARY KEY, kind STRING, source STRING, content STRING,
     occurred_at INT64, created_by STRING, created_at INT64, updated_at INT64, deleted_at INT64)`,
  "CREATE REL TABLE IF NOT EXISTS MENTIONS(FROM Episode TO Entity)",
  "CREATE REL TABLE IF NOT EXISTS SUBJECT(FROM Fact TO Entity)",
  "CREATE REL TABLE IF NOT EXISTS OBJECT(FROM Fact TO Entity)",
  "CREATE REL TABLE IF NOT EXISTS FROM_EPISODE(FROM Fact TO Episode)",
  "CREATE REL TABLE IF NOT EXISTS SUPERSEDES(FROM Fact TO Fact)",
  "CREATE REL TABLE IF NOT EXISTS CONTRADICTS(FROM Fact TO Fact)",
  "CREATE REL TABLE IF NOT EXISTS ALIAS_OF(FROM Entity TO Entity)",
  ONTOLOGY_DDL,
];

// Changes to tables that already exist, in order. Each is safe to run again,
// so they all run on every open (once per process); append, never edit one
// that has shipped. The Fact scans are fine at personal scale.
const MIGRATIONS = [
  "ALTER TABLE Entity ADD IF NOT EXISTS deleted_reason STRING",
  "ALTER TABLE Fact ADD IF NOT EXISTS deleted_reason STRING",
  "ALTER TABLE Episode ADD IF NOT EXISTS deleted_reason STRING",
  // No default: rows written before read NULL, which seed() backfills.
  "ALTER TABLE Ontology ADD IF NOT EXISTS parent STRING",
  "ALTER TABLE Ontology ADD IF NOT EXISTS naming STRING",
  "ALTER TABLE Ontology ADD IF NOT EXISTS role STRING",
  "ALTER TABLE Episode ADD IF NOT EXISTS speaker STRING",
  // Facts written before world time stored record time in its place: a
  // valid_at equal to created_at, an invalid_at equal to expired_at. Neither
  // is a date the words gave. A new write makes them equal only when the
  // date given is the very millisecond it was written.
  "MATCH (f:Fact) WHERE f.valid_at = f.created_at SET f.valid_at = NULL",
  "MATCH (f:Fact) WHERE f.invalid_at IS NOT NULL AND f.invalid_at = f.expired_at SET f.invalid_at = NULL",
  // The name a name fact (predicate role alias) gave its subject as an alias, so forgetting the fact can take it back.
  "ALTER TABLE Fact ADD IF NOT EXISTS value STRING",
  // A mishearing fact's written form, when it is not its subject's name ("bee tee see" → BTC on Bitcoin).
  "ALTER TABLE Fact ADD IF NOT EXISTS form STRING",
];

export type Row = Record<string, any>;
export type Query = (cypher: string, params?: Record<string, any>) => Promise<Row[]>;

/** The old database's file: `STRUT_MEMORY_DB` (secret store → env), else
 *  `<dataDir>/memory/graph.lbug`; undefined when there is none. */
export async function oldMemoryPath(ctx?: StepContext<unknown>): Promise<string | undefined> {
  const services = ctx?.services as Partial<StrutCapabilities> | undefined;
  const explicit = await services?.secrets?.get("STRUT_MEMORY_DB");
  const path = explicit ? resolve(explicit) : services?.dataDir ? resolve(join(services.dataDir, "memory", "graph.lbug")) : undefined;
  return path && existsSync(path) ? path : undefined;
}

// One open copy per old file per process: a Ladybug open reserves address
// space that close() never gives back (max-size.ts), so a second import in
// the same process reads the copy the first one made.
const COPIES = Symbol.for("strut.old-memory.copies");
const copies = (): Map<string, Promise<Query>> => ((globalThis as Record<symbol, Map<string, Promise<Query>>>)[COPIES] ??= new Map());

/** The old memory at `path`, read from a copy of it: a query function. */
export function oldMemory(path: string): Promise<Query> {
  let q = copies().get(path);
  if (!q) {
    q = openCopy(path);
    copies().set(path, q);
    q.catch(() => copies().delete(path));
  }
  return q;
}

async function openCopy(path: string): Promise<Query> {
  const dir = mkdtempSync(join(tmpdir(), "strut-old-memory-"));
  // Owner-only by mkdtemp (0700). The WAL holds the latest writes: without it they are lost.
  const copy = join(dir, "graph.lbug");
  copyFileSync(path, copy);
  if (existsSync(`${path}.wal`)) copyFileSync(`${path}.wal`, `${copy}.wal`);
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  const lbug = await loadLadybug();
  const db = new lbug.Database(copy, 0, true, false, ladybugMaxDbSize());
  const conn = new lbug.Connection(db);
  const query: Query = async (cypher, params = {}) => {
    const result = Object.keys(params).length ? await conn.execute(await conn.prepare(cypher), params) : await conn.query(cypher);
    const last = Array.isArray(result) ? result[result.length - 1]! : result;
    return (await last.getAll()) as Row[];
  };
  // A file an older strut wrote lacks later columns and seeded roles.
  await createTables(query);
  await seed(query, SEED);
  return query;
}

/** The old memory's tables, made or brought up to date: what its last version had. */
export async function createTables(query: Query): Promise<void> {
  for (const ddl of [...SCHEMA, ...MIGRATIONS]) await query(ddl);
}

export const normalize = foldText;

export function iso(ms: unknown): string | undefined {
  return typeof ms === "number" || typeof ms === "bigint" ? new Date(Number(ms)).toISOString() : undefined;
}
