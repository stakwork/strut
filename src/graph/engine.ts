/**
 * The engine seams (plans/ladybug-backend.md §4): what the graph layer
 * needs from a database, as small interfaces with one implementation per
 * engine — `neo4j-engine.ts` (today's Cypher over bolt, moved here as it
 * was) and `ladybug/engine.ts` (one LadybugDB file). Everything pure —
 * validation, `node_key` and `Data_Bank` composition, the edge rules, the
 * schema merge, the seeds' add-only discipline — stays in the writers and
 * the resolver and runs on both.
 *
 * Three kinds of thing cross a seam:
 *
 *   - `GraphEngine.query` / `tx`: one auto-commit statement, or a write
 *     transaction, in the engine's own Cypher. The pattern-level readers
 *     (`workspace-store.ts`, later `claims.ts` / `projector.ts`) write
 *     statements both engines accept through the `Dialect` helpers;
 *   - the engine interfaces (`NodeEngine`, `EdgeEngine`, `SchemaSource`):
 *     the statements that cannot be written neutrally — MERGE identity,
 *     labels vs a `node_type` column, `SET n += map`, `shortestPath`, the
 *     Schema meta-graph — each a method with two bodies;
 *   - plain JS values. Integers are plain numbers here; the Neo4j engine
 *     wraps what jarvis stores as an Integer (`bolt.ts`) and the Ladybug
 *     engine writes INT64 columns. No caller touches `int()`.
 *
 * No runtime imports: `claims.ts` must not load neo4j-driver, and the
 * Ladybug engine must not load it either.
 */
import type { Bolt } from "./bolt.js";
import type { NodeSchema } from "./schema-resolver.js";

export type Params = Record<string, unknown>;
export type Row = Record<string, unknown>;

export type GraphKind = "neo4j" | "ladybug";

/** A statement runner inside one write transaction. */
export interface GraphTx {
  run(cypher: string, params?: Params): Promise<Row[]>;
}

/**
 * The fixed set of dialect helpers (§4), nine of them. A pattern-level
 * statement that cannot be written with these becomes a method on an
 * engine interface — there is no tenth helper. Every argument is Cypher
 * text (an alias, a `$param`, an expression), never a value.
 */
export interface Dialect {
  readonly kind: GraphKind;
  /** A node pattern of one type: ``(a:`Type` {k: $v})`` vs
   *  `(a:Node {node_type: 'Type', k: $v})`. `props` maps a property to the
   *  Cypher expression it must equal — on Ladybug one of the hot columns
   *  (every Strut and claim attribute is one; §3.1). */
  node(alias: string, type: string, props?: Record<string, string>): string;
  /** `a` is one of `types`: label checks vs `a.node_type IN [...]`. */
  isType(alias: string, types: readonly string[]): string;
  /** The type of a bound node: `labels(a)` (then `typeLabelOf`) vs `a.node_type`. */
  typeOf(alias: string): string;
  /** The type of a bound relationship: `type(r)` vs `label(r)`. */
  edgeType(alias: string): string;
  /** A node that is not soft-deleted: `NODE_LIVE` (`deletion.ts`) vs
   *  `a.deleted_at IS NULL` — the file has no `is_deleted`. */
  live(alias: string): string;
  /** An edge that carries no legacy flag: `EDGE_LIVE` vs `true` — on
   *  Ladybug an edge is live or gone. */
  edgeLive(alias: string): string;
  /** An integer cast: `toInteger(x)` vs `CAST(x AS INT64)`. */
  int(expr: string): string;
  lower(expr: string): string;
  /** `{a: n.a, b: n.b}` — the projection both engines return as a map;
   *  never `properties(n)` on a hot path (a Ladybug node struct carries
   *  every column). */
  project(alias: string, fields: readonly string[]): string;
}

// ── Nodes ───────────────────────────────────────────────────────────────────

export type WriteMode = "create" | "upsert";
export type WriteOutcome = "created" | "existing" | "restored" | "updated";

/** A node the writer validated and composed, ready for the engine: the
 *  identity, and every property as a plain value — attributes (a datetime
 *  as epoch seconds), `Data_Bank` + `_search_fields_used`, the vectors. */
export interface PreparedNode {
  schema: NodeSchema;
  node_key: string;
  ref_id: string;
  namespace: string;
  props: Record<string, unknown>;
}

/** A stored node as the engine holds it: its type and every property,
 *  stamps included (`namespace`, `node_key`, `Data_Bank`, …), as Neo4j's
 *  `properties(n)` — absent properties absent, never null. */
export interface RawNode {
  ref_id: string;
  type: string | undefined;
  props: Record<string, unknown>;
}

/** What a soft delete must match besides the ref_id: Strut's own nodes
 *  (`domainLabel`), or a node of one type with given property values. An
 *  EMPTY guard matches any content node in the namespace — `graph/delete-node`,
 *  a delete on a caller's say-so. */
export interface NodeGuard {
  domainLabel?: string;
  type?: string;
  props?: Record<string, unknown>;
}

/** What a soft delete took with it. */
export interface SoftDeleteResult {
  /** The node's in-scope edges hard-deleted with it. */
  edges: number;
}

/** What an edge delete removed: the edge as it was, by its endpoints. */
export interface EdgeDeleteResult {
  ref_id: string;
  edge: string;
  source_ref_id: string;
  target_ref_id: string;
}

export interface NodeEngine {
  /** Write one type's batch: create the misses, and on a hit SET the
   *  non-identity properties when `mode` is `upsert` or the node is
   *  soft-deleted (a restore clears both delete markers). Returns the
   *  outcome per row, input order. */
  mergeBatch(tx: GraphTx, schema: NodeSchema, namespace: string, nodes: PreparedNode[], mode: WriteMode): Promise<Array<{ ref_id: string; node_key: string; outcome: WriteOutcome }>>;
  readRaw(tx: GraphTx, ref_id: string): Promise<RawNode | null>;
  /** The ref_id of the node of `type` with this identity, or null. */
  refByKey(tx: GraphTx, type: string, node_key: string, namespace: string): Promise<string | null>;
  /** Set `set` (attributes + `node_key` + search text + vectors, plain
   *  values) and remove `remove` on one node. */
  update(tx: GraphTx, schema: NodeSchema, ref_id: string, set: Record<string, unknown>, remove: string[]): Promise<void>;
  /** `deletion.ts`: stamp `deleted_at` (first delete kept) + `is_deleted`
   *  and hard-delete the node's in-scope edges, counted. Null when nothing matched. */
  softDelete(ref_id: string, namespace: string, guard: NodeGuard): Promise<SoftDeleteResult | null>;
}

// ── Edges ───────────────────────────────────────────────────────────────────

export interface EdgeEndpoint {
  type: string | undefined;
  uid: string | null;
}

/** One edge to merge: the writer's stamps as plain values, the caller's
 *  properties as given. */
export interface EdgeMergeRow {
  k: number;
  src: string;
  tgt: string;
  edge_key: string;
  ref_id: string;
  weight: number;
  date_added_to_graph: number;
  unique_source_id?: string;
  props: Record<string, unknown>;
}

export interface EdgeMergeResult {
  k: number;
  ref_id: string;
  created: boolean;
  source_ref_id: string;
  target_ref_id: string;
}

export interface EdgeEngine {
  /** Type and `unique_source_id` of every resolvable id. */
  endpoints(tx: GraphTx, ids: string[]): Promise<Map<string, EdgeEndpoint>>;
  /** One edge per (source, type, target) after the `IS_ALIAS` rewrite:
   *  ON CREATE the stamps and properties; ON MATCH a legacy flagged edge
   *  is made live and nothing else changes. */
  mergeBatch(tx: GraphTx, edge: string, rows: EdgeMergeRow[]): Promise<EdgeMergeResult[]>;
  /** Set / remove properties on the edge with this ref_id; null when there
   *  is none. */
  setProps(tx: GraphTx, ref_id: string, set: Record<string, unknown>, remove: string[]): Promise<{ ref_id: string; edge: string; source_ref_id: string; target_ref_id: string } | null>;
  /** The live `edge` edges from `src` to `tgt` (alias-rewritten), by ref_id. */
  findByTriple(tx: GraphTx, edge: string, src: string, tgt: string): Promise<string[]>;
  /** `DELETE r` by ref_id: the edge as it was, or null when there is none. */
  delete(ref_id: string, tx?: GraphTx): Promise<EdgeDeleteResult | null>;
  /** The node `ref_id` names (its canonical ref after the alias rewrite)
   *  and its live `edge` edges that way — `forward` = `(node)-[edge]->(other)`.
   *  Null when there is no such node. */
  liveEdgesOf(tx: GraphTx, ref_id: string, edge: string, forward: boolean): Promise<{ node: string; edges: Array<{ other: string; edge_ref_id: string; props: Record<string, unknown> }> } | null>;
  /** Would hanging `node` under `to` along `edge` make a cycle: is `to`
   *  (alias-rewritten) already below `node` that way? */
  wouldCycle(tx: GraphTx, edge: string, node: string, to: string, forward: boolean): Promise<boolean>;
  /** Copy every property of the old edge onto the new one, then put the new
   *  one's own stamps back, with `uid` as its `unique_source_id`. */
  copyProps(tx: GraphTx, fromRef: string, toRef: string, uid: string | null): Promise<void>;
}

// ── The Schema meta-graph ───────────────────────────────────────────────────

/** One Schema as jarvis stores it: the flat property map (core keys and
 *  attribute declarations alike). */
export interface SchemaRow {
  type: string;
  ref_id: string | undefined;
  props: Record<string, unknown>;
}

export interface EdgeSchemaRow {
  source: string;
  target: string;
  edge_type: string;
  props: Record<string, unknown>;
}

/** The lookups `SchemaResolver.edgeSchema` tries in order (jarvis
 *  `get_schema_edge_by_edge_type`). */
export type EdgeSchemaWalk = "exact" | "source-ancestor" | "target-ancestor" | "both-ancestors" | "wildcard";

/** A schema source that is a registry in code (Ladybug, `ladybug/registry.ts`):
 *  the resolver resolves types and edge rules from it alone — case-insensitive
 *  on the type name, exact on the edge triple, no allowlist, no hidden
 *  domains — and every write below is refused. */
export interface ClosedRegistry {
  schema(type: string): NodeSchema | null;
  types(): readonly NodeSchema[];
  edge(edge: string, source: string, target: string): EdgeSchemaRow | null;
}

export interface SchemaSource {
  /** Present when the source is a closed registry (ruling 6). */
  readonly registry?: ClosedRegistry;
  /** The Schema whose type matches case-insensitively, exact case first.
   *  `live` skips soft-deleted ones and the `*` sentinel. */
  schemaRow(type: string, opts?: { live?: boolean }, tx?: GraphTx): Promise<SchemaRow | null>;
  /** A node LABEL in the catalog matching case-insensitively (exact case
   *  first) — Neo4j's `db.labels()`; no such catalog on Ladybug (null). */
  labelLike(type: string, tx?: GraphTx): Promise<string | null>;
  /** The CHILD_OF ancestors of `type` (exact), nearest first, along the
   *  longest chain: their types and flat property maps. */
  ancestors(type: string, tx?: GraphTx): Promise<{ chain: string[]; rows: Array<Record<string, unknown>> }>;
  /** `About.hidden_domains` / `hidden_types`, as stored (unknown shape). */
  hidden(tx?: GraphTx): Promise<{ domains: unknown; types: unknown }>;
  findEdgeSchema(walk: EdgeSchemaWalk, source: string, edge: string, target: string, tx?: GraphTx): Promise<EdgeSchemaRow | null>;

  /** Write a new Schema from its flat map (`ref_id` included). */
  createSchema(flat: Record<string, unknown>, tx?: GraphTx): Promise<void>;
  /** Add keys to an existing Schema (exact type); nothing present changes. */
  extendSchema(type: string, props: Record<string, unknown>, tx?: GraphTx): Promise<void>;
  /** Hard-delete a Schema and its edges (a soft-deleted one being replaced). */
  deleteSchema(type: string, tx?: GraphTx): Promise<void>;
  /** `MERGE (child)-[:CHILD_OF]->(parent)`, stamping `ref_id` on create.
   *  False when it already existed; null when an endpoint is missing. */
  ensureChildOf(child: string, parent: string, ref_id: string, tx?: GraphTx): Promise<boolean | null>;
  /** `MERGE (source)-[:EDGE]->(target)` between two Schemas, `props`
   *  (`ref_id` included) set on create only; the edge's ref_id either way.
   *  Null when an endpoint Schema is missing. */
  ensureEdgeSchema(source: string, edge: string, target: string, props: Record<string, unknown>, tx?: GraphTx): Promise<{ created: boolean; ref_id: string } | null>;
  /** The `*` wildcard Schema sentinel. */
  ensureWildcardSchema(ref_id: string, tx?: GraphTx): Promise<void>;
  /** The migration ledger: stamp `id` as done (idempotent). */
  stampMigration(id: string): Promise<void>;
}

// ── The engine ──────────────────────────────────────────────────────────────

export interface GraphEngine {
  readonly kind: GraphKind;
  /** The namespace every node is written into (`cfg.namespace`). */
  readonly namespace: string;
  readonly dialect: Dialect;
  /** One auto-commit statement in the engine's Cypher, for a read: on a
   *  LadybugDB file it runs on the read connection, outside the writes'
   *  queue, so a write there fails while any write transaction is open.
   *  A write goes through `tx`. */
  query(cypher: string, params?: Params): Promise<Row[]>;
  /** One write transaction: all of `fn`'s statements land, or none. */
  tx<T>(fn: (tx: GraphTx) => Promise<T>): Promise<T>;
  readonly nodeEngine: NodeEngine;
  readonly edgeEngine: EdgeEngine;
  readonly schemaSource: SchemaSource;
  /** Neo4j only: the driver, for the DDL and migrations that have no
   *  Ladybug twin. */
  readonly bolt?: Bolt;
}

/** What the writers, resolver and seeds take: an engine, or a bare `Bolt`
 *  (the Neo4j engine over it — `asEngine` in `neo4j-engine.ts`). */
export type EngineLike = GraphEngine | Bolt;

/** A stored attribute value against the writer's, for whether a write changes
 *  the node (`updated_at`): scalars by value (bigint / number alike), lists
 *  elementwise; null, absent and "" are all no value, as the writer drops "". */
export function sameStored(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameStored(x, b[i]));
  }
  const none = (v: unknown) => v === null || v === undefined || v === "";
  if (none(a) || none(b)) return none(a) && none(b);
  return String(a) === String(b);
}
