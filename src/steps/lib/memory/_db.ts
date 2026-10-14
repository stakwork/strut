// Shared Ladybug handle and schema for the memory/* steps. Leading-underscore
// file → imported by siblings, skipped by registry discovery (see AGENTS.md).
//
// The memory is a Graphiti-style graph: an Episode is what was said, an
// Entity what it was about, a Fact one sentence linking them, with valid /
// invalid / expired times. A fact that changes is superseded, never
// overwritten. Vocabulary (entity types, predicates) lives in the Ontology
// table (_ontology.ts).
//
// Writes are not atomic: remember and merge are many statements with no
// transaction around them. A failure part-way can leave a partial write (an
// episode without its facts, a fact without its episode link); a later
// remember of the same thing repeats it rather than repairing it.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { ONTOLOGY_DDL, seed } from "./_ontology.js";
import { SEED } from "./_ontology-seed.js";

export const EntityRef = z.object({
  ref_id: z.string().optional().describe("An existing entity's ref_id, when you already know it."),
  type: z.string().min(1).describe(
    "An entity type from memory/ontology, e.g. Person; each type's description says when to use it, and user_type is the user. " +
      "A new type is kept as proposed.",
  ),
  name: z.string().min(1).describe("The entity's name, e.g. 'Kate' or 'Friday Night Chef'."),
});
export type EntityRefT = z.infer<typeof EntityRef>;

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
// so they all run on every open; append, never edit one that has shipped.
const MIGRATIONS = [
  "ALTER TABLE Entity ADD IF NOT EXISTS deleted_reason STRING",
  "ALTER TABLE Fact ADD IF NOT EXISTS deleted_reason STRING",
  "ALTER TABLE Episode ADD IF NOT EXISTS deleted_reason STRING",
  // No default: rows written before read NULL, which seed() backfills.
  "ALTER TABLE Ontology ADD IF NOT EXISTS parent STRING",
  "ALTER TABLE Ontology ADD IF NOT EXISTS naming STRING",
  "ALTER TABLE Ontology ADD IF NOT EXISTS role STRING",
];

export type Row = Record<string, any>;
export type Query = (cypher: string, params?: Record<string, any>) => Promise<Row[]>;

// One handle per database file per process: Ladybug allows one open
// database per file. Kept on globalThis so a re-imported module shares it.
// The handle is the query function itself, one per file, so a cache keyed
// by it (_ontology.ts vocabulary) is per database.
const HANDLES = Symbol.for("strut.memory.ladybug");

/** `STRUT_MEMORY_DB` (secret store → env), else `<dataDir>/memory/graph.lbug`; absolute, so
 *  every spelling of one file shares one handle. */
async function dbPath(ctx?: StepContext<StrutCapabilities>): Promise<string> {
  const services = ctx?.services as Partial<StrutCapabilities> | undefined;
  const explicit = await services?.secrets?.get("STRUT_MEMORY_DB");
  if (explicit) return resolve(explicit);
  if (!services?.dataDir) {
    throw new Error("memory/* steps need the server's dataDir (ctx.services.dataDir) or STRUT_MEMORY_DB set to the database file");
  }
  return resolve(join(services.dataDir, "memory", "graph.lbug"));
}

async function open(path: string): Promise<Query> {
  // Owner-only: whatever modes Ladybug gives its files, nobody else on
  // this machine can reach them through this folder. A folder that was
  // already there keeps its modes; an open one gets a warning.
  const folder = dirname(path);
  if (mkdirSync(folder, { recursive: true, mode: 0o700 })) chmodSync(folder, 0o700);
  else if (statSync(folder).mode & 0o077) {
    console.warn(`memory: ${folder} is readable by other users; chmod 700 it to keep the memory graph private`);
  }
  // Lazy: an optional dependency with a native addon, loaded on first use
  // only, so registry build never needs it (lib step dependency convention).
  const lbug = await import("@ladybugdb/core").catch((err: unknown) => {
    throw new Error(
      `memory/* steps need @ladybugdb/core, an optional dependency that did not load here ` +
        `(${err instanceof Error ? err.message : String(err)}). Install it with: npm install @ladybugdb/core`,
    );
  });
  const conn = new lbug.Connection(new lbug.Database(path));
  for (const ddl of [...SCHEMA, ...MIGRATIONS]) await conn.query(ddl);
  const query: Query = async (cypher, params = {}) => {
    const result = Object.keys(params).length
      ? await conn.execute(await conn.prepare(cypher), params)
      : await conn.query(cypher);
    const last = Array.isArray(result) ? result[result.length - 1]! : result;
    return (await last.getAll()) as Row[];
  };
  await seed(query, SEED);
  return query;
}

function connection(path: string): Promise<Query> {
  const g = globalThis as Record<symbol, Map<string, Promise<Query>> | undefined>;
  const handles = (g[HANDLES] ??= new Map());
  let handle = handles.get(path);
  if (!handle) {
    handle = open(path);
    handles.set(path, handle);
    // A failed open is not cached: the next run tries again.
    handle.catch(() => handles.delete(path));
  }
  return handle;
}

/** The memory graph this run's deployment keeps, as a query function. */
export async function memoryDb(ctx?: StepContext<unknown>): Promise<Query> {
  return connection(await dbPath(ctx as StepContext<StrutCapabilities> | undefined));
}

// Writes go one at a time so a remember never interleaves with another.
let queue: Promise<unknown> = Promise.resolve();
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

/** Time-sortable and random, never derived from text. */
export function newRefId(): string {
  return Date.now().toString(36).padStart(9, "0") + randomBytes(8).toString("hex");
}

export function normalize(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function iso(ms: unknown): string | undefined {
  return typeof ms === "number" || typeof ms === "bigint" ? new Date(Number(ms)).toISOString() : undefined;
}

/** The entity a ref_id now means: itself, or, once merged away, the entity it is an alias of. */
export async function canonical(query: Query, refId: string): Promise<string> {
  const [hit] = await query(
    `MATCH (d:Entity)-[:ALIAS_OF*1..5]->(k:Entity) WHERE d.ref_id = $id AND d.deleted_at IS NOT NULL AND k.deleted_at IS NULL
     RETURN k.ref_id AS id LIMIT 1`,
    { id: refId },
  );
  return hit?.id ?? refId;
}
