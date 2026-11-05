/**
 * The SEED of a Ladybug file's ontology (plans/ladybug-backend.md §3, ruling 6
 * as amended 2026-10-28; plans/memory-in-workspace-graph.md, PR A): the
 * nineteen node types a new file starts with and the twenty-two edge types
 * between them. The ontology itself lives in the file, as `Schema` rows of
 * the `Node` table (`ontology.ts`), seeded from this module at open
 * (add-only) and created and edited at runtime like Neo4j's `:Schema` nodes.
 *
 *   - the ten Strut types the workspace store and the projector need, from
 *     `strut-schemas.ts` by name, with Thing's unread stamps left off;
 *   - `Claim`, `Check`, `Evidence` (plans/claims.md) and `Concept` with
 *     their edge rules, the seed both engines share (`../seed-types.ts`,
 *     plans/ontology.md);
 *   - the base types `Person` (the user is the one marked `is_owner`) and
 *     `Lingo` (plans/graph-memory-plan.md step 2), with their rules;
 *   - `Mishearing`, dictation's hidden record of a word it mishears;
 *   - `Thing`, the root, with `name` and `description` only.
 *
 * Pure: no engine, no addon. `nodeColumns()` is the columns a new file is
 * created with: the generic ones, the Schema type's own fields, and the
 * union of the seed types' attributes; the module refuses to load when two
 * types declare one name with different column types — one name, one
 * column type, since every attribute is a real column. A type created at
 * runtime adds its columns then (`ontology.ts`), under the same rule.
 */
import { createHash } from "node:crypto";
import type { EdgeSchemaRow } from "../engine.js";
import { fromStrut, type NodeSchema } from "../schema-resolver.js";
import { CONCEPT_TYPE, SEED_EDGES, SEED_TYPES, seedType } from "../seed-types.js";
import { STRUT_DOMAIN, STRUT_EDGES, THING_TYPE, getStrutSchema, type AttrBase } from "../strut-schemas.js";

export { CONCEPT_TYPE };
/** A person; the user is the one Person marked `is_owner` (no `Self` type). */
export const PERSON_TYPE = "Person";
/** A word or phrase dictation learns (src/audio's fixer reads the type). */
export const LINGO_TYPE = "Lingo";
/** A temporal edge's search row (plans/graph-edge-search.md): one hidden
 *  node per fact, holding its composed text and vector, since a rel table
 *  takes no index. Written by `assert` alone (`ladybug/temporal.ts`). */
export const EDGE_TEXT_TYPE = "EdgeText";
/** A merge's record (`../merge.ts`): one hidden node per merge, saying who
 *  merged which node into which, and every edge it moved, so an old ref_id
 *  still leads to the kept node and the merge can be undone. Written by
 *  `graph/merge` alone. */
export const MERGE_TYPE = "Merge";
/** A mishearing dictation learned (src/steps/lib/dictation/_store.ts): one
 *  hidden node per pair, saying dictation writes `value` for the node
 *  `entity_ref_id` (as `form`, null meaning its name). Undo and remove are
 *  soft deletes with the reason. Not searched, embedded or walked. */
export const MISHEARING_TYPE = "Mishearing";

/** The ontology's own type: one row per type in the `Node` table. */
export const SCHEMA_TYPE = "Schema";

/** The Strut types in the file (plans/ladybug-backend.md §3). */
export const LADYBUG_STRUT_TYPES: readonly string[] = ["StrutWorkflow", "StrutWorkflowVersion", "StrutStep", "StrutStepVersion", "StrutApp", "StrutAppVersion", "StrutRun", "StrutJob", "StrutArtifact", "StrutProposal"];

/** Thing's attributes nothing on the desktop reads: not in the table. */
const THING_VESTIGES = ["weight", "is_muted", "unique_source_id", "image_url"];

function strutType(type: string): NodeSchema {
  const s = fromStrut(getStrutSchema(type)!);
  const attributes = { ...s.attributes };
  for (const k of THING_VESTIGES) delete attributes[k];
  // The per-stem vectors (`input_q` / `output_q` search) are not in the file.
  return { ...s, attributes, vector_index: [] };
}

/** Every node type, canonical name → schema. */
export const LADYBUG_SCHEMAS: readonly NodeSchema[] = [
  ...LADYBUG_STRUT_TYPES.map(strutType),
  ...SEED_TYPES,
  // The base types (plans/graph-memory-plan.md step 2), without jarvis's
  // fixture. Two people may share a name, so a Person is keyed by its
  // ref_id and named by its email; the user is the Person whose `is_owner` is
  // true. A Lingo word is keyed by its ref_id too: a name key keeps only
  // a-z and digits, so a word with no Latin letters (凯特) could not be one.
  // `resolve` finds a word by its name or `alt_names`.
  seedType(PERSON_TYPE, "ref_id", ["name", "description", "email"], "name", "description", {
    name: "string",
    description: "?string",
    email: "?string",
    is_owner: "?boolean",
    alt_names: "?list",
  }, { role: "entity", identifiers: ["email"] }),
  seedType(LINGO_TYPE, "ref_id", ["name", "description"], "name", "description", {
    name: "string",
    description: "?string",
    alt_names: "?list",
  }, { role: "entity" }),
  // No domain: these rows are memory, which the memory tools read.
  seedType(EDGE_TEXT_TYPE, "edgetext-edge_ref_id", ["composed"], "text", "text", {
    edge_ref_id: "string",
    edge_type: "string",
    source_ref_id: "string",
    target_ref_id: "string",
    /** The edge's sentence, as asserted. */
    text: "string",
    /** What is searched and embedded: both ends' titles, the edge type as words, the sentence. */
    composed: "string",
    /** The edge's clocks, copied: a row is in its fact's time window. */
    valid_at: "?int",
    invalid_at: "?int",
    expired_at: "?int",
  }, { role: "record" }),
  // Not searched or embedded: read by ref_id and by `duplicate_ref_id`.
  { ...seedType(MERGE_TYPE, "ref_id", [], "title", "title", {
    kept_ref_id: "string",
    duplicate_ref_id: "string",
    /** What the merge did, as JSON (`MergeMoves`): what the undo reads. */
    merge_moves: "string",
    undone_at: "?int",
    undone_by: "?string",
  }, { role: "record" }), embed: false },
  // Read by dictation alone, by `entity_ref_id`.
  { ...seedType(MISHEARING_TYPE, "ref_id", [], "value", "value", {
    entity_ref_id: "string",
    /** What dictation writes. */
    value: "string",
    /** The written form it is heard for; absent: the entity's name. */
    form: "?string",
  }, { role: "record" }), embed: false },
];

/** The types that are records, not nodes: never searched, walked or resolved. */
export const HIDDEN_TYPES: readonly string[] = [SCHEMA_TYPE, EDGE_TEXT_TYPE, MERGE_TYPE, MISHEARING_TYPE];

const BY_TYPE = new Map(LADYBUG_SCHEMAS.map((s) => [s.type.toLowerCase(), s]));

/** The schema for a type name, case-insensitive; null when the file does
 *  not hold that type. */
export function ladybugSchema(type: string): NodeSchema | null {
  return BY_TYPE.get(type.trim().toLowerCase()) ?? null;
}

export interface LadybugEdgeDef {
  edge: string;
  source: string;
  target: string;
}

/** Every (source, edge, target) a Ladybug file may hold: the Strut rows
 *  whose ends are kept types, the claim edges (plans/claims.md), and the
 *  Concept tree. */
export const LADYBUG_EDGES: readonly LadybugEdgeDef[] = [
  ...STRUT_EDGES.filter((e) => BY_TYPE.has(e.source.toLowerCase()) && BY_TYPE.has(e.target.toLowerCase())).map(({ edge, source, target }) => ({ edge, source, target })),
  ...SEED_EDGES,
  // What a work product was made from: on the file, its rel table. The
  // Strut registry's wildcard lets it point at any node the file holds (a
  // Concept, an app's excerpt type), as `STRUT_EDGES` declares it.
  { edge: "DERIVED_FROM", source: "StrutArtifact", target: CONCEPT_TYPE },
  // What a run read (the projector): the registry's wildcard lets it point
  // at any node the file holds; this row gives the file its rel table.
  { edge: "ACCESSED", source: "StrutRun", target: CONCEPT_TYPE },
];

/** The rel tables, sorted. */
export const LADYBUG_EDGE_TYPES: readonly string[] = [...new Set(LADYBUG_EDGES.map((e) => e.edge))].sort();

/** The edge rule for one triple (exact types), as the resolver reports it. */
export function ladybugEdge(edge: string, source: string, target: string): EdgeSchemaRow | null {
  const hit = LADYBUG_EDGES.find((e) => e.edge === edge && e.source === source && e.target === target);
  return hit ? { source: hit.source, target: hit.target, edge_type: hit.edge, props: {} } : null;
}

// ── Columns ─────────────────────────────────────────────────────────────────

export type ColumnType = "STRING" | "INT64" | "DOUBLE" | "BOOL" | "STRING[]" | "FLOAT[384]";

/** Attribute grammar → column type. */
export function columnTypeOf(base: AttrBase | "complex"): ColumnType | null {
  switch (base) {
    case "string":
      return "STRING";
    case "int":
    case "datetime":
      return "INT64";
    case "float":
      return "DOUBLE";
    case "boolean":
      return "BOOL";
    case "list":
      return "STRING[]";
    default:
      return null; // `complex`: jarvis's grammar, never strut's
  }
}

/** The columns every row has: identity, type, title, search text and
 *  vector, the stamps (plans/graph-memory-plan.md "Core attributes"; a
 *  Neo4j graph keeps jarvis's names for three of them: `node_key`,
 *  `Data_Bank`, `date_added_to_graph`). `ref_id` is the primary key. */
export const GENERIC_COLUMNS: Readonly<Record<string, ColumnType>> = {
  ref_id: "STRING",
  key: "STRING",
  namespace: "STRING",
  node_type: "STRING",
  title: "STRING",
  search_text: "STRING",
  text_embeddings: "FLOAT[384]",
  // Epoch ms of the row's creation, set by the writer.
  created_at: "INT64",
  // Who wrote the row (the caller's actor), set by the writer on create.
  created_by: "STRING",
  // System stamp: epoch ms of the last create / change, set by the writer.
  updated_at: "INT64",
  deleted_at: "INT64",
  // Why a soft delete happened, when the deleter said (`SoftDeleteOptions.reason`).
  deleted_reason: "STRING",
};

/** The columns every edge has: the writer's stamps and `importance` (the
 *  one edge property a neighbors read orders by, jarvis's sort key). */
export const EDGE_COLUMNS: Readonly<Record<string, ColumnType>> = {
  ref_id: "STRING",
  edge_key: "STRING",
  // The core attributes every edge has (plans/graph-memory-plan.md): its
  // namespace, who wrote it, and the writer's times.
  namespace: "STRING",
  created_by: "STRING",
  created_at: "INT64",
  updated_at: "INT64",
  deleted_at: "INT64",
  weight: "DOUBLE",
  importance: "DOUBLE",
};

/** The edge columns an older file's rel tables lack (`db.ts`
 *  `moveToNamespaces` adds them). */
export const EDGE_CORE_COLUMNS: readonly string[] = ["namespace", "created_by", "updated_at", "deleted_at"];

/** The columns only some edge types have: what the claim layer writes
 *  (`verify.ts`: `strength` on EVIDENCED_BY, `context` / `start_time` /
 *  `end_time` / `post_url` on HAS_SOURCE). A file an older build made has
 *  them on every rel table, empty elsewhere: a column is never dropped. */
export const EDGE_TYPE_COLUMNS: Readonly<Record<string, Readonly<Record<string, ColumnType>>>> = {
  EVIDENCED_BY: { strength: "DOUBLE" },
  HAS_SOURCE: { context: "STRING", start_time: "INT64", end_time: "INT64", post_url: "STRING" },
};

/** The columns of edge type `edge`'s rel table. */
export function edgeColumnsOf(edge: string): Readonly<Record<string, ColumnType>> {
  const own = EDGE_TYPE_COLUMNS[edge];
  return own ? { ...EDGE_COLUMNS, ...own } : EDGE_COLUMNS;
}

/** The columns of a temporal edge type (plans/graph-memory-plan.md "Core
 *  attributes"), on its rel table alone: added when the table is made for a
 *  temporal type or the type becomes temporal (`ontology.ts`). Only
 *  `assert` writes them (`temporal.ts`). Times are epoch ms; `sources` the
 *  ref_ids of the nodes the edge was learned from. */
export const TEMPORAL_EDGE_COLUMNS: Readonly<Record<string, ColumnType>> = {
  text: "STRING",
  sources: "STRING[]",
  valid_at: "INT64",
  invalid_at: "INT64",
  expired_at: "INT64",
  superseded_by: "STRING",
  last_confirmed_at: "INT64",
};

/** Every edge column of any type: what an edge struct is read back with. */
export const ALL_EDGE_COLUMNS: Readonly<Record<string, ColumnType>> = Object.assign({}, EDGE_COLUMNS, ...Object.values(EDGE_TYPE_COLUMNS), TEMPORAL_EDGE_COLUMNS);

/** The Schema type's own fields (plans/memory-in-workspace-graph.md decision
 *  1), one column each on its rows. The attributes a type declares are one
 *  JSON attribute, `attributes`; the type's key spec is `key_spec` (a Neo4j
 *  `:Schema` node's `node_key`). */
export const SCHEMA_COLUMNS: Readonly<Record<string, ColumnType>> = {
  type: "STRING",
  parent: "STRING",
  key_spec: "STRING",
  index: "STRING[]",
  vector_index: "STRING[]",
  title_key: "STRING",
  description_key: "STRING",
  type_description: "STRING",
  domain: "STRING",
  icon: "STRING",
  shape: "STRING",
  primary_color: "STRING",
  secondary_color: "STRING",
  embed: "BOOL",
  exact_key: "BOOL",
  attributes: "STRING",
  aliases: "STRING[]",
  status: "STRING",
  role: "STRING",
  identifiers: "STRING[]",
  naming: "STRING",
  managed_by: "STRING",
};

const baseOf = (t: string) => t.replace(/^\?/, "") as AttrBase | "complex";

/** Core columns a type may also declare as its own attribute, of the same
 *  column type: a type with a `title` field (StrutApp, StrutJob) keeps the
 *  node's title in it (node-writer.ts). */
export const TYPE_OWNED_COLUMNS: ReadonlySet<string> = new Set(["title"]);

function buildColumns(): Record<string, ColumnType> {
  const out: Record<string, ColumnType> = { ...GENERIC_COLUMNS, ...SCHEMA_COLUMNS };
  const by: Record<string, string> = {};
  for (const s of LADYBUG_SCHEMAS) {
    for (const [k, t] of Object.entries(s.attributes)) {
      const col = columnTypeOf(baseOf(t));
      if (!col) throw new Error(`ladybug registry: ${s.type}.${k} has type ${t}, which has no column type`);
      if ((k in GENERIC_COLUMNS && !(TYPE_OWNED_COLUMNS.has(k) && GENERIC_COLUMNS[k] === col)) || k in SCHEMA_COLUMNS) {
        throw new Error(`ladybug registry: ${s.type}.${k} shadows a generic or Schema column`);
      }
      if (out[k] && out[k] !== col) throw new Error(`ladybug registry: ${s.type}.${k} is ${col} but ${by[k]}.${k} is ${out[k]} — one name, one column type`);
      out[k] = col;
      by[k] = s.type;
    }
  }
  return out;
}

let COLUMNS: Record<string, ColumnType> | undefined;

/** The Node columns a new file is created with: the generic ones, the
 *  Schema fields, and the union of the seed types' attributes. Built once;
 *  throws on a type conflict. A file's actual columns are its catalog
 *  (`ontology.ts`), which runtime types add to. */
export function nodeColumns(): Readonly<Record<string, ColumnType>> {
  return (COLUMNS ??= buildColumns());
}

nodeColumns();

// ── The seed ────────────────────────────────────────────────────────────────

/** The root every seed type is CHILD_OF: Thing without its jarvis stamps. */
const THING_SEED: NodeSchema = {
  type: THING_TYPE,
  key_spec: "thing-name",
  index: ["name", "description"],
  vector_index: [],
  embed: true,
  attributes: { name: "string", description: "?string" },
  title_key: "name",
  description_key: "description",
  domainLabels: [],
  isStrut: false,
};

/** One seed type as the flat map a Schema row is written from: the core
 *  keys, then the attributes, as `schema-seed.ts` flattens a Strut schema.
 *  The Strut types carry their domain and display keys. */
function seedFlat(s: NodeSchema): Record<string, unknown> {
  const strut = getStrutSchema(s.type);
  return {
    type: s.type,
    ...(s.parent ? { parent: s.parent } : {}),
    key_spec: s.key_spec,
    index: [...s.index],
    vector_index: [...s.vector_index],
    ...(s.title_key ? { title_key: s.title_key } : {}),
    ...(s.description_key ? { description_key: s.description_key } : {}),
    embed: s.embed,
    ...(s.exact_key ? { exact_key: true } : {}),
    ...(s.role ? { role: s.role } : {}),
    ...(s.identifiers?.length ? { identifiers: [...s.identifiers] } : {}),
    ...(strut
      ? { domain: STRUT_DOMAIN, icon: strut.icon, shape: strut.shape, primary_color: strut.primary_color, secondary_color: strut.secondary_color, type_description: strut.type_description }
      : {}),
    ...s.attributes,
  };
}

export interface OntologySeed {
  /** Thing first, then every seed type: flat maps, as `createSchema` takes them. */
  schemas: Array<Record<string, unknown>>;
  edges: readonly LadybugEdgeDef[];
  /** Changes when the seed does: the `Migration` stamp the open checks. */
  id: string;
}

let SEED: OntologySeed | undefined;

/** What a file's ontology is seeded with at open (`db.ts`). */
export function ontologySeed(): OntologySeed {
  if (SEED) return SEED;
  const schemas = [THING_SEED, ...LADYBUG_SCHEMAS].map(seedFlat);
  const hash = createHash("sha256").update(JSON.stringify({ schemas, edges: LADYBUG_EDGES })).digest("hex").slice(0, 16);
  return (SEED = { schemas, edges: LADYBUG_EDGES, id: `ladybug_ontology_seed:${hash}` });
}
