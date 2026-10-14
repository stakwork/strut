/**
 * The closed registry (plans/ladybug-backend.md §3, ruling 6): the ten node
 * types a Ladybug file holds and the fourteen edge types between them,
 * declared here and nowhere else. No Schema meta-graph, no runtime
 * registration: on Ladybug the `SchemaResolver` resolves from this module
 * (`SchemaSource.registry`), and the table's columns are derived from it.
 *
 *   - the six Strut types the workspace store and the projector need, from
 *     `strut-schemas.ts` by name, with Thing's unread stamps left off;
 *   - `Claim`, `Check`, `Evidence` (plans/claims.md) and `Concept`, under
 *     their jarvis names with the SAME `node_key` specs, so the ids and
 *     keys a desktop writes match a swarm's — but with exactly the
 *     attributes strut writes and reads (`claims.ts`'s field lists).
 *
 * Pure: no engine, no addon. `nodeColumns()` is the union of every type's
 * attributes as column types, and the module refuses to load when two types
 * declare one name with different column types — the registry's one
 * invariant, since every attribute is a real column (no JSON).
 */
import { CHECK_TYPE, CLAIM_TYPE, EVIDENCE_TYPE } from "../claims.js";
import type { EdgeSchemaRow } from "../engine.js";
import { fromStrut, type NodeSchema } from "../schema-resolver.js";
import { STRUT_EDGES, getStrutSchema, type AttrBase, type AttrType } from "../strut-schemas.js";

export const CONCEPT_TYPE = "Concept";

/** The Strut types in the file (plans/ladybug-backend.md §3). */
export const LADYBUG_STRUT_TYPES: readonly string[] = ["StrutWorkflow", "StrutWorkflowVersion", "StrutStep", "StrutStepVersion", "StrutRun", "StrutJob"];

/** Thing's attributes nothing on the desktop reads: not in the table. */
const THING_VESTIGES = ["weight", "is_muted", "unique_source_id", "image_url"];

const jarvisType = (type: string, node_key: string, index: string[], title_key: string, description_key: string, attributes: Record<string, AttrType>): NodeSchema => ({
  type,
  parent: "Thing",
  node_key,
  index,
  vector_index: [],
  embed: true,
  attributes,
  title_key,
  description_key,
  domainLabels: [],
  isStrut: false,
});

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
  jarvisType(CLAIM_TYPE, "claim-id", ["name", "claim_text", "speaker_name"], "name", "claim_text", {
    id: "string",
    name: "?string",
    claim_text: "string",
    speaker_name: "?string",
    belief_valid_from: "?datetime",
    belief_valid_to: "?datetime",
  }),
  jarvisType(CHECK_TYPE, "check-id", ["name", "description"], "name", "description", {
    id: "string",
    name: "?string",
    description: "?string",
    step_type: "?string",
    step_config: "?string",
    run_when: "?string",
    policy: "?string",
    freshness_days: "?int",
    sample_rate: "?float",
    publisher: "?string",
    created_at: "datetime",
    retired_at: "?datetime",
  }),
  jarvisType(EVIDENCE_TYPE, "evidence-id", ["name", "description", "content"], "name", "description", {
    id: "string",
    name: "?string",
    description: "?string",
    content: "?string",
    evidence_mode: "?string",
    evidence_status: "?string",
    observed_at: "?datetime",
  }),
  jarvisType(CONCEPT_TYPE, "concept-name", ["name", "description", "docs"], "name", "description", {
    name: "string",
    description: "?string",
    docs: "?string",
    id: "?string",
    repo: "?string",
    file: "?string",
    pr_numbers: "?string",
    commit_shas: "?string",
  }),
];

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
  { edge: "ABOUT", source: CLAIM_TYPE, target: "StrutWorkflow" },
  { edge: "ABOUT", source: CLAIM_TYPE, target: "StrutStep" },
  { edge: "ABOUT", source: EVIDENCE_TYPE, target: "StrutWorkflowVersion" },
  { edge: "ABOUT", source: EVIDENCE_TYPE, target: "StrutStepVersion" },
  { edge: "TESTS", source: CHECK_TYPE, target: CLAIM_TYPE },
  { edge: "EVIDENCED_BY", source: CLAIM_TYPE, target: EVIDENCE_TYPE },
  { edge: "PRODUCED_BY", source: EVIDENCE_TYPE, target: CHECK_TYPE },
  { edge: "HAS_SOURCE", source: EVIDENCE_TYPE, target: "StrutRun" },
  { edge: "SUPERSEDES", source: CLAIM_TYPE, target: CLAIM_TYPE },
  { edge: "SUPERSEDES", source: CHECK_TYPE, target: CHECK_TYPE },
  { edge: "CHILD_OF", source: CONCEPT_TYPE, target: CONCEPT_TYPE },
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

/** The columns every row has: identity, type, search text and vector,
 *  the two stamps. `ref_id` is the primary key. */
export const GENERIC_COLUMNS: Readonly<Record<string, ColumnType>> = {
  ref_id: "STRING",
  node_key: "STRING",
  namespace: "STRING",
  node_type: "STRING",
  Data_Bank: "STRING",
  text_embeddings: "FLOAT[384]",
  date_added_to_graph: "INT64",
  deleted_at: "INT64",
};

/** Every edge has the same columns: the writer's stamps and the properties
 *  the claim layer writes (`verify.ts`: `strength` on EVIDENCED_BY,
 *  `context` / `start_time` / `end_time` / `post_url` on HAS_SOURCE). */
export const EDGE_COLUMNS: Readonly<Record<string, ColumnType>> = {
  ref_id: "STRING",
  edge_key: "STRING",
  date_added_to_graph: "INT64",
  weight: "DOUBLE",
  strength: "DOUBLE",
  context: "STRING",
  start_time: "INT64",
  end_time: "INT64",
  post_url: "STRING",
};

const baseOf = (t: string) => t.replace(/^\?/, "") as AttrBase | "complex";

function buildColumns(): Record<string, ColumnType> {
  const out: Record<string, ColumnType> = { ...GENERIC_COLUMNS };
  const by: Record<string, string> = {};
  for (const s of LADYBUG_SCHEMAS) {
    for (const [k, t] of Object.entries(s.attributes)) {
      const col = columnTypeOf(baseOf(t));
      if (!col) throw new Error(`ladybug registry: ${s.type}.${k} has type ${t}, which has no column type`);
      if (k in GENERIC_COLUMNS) throw new Error(`ladybug registry: ${s.type}.${k} shadows a generic column`);
      if (out[k] && out[k] !== col) throw new Error(`ladybug registry: ${s.type}.${k} is ${col} but ${by[k]}.${k} is ${out[k]} — one name, one column type`);
      out[k] = col;
      by[k] = s.type;
    }
  }
  return out;
}

let COLUMNS: Record<string, ColumnType> | undefined;

/** Every Node column with its type: the generic ones plus the union of
 *  the ten types' attributes. Built once; throws on a type conflict. */
export function nodeColumns(): Readonly<Record<string, ColumnType>> {
  return (COLUMNS ??= buildColumns());
}

nodeColumns();
