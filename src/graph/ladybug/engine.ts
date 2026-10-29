/**
 * The Ladybug engine (plans/ladybug-backend.md §3, §4): the three seams of
 * `engine.ts` over one LadybugDB file — one `Node` table whose columns are
 * the ontology's attributes, one rel table per edge type, a `Migration`
 * ledger. The writers and the resolver above it are the
 * shared ones; this file is the statements.
 *
 *   - identity is `(node_type, node_key)`, resolved by a pre-read in the
 *     write transaction (MERGE needs the primary key): the misses are
 *     CREATEd in one UNWIND with their `ref_id`s, the hits SET one by one
 *     with explicit column lists;
 *   - a soft delete is `deleted_at` alone, then the node's edges go
 *     (outgoing, incoming) in the same transaction;
 *   - no alias rewrite, no edge flags, no namespace but `default`: an edge
 *     is live or gone, and `edgeLive` is `true`;
 *   - the schema source is the file's `Schema` rows (`ontology.ts`), seeded
 *     from `registry.ts` at open and written at runtime: a new attribute
 *     adds its column, a new edge type its rel table. The columns and rel
 *     tables a write checks against are the file's catalog.
 *
 * Integers are plain numbers here (INT64 reads back as a number); a JS
 * number into an INT64 column is written as given, the writer having
 * validated it an integer.
 */
import type {
  Dialect,
  EdgeEndpoint,
  EdgeEngine,
  EdgeMergeResult,
  EdgeMergeRow,
  EdgeSchemaRow,
  EdgeSchemaWalk,
  GraphEngine,
  NamedSchema,
  GraphTx,
  NodeEngine,
  NodeGuard,
  SoftDeleteOptions,
  SoftDeleteResult,
  EdgeDeleteResult,
  Params,
  PreparedNode,
  RawNode,
  Row,
  SchemaRow,
  SchemaSource,
  WriteMode,
  WriteOutcome,
} from "../engine.js";
import { sameStored } from "../engine.js";
import { GraphValidationError } from "../node-writer.js";
import type { NodeSchema } from "../schema-resolver.js";
import type { LadybugHandle } from "./db.js";
import * as ontology from "./ontology.js";
import { catalogOf, readCatalog, type Catalog, type LadybugCatalog } from "./ontology.js";
import { EDGE_COLUMNS, GENERIC_COLUMNS, LADYBUG_STRUT_TYPES, nodeColumns } from "./registry.js";

const q = (s: string) => `\`${s}\``;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export const LADYBUG_DIALECT: Dialect = {
  kind: "ladybug",
  node: (alias, type, props) =>
    `(${alias}:Node {node_type: ${lit(type)}${props ? `, ${Object.entries(props).map(([k, v]) => `${q(k)}: ${v}`).join(", ")}` : ""}})`,
  isType: (alias, types) => `${alias}.node_type IN [${types.map(lit).join(", ")}]`,
  typeOf: (alias) => `${alias}.node_type`,
  edgeType: (alias) => `label(${alias})`,
  live: (alias) => `${alias}.deleted_at IS NULL`,
  edgeLive: () => `true`,
  int: (expr) => `CAST(${expr} AS INT64)`,
  lower: (expr) => `lower(${expr})`,
  project: (alias, fields) => `{${fields.map((f) => `${q(f)}: ${alias}.${q(f)}`).join(", ")}}`,
};

/** Identity props never touched after create. */
const PRESERVED = new Set(["ref_id", "node_key", "namespace", "node_type", "date_added_to_graph"]);
/** What the shared writer composes that the file does not keep. */
const DROPPED_PROPS = new Set(["_search_fields_used"]);
/** Edge stamps the writer sets on create and `setProps` never touches. */
const EDGE_STAMPS = new Set(["ref_id", "edge_key", "date_added_to_graph"]);

export class LadybugEngine implements GraphEngine {
  readonly kind = "ladybug" as const;
  readonly dialect = LADYBUG_DIALECT;
  readonly nodeEngine: NodeEngine;
  readonly edgeEngine: EdgeEngine;
  readonly schemaSource: LadybugSchemas;
  /** The file's tables, shared by every engine and reader over the handle. */
  readonly catalog: LadybugCatalog;

  constructor(
    readonly lbug: LadybugHandle,
    readonly namespace: string,
  ) {
    this.catalog = catalogOf(lbug);
    this.nodeEngine = new LadybugNodes(lbug, namespace, this.catalog);
    this.edgeEngine = new LadybugEdges(lbug, this.catalog);
    this.schemaSource = new LadybugSchemas(lbug, this.catalog);
  }

  query(cypher: string, params: Params = {}): Promise<Row[]> {
    return this.lbug.query(cypher, params);
  }

  tx<T>(fn: (tx: GraphTx) => Promise<T>): Promise<T> {
    return this.lbug.withWrite(fn);
  }
}

/** Runs on the transaction when there is one, else as one auto-commit write. */
const on = (lbug: LadybugHandle, tx: GraphTx | undefined, cypher: string, params: Params = {}) =>
  tx ? tx.run(cypher, params) : lbug.exclusive((w) => w(cypher, params));

/** The catalog, read again on `tx` when it lacks one of `names` (a column or
 *  table another handle's write, or one in this transaction, just made). */
async function catalogFor(catalog: LadybugCatalog, tx: GraphTx, has: (c: Catalog) => boolean): Promise<Catalog> {
  const cached = await catalog.get();
  if (has(cached)) return cached;
  catalog.invalidate();
  return readCatalog((cypher, params) => tx.run(cypher, params));
}

// ── Nodes ───────────────────────────────────────────────────────────────────

class LadybugNodes implements NodeEngine {
  constructor(
    private readonly lbug: LadybugHandle,
    private readonly ns: string,
    private readonly catalog: LadybugCatalog,
  ) {}

  /** The file's columns, with every one of `names` in it if the file has it. */
  private async known(tx: GraphTx, names: string[]): Promise<Record<string, string>> {
    return (await catalogFor(this.catalog, tx, (c) => names.every((k) => DROPPED_PROPS.has(k) || k in c.columns))).columns;
  }

  /** The writer's props as columns: every key must be an attribute of the
   *  schema or one of the generic columns the writer fills. */
  private async columns(tx: GraphTx, schema: NodeSchema, props: Record<string, unknown>): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const known = await this.known(tx, Object.keys(props));
    for (const [k, v] of Object.entries(props)) {
      if (DROPPED_PROPS.has(k)) continue;
      if (!(k in schema.attributes) && !(k in GENERIC_COLUMNS)) throw new GraphValidationError("UNKNOWN_ATTRIBUTE", schema.type, "not a column of the ladybug Node table", k);
      if (!known[k]) throw new GraphValidationError("UNKNOWN_ATTRIBUTE", schema.type, "not a column of the ladybug Node table", k);
      out[k] = v;
    }
    return out;
  }

  async mergeBatch(tx: GraphTx, schema: NodeSchema, namespace: string, nodes: PreparedNode[], mode: WriteMode) {
    if (namespace !== this.ns) throw new GraphValidationError("UNKNOWN_ATTRIBUTE", schema.type, `a ladybug file holds one namespace (${this.ns}); got ${namespace}`, "namespace");
    const found = await tx.run(
      `UNWIND $keys AS k MATCH (n:Node {node_type: $type, node_key: k}) RETURN k AS node_key, n.ref_id AS ref_id, n.deleted_at IS NOT NULL AS deleted`,
      { keys: nodes.map((n) => n.node_key), type: schema.type },
    );
    const hits = new Map(found.map((r) => [String(r["node_key"]), { ref_id: String(r["ref_id"]), deleted: r["deleted"] === true }]));

    const misses = nodes.filter((n) => !hits.has(n.node_key));
    if (misses.length) {
      const rows = await Promise.all(misses.map(async (n) => ({
        ref_id: n.ref_id,
        node_key: n.node_key,
        namespace,
        node_type: schema.type,
        ...(await this.columns(tx, schema, n.props)),
      })));
      // One row shape for the batch; a column null on every row is left out.
      const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => rows.some((r) => r[c as keyof typeof r] != null));
      await tx.run(`UNWIND $rows AS r CREATE (n:Node {${columns.map((c) => `${q(c)}: r.${q(c)}`).join(", ")}})`, {
        rows: rows.map((r) => Object.fromEntries(columns.map((c) => [c, (r as Record<string, unknown>)[c] ?? null]))),
      });
    }

    for (const n of nodes) {
      const hit = hits.get(n.node_key);
      if (!hit || (mode !== "upsert" && !hit.deleted)) continue;
      const set = await this.columns(tx, schema, n.props);
      if (!hit.deleted && !(await this.changed(tx, schema, hit.ref_id, set))) delete set["updated_at"]; // a resync that changes nothing keeps its stamp
      const params: Params = { ref_id: hit.ref_id };
      const assigns: string[] = [];
      let i = 0;
      for (const [k, v] of Object.entries(set)) {
        if (PRESERVED.has(k)) continue;
        params[`v${i}`] = v;
        assigns.push(`n.${q(k)} = $v${i++}`);
      }
      if (hit.deleted) assigns.push("n.deleted_at = NULL", "n.deleted_reason = NULL");
      if (assigns.length) await tx.run(`MATCH (n:Node {ref_id: $ref_id}) SET ${assigns.join(", ")}`, params);
    }

    return nodes.map((n) => {
      const hit = hits.get(n.node_key);
      let outcome: WriteOutcome;
      if (!hit) outcome = "created";
      else if (hit.deleted) outcome = "restored";
      else if (mode === "upsert") outcome = "updated";
      else outcome = "existing";
      return { ref_id: hit?.ref_id ?? n.ref_id, node_key: n.node_key, outcome };
    });
  }

  /** Would writing `set` over the stored row change an attribute? Data_Bank
   *  and the vectors follow from the attributes. */
  private async changed(tx: GraphTx, schema: NodeSchema, ref_id: string, set: Record<string, unknown>): Promise<boolean> {
    const rows = await tx.run(`MATCH (n:Node {ref_id: $ref_id}) RETURN n`, { ref_id });
    const stored = (rows[0]?.["n"] ?? {}) as Record<string, unknown>;
    return Object.entries(set).some(([k, v]) => k in schema.attributes && k !== "updated_at" && !sameStored(stored[k], v));
  }

  async readRaw(tx: GraphTx, ref_id: string): Promise<RawNode | null> {
    const rows = await tx.run(`MATCH (n:Node {ref_id: $ref_id}) RETURN n`, { ref_id });
    if (rows.length === 0) return null;
    const { node_type, ...props } = rows[0]!["n"] as Record<string, unknown>;
    return { ref_id, type: typeof node_type === "string" ? node_type : undefined, props };
  }

  async refByKey(tx: GraphTx, type: string, node_key: string): Promise<string | null> {
    const rows = await tx.run(`MATCH (n:Node {node_type: $type, node_key: $k}) RETURN n.ref_id AS ref_id LIMIT 1`, { type, k: node_key });
    return rows.length ? String(rows[0]!["ref_id"]) : null;
  }

  async update(tx: GraphTx, schema: NodeSchema, ref_id: string, set: Record<string, unknown>, remove: string[]): Promise<void> {
    const columns = await this.columns(tx, schema, set);
    const known = await this.known(tx, remove);
    const params: Params = { ref_id };
    const assigns: string[] = [];
    let i = 0;
    for (const [k, v] of Object.entries(columns)) {
      params[`v${i}`] = v;
      assigns.push(`n.${q(k)} = $v${i++}`);
    }
    // A removed name that was never a column (a per-stem vector) is nothing to clear.
    for (const k of remove) if (known[k] && !(k in columns) && !PRESERVED.has(k)) assigns.push(`n.${q(k)} = NULL`);
    if (assigns.length) await tx.run(`MATCH (n:Node {ref_id: $ref_id}) SET ${assigns.join(", ")}`, params);
  }

  /** Three statements in one transaction: stamp `deleted_at` (the first
   *  delete time and reason kept), delete the node's outgoing edges, then its
   *  incoming ones — or leave them (`keepEdges`). Every node in the file is
   *  in scope. */
  async softDelete(ref_id: string, _namespace: string, guard: NodeGuard, opts: SoftDeleteOptions = {}): Promise<SoftDeleteResult | null> {
    const go = async (tx: GraphTx): Promise<SoftDeleteResult | null> => {
      const params: Params = { ref_id, now: opts.at ?? Date.now() };
      const pattern = ["ref_id: $ref_id"];
      const where: string[] = [];
      if (guard.type) {
        params["type"] = guard.type;
        pattern.push("node_type: $type");
      }
      if (guard.domainLabel) {
        // The one domain the file has: `Domain_strut` is the Strut types.
        if (guard.domainLabel !== "Domain_strut") return null;
        where.push(`n.node_type IN [${LADYBUG_STRUT_TYPES.map(lit).join(", ")}]`);
      }
      let i = 0;
      for (const [k, v] of Object.entries(guard.props ?? {})) {
        if (!nodeColumns()[k]) return null;
        params[`g${i}`] = v;
        pattern.push(`${q(k)}: $g${i++}`);
      }
      const sets = ["n.deleted_at = coalesce(n.deleted_at, CAST($now AS INT64))"];
      if (opts.reason !== undefined) {
        params["reason"] = opts.reason;
        sets.push("n.deleted_reason = coalesce(n.deleted_reason, $reason)");
      }
      const hit = await tx.run(
        `MATCH (n:Node {${pattern.join(", ")}}) ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         SET ${sets.join(", ")} RETURN n.ref_id AS ref_id`,
        params,
      );
      if (hit.length === 0) return null;
      if (opts.keepEdges) return { edges: 0 };
      const out = await tx.run(`MATCH (n:Node {ref_id: $ref_id})-[r]->(:Node) DELETE r RETURN count(r) AS n`, { ref_id });
      const inc = await tx.run(`MATCH (n:Node {ref_id: $ref_id})<-[r]-(:Node) DELETE r RETURN count(r) AS n`, { ref_id });
      return { edges: Number(out[0]?.["n"] ?? 0) + Number(inc[0]?.["n"] ?? 0) };
    };
    return opts.tx ? go(opts.tx) : this.lbug.withWrite(go);
  }
}

// ── Edges ───────────────────────────────────────────────────────────────────


/** An edge struct (`RETURN r`) as its properties: the columns it has. */
function edgeProps(rel: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(EDGE_COLUMNS)) if (rel[k] !== undefined && rel[k] !== null) out[k] = rel[k];
  return out;
}

/** Caller properties as edge columns; anything else is an error, not a blob. */
function edgeColumns(edge: string, props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (!EDGE_COLUMNS[k] || EDGE_STAMPS.has(k)) {
      throw new GraphValidationError("UNKNOWN_ATTRIBUTE", edge, `not an edge column of the ladybug file (${Object.keys(EDGE_COLUMNS).filter((c) => !EDGE_STAMPS.has(c)).join(", ")})`, k);
    }
    out[k] = v;
  }
  return out;
}

class LadybugEdges implements EdgeEngine {
  constructor(
    private readonly lbug: LadybugHandle,
    private readonly catalog: LadybugCatalog,
  ) {}

  /** Does the file have a rel table for `edge`? */
  private async table(tx: GraphTx, edge: string): Promise<boolean> {
    return (await catalogFor(this.catalog, tx, (c) => c.edges.has(edge))).edges.has(edge);
  }

  async endpoints(tx: GraphTx, ids: string[]): Promise<Map<string, EdgeEndpoint>> {
    const rows = await tx.run(`UNWIND $ids AS id MATCH (n:Node {ref_id: id}) RETURN id, n.node_type AS type`, { ids });
    return new Map(rows.map((r) => [String(r["id"]), { type: typeof r["type"] === "string" ? r["type"] : undefined, uid: null }]));
  }

  async mergeBatch(tx: GraphTx, edge: string, rows: EdgeMergeRow[]): Promise<EdgeMergeResult[]> {
    if (!(await this.table(tx, edge))) throw new GraphValidationError("WRONG_TYPE", edge, "not an edge type this graph holds: register it between two types first (graph/create-triplet's create_schema_if_missing)");
    const out: EdgeMergeResult[] = [];
    for (const e of rows) {
      const extra = edgeColumns(edge, e.props);
      const params: Params = { src: e.src, tgt: e.tgt, edge_key: e.edge_key, ref_id: e.ref_id, weight: e.weight, added: e.date_added_to_graph };
      const sets = ["r.ref_id = $ref_id", "r.weight = $weight", "r.date_added_to_graph = CAST($added AS INT64)"];
      let i = 0;
      for (const [k, v] of Object.entries(extra)) {
        params[`p${i}`] = v;
        sets.push(`r.${q(k)} = $p${i++}`);
      }
      const r = await tx.run(
        `MATCH (s:Node {ref_id: $src}), (t:Node {ref_id: $tgt})
         MERGE (s)-[r:${q(edge)} {edge_key: $edge_key}]->(t)
         ON CREATE SET ${sets.join(", ")}
         RETURN r.ref_id AS ref_id, r.ref_id = $ref_id AS created, s.ref_id AS source_ref_id, t.ref_id AS target_ref_id`,
        params,
      );
      const row = r[0];
      if (!row) throw new Error(`edge MERGE for ${edge} matched no endpoints (${e.src} → ${e.tgt})`);
      out.push({ k: e.k, ref_id: String(row["ref_id"]), created: row["created"] === true, source_ref_id: String(row["source_ref_id"]), target_ref_id: String(row["target_ref_id"]) });
    }
    return out;
  }

  private async locate(tx: GraphTx, ref_id: string): Promise<{ edge: string; src: string; tgt: string } | null> {
    const rows = await tx.run(`MATCH (s:Node)-[r {ref_id: $ref_id}]->(t:Node) RETURN label(r) AS edge, s.ref_id AS src, t.ref_id AS tgt LIMIT 1`, { ref_id });
    const r = rows[0];
    return r ? { edge: String(r["edge"]), src: String(r["src"]), tgt: String(r["tgt"]) } : null;
  }

  async setProps(tx: GraphTx, ref_id: string, set: Record<string, unknown>, remove: string[]) {
    const at = await this.locate(tx, ref_id);
    if (!at) return null;
    const columns = edgeColumns(at.edge, set);
    for (const k of remove) edgeColumns(at.edge, { [k]: true });
    const params: Params = { ref_id };
    const assigns: string[] = [];
    let i = 0;
    for (const [k, v] of Object.entries(columns)) {
      params[`v${i}`] = v;
      assigns.push(`r.${q(k)} = $v${i++}`);
    }
    for (const k of remove) if (!(k in columns)) assigns.push(`r.${q(k)} = NULL`);
    if (assigns.length) await tx.run(`MATCH ()-[r:${q(at.edge)} {ref_id: $ref_id}]->() SET ${assigns.join(", ")}`, params);
    return { ref_id, edge: at.edge, source_ref_id: at.src, target_ref_id: at.tgt };
  }

  async findByTriple(tx: GraphTx, edge: string, src: string, tgt: string): Promise<string[]> {
    if (!(await this.table(tx, edge))) return [];
    const rows = await tx.run(`MATCH (s:Node {ref_id: $src})-[r:${q(edge)}]->(t:Node {ref_id: $tgt}) RETURN r.ref_id AS ref_id`, { src, tgt });
    return rows.map((r) => String(r["ref_id"]));
  }

  async delete(ref_id: string, tx?: GraphTx): Promise<EdgeDeleteResult | null> {
    const go = async (t: GraphTx): Promise<EdgeDeleteResult | null> => {
      const at = await this.locate(t, ref_id);
      if (!at) return null;
      await t.run(`MATCH ()-[r:${q(at.edge)} {ref_id: $ref_id}]->() DELETE r`, { ref_id });
      return { ref_id, edge: at.edge, source_ref_id: at.src, target_ref_id: at.tgt };
    };
    return tx ? go(tx) : this.lbug.withWrite(go);
  }

  async liveEdgesOf(tx: GraphTx, ref_id: string, edge: string, forward: boolean) {
    const node = await tx.run(`MATCH (x:Node {ref_id: $ref_id}) RETURN x.ref_id AS ref_id`, { ref_id });
    if (node.length === 0) return null;
    if (!(await this.table(tx, edge))) return { node: ref_id, edges: [] };
    const hop = forward ? `-[r:${q(edge)}]->` : `<-[r:${q(edge)}]-`;
    const rows = await tx.run(`MATCH (n:Node {ref_id: $ref_id})${hop}(p:Node) RETURN p.ref_id AS other, r.ref_id AS edge_ref_id, r AS rel`, { ref_id });
    return {
      node: ref_id,
      edges: rows.map((r) => ({ other: String(r["other"]), edge_ref_id: String(r["edge_ref_id"]), props: edgeProps(r["rel"] as Record<string, unknown>) })),
    };
  }

  async wouldCycle(tx: GraphTx, edge: string, node: string, to: string, forward: boolean): Promise<boolean> {
    if (!(await this.table(tx, edge))) return false;
    const [a, b] = forward ? [to, node] : [node, to];
    const rows = await tx.run(
      `MATCH (a:Node {ref_id: $a}), (b:Node {ref_id: $b}) MATCH p = (a)-[:${q(edge)}* SHORTEST 1..30]->(b) RETURN count(p) AS c`,
      { a, b },
    );
    return Number(rows[0]?.["c"] ?? 0) > 0;
  }

  async copyProps(tx: GraphTx, fromRef: string, toRef: string): Promise<void> {
    const old = await tx.run(`MATCH ()-[r {ref_id: $ref_id}]->() RETURN r AS rel LIMIT 1`, { ref_id: fromRef });
    const at = await this.locate(tx, toRef);
    if (!old[0] || !at) return;
    const props = edgeProps(old[0]["rel"] as Record<string, unknown>);
    const params: Params = { ref_id: toRef };
    const assigns: string[] = [];
    let i = 0;
    for (const [k, v] of Object.entries(props)) {
      if (EDGE_STAMPS.has(k)) continue;
      params[`v${i}`] = v;
      assigns.push(`r.${q(k)} = $v${i++}`);
    }
    if (assigns.length) await tx.run(`MATCH ()-[r:${q(at.edge)} {ref_id: $ref_id}]->() SET ${assigns.join(", ")}`, params);
  }
}

// ── The schema source: the file's Schema rows ───────────────────────────────

/** `ontology.ts` over the handle: reads on the caller's transaction when
 *  there is one, else the read connection; writes in the caller's
 *  transaction, else one of their own. Every write drops the catalog. */
export class LadybugSchemas implements SchemaSource {
  readonly holdsStrutTypes = true;
  constructor(
    private readonly lbug: LadybugHandle,
    private readonly catalog: LadybugCatalog,
  ) {}

  private reader(tx?: GraphTx): ontology.Run {
    return tx ? (c, p) => tx.run(c, p) : (c, p) => this.lbug.query(c, p);
  }

  private async write<T>(tx: GraphTx | undefined, fn: (run: ontology.Run, catalog: Catalog) => Promise<T>): Promise<T> {
    const go = async (t: GraphTx) => {
      const run: ontology.Run = (c, p) => t.run(c, p);
      this.catalog.invalidate();
      try {
        return await fn(run, await readCatalog(run));
      } finally {
        this.catalog.invalidate();
      }
    };
    return tx ? go(tx) : this.lbug.withWrite(go);
  }

  async schemaRow(type: string, opts: { live?: boolean } = {}, tx?: GraphTx): Promise<SchemaRow | null> {
    return ontology.schemaRow(this.reader(tx), type, opts.live);
  }
  async labelLike(): Promise<string | null> {
    return null; // no label catalog: a type is a Schema row or nothing
  }
  async ancestors(type: string, tx?: GraphTx): Promise<{ chain: string[]; rows: Array<Record<string, unknown>> }> {
    return ontology.ancestors(this.reader(tx), type);
  }
  async hidden(): Promise<{ domains: unknown; types: unknown }> {
    return { domains: undefined, types: undefined }; // no About node
  }
  async findEdgeSchema(walk: EdgeSchemaWalk, source: string, edge: string, target: string, tx?: GraphTx): Promise<EdgeSchemaRow | null> {
    return ontology.findEdgeSchema(this.reader(tx), walk, source, edge, target);
  }
  async typesNamed(names: string[], tx?: GraphTx): Promise<NamedSchema[]> {
    return ontology.typesNamed(this.reader(tx), names);
  }
  async managedTypes(tx?: GraphTx): Promise<Map<string, string>> {
    const rows = await this.reader(tx)(
      `MATCH (n:Node {node_type: 'Schema'}) WHERE n.managed_by IS NOT NULL AND n.deleted_at IS NULL RETURN n.type AS type, n.managed_by AS manager`,
    );
    return new Map(rows.map((r) => [String(r["type"]), String(r["manager"])]));
  }
  /** Every live Schema and edge rule: the reader's ontology. */
  async ontology(): Promise<{ schemas: SchemaRow[]; edges: Array<{ edge: string; source: string; target: string }> }> {
    const run = this.reader();
    return { schemas: await ontology.schemaRows(run), edges: await ontology.edgeSchemaRows(run) };
  }
  async createSchema(flat: Record<string, unknown>, tx?: GraphTx): Promise<void> {
    await this.write(tx, (run, c) => ontology.createSchemaRow(run, c, flat));
  }
  async extendSchema(type: string, props: Record<string, unknown>, tx?: GraphTx): Promise<void> {
    await this.write(tx, (run, c) => ontology.extendSchemaRow(run, c, type, props));
  }
  async deleteSchema(type: string, tx?: GraphTx): Promise<void> {
    await this.write(tx, (run) => ontology.deleteSchemaRow(run, type));
  }
  async ensureChildOf(child: string, parent: string, ref_id: string, tx?: GraphTx): Promise<boolean | null> {
    return this.write(tx, (run, c) => ontology.ensureChildOf(run, c, child, parent, ref_id));
  }
  async ensureEdgeSchema(source: string, edge: string, target: string, props: Record<string, unknown>, tx?: GraphTx) {
    return this.write(tx, (run, c) => ontology.ensureEdgeSchema(run, c, source, edge, target, props));
  }
  async ensureWildcardSchema(ref_id: string, tx?: GraphTx): Promise<void> {
    await this.write(tx, (run) => ontology.ensureWildcardSchema(run, ref_id));
  }
  async stampMigration(id: string): Promise<void> {
    await this.lbug.exclusive((w) => w(`MERGE (m:Migration {migration_id: $id}) ON CREATE SET m.executed_at = CAST($now AS INT64)`, { id, now: Date.now() }));
  }
}
