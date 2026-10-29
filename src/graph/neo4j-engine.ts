/**
 * The Neo4j engine: today's jarvis-dialect Cypher (`plans/jarvis-graph-compat.md`),
 * moved out of the node writer, the edge writer, the schema resolver and
 * the seeders as it was, behind the seams in `engine.ts`. The semantics
 * live in those callers; this file is the statements.
 *
 * Integers: a plain JS number is sent to Neo4j as a FLOAT, so everything
 * jarvis stores as an Integer — `date_added_to_graph`, every `int` /
 * `datetime` attribute, an integral edge `weight` — is wrapped with `int()`
 * HERE, from the schema the caller hands over. Nothing above this file
 * wraps a number.
 */
import type { ManagedTransaction } from "neo4j-driver";
import { Bolt, int, txRows } from "./bolt.js";
import { DELETE_NODE_TAIL, EDGE_LIVE, NODE_LIVE, nowMs } from "./deletion.js";
import type {
  Dialect,
  EdgeEndpoint,
  EdgeEngine,
  EdgeMergeResult,
  EdgeMergeRow,
  EdgeSchemaRow,
  EdgeSchemaWalk,
  NamedSchema,
  EngineLike,
  GraphEngine,
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
} from "./engine.js";
import type { NodeSchema } from "./schema-resolver.js";
import { typeLabelOf } from "./strut-schemas.js";

const MAX_ANCESTOR_WALK_DEPTH = 10;

/** Identity props never touched after create. */
const PRESERVED = new Set(["ref_id", "node_key", "namespace", "date_added_to_graph"]);

const q = (s: string) => `\`${s}\``;

export const NEO4J_DIALECT: Dialect = {
  kind: "neo4j",
  node: (alias, type, props) =>
    `(${alias}:${q(type)}${props ? ` {${Object.entries(props).map(([k, v]) => `${q(k)}: ${v}`).join(", ")}}` : ""})`,
  isType: (alias, types) => `(${types.map((t) => `${alias}:${q(t)}`).join(" OR ")})`,
  typeOf: (alias) => `labels(${alias})`,
  edgeType: (alias) => `type(${alias})`,
  live: (alias) => NODE_LIVE(alias),
  edgeLive: (alias) => EDGE_LIVE(alias),
  int: (expr) => `toInteger(${expr})`,
  lower: (expr) => `toLower(${expr})`,
  project: (alias, fields) => `{${fields.map((f) => `${q(f)}: ${alias}.${q(f)}`).join(", ")}}`,
};

const txOf = (mtx: ManagedTransaction): GraphTx => ({ run: (cypher, params = {}) => txRows(mtx, cypher, params) });

export class Neo4jEngine implements GraphEngine {
  readonly kind = "neo4j" as const;
  readonly dialect = NEO4J_DIALECT;
  readonly nodeEngine: NodeEngine;
  readonly edgeEngine: EdgeEngine;
  readonly schemaSource: SchemaSource;

  constructor(readonly bolt: Bolt) {
    this.nodeEngine = new Neo4jNodes(bolt);
    this.edgeEngine = new Neo4jEdges(bolt);
    this.schemaSource = new Neo4jSchemas(bolt);
  }

  get namespace(): string {
    return this.bolt.namespace;
  }

  query(cypher: string, params: Params = {}): Promise<Row[]> {
    return this.bolt.run(cypher, params);
  }

  /** A managed write transaction — retried by the driver on transient
   *  errors, so `fn` may run more than once. */
  tx<T>(fn: (tx: GraphTx) => Promise<T>): Promise<T> {
    return this.bolt.write((mtx) => fn(txOf(mtx)));
  }
}

/** A bare `Bolt` is the Neo4j engine over it. */
export function asEngine(e: EngineLike): GraphEngine {
  return "kind" in e ? e : new Neo4jEngine(e);
}

/** Runs on the transaction when there is one, else auto-commit. */
const on = (bolt: Bolt, tx: GraphTx | undefined, cypher: string, params: Params = {}) => (tx ? tx.run(cypher, params) : bolt.run(cypher, params));

/** The attribute values jarvis stores as Neo4j Integers (`int` / `datetime`
 *  attributes, `date_added_to_graph`), wrapped; everything else as given. */
function wrapInts(schema: NodeSchema, map: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) {
    const t = schema.attributes[k];
    const base = t ? (t.startsWith("?") ? t.slice(1) : t) : undefined;
    out[k] = typeof v === "number" && (k === "date_added_to_graph" || k === "updated_at" || base === "int" || base === "datetime") ? int(v) : v;
  }
  return out;
}

// ── Nodes ───────────────────────────────────────────────────────────────────

class Neo4jNodes implements NodeEngine {
  constructor(private readonly bolt: Bolt) {}

  /**
   * The one Cypher template, UNWIND form. Labels = `Type` + Node + Data_Bank
   * + the schema's Domain_* labels; identity = (node_key, namespace). ON
   * CREATE gets the full stamped payload; ON MATCH gets the non-identity
   * payload only when the mode is `upsert` or the node is soft-deleted
   * (restore). A restore clears both delete markers (`deleted_at`,
   * `is_deleted`) and the `deleted_reason`, and never touches `is_muted`; otherwise the markers are left
   * exactly as they were. Whether the node was deleted is read in a WITH
   * before the MERGE: SET items apply in order, so a CASE reading a marker an
   * earlier item cleared would never fire.
   *
   * Outcome per row comes from a pre-read in the same transaction; the MERGE
   * itself stays race-safe (a concurrent create just turns into a match).
   *
   * `all(…)` sits in its own parentheses inside `coalesce`: Neo4j 5.19 (the
   * swarms') reads `coalesce(all(` as the ALL modifier of a function argument
   * (`count(ALL x)`) and refuses the whole statement.
   */
  async mergeBatch(tx: GraphTx, schema: NodeSchema, namespace: string, nodes: PreparedNode[], mode: WriteMode) {
    const type = schema.type;
    const labels = [q(type), "Node", "Data_Bank", ...schema.domainLabels.map(q)].join(":");
    const before = await tx.run(
      `UNWIND $keys AS k
       MATCH (n:${q(type)} {node_key: k, namespace: $ns})
       RETURN k AS node_key, NOT ${NODE_LIVE("n")} AS deleted`,
      { keys: nodes.map((n) => n.node_key), ns: namespace },
    );
    const deleted = new Set(before.filter((r) => r["deleted"] === true).map((r) => r["node_key"] as string));

    const rows = await tx.run(
      `UNWIND $rows AS row
       OPTIONAL MATCH (prior:${q(type)} {node_key: row.node_key, namespace: $ns})
       WITH row, prior IS NOT NULL AND NOT ${NODE_LIVE("prior")} AS restore,
            prior IS NOT NULL AND coalesce((all(k IN keys(row.attrs) WHERE prior[k] = row.attrs[k])), false) AS same
       MERGE (node:${labels} {node_key: row.node_key, namespace: $ns})
       ON CREATE SET node += row.on_create
       ON MATCH SET
         node += CASE WHEN $mode = 'upsert' OR restore THEN row.on_match ELSE {} END,
         node.updated_at = CASE WHEN restore OR ($mode = 'upsert' AND NOT same) THEN row.stamp ELSE node.updated_at END,
         node.deleted_at = CASE WHEN restore THEN null ELSE node.deleted_at END,
         node.is_deleted = CASE WHEN restore THEN null ELSE node.is_deleted END,
         node.deleted_reason = CASE WHEN restore THEN null ELSE node.deleted_reason END
       RETURN row.node_key AS node_key, node.ref_id AS ref_id, node.ref_id = row.on_create.ref_id AS created`,
      {
        rows: nodes.map((n) => {
          // The system stamp rides beside the payload: it moves on a restore,
          // or when an upsert changes an attribute (`attrs`; Data_Bank and the
          // vectors follow from them).
          const onMatch: Record<string, unknown> = {};
          const attrs: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(n.props)) {
            if (PRESERVED.has(k) || k === "updated_at") continue;
            onMatch[k] = v;
            if (k in schema.attributes) attrs[k] = v;
          }
          return {
            node_key: n.node_key,
            stamp: int(n.props["updated_at"] as number),
            on_create: wrapInts(schema, { ...n.props, ref_id: n.ref_id, node_key: n.node_key, namespace }),
            on_match: wrapInts(schema, onMatch),
            attrs: wrapInts(schema, attrs),
          };
        }),
        ns: namespace,
        mode,
      },
    );
    const byKey = new Map(rows.map((r) => [r["node_key"] as string, r]));
    return nodes.map((n) => {
      const r = byKey.get(n.node_key)!;
      let outcome: WriteOutcome;
      if (r["created"] as boolean) outcome = "created";
      else if (deleted.has(n.node_key)) outcome = "restored";
      else if (mode === "upsert") outcome = "updated";
      else outcome = "existing";
      return { ref_id: r["ref_id"] as string, node_key: n.node_key, outcome };
    });
  }

  async readRaw(tx: GraphTx, ref_id: string): Promise<RawNode | null> {
    const rows = await tx.run(`MATCH (n:Data_Bank {ref_id: $ref_id}) RETURN labels(n) AS labels, properties(n) AS props`, { ref_id });
    if (rows.length === 0) return null;
    return { ref_id, type: typeLabelOf(rows[0]!["labels"] as string[]), props: rows[0]!["props"] as Record<string, unknown> };
  }

  async refByKey(tx: GraphTx, type: string, node_key: string, namespace: string): Promise<string | null> {
    const rows = await tx.run(`MATCH (m:${q(type)} {node_key: $k, namespace: $ns}) RETURN m.ref_id AS ref_id LIMIT 1`, { k: node_key, ns: namespace });
    return rows.length ? String(rows[0]!["ref_id"]) : null;
  }

  async update(tx: GraphTx, schema: NodeSchema, ref_id: string, set: Record<string, unknown>, remove: string[]): Promise<void> {
    const removeClause = remove.length ? `REMOVE ${remove.map((k) => `n.${q(k)}`).join(", ")}` : "";
    await tx.run(`MATCH (n:Data_Bank {ref_id: $ref_id}) SET n += $set ${removeClause}`, { ref_id, set: wrapInts(schema, set) });
  }

  async softDelete(ref_id: string, namespace: string, guard: NodeGuard, opts: SoftDeleteOptions = {}): Promise<SoftDeleteResult | null> {
    // No domain, no type: any content node in the namespace.
    const label = guard.domainLabel ?? guard.type ?? "Data_Bank";
    const extra = Object.keys(guard.props ?? {});
    const pattern = ["ref_id: $ref_id", "namespace: $ns", ...extra.map((k) => `${q(k)}: $p_${k}`)].join(", ");
    const params: Params = { ref_id, ns: namespace, now_ms: nowMs() };
    for (const k of extra) params[`p_${k}`] = guard.props![k];
    let reason = "";
    if (opts.reason !== undefined) {
      params["reason"] = opts.reason;
      reason = "SET n.deleted_reason = coalesce(n.deleted_reason, $reason)";
    }
    const tail = opts.keepEdges
      ? `SET n.deleted_at = coalesce(n.deleted_at, toInteger($now_ms)), n.is_deleted = true RETURN n.ref_id AS ref_id, 0 AS deleted_edge_count`
      : DELETE_NODE_TAIL("n");
    const rows = await on(this.bolt, opts.tx, `MATCH (n:${q(label)} {${pattern}}) ${reason} ${tail}`, params);
    return rows.length > 0 ? { edges: Number(rows[0]!["deleted_edge_count"] ?? 0) } : null;
  }
}

// ── Edges ───────────────────────────────────────────────────────────────────

class Neo4jEdges implements EdgeEngine {
  constructor(private readonly bolt: Bolt) {}

  async endpoints(tx: GraphTx, ids: string[]): Promise<Map<string, EdgeEndpoint>> {
    const rows = await tx.run(`UNWIND $ids AS id MATCH (n:Data_Bank {ref_id: id}) RETURN id, labels(n) AS labels, n.unique_source_id AS uid`, { ids });
    return new Map(rows.map((r) => [r["id"] as string, { type: typeLabelOf(r["labels"] as string[]), uid: (r["uid"] as string | null) ?? null }]));
  }

  async mergeBatch(tx: GraphTx, edge: string, edges: EdgeMergeRow[]): Promise<EdgeMergeResult[]> {
    const rows = edges.map((e) => ({
      k: e.k,
      src: e.src,
      tgt: e.tgt,
      edge_key: e.edge_key,
      on_create: {
        ...e.props,
        ref_id: e.ref_id,
        edge_key: e.edge_key,
        weight: Number.isInteger(e.weight) ? int(e.weight) : e.weight,
        date_added_to_graph: int(e.date_added_to_graph),
        ...(e.unique_source_id ? { unique_source_id: e.unique_source_id } : {}),
      },
    }));
    const out = await tx.run(
      `UNWIND $edges AS e
       MATCH (source:Data_Bank {ref_id: e.src})
       MATCH (target:Data_Bank {ref_id: e.tgt})
       OPTIONAL MATCH (source)-[:IS_ALIAS]->(sa)
       OPTIONAL MATCH (target)-[:IS_ALIAS]->(ta)
       WITH COALESCE(sa, source) AS ns, COALESCE(ta, target) AS nt, e
       MERGE (ns)-[r:${q(edge)} {edge_key: e.edge_key}]->(nt)
       ON CREATE SET r += e.on_create
       ON MATCH SET r.is_muted = null, r.is_deleted = null, r.muted_by_delete_of = null
       RETURN e.k AS k, r.ref_id AS ref_id, r.ref_id = e.on_create.ref_id AS created,
              ns.ref_id AS source_ref_id, nt.ref_id AS target_ref_id`,
      { edges: rows },
    );
    if (out.length !== edges.length) {
      throw new Error(`edge MERGE for ${edge} returned ${out.length} rows for ${edges.length} inputs`);
    }
    return out.map((r) => ({
      k: r["k"] as number,
      ref_id: r["ref_id"] as string,
      created: r["created"] as boolean,
      source_ref_id: r["source_ref_id"] as string,
      target_ref_id: r["target_ref_id"] as string,
    }));
  }

  async setProps(tx: GraphTx, ref_id: string, set: Record<string, unknown>, remove: string[]) {
    const wrapped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(set)) wrapped[k] = k === "weight" && typeof v === "number" && Number.isInteger(v) ? int(v) : v;
    const removeClause = remove.length ? `REMOVE ${remove.map((k) => `r.${q(k)}`).join(", ")}` : "";
    const rows = await tx.run(
      `MATCH (s)-[r {ref_id: $ref_id}]->(t) SET r += $set ${removeClause}
       RETURN r.ref_id AS ref_id, type(r) AS edge, s.ref_id AS source_ref_id, t.ref_id AS target_ref_id`,
      { ref_id, set: wrapped },
    );
    const r = rows[0];
    if (!r) return null;
    return { ref_id: String(r["ref_id"]), edge: String(r["edge"]), source_ref_id: String(r["source_ref_id"]), target_ref_id: String(r["target_ref_id"]) };
  }

  async findByTriple(tx: GraphTx, edge: string, src: string, tgt: string): Promise<string[]> {
    const found = await tx.run(
      `MATCH (source:Data_Bank {ref_id: $src})
       MATCH (target:Data_Bank {ref_id: $tgt})
       OPTIONAL MATCH (source)-[:IS_ALIAS]->(sa)
       OPTIONAL MATCH (target)-[:IS_ALIAS]->(ta)
       WITH COALESCE(sa, source) AS s, COALESCE(ta, target) AS t
       MATCH (s)-[r:${q(edge)}]->(t)
       WHERE ${EDGE_LIVE("r")}
       RETURN r.ref_id AS ref_id`,
      { src, tgt },
    );
    return found.map((r) => String(r["ref_id"]));
  }

  async delete(ref_id: string, tx?: GraphTx): Promise<EdgeDeleteResult | null> {
    const rows = await on(
      this.bolt,
      tx,
      `MATCH (s)-[r {ref_id: $ref_id}]->(t)
       WITH r, r.ref_id AS ref_id, type(r) AS edge, s.ref_id AS source_ref_id, t.ref_id AS target_ref_id
       DELETE r
       RETURN ref_id, edge, source_ref_id, target_ref_id`,
      { ref_id },
    );
    const r = rows[0];
    if (!r) return null;
    return { ref_id: String(r["ref_id"]), edge: String(r["edge"]), source_ref_id: String(r["source_ref_id"]), target_ref_id: String(r["target_ref_id"]) };
  }

  async liveEdgesOf(tx: GraphTx, ref_id: string, edge: string, forward: boolean) {
    const hop = forward ? `-[r:${q(edge)}]->` : `<-[r:${q(edge)}]-`;
    const rows = await tx.run(
      `MATCH (x:Data_Bank {ref_id: $ref_id})
       OPTIONAL MATCH (x)-[:IS_ALIAS]->(xa)
       WITH COALESCE(xa, x) AS n
       OPTIONAL MATCH (n)${hop}(p) WHERE ${EDGE_LIVE("r")}
       RETURN n.ref_id AS node, p.ref_id AS other, r.ref_id AS edge_ref_id, properties(r) AS props`,
      { ref_id },
    );
    if (rows.length === 0) return null;
    return {
      node: String(rows[0]!["node"]),
      edges: rows
        .filter((r) => r["other"] != null)
        .map((r) => ({ other: String(r["other"]), edge_ref_id: String(r["edge_ref_id"]), props: (r["props"] ?? {}) as Record<string, unknown> })),
    };
  }

  async wouldCycle(tx: GraphTx, edge: string, node: string, to: string, forward: boolean): Promise<boolean> {
    const cycle = await tx.run(
      `MATCH (t0:Data_Bank {ref_id: $to})
       OPTIONAL MATCH (t0)-[:IS_ALIAS]->(ta)
       WITH COALESCE(ta, t0) AS t
       MATCH (n:Data_Bank {ref_id: $node})
       MATCH path = shortestPath(${forward ? `(t)-[:${q(edge)}*1..]->(n)` : `(n)-[:${q(edge)}*1..]->(t)`})
       WHERE ALL(rel IN relationships(path) WHERE ${EDGE_LIVE("rel")})
       RETURN t.ref_id AS t LIMIT 1`,
      { to, node },
    );
    return cycle.length > 0;
  }

  /** The old edge's properties verbatim (Integers stay Integers), the new
   *  edge's own stamps back on top. */
  async copyProps(tx: GraphTx, fromRef: string, toRef: string, uid: string | null): Promise<void> {
    await tx.run(
      `MATCH ()-[old {ref_id: $old}]->()
       MATCH ()-[new {ref_id: $new}]->()
       WITH old, new, new.edge_key AS edge_key, new.date_added_to_graph AS added
       SET new += properties(old)
       SET new.ref_id = $new, new.edge_key = edge_key, new.date_added_to_graph = added, new.unique_source_id = $uid`,
      { old: fromRef, new: toRef, uid },
    );
  }
}

// ── The Schema meta-graph ───────────────────────────────────────────────────

class Neo4jSchemas implements SchemaSource {
  readonly holdsStrutTypes = false;
  constructor(private readonly bolt: Bolt) {}

  async schemaRow(type: string, opts: { live?: boolean } = {}, tx?: GraphTx): Promise<SchemaRow | null> {
    const liveClause = opts.live ? `AND (n.is_deleted IS NULL OR n.is_deleted = false) AND n.type <> "*"` : "";
    const rows = await on(
      this.bolt,
      tx,
      `MATCH (n:Schema) WHERE toLower(n.type) = toLower($t) ${liveClause}
       RETURN properties(n) AS props ORDER BY CASE WHEN n.type = $t THEN 0 ELSE 1 END, n.type LIMIT 1`,
      { t: type },
    );
    if (rows.length === 0) return null;
    const props = rows[0]!["props"] as Record<string, unknown>;
    return { type: String(props["type"]), ref_id: typeof props["ref_id"] === "string" ? props["ref_id"] : undefined, props };
  }

  async labelLike(type: string, tx?: GraphTx): Promise<string | null> {
    const labels = await on(
      this.bolt,
      tx,
      `CALL db.labels() YIELD label WHERE toLower(label) = toLower($t)
       RETURN label ORDER BY CASE WHEN label = $t THEN 0 ELSE 1 END, label LIMIT 1`,
      { t: type },
    );
    return labels.length ? String(labels[0]!["label"]) : null;
  }

  async ancestors(type: string, tx?: GraphTx) {
    const rows = await on(
      this.bolt,
      tx,
      `MATCH (n:Schema {type: $t})
       OPTIONAL MATCH path = (n)-[:CHILD_OF*1..${MAX_ANCESTOR_WALK_DEPTH}]->(ancestor:Schema)
       RETURN [node IN nodes(path) WHERE node <> n | node.type] AS chain, [node IN nodes(path) WHERE node <> n | properties(node)] AS ancestors
       ORDER BY size(chain) DESC LIMIT 1`,
      { t: type },
    );
    if (rows.length === 0) return { chain: [], rows: [] };
    return {
      chain: ((rows[0]!["chain"] as string[] | null) ?? []).filter(Boolean),
      rows: (rows[0]!["ancestors"] as Array<Record<string, unknown>> | null) ?? [],
    };
  }

  async hidden(tx?: GraphTx) {
    const rows = await on(this.bolt, tx, `MATCH (a:About) RETURN a.hidden_domains AS d, a.hidden_types AS t LIMIT 1`);
    return { domains: rows[0]?.["d"], types: rows[0]?.["t"] };
  }

  async findEdgeSchema(walk: EdgeSchemaWalk, source: string, edge: string, target: string, tx?: GraphTx): Promise<EdgeSchemaRow | null> {
    const p = { s: source, t: target, e: edge };
    const D = MAX_ANCESTOR_WALK_DEPTH;
    const cypher = {
      exact: `MATCH (source:Schema)-[r]->(target:Schema)
           WHERE toLower(source.type) = toLower($s) AND toLower(target.type) = toLower($t) AND toLower(type(r)) = toLower($e)
           RETURN source.type AS source, target.type AS target, type(r) AS edge_type, properties(r) AS props LIMIT 1`,
      "source-ancestor": `MATCH path = (child:Schema)-[:CHILD_OF*1..${D}]->(ancestor:Schema)
           MATCH (ancestor)-[r]->(target:Schema)
           WHERE toLower(child.type) = toLower($s) AND toLower(target.type) = toLower($t) AND toLower(type(r)) = toLower($e)
           RETURN child.type AS source, target.type AS target, type(r) AS edge_type, properties(r) AS props
           ORDER BY length(path) ASC LIMIT 1`,
      "target-ancestor": `MATCH path = (child:Schema)-[:CHILD_OF*1..${D}]->(ancestor:Schema)
           MATCH (source:Schema)-[r]->(ancestor)
           WHERE toLower(child.type) = toLower($t) AND toLower(source.type) = toLower($s) AND toLower(type(r)) = toLower($e)
           RETURN source.type AS source, child.type AS target, type(r) AS edge_type, properties(r) AS props
           ORDER BY length(path) ASC LIMIT 1`,
      "both-ancestors": `MATCH src_path = (src_child:Schema)-[:CHILD_OF*1..${D}]->(src_anc:Schema)
           MATCH tgt_path = (tgt_child:Schema)-[:CHILD_OF*1..${D}]->(tgt_anc:Schema)
           MATCH (src_anc)-[r]->(tgt_anc)
           WHERE toLower(src_child.type) = toLower($s) AND toLower(tgt_child.type) = toLower($t) AND toLower(type(r)) = toLower($e)
           RETURN src_child.type AS source, tgt_child.type AS target, type(r) AS edge_type, properties(r) AS props
           ORDER BY (length(src_path) + length(tgt_path)) ASC LIMIT 1`,
      wildcard: `MATCH (source:Schema {type: "*"})-[r]->(target:Schema {type: "*"})
           WHERE toLower(type(r)) = toLower($e)
           RETURN source.type AS source, target.type AS target, type(r) AS edge_type, properties(r) AS props LIMIT 1`,
    }[walk];
    const rows = await on(this.bolt, tx, cypher, p);
    const r = rows[0];
    if (!r) return null;
    return { source: String(r["source"]), target: String(r["target"]), edge_type: String(r["edge_type"]), props: r["props"] as Record<string, unknown> };
  }

  async managedTypes(tx?: GraphTx): Promise<Map<string, string>> {
    const rows = await on(
      this.bolt,
      tx,
      `MATCH (s:Schema) WHERE s.managed_by IS NOT NULL AND (s.is_deleted IS NULL OR s.is_deleted = false) RETURN s.type AS type, s.managed_by AS manager`,
    );
    return new Map(rows.map((r) => [String(r["type"]), String(r["manager"])]));
  }

  async createSchema(flat: Record<string, unknown>, tx?: GraphTx): Promise<void> {
    await on(this.bolt, tx, `MERGE (s:Schema {type: $type}) ON CREATE SET s = $flat`, { type: flat["type"], flat });
  }

  async extendSchema(type: string, props: Record<string, unknown>, tx?: GraphTx): Promise<void> {
    await on(this.bolt, tx, `MATCH (s:Schema {type: $t}) SET s += $missing`, { t: type, missing: props });
  }

  async deleteSchema(type: string, tx?: GraphTx): Promise<void> {
    await on(this.bolt, tx, `MATCH (s:Schema {type: $t}) DETACH DELETE s`, { t: type });
  }

  async ensureChildOf(child: string, parent: string, ref_id: string, tx?: GraphTx): Promise<boolean | null> {
    const rows = await on(
      this.bolt,
      tx,
      `MATCH (child:Schema {type: $child}), (parent:Schema {type: $parent})
       MERGE (child)-[r:CHILD_OF]->(parent)
       ON CREATE SET r.ref_id = $ref_id
       RETURN r.ref_id = $ref_id AS created`,
      { child, parent, ref_id },
    );
    return rows.length ? Boolean(rows[0]!["created"]) : null;
  }

  /** The props may carry a caller's ref_id (the fixture keeps jarvis's), so
   *  "did MERGE create?" cannot be read off it — a transient marker says. */
  async ensureEdgeSchema(source: string, edge: string, target: string, props: Record<string, unknown>, tx?: GraphTx) {
    const rows = await on(
      this.bolt,
      tx,
      `MATCH (s:Schema {type: $s}), (t:Schema {type: $t})
       MERGE (s)-[r:${q(edge)}]->(t)
       ON CREATE SET r = $props, r.__created = true
       WITH r, coalesce(r.__created, false) AS created
       REMOVE r.__created
       RETURN created, r.ref_id AS ref_id`,
      { s: source, t: target, props },
    );
    if (rows.length === 0) return null;
    return { created: Boolean(rows[0]!["created"]), ref_id: String(rows[0]!["ref_id"]) };
  }

  async ensureWildcardSchema(ref_id: string, tx?: GraphTx): Promise<void> {
    await on(this.bolt, tx, `MERGE (s:Schema {type: "*"}) ON CREATE SET s.ref_id = $r, s.is_system = true`, { r: ref_id });
  }

  async typesNamed(names: string[], tx?: GraphTx): Promise<NamedSchema[]> {
    const wanted = names.map((n) => n.trim().toLowerCase()).filter(Boolean);
    if (!wanted.length) return [];
    const rows = await on(
      this.bolt,
      tx,
      `MATCH (s:Schema) WHERE (s.is_deleted IS NULL OR s.is_deleted = false) AND s.type <> "*"
         AND (toLower(s.type) IN $names OR any(a IN coalesce(s.aliases, []) WHERE toLower(toString(a)) IN $names))
       RETURN s.type AS type, s.aliases AS aliases, s.managed_by AS managed_by`,
      { names: wanted },
    );
    return rows.map((r) => ({
      type: String(r["type"]),
      aliases: Array.isArray(r["aliases"]) ? (r["aliases"] as unknown[]).map(String) : [],
      ...(typeof r["managed_by"] === "string" ? { managed_by: r["managed_by"] as string } : {}),
    }));
  }

  async stampMigration(id: string): Promise<void> {
    await this.bolt.run(`MERGE (m:Migration {migration_id: $id}) ON CREATE SET m.executed_at = timestamp()`, { id });
  }
}
