/**
 * Strut domain registration — the schema meta-graph, constraints, and
 * indexes jarvis would have created for a domain of its own
 * (`plans/jarvis-graph-compat.md` §4).
 *
 * Runs at every boot of the graph backend. Idempotent and ADD-ONLY: every
 * statement is `IF NOT EXISTS` or a guarded MERGE/CREATE, and an existing
 * Schema node is only ever extended with keys it lacks — never overwritten.
 * Running it twice produces zero graph diff; running it against a
 * jarvis-seeded database changes nothing jarvis owns.
 *
 * Two deployment modes fall out of the same code path: **standalone** (a
 * fresh Neo4j — we create `Thing`, the global constraints, and the global
 * vector index too) and **shared** (jarvis already seeded those; our
 * `IF NOT EXISTS` forms are no-ops).
 *
 * The Schema rows go through `SchemaSource` (`engine.ts`), so the same seed
 * runs on a Ladybug file; the constraints and search indexes are Neo4j DDL
 * and run only there (`engine.bolt`).
 */
import { randomUUID } from "node:crypto";
import type { Bolt } from "./bolt.js";
import type { EngineLike, SchemaSource } from "./engine.js";
import { asEngine } from "./neo4j-engine.js";
import {
  THING_SCHEMA,
  THING_TYPE,
  STRUT_DOMAIN_LABEL,
  STRUT_EDGES,
  JARVIS_SOURCED_EDGES,
  STRUT_SCHEMAS,
  embeddingColumn,
  searchableAttributes,
  vectorIndexName,
  vectorIndexedPairs,
  type StrutEdgeDef,
  type StrutSchema,
} from "./strut-schemas.js";

export const STRUT_MIGRATION_ID = "strut_domain_seed_v1";
export const DOMAIN_VECTOR_INDEX = `${STRUT_DOMAIN_LABEL.toLowerCase()}_vector_index`; // domain_strut_vector_index
export const DOMAIN_FULLTEXT_INDEX_V2 = `${STRUT_DOMAIN_LABEL.toLowerCase()}_attribute_index_v2`;
export const GLOBAL_VECTOR_INDEX = "text_embeddings_vector_index";

const VECTOR_OPTIONS =
  "OPTIONS { indexConfig: { `vector.dimensions`: 384, `vector.similarity_function`: 'cosine' } }";

/**
 * Run one schema statement (CREATE CONSTRAINT / INDEX … IF NOT EXISTS),
 * tolerating a pre-existing EQUIVALENT object under a different shape: a
 * jarvis database may carry a plain index on `Data_Bank(ref_id)` where we
 * ask for a uniqueness constraint (Neo4j then refuses: "A constraint cannot
 * be created until the index has been dropped"). jarvis's own seeder logs
 * and continues in that case; so do we — the existing object serves the
 * same purpose and is jarvis-owned. Returns the skip reason, or null.
 */
export async function schemaStatement(bolt: Bolt, cypher: string): Promise<string | null> {
  try {
    await bolt.run(cypher);
    return null;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/already exists|cannot be created until|equivalent/i.test(msg)) return msg.split("\n")[0]!;
    throw e;
  }
}

export interface SeedReport {
  /** `closed`: the engine's types are a registry in code (Ladybug) — nothing to seed. */
  mode: "standalone" | "shared" | "closed";
  /** Schema types created on this run. */
  createdSchemas: string[];
  /** Existing schemas that were extended with missing keys (add-only). */
  reconciled: Record<string, string[]>;
  /** Edge-schema rows created on this run, as `SRC-[EDGE]->TGT`. */
  createdEdgeSchemas: string[];
  /** Edge-schema rows skipped because an endpoint Schema is absent. */
  skippedEdgeSchemas: string[];
  /** Schema statements skipped because an equivalent jarvis-owned object
   *  already exists under another shape (see `schemaStatement`). */
  skippedSchemaObjects: string[];
}

/**
 * Flatten a schema the way jarvis stores it: core keys and attributes as
 * top-level properties, no `attributes` blob (`schema_crud.py:932,989`).
 * `Thing`'s `name` sits at its top level and flattens the same way.
 */
export function flattenSchema(schema: StrutSchema | typeof THING_SCHEMA): Record<string, unknown> {
  const { attributes, ...core } = schema;
  const flat: Record<string, unknown> = { ...core, ...attributes };
  // `exact_key` is strut's composition rule (strut-schemas.ts), not a
  // jarvis schema key: on the node it would read as an attribute. `embed`
  // IS a jarvis key, but only once jarvis knows it: on a Schema node an
  // older jarvis reads it as a required attribute, so strut's own types
  // keep their mark in code (plans/semantic-search.md ruling 2).
  delete flat["exact_key"];
  delete flat["embed"];
  return flat;
}

/** Seed the Strut domain. Safe to call on every boot. */
export async function seedStrutDomain(e: EngineLike): Promise<SeedReport> {
  const engine = asEngine(e);
  const src = engine.schemaSource;
  const bolt = engine.bolt;
  const report: SeedReport = {
    mode: "shared",
    createdSchemas: [],
    reconciled: {},
    createdEdgeSchemas: [],
    skippedEdgeSchemas: [],
    skippedSchemaObjects: [],
  };
  if (src.registry) return { ...report, mode: "closed" };
  // Neo4j DDL (constraints, search indexes): nothing to run on Ladybug,
  // whose tables and indexes the handle creates at open.
  const ddl = async (cypher: string) => {
    if (!bolt) return;
    const skipped = await schemaStatement(bolt, cypher);
    if (skipped) report.skippedSchemaObjects.push(skipped);
  };

  // 1. Thing root — a jarvis-seeded Thing is left untouched.
  const hadThing = (await src.schemaRow(THING_TYPE))?.type === THING_TYPE;
  report.mode = hadThing ? "shared" : "standalone";
  if (!hadThing) await src.createSchema({ ...flattenSchema(THING_SCHEMA), ref_id: randomUUID() });

  // 2. Each Strut schema: guard (case-insensitive, no is_deleted filter — a
  //    soft-deleted schema blocks re-create, same as jarvis's seeder), create
  //    on miss, add-only reconcile on hit.
  for (const schema of STRUT_SCHEMAS) {
    const flat = flattenSchema(schema);
    const hit = await src.schemaRow(schema.type);
    if (!hit) {
      await src.createSchema({ ...flat, ref_id: randomUUID() });
      report.createdSchemas.push(schema.type);
    } else {
      const live = new Set(Object.keys(hit.props));
      const missing: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(flat)) {
        if (k === "type" || k === "parent" || k === "ref_id") continue;
        if (!live.has(k)) missing[k] = v;
      }
      if (Object.keys(missing).length > 0) {
        await src.extendSchema(hit.type, missing);
        report.reconciled[schema.type] = Object.keys(missing).sort();
      }
    }

    // 3. CHILD_OF to Thing (type resolution, inheritance, and the edge-schema
    //    ancestor walk all depend on it).
    await src.ensureChildOf(schema.type, THING_TYPE, randomUUID());

    // 4. Per-type (node_key, namespace) uniqueness + node_key range index.
    await ddl(
      `CREATE CONSTRAINT ${`unique_${schema.type.toLowerCase()}_node_key`} IF NOT EXISTS
       FOR (n:\`${schema.type}\`) REQUIRE (n.node_key, n.namespace) IS UNIQUE`,
    );
    await ddl(`CREATE INDEX IF NOT EXISTS FOR (n:\`${schema.type}\`) ON (n.node_key)`);
  }

  // 5. Global objects (jarvis-owned in shared mode; IF NOT EXISTS is a no-op).
  await ddl(
    `CREATE CONSTRAINT unique_node_key_global IF NOT EXISTS
     FOR (n:Node) REQUIRE (n.node_key, n.namespace) IS UNIQUE`,
  );
  await ddl(`CREATE CONSTRAINT IF NOT EXISTS FOR (n:Data_Bank) REQUIRE n.ref_id IS UNIQUE`);

  // 6. Edge schemas — one relationship per registry row between Schema nodes.
  for (const e of [...STRUT_EDGES, ...JARVIS_SOURCED_EDGES]) {
    const r = await seedEdgeSchema(src, e);
    if (r === "created") report.createdEdgeSchemas.push(`${e.source}-[${e.edge}]->${e.target}`);
    else if (r === "skipped") report.skippedEdgeSchemas.push(`${e.source}-[${e.edge}]->${e.target}`);
  }

  // 7. Vector indexes — the one thing jarvis does NOT auto-create for a new
  //    domain at startup. Domain, global (standalone), and per-stem.
  await ddl(
    `CREATE VECTOR INDEX \`${DOMAIN_VECTOR_INDEX}\` IF NOT EXISTS
     FOR (n:\`${STRUT_DOMAIN_LABEL}\`) ON n.text_embeddings ${VECTOR_OPTIONS}`,
  );
  await ddl(
    `CREATE VECTOR INDEX \`${GLOBAL_VECTOR_INDEX}\` IF NOT EXISTS
     FOR (n:Data_Bank) ON n.text_embeddings ${VECTOR_OPTIONS}`,
  );
  for (const { type, prop } of vectorIndexedPairs()) {
    await ddl(
      `CREATE VECTOR INDEX \`${vectorIndexName(type, prop)}\` IF NOT EXISTS
       FOR (n:\`${type}\`) ON n.${embeddingColumn(prop)} ${VECTOR_OPTIONS}`,
    );
  }

  // 8. Fulltext (english analyzer `_v2` form — the one jarvis's queries use).
  //    Property list = sorted searchable attrs + node_key, like jarvis's
  //    v2 builder (`attribute_index_helper.py:823,838`).
  const props = [...searchableAttributes(), "node_key"].map((p) => `n.\`${p}\``).join(", ");
  await ddl(
    `CREATE FULLTEXT INDEX \`${DOMAIN_FULLTEXT_INDEX_V2}\` IF NOT EXISTS
     FOR (n:\`${STRUT_DOMAIN_LABEL}\`) ON EACH [${props}]
     OPTIONS { indexConfig: { \`fulltext.analyzer\`: 'english' } }`,
  );

  // 9. Migration ledger stamp so jarvis's runner sees done work, not conflict.
  await ddl(
    `CREATE CONSTRAINT migration_id_unique IF NOT EXISTS
     FOR (m:Migration) REQUIRE m.migration_id IS UNIQUE`,
  );
  await src.stampMigration(STRUT_MIGRATION_ID);

  return report;
}

/**
 * `MERGE (source)-[r:EDGE]->(target)` between two `:Schema` nodes, stamping
 * `ref_id` on create only. A missing endpoint would make MERGE a silent
 * zero-row no-op, so the existence check is explicit: Strut endpoints must
 * exist (bug otherwise); a jarvis-owned endpoint (`Person`) may legitimately
 * be absent in standalone mode → skipped, and `PUBLISHED_BY` stays a
 * property until shared mode.
 */
async function seedEdgeSchema(src: SchemaSource, e: StrutEdgeDef): Promise<"created" | "existing" | "skipped"> {
  const r = await src.ensureEdgeSchema(e.source, e.edge, e.target, { ref_id: randomUUID() });
  if (!r) {
    if (e.note) return "skipped";
    throw new Error(`seedEdgeSchema: endpoint Schema missing for ${e.source}-[${e.edge}]->${e.target}`);
  }
  return r.created ? "created" : "existing";
}
