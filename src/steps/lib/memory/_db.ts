// Shared Ladybug handle and schema for the memory/* steps. Leading-underscore
// file → imported by siblings, skipped by registry discovery (see AGENTS.md).
//
// The memory is a Graphiti-style graph: an Episode is what was said, an
// Entity what it was about, a Fact one sentence linking them, with valid /
// invalid / expired times. A fact that changes is superseded, never
// overwritten. Vocabulary (entity types, predicates) lives in the Ontology
// table (_ontology.ts).
//
// Two clocks: valid_at / invalid_at say when a fact was true in the world
// (NULL when the words gave no time), created_at / expired_at when the memory
// learned it and stopped holding it current.
//
// An episode's speaker is the ref_id of who said it; NULL means the user, so
// an episode the user said before they had an entity needs none made.
//
// remember, merge and forget each run as one transaction on a connection of their
// own (memoryWrite): a failure part-way leaves nothing behind, and a read on
// the shared connection never sees a write in progress.
import type { Connection } from "@ladybugdb/core";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { ONTOLOGY_DDL, invalidate, seed, wroteOntology } from "./_ontology.js";
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
];

export type Row = Record<string, any>;
export type Query = (cypher: string, params?: Record<string, any>) => Promise<Row[]>;

// One handle per database file per process: Ladybug allows one open
// database per file. Kept on globalThis so a re-imported module shares it,
// with the queue that runs its writes one at a time.
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

export type Handle = { path: string; read: Query; write: Query; queue: Promise<unknown>; ladybug: string };

// The address space a Database reserves on open, which `close()` never
// returns: the addon's default is 8 TB, and the kernel maps eight to ten of
// those per process, so a test file with nine databases failed on the
// ninth. 1 TB is no limit a memory graph reaches and fits a hundred times.
export const MAX_DB_SIZE = 2 ** 40;

async function open(path: string): Promise<Handle> {
  // Owner-only: whatever modes Ladybug gives its files, nobody else on
  // this machine can reach them through this folder. A folder that was
  // already there keeps its modes; an open one gets a warning.
  const folder = dirname(path);
  if (!ownerOnly(folder) && statSync(folder).mode & 0o077) {
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
  const db = new lbug.Database(path, 0, true, false, MAX_DB_SIZE);
  const handle = {
    path,
    read: queryOn(new lbug.Connection(db)),
    write: queryOn(new lbug.Connection(db)),
    queue: Promise.resolve(),
    ladybug: lbug.Database.getVersion(),
  };
  await ensureSchema(handle.read);
  return handle;
}

/** Makes `folder` owner-only (0700, whatever the umask) when it creates it; true when it did. */
export function ownerOnly(folder: string): boolean {
  if (!mkdirSync(folder, { recursive: true, mode: 0o700 })) return false;
  chmodSync(folder, 0o700);
  return true;
}

/** Creates what is missing, brings older tables up to date, and seeds the ontology. */
export async function ensureSchema(query: Query): Promise<void> {
  for (const ddl of [...SCHEMA, ...MIGRATIONS]) await query(ddl);
  await seed(query, SEED);
}

/** How many migrations this strut knows: a snapshot's tables are up to date to this many. */
export const MIGRATION_COUNT = MIGRATIONS.length;

function connection(path: string): Promise<Handle> {
  const g = globalThis as Record<symbol, Map<string, Promise<Handle>> | undefined>;
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

function queryOn(conn: Connection): Query {
  return async (cypher, params = {}) => {
    const result = Object.keys(params).length
      ? await conn.execute(await conn.prepare(cypher), params)
      : await conn.query(cypher);
    const last = Array.isArray(result) ? result[result.length - 1]! : result;
    return (await last.getAll()) as Row[];
  };
}

const handleFor = async (ctx?: StepContext<unknown>) => connection(await dbPath(ctx as StepContext<StrutCapabilities> | undefined));

/** The memory graph this run's deployment keeps, as a query function. */
export async function memoryDb(ctx?: StepContext<unknown>): Promise<Query> {
  return (await handleFor(ctx)).read;
}

/** Runs `fn` as one transaction on the write connection, one write at a time:
 *  all of it lands, or, when it throws, none of it. Must not nest: an inner
 *  call would wait on the queue the outer one holds. */
export async function memoryWrite<T>(ctx: StepContext<unknown> | undefined, fn: (query: Query) => Promise<T>): Promise<T> {
  return memoryExclusive(ctx, async (handle) => {
    // A failed statement rolls the transaction back, so every later one,
    // and the commit, fails with it, even when `fn` caught the first.
    let dead: { err: unknown } | undefined;
    const tx: Query = async (cypher, params) => {
      if (dead) throw dead.err;
      try {
        return await handle.write(cypher, params);
      } catch (err) {
        dead = { err };
        throw err;
      }
    };
    await handle.write("BEGIN TRANSACTION");
    try {
      const out = await fn(tx);
      await tx("COMMIT");
      if (wroteOntology(tx)) invalidate(handle.read);
      return out;
    } catch (err) {
      await handle.write("ROLLBACK").catch(() => undefined);
      throw err;
    }
  });
}

/** Runs `fn` in the writes' queue with no transaction around it: for what
 *  cannot run inside one (CHECKPOINT, EXPORT / IMPORT DATABASE, DROP TABLE).
 *  Reads go on meanwhile. Must not nest, as memoryWrite. */
export async function memoryExclusive<T>(ctx: StepContext<unknown> | undefined, fn: (handle: Handle) => Promise<T>): Promise<T> {
  const handle = await handleFor(ctx);
  const run = () => fn(handle);
  const next = handle.queue.then(run, run);
  handle.queue = next.catch(() => undefined);
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

/** Ends the `old` facts as replaced by `by` (expired now) and links them to it. In
 *  the world one ended when `by` began, when that is known and not before it began itself;
 *  an end still to come is brought forward to then, or to now when that is not known. */
export async function supersede(query: Query, by: string, valid: number | null, old: string[], now: number): Promise<void> {
  if (!old.length) return;
  // When `by` began, if known and not before `o` did.
  const began = valid === null ? "false" : "(o.valid_at IS NULL OR o.valid_at <= $valid)";
  await query(
    `MATCH (o:Fact), (n:Fact) WHERE o.ref_id IN $old AND n.ref_id = $by
     SET o.expired_at = $now, o.updated_at = $now,
         o.invalid_at = CASE
           WHEN o.invalid_at IS NULL THEN CASE WHEN ${began} THEN $valid ELSE o.invalid_at END
           WHEN o.invalid_at <= $now THEN o.invalid_at
           WHEN ${began} THEN CASE WHEN $valid < o.invalid_at THEN $valid ELSE o.invalid_at END
           ELSE $now END
     CREATE (n)-[:SUPERSEDES]->(o)`,
    { old, by, valid, now },
  );
}

/** Adds names to an entity's aliases, or with `remove` takes them off; normalised either way. Returns the aliases after. */
export async function editAliases(query: Query, id: string, names: string[], now: number, remove = false): Promise<string[]> {
  const [e] = await query("MATCH (e:Entity) WHERE e.ref_id = $id RETURN e.aliases AS aliases", { id });
  const was: string[] = e?.aliases ?? [];
  const keys = names.map(normalize);
  const next = remove ? was.filter((a) => !keys.includes(a)) : [...new Set([...was, ...keys])];
  if (e && next.length !== was.length) await query("MATCH (e:Entity) WHERE e.ref_id = $id SET e.aliases = $next, e.updated_at = $now", { id, next, now });
  return next;
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
