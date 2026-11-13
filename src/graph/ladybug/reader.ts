/**
 * The read surface over one Ladybug file (plans/ladybug-backend.md §6,
 * slice 3): `GraphReader` (`search.ts`) over the file's ontology (its
 * `Schema` rows, `ontology.ts`). The same shapes as the Neo4j reader, so `graph-get` /
 * `graph-search` / `graph-neighbors`, the builder's `graph_get`, the run
 * flyout's nodes and the Run popover's typeahead read a file as they read
 * a swarm — and the same ranking: the retrievers here hand `Hit`s to the
 * shared `fuseHits` / `applyTitleBoost` / `applyUsageTiebreak`.
 *
 * What is different is the engine:
 *
 *   - one `Node` table, so a type is `node_type` and a hidden node is one
 *     with `deleted_at` (the file has no `is_muted`, no `status`);
 *   - types and schemas resolve from the Schema rows, case-insensitively;
 *     an unknown type matches nothing, as on Neo4j. Schema rows are never
 *     search hits, and the root `Thing` (which holds no nodes) is left out
 *     of the ontology views;
 *   - namespaces need no registering (`namespaces.ts`): any well-formed
 *     name resolves (`default` to the backend's own, `private`), and a key
 *     or name lookup reads the one asked for. A search names one or reads
 *     them all; a reader built `withScope` (step 6) reads only its list,
 *     and an edge only when its own namespace and both ends are in it;
 *   - a domain is the types whose Schema names it (`strut`: the Strut
 *     types); a domain no type names is `INVALID_DOMAIN`;
 *   - one FTS index (`node_fts` over `search_text` + `title`, BM25, porter) and
 *     one HNSW index (`node_vec`, cosine), each read with `QUERY_*_INDEX`
 *     and filtered AFTER the index's top-k — so a typed search over-fetches
 *     BOTH halves (Neo4j routes the keyword half through a domain index
 *     and widens only on `exclude` / `linked`);
 *   - the keyword query is the words of the query, all required
 *     (`conjunctive`); a quoted span is its words, there is no fuzzy
 *     operator, so the zero-hit fallback is any-word;
 *   - no per-field vectors: `input_q` / `output_q` alone find nothing and
 *     say so in `warnings`;
 *   - a hop's direction comes from two directed statements (no
 *     `startNode`), merged and ordered by `importance` in TS.
 */
import type { GraphEngine, Params, Row } from "../engine.js";
import type { Embedder } from "../node-writer.js";
import type { NodeSchema } from "../schema-resolver.js";
import {
  EDGE_TYPE_NAME,
  EDGES_AMONG_MAX,
  GraphReadError,
  applyTitleBoost,
  applyUsageTiebreak,
  asOfTime,
  cmp,
  envelope,
  excludeRegex,
  fetchLimit,
  fuseHits,
  fusionWeights,
  isExactQuery,
  liftFactsOverEnds,
  overfetch,
  parseLinks,
  pyRound,
  refIdOf,
  retrieverLayer,
  serializeEdge,
  serializeNode,
  splitSchema,
  type ConnectionCount,
  type EdgeEnvelope,
  type EdgeLink,
  type FactEnd,
  type FactEnvelope,
  type GraphReader,
  type Hit,
  type HitNode,
  type Link,
  type NameHit,
  type NeighborsParams,
  type NodeEnvelope,
  type OntologyEdge,
  type ReadScope,
  type SchemaEnvelope,
  type SearchParams,
  type SearchResult,
} from "../search.js";
import { BRANCH_NAMESPACE_PREFIX, branchedNamespace } from "../search.js";
import { THING_TYPE } from "../strut-schemas.js";

/** The type a branch's namespace holds (`ReadScope.concepts`). */
const CONCEPT = "Concept";
import { ALT_NAMES } from "../node-writer.js";
import { corrections, cuedPredicates, predicateWords, textQuery, words, type TextQuery } from "../text-match.js";
import { namespaceName } from "./namespaces.js";
import type { LadybugSchemas } from "./engine.js";
import { edgeRule, type LadybugCatalog } from "./ontology.js";
import { edgeRuleOf } from "../schema-resolver.js";
import { scoreSlot, type FactTrust, type Person, type SlotEdge } from "../fact-score.js";
import { factClaimId, factEvidence } from "./fact-claims.js";
import { mergedInto } from "./merge.js";
import { EDGE_TEXT_TYPE, HIDDEN_TYPES, PERSON_TYPE } from "./registry.js";
import { temporalEdgeTypes } from "./temporal.js";

export interface LadybugReaderOptions {
  /** The semantic half; without it search is keyword-only. */
  embedder?: Embedder;
}

type Engine = Pick<GraphEngine, "query" | "namespace"> & { readonly catalog: LadybugCatalog; readonly schemaSource: LadybugSchemas };

const q = (s: string) => `\`${s}\``;
/** The HNSW search breadth for a vector query: recall at 10 held at 100% on
 *  50k rows with 500, and fell to 90% with the default (the plan's
 *  search-row prototype). */
export const VECTOR_EFS = 500;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const LIVE = (alias: string) => `${alias}.deleted_at IS NULL`;
/** An edge not deleted: a delete hides an edge (its `deleted_at`), never erases it. */
const EDGE_LIVE = (alias: string) => `${alias}.deleted_at IS NULL`;
/** `LIVE` unless the read asks for deleted things too (`include_deleted`). */
const live = (alias: string, all?: boolean) => (all ? "true" : LIVE(alias));
/** A data node: the ontology's Schema rows, the edges' search rows (`EdgeText`), merge records and dictation's mishearings are not read, walked or counted. */
const DATA = (alias: string) => `NOT ${alias}.node_type IN [${HIDDEN_TYPES.map(lit).join(", ")}]`;

/** Which temporal edges a read shows, as one condition on an edge or a
 *  search row (both hold the clocks; a plain edge has none, so it always
 *  passes): by default the current ones, not expired and not past their
 *  `invalid_at`; `include_ended` every one; `as_of` the ones true then,
 *  begun by it (or with no start) and not yet ended (`invalid_at`, else
 *  `expired_at` for an edge that was ended with no date). */
export function timeClause(alias: string, p: { include_ended?: boolean; as_of?: string | number }, params: Params): string {
  const asOf = asOfTime(p.as_of);
  if (asOf !== undefined) {
    params["as_of"] = asOf;
    const end = `coalesce(${alias}.invalid_at, ${alias}.expired_at)`;
    return `(${alias}.valid_at IS NULL OR ${alias}.valid_at <= $as_of) AND (${end} IS NULL OR ${end} > $as_of)`;
  }
  if (p.include_ended) return "true";
  params["now"] ??= Date.now();
  return `${alias}.expired_at IS NULL AND (${alias}.invalid_at IS NULL OR ${alias}.invalid_at > $now)`;
}

const msOf = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));

/** A node as a struct of every column but the vector: 384 floats on every
 *  row of an over-fetch are weight the response strips anyway. */
function projection(alias: string, columns: Record<string, string>): string {
  return `{${Object.keys(columns)
    .filter((c) => c !== "text_embeddings")
    .map((c) => `${q(c)}: ${alias}.${q(c)}`)
    .join(", ")}}`;
}

/** A projected row as the shared helpers' `HitNode`: the type is the one
 *  label, the rest the properties (the handle already dropped the nulls). */
function hitNode(row: unknown): HitNode {
  const { node_type, ...properties } = (row ?? {}) as Record<string, unknown>;
  return { labels: typeof node_type === "string" ? [node_type] : [], properties };
}

/** `links` as one condition on `node`: a live edge of the type, in its
 *  direction, to a live node of the type. An edge type the file has no
 *  table for is `false` — `EXISTS` over a missing table is a binder error. */
export function ladybugLinkedClause(links: Link[], tables: ReadonlySet<string>): string | null {
  const alts = links.map(({ edge, direction, type }) => {
    if (!tables.has(edge)) return "false";
    const rel = direction === ">" ? `-[e:${q(edge)}]->` : `<-[e:${q(edge)}]-`;
    return `EXISTS { MATCH (node)${rel}(x:Node) WHERE x.node_type = ${lit(type)} AND ${LIVE("x")} AND ${EDGE_LIVE("e")} }`;
  });
  return alts.length ? `(${alts.join(" OR ")})` : null;
}

/** The keyword query the FTS index reads: the query's words, a quoted span
 *  as its words (the index has no phrase operator). */
export function ftsTerms(qstr: string): string {
  return qstr.replace(/"/g, " ").trim().replace(/\s+/g, " ");
}

/** A scope as query text: a clause per node or edge alias (each with its
 *  leading AND, empty when unscoped) and the parameters they read. */
interface ScopeSql {
  node(alias: string): string;
  edge(alias: string): string;
  params: Params;
}
const UNSCOPED: ScopeSql = { node: () => "", edge: () => "", params: {} };

/** A fact search's filter over the search rows, and its full-text read. */
interface FactQuery {
  filter: string;
  base: Params;
  cap: number;
  row: string;
  asHit: (r: Row) => Hit;
  fts: (terms: string, conjunctive: boolean) => Promise<Hit[]>;
  /** The rows of the facts with one of `ids` at an end, of `types` when given. */
  of: (ids: string[], types?: string[]) => Promise<Hit[]>;
}

/** The reads the keyword half ranks: full-text hits for some words, nodes by ref_id, and the facts of some nodes. */
interface KeywordReads {
  nodes: (terms: string) => Promise<Hit[]>;
  nodesById: (ids: string[]) => Promise<Hit[]>;
  facts?: (terms: string) => Promise<Hit[]>;
  factsOf?: (ids: string[]) => Promise<Hit[]>;
  /** The rows of the facts of some edge types with one of `ids` at an end. */
  factsOfTypes?: (types: string[], ids: string[]) => Promise<Hit[]>;
}

/** The full-text query for a term list: the words, each once. */
const ftsWords = (list: Iterable<string>) => [...new Set(list)].join(" ");

export class LadybugReader implements GraphReader {
  constructor(
    private readonly engine: Engine,
    private readonly opts: LadybugReaderOptions = {},
    private readonly scope?: ReadScope,
  ) {}

  withScope(scope: ReadScope): LadybugReader {
    return new LadybugReader(this.engine, this.opts, scope);
  }

  /** This reader's scope as query text. The excluded domains are read as
   *  their types, from the Schema rows, on every call. */
  private async sql(): Promise<ScopeSql> {
    if (!this.scope) return UNSCOPED;
    const domains = new Set((this.scope.exclude_domains ?? []).map((d) => d.toLowerCase()));
    const hidden = domains.size
      ? (await this.engine.schemaSource.ontology()).schemas.filter((s) => domains.has(String(s.props["domain"] ?? "").toLowerCase())).map((s) => s.type)
      : [];
    const ns = this.scope.namespaces;
    const concepts = this.scope.concepts;
    // On a branch: a node is a Concept exactly when it is in the branch's namespace.
    const branch = (a: string) =>
      concepts ? ` AND ((${a}.node_type = '${CONCEPT}' AND ${a}.namespace = $scope_concepts) OR (${a}.node_type <> '${CONCEPT}' AND ${a}.namespace <> $scope_concepts))` : "";
    return {
      node: (a) => `${ns ? ` AND ${a}.namespace IN $scope_ns` : ""}${hidden.length ? ` AND NOT ${a}.node_type IN $scope_hidden` : ""}${branch(a)}`,
      edge: (a) => (ns ? ` AND ${a}.namespace IN $scope_ns` : ""),
      params: { ...(ns ? { scope_ns: ns } : {}), ...(hidden.length ? { scope_hidden: hidden } : {}), ...(concepts ? { scope_concepts: concepts } : {}) },
    };
  }

  /** `timeClause` on an edge alias, when the file has a temporal edge
   *  table to read the clocks from; else every edge is a plain one, and
   *  passes (a column no table holds is a binder error). */
  private async edgeTime(alias: string, p: { include_ended?: boolean; as_of?: string | number }, params: Params): Promise<string> {
    asOfTime(p.as_of);
    const tables = (await this.engine.catalog.get()).edges;
    const temporal = (await temporalEdgeTypes((c, x) => this.engine.query(c, x))).some((t) => tables.has(t));
    return temporal ? timeClause(alias, p, params) : "true";
  }

  /** The projection of every column the file has. */
  private async project(alias: string): Promise<string> {
    return projection(alias, (await this.engine.catalog.get()).columns);
  }

  /** A type name as the ontology spells it; an unknown one as given (it
   *  matches nothing, jarvis's silent-empty behaviour). */
  private async canonical(raw: string): Promise<string> {
    return (await this.engine.schemaSource.schemaRow(raw, { live: true }))?.type ?? raw.trim();
  }

  // ── namespaces ──────────────────────────────────────────────────────────

  /** The namespaces the file holds a node in, beyond the backend's own. */
  async listNamespaces(): Promise<string[]> {
    const rows = await this.engine.query(`MATCH (n:Node) WHERE n.namespace IS NOT NULL RETURN DISTINCT n.namespace AS ns`);
    return rows
      .map((r) => String(r["ns"]))
      .filter((ns) => ns !== this.engine.namespace && (!this.scope?.namespaces || this.scope.namespaces.includes(ns)))
      .sort();
  }

  /** Nothing to store: a namespace is there once something is written in
   *  it. `created` says it held nothing yet. */
  async registerNamespace(name: string): Promise<{ namespace: string; created: boolean }> {
    const ns = namespaceName(String(name ?? ""), this.engine.namespace);
    if (!String(name ?? "").trim() || ns === null) throw new GraphReadError("INVALID_INPUT", `${String(name)} is not a namespace name`);
    const held = await this.engine.query(`MATCH (n:Node {namespace: $ns}) RETURN n.ref_id AS r LIMIT 1`, { ns });
    return { namespace: ns, created: held.length === 0 };
  }

  async resolveNamespace(namespace: string | undefined): Promise<string> {
    const ns = namespaceName(namespace, this.engine.namespace);
    if (ns === null) throw new GraphReadError("INVALID_NAMESPACE", `${String(namespace)} is not a namespace name`);
    return ns;
  }


  // ── nodes ───────────────────────────────────────────────────────────────

  /** A node merged into another (`../merge.ts`) is read as the node it
   *  was merged into: an old ref_id keeps working in every tool. */
  async getNode(ref_id: string, opts: { include_deleted?: boolean } = {}): Promise<NodeEnvelope | null> {
    // A Schema row is read through the ontology views, never as a node.
    const sc = await this.sql();
    const read = async (id: string) =>
      this.engine.query(`MATCH (n:Node {ref_id: $ref_id}) WHERE ${live("n", opts.include_deleted)} AND ${DATA("n")}${sc.node("n")} RETURN ${await this.project("n")} AS n LIMIT 1`, { ref_id: id, ...sc.params });
    let rows = await read(ref_id);
    if (rows.length === 0) {
      const kept = await mergedInto((c, p) => this.engine.query(c, p), ref_id);
      if (kept) rows = await read(kept);
    }
    return rows.length === 0 ? null : envelope(hitNode(rows[0]!["n"]));
  }

  async getNodeByKey(type: string, key: string, namespace?: string): Promise<NodeEnvelope | null> {
    const canonical = await this.canonical(type);
    const sc = await this.sql();
    const rows = await this.engine.query(
      `MATCH (n:Node {node_type: $type, namespace: $ns, key: $key}) WHERE ${LIVE("n")}${sc.node("n")} RETURN ${await this.project("n")} AS n LIMIT 1`,
      { type: canonical, key, ns: await this.resolveNamespace(branchedNamespace(this.scope, canonical, namespace, this.engine.namespace)), ...sc.params },
    );
    return rows.length === 0 ? null : envelope(hitNode(rows[0]!["n"]));
  }

  async namesLike(type: string, qstr: string, limit = 8, namespace?: string): Promise<NameHit[]> {
    const frag = qstr.trim().toLowerCase();
    const schema = frag ? await this.engine.schemaSource.schemaRow(type, { live: true }) : null;
    if (!frag || !schema) return [];
    const ns = await this.resolveNamespace(branchedNamespace(this.scope, schema.type, namespace, this.engine.namespace));
    const cap = Math.min(50, Math.max(1, Math.floor(Number(limit) || 8)));
    const sc = await this.sql();
    const rows = await this.engine.query(
      `MATCH (n:Node {node_type: $type, namespace: $ns})
       WHERE n.name IS NOT NULL AND lower(n.name) CONTAINS $frag AND ${LIVE("n")}${sc.node("n")}
       RETURN n.ref_id AS ref_id, n.name AS name, n.description AS description
       ORDER BY CASE WHEN lower(n.name) STARTS WITH $frag THEN 0 ELSE 1 END, lower(n.name)
       LIMIT ${cap}`,
      { type: schema.type, frag, ns, ...sc.params },
    );
    return rows.map((r) => ({
      ref_id: String(r["ref_id"]),
      node_type: schema.type,
      name: String(r["name"]),
      ...(typeof r["description"] === "string" && r["description"] ? { description: r["description"] as string } : {}),
    }));
  }

  async connectionCounts(ref_id: string, namespace?: string): Promise<ConnectionCount[]> {
    await this.resolveNamespace(namespace);
    const sc = await this.sql();
    const params: Params = { ref_id, ...sc.params };
    const time = await this.edgeTime("r", {}, params);
    const half = (dir: "out" | "in") =>
      this.engine.query(
        `MATCH (n:Node {ref_id: $ref_id})${dir === "out" ? "-[r]->" : "<-[r]-"}(m:Node) WHERE ${LIVE("m")} AND ${EDGE_LIVE("r")} AND ${DATA("m")}${sc.node("n")}${sc.node("m")}${sc.edge("r")} AND ${time}
         RETURN label(r) AS edge_type, m.node_type AS target_type, count(*) AS cnt`,
        params,
      );
    const out: ConnectionCount[] = [];
    for (const direction of ["out", "in"] as const) {
      for (const r of await half(direction)) {
        out.push({ edge_type: String(r["edge_type"]), target_type: String(r["target_type"]), direction, count: Number(r["cnt"]) });
      }
    }
    return out.sort((a, b) => b.count - a.count || cmp(a.edge_type, b.edge_type) || cmp(a.target_type, b.target_type) || cmp(a.direction, b.direction));
  }

  async edgeCounts(ref_ids: string[], namespace: string, _pinNamespace = false): Promise<Record<string, Record<string, number>>> {
    if (ref_ids.length === 0) return {};
    await this.resolveNamespace(namespace);
    const sc = await this.sql();
    const params: Params = { ids: ref_ids, ...sc.params };
    const time = await this.edgeTime("r", {}, params);
    const rows = await this.engine.query(
      `UNWIND $ids AS id MATCH (n:Node {ref_id: id})-[r]-(m:Node) WHERE ${LIVE("m")} AND ${EDGE_LIVE("r")} AND ${DATA("m")}${sc.node("n")}${sc.node("m")}${sc.edge("r")} AND ${time}
       RETURN id AS ref_id, label(r) AS edge_type, count(*) AS cnt`,
      params,
    );
    const out: Record<string, Record<string, number>> = {};
    for (const r of rows) (out[String(r["ref_id"])] ??= {})[String(r["edge_type"])] = Number(r["cnt"]);
    return out;
  }

  async neighbors(ref_id: string, p: NeighborsParams = {}): Promise<{ nodes: NodeEnvelope[]; edges: EdgeEnvelope[] }> {
    // A deleted source shows nothing, though it keeps its edges; deleted
    // edges are hidden. `include_deleted` shows them all.
    const sc = await this.sql();
    const all = p.include_deleted;
    const where = [live("source", all), live("node", all), live("r", all), DATA("node") + sc.node("source") + sc.node("node") + sc.edge("r")];
    const params: Params = { ref_id, ...sc.params };
    where.push(await this.edgeTime("r", p, params));
    if (p.node_types?.length) {
      params["node_types"] = await Promise.all(p.node_types.map((t) => this.canonical(t)));
      where.push("node.node_type IN $node_types");
    }
    if (p.exclude_node_types?.length) {
      params["exclude_node_types"] = p.exclude_node_types.map((n) => n.toLowerCase());
      where.push("NOT lower(node.node_type) IN $exclude_node_types");
    }
    if (p.edge_types?.length) {
      params["edge_types"] = p.edge_types.map((e) => e.replace(/[<>]/g, ""));
      where.push("label(r) IN $edge_types");
    }
    const [pn, ps] = [await this.project("node"), await this.project("source")];
    const half = async (dir: "forward" | "reverse"): Promise<Row[]> =>
      this.engine.query(
        `MATCH (source:Node {ref_id: $ref_id})${dir === "forward" ? "-[r]->" : "<-[r]-"}(node:Node)
         WHERE ${where.join(" AND ")}
         RETURN label(r) AS type, r AS rel, ${pn} AS node, ${ps} AS source`,
        params,
      );
    const dirs: Array<"forward" | "reverse"> = p.direction ? [p.direction] : ["forward", "reverse"];
    type Edge = { type: string; props: Record<string, unknown>; src: string; tgt: string; node: HitNode; source: HitNode };
    let rels: Edge[] = [];
    for (const dir of dirs) {
      for (const r of await half(dir)) {
        const node = hitNode(r["node"]);
        const source = hitNode(r["source"]);
        const [src, tgt] = dir === "forward" ? [refIdOf(source), refIdOf(node)] : [refIdOf(node), refIdOf(source)];
        rels.push({ type: String(r["type"]), props: (r["rel"] as Record<string, unknown>) ?? {}, src, tgt, node, source });
      }
    }
    if (rels.length === 0) return { nodes: [], edges: [] };
    // jarvis's importance order before the limit; a stable sort keeps the
    // engine's order among equals.
    rels = rels.map((e, i) => [e, i] as const).sort(([a, i], [b, j]) => (Number(b.props["importance"]) || 0) - (Number(a.props["importance"]) || 0) || i - j).map(([e]) => e);
    if (p.limit && p.limit > 0) rels = rels.slice(0, p.limit);
    const nodes: NodeEnvelope[] = [];
    const seen = new Set<string>();
    for (const n of [...rels.map((e) => e.node), rels[0]!.source]) {
      const id = refIdOf(n);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      nodes.push(serializeNode(n));
    }
    const edges: EdgeEnvelope[] = [];
    const seenEdges = new Set<string>();
    for (const e of rels) {
      const id = String(e.props["ref_id"] ?? `${e.src}|${e.type}|${e.tgt}`);
      if (seenEdges.has(id)) continue;
      seenEdges.add(id);
      edges.push(serializeEdge(e.type, e.props, e.src, e.tgt));
    }
    if (p.trust) {
      const facts = edges.filter((e) => typeof e.properties["text"] === "string" && e.ref_id);
      const trust = await this.trustOf(facts.map((e) => ({ ref_id: e.ref_id!, edge_type: e.edge_type, subject: e.source })), sc);
      for (const e of facts) if (trust.has(e.ref_id!)) e.trust = trust.get(e.ref_id!)!;
    }
    if (p.include_edge_counts && nodes.length) {
      const counts = await this.edgeCounts(nodes.map((n) => n.ref_id), p.namespace ?? this.engine.namespace, Boolean(p.namespace));
      for (const n of nodes) n.edges = counts[n.ref_id] ?? {};
    }
    return { nodes, edges };
  }

  /** `GraphReader.edgesAmong`: out of `ref_ids`, then into them from the rest of the set, each edge once. */
  async edgesAmong(ref_ids: string[], among: string[] = [], limit = EDGES_AMONG_MAX): Promise<{ edges: EdgeLink[]; truncated: boolean }> {
    if (ref_ids.length === 0) return { edges: [], truncated: false };
    const all = [...new Set([...ref_ids, ...among])];
    const sc = await this.sql();
    const scoped = sc.node("a") + sc.node("b") + sc.edge("r");
    const rows = [
      ...(await this.engine.query(
        `UNWIND $ids AS id MATCH (a:Node {ref_id: id})-[r]->(b:Node)
         WHERE b.ref_id IN $within AND b.ref_id <> id AND ${LIVE("a")} AND ${LIVE("b")} AND ${EDGE_LIVE("r")} AND ${DATA("b")}${scoped}
         RETURN id AS source, label(r) AS edge_type, b.ref_id AS target`,
        { ids: ref_ids, within: all, ...sc.params },
      )),
      ...(await this.engine.query(
        `UNWIND $ids AS id MATCH (a:Node {ref_id: id})<-[r]-(b:Node)
         WHERE b.ref_id IN $within AND NOT b.ref_id IN $ids AND ${LIVE("a")} AND ${LIVE("b")} AND ${EDGE_LIVE("r")} AND ${DATA("b")}${scoped}
         RETURN b.ref_id AS source, label(r) AS edge_type, id AS target`,
        { ids: ref_ids, within: all, ...sc.params },
      )),
    ];
    const seen = new Set<string>();
    const edges: EdgeLink[] = [];
    for (const r of rows) {
      const e = { source: String(r["source"]), target: String(r["target"]), edge_type: String(r["edge_type"]) };
      const key = `${e.source}|${e.edge_type}|${e.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(e);
    }
    return { edges: edges.slice(0, limit), truncated: edges.length > limit };
  }

  /** `GraphReader.incoming`; an edge type the file has no table for has none. */
  async incoming(ref_ids: string[], edge_type: string): Promise<Array<{ target: string; node: NodeEnvelope }>> {
    if (ref_ids.length === 0 || !EDGE_TYPE_NAME.test(edge_type) || !(await this.engine.catalog.get()).edges.has(edge_type)) return [];
    const sc = await this.sql();
    const rows = await this.engine.query(
      `UNWIND $ids AS id MATCH (p:Node)-[r:${q(edge_type)}]->(c:Node {ref_id: id})
       WHERE ${LIVE("p")} AND ${EDGE_LIVE("r")} AND ${DATA("p")}${sc.node("p")}${sc.node("c")}${sc.edge("r")}
       RETURN id AS target, ${await this.project("p")} AS node`,
      { ids: ref_ids, ...sc.params },
    );
    return rows.map((r) => ({ target: String(r["target"]), node: serializeNode(hitNode(r["node"])) }));
  }

  // ── search ──────────────────────────────────────────────────────────────

  /** A search's namespace clause: the one asked for (on a branch, with the
   *  branch's, where its Concepts are); none asked reads every namespace
   *  but a Concept branch's — main never sees a branch's copies — or, on a
   *  branch, every one, `sql` keeping that branch's Concepts alone. Sets
   *  `$namespace` / `$branch_prefix` in `base`; null when nothing to add. */
  private branchClause(alias: string, asked: string | undefined, base: Params): string | null {
    if (asked !== undefined) {
      base["namespace"] = namespaceName(asked, this.engine.namespace) ?? asked;
      return this.scope?.concepts ? `(${alias}.namespace = $namespace OR ${alias}.namespace = $scope_concepts)` : `${alias}.namespace = $namespace`;
    }
    if (this.scope?.concepts) return null;
    base["branch_prefix"] = BRANCH_NAMESPACE_PREFIX;
    return `NOT ${alias}.namespace STARTS WITH $branch_prefix`;
  }

  async search(p: SearchParams): Promise<SearchResult> {
    const qstr = (p.q ?? "").trim();
    const fieldQuery = Boolean(p.input_q?.trim() || p.output_q?.trim());
    const empty: SearchResult = { nodes: [], total: 0, truncated: false };
    if (!qstr) return fieldQuery ? { ...empty, warnings: ["input_q / output_q: a ladybug file keeps no per-field vectors; only q is searched"] } : empty;

    const namespace = await this.resolveNamespace(p.namespace);
    const limit = p.limit ?? 10;
    const skip = p.skip ?? 0;
    const domains = (p.domains ?? []).map((d) => d.toLowerCase()).filter(Boolean);
    // `type` and `domains` are both a type list here: a domain is the types
    // whose Schema names it.
    let types = p.types?.length ? await Promise.all(p.types.map((t) => this.canonical(t))) : undefined;
    const ontology = domains.length ? await this.engine.schemaSource.ontology() : undefined;
    if (domains.length) {
      const inDomain = (d: string) => ontology!.schemas.filter((s) => String(s.props["domain"] ?? "").toLowerCase() === d).map((s) => s.type);
      for (const d of domains) if (!inDomain(d).length) throw new GraphReadError("INVALID_DOMAIN", `unknown domain ${d}`);
      const allowed = new Set(domains.flatMap(inDomain));
      types = types ? types.filter((t) => allowed.has(t)) : [...allowed];
    }
    if (types && types.length === 0) return empty;
    const time: Params = {};
    const timeRow = timeClause("node", p, time);
    const links = await Promise.all(parseLinks(p.linked ?? []).map(async (l) => ({ ...l, type: await this.canonical(l.type) })));

    // A Schema row has no search text, so no index returns it; said anyway.
    // A namespace asked for narrows the reader's scope; none reads them all
    // but a Concept branch's (`branchClause`).
    const sc = await this.sql();
    const clauses = [live("node", p.include_deleted), DATA("node") + sc.node("node")];
    const base: Params = { ...sc.params };
    const notBranch = this.branchClause("node", p.namespace, base);
    if (notBranch) clauses.push(notBranch);
    if (types) {
      clauses.push("node.node_type IN $node_types");
      base["node_types"] = types;
    }
    const excludeRe = excludeRegex(p.exclude ?? []);
    if (excludeRe) {
      clauses.push("(node.file IS NULL OR NOT node.file =~ $exclude_re)");
      base["exclude_re"] = excludeRe;
    }
    const linked = ladybugLinkedClause(links, (await this.engine.catalog.get()).edges);
    if (linked) clauses.push(linked);
    // Every filter is a WHERE after the index's top-k (one index, no
    // routing), so any filter widens both halves.
    const widen = Boolean(types || excludeRe || linked || this.scope || notBranch);
    const filter = clauses.join(" AND ");
    const cap = fetchLimit(limit, skip);
    const warnings: string[] = [];
    const layer = retrieverLayer(warnings);
    const asHit = (r: Row): Hit => ({ node: hitNode(r["node"]), raw_score: Number(r["score"]) });
    const pnode = await this.project("node");

    const runFts = async (terms: string, conjunctive: boolean, k: number): Promise<Hit[]> => {
      const rows = await this.engine.query(
        `CALL QUERY_FTS_INDEX('Node', 'node_fts', $q, conjunctive := $conjunctive, top := $k)
         WITH node, score WHERE ${filter}
         RETURN ${pnode} AS node, score`,
        { ...base, q: terms, conjunctive, k },
      );
      return rows.map(asHit);
    };
    const nodeFts = (terms: string, conjunctive: boolean) => (widen ? overfetch(cap, (k) => runFts(terms, conjunctive, k)) : runFts(terms, conjunctive, cap));

    // Facts, through their search rows, unless the search asks for nodes of
    // some types (`type`, `domains`, `linked` say what a node is; a fact is none).
    // A file whose Node table has no search-row columns holds no facts.
    const columns = (await this.engine.catalog.get()).columns;
    const rowsHeld = ["edge_ref_id", "valid_at", "invalid_at", "expired_at"].every((c) => c in columns);
    const factQuery = p.facts === false || types || links.length || !rowsHeld ? undefined : await this.factQuery({ ...p, limit, skip }, sc, timeRow, time);

    // Words, not a quoted span: any word finds a candidate, and the
    // candidates are ranked by the words they match (`keyword`). A quoted
    // query keeps every word required, like jarvis's `+` terms; on nothing,
    // any word — the analogue of the `~` fallback — except for an exact query.
    const tq = isExactQuery(qstr) ? undefined : textQuery(qstr);
    let factsFulltext: Hit[] | undefined;
    let keywordOnly = false;
    const fulltext = await layer("fulltext", async () => {
      if (tq?.terms.length) {
        const nodesById = async (ids: string[]) =>
          (await this.engine.query(`MATCH (node:Node) WHERE node.ref_id IN $ids AND ${filter} RETURN ${pnode} AS node, 0.0 AS score`, { ...base, ids })).map(asHit);
        const kw = await this.keyword(tq, {
          nodes: (terms) => nodeFts(terms, false),
          nodesById,
          ...(factQuery ? { facts: (terms: string) => factQuery.fts(terms, false), factsOf: (ids: string[]) => factQuery.of(ids), factsOfTypes: (types: string[], ids: string[]) => factQuery.of(ids, types) } : {}),
        }, sc);
        factsFulltext = kw.facts;
        keywordOnly = true;
        return kw.nodes;
      }
      let hits = await nodeFts(ftsTerms(qstr), true);
      if (hits.length === 0 && !isExactQuery(qstr) && ftsTerms(qstr).includes(" ")) hits = await nodeFts(ftsTerms(qstr), false);
      return hits;
    }, [] as Hit[]);

    let semantic: Hit[] = [];
    if (this.opts.embedder) {
      semantic = await layer("semantic", async () => {
        const [embedding] = await this.opts.embedder!.embed([qstr]);
        const runVec = async (k: number): Promise<Hit[]> => {
          const rows = await this.engine.query(
            `CALL QUERY_VECTOR_INDEX('Node', 'node_vec', $embedding, $k, efs := ${VECTOR_EFS})
             WITH node, distance WHERE ${filter}
             RETURN ${pnode} AS node, 1 - distance AS score`,
            { ...base, embedding, k },
          );
          return rows.map(asHit);
        };
        return (await (widen ? overfetch(cap, runVec) : runVec(cap))).filter((h) => h.raw_score >= (this.opts.embedder!.minSimilarity ?? 0));
      }, [] as Hit[]);
    }
    if (fieldQuery) warnings.push("input_q / output_q: a ladybug file keeps no per-field vectors; only q was searched");

    const facts = factQuery ? await this.searchFacts(qstr, factQuery, { ...p, limit, skip }, sc, layer, factsFulltext) : { facts: [] as FactEnvelope[], truncated: false, fulltext: [] as Hit[], semantic: [] as Hit[] };

    // Nothing found by its words: only a close match by meaning counts.
    const alone = this.opts.embedder?.aloneMinSimilarity;
    if (alone !== undefined && fulltext.length === 0 && facts.fulltext.length === 0) {
      semantic = semantic.filter((h) => h.raw_score >= alone);
      facts.semantic = facts.semantic.filter((h) => h.raw_score >= alone);
      const kept = new Set(facts.semantic.map((h) => refIdOf(h.node)));
      facts.facts = facts.facts.filter((f) => kept.has(f.ref_id));
    }
    let ranked = fuseHits(fulltext, semantic, {}, fusionWeights(qstr));
    const titles = new Map<string, string>();
    for (const t of new Set(ranked.map((e) => e.node.labels[0]).filter((t): t is string => !!t))) {
      const key = (await this.engine.schemaSource.schemaRow(t))?.props["title_key"];
      titles.set(t, typeof key === "string" ? key : "name");
    }
    ranked = applyTitleBoost(ranked, qstr, (t) => (t ? titles.get(t) ?? "name" : "name"));
    ranked = applyUsageTiebreak(ranked);

    // Nodes and facts on one scale, so the two lists compare (a fact that
    // answers the question outranks its subject). With vectors: one
    // reciprocal-rank fusion over all four lists, the keyword list and the
    // vector list each holding nodes and facts together (both are rows of
    // the same indexes, so their raw scores compare). Keyword only: a hit's
    // keyword score over the best of both (`keyword` ranked them as one pool).
    let rescore: ((ref: string) => number | undefined) | undefined;
    if (semantic.length || facts.semantic.length) {
      let pool = fuseHits([...fulltext, ...facts.fulltext], [...semantic, ...facts.semantic], {}, fusionWeights(qstr));
      pool = applyTitleBoost(pool, qstr, (t) => (t ? titles.get(t) ?? "name" : "name"));
      pool = liftFactsOverEnds(pool, qstr, (t) => (t ? titles.get(t) ?? "name" : "name"));
      const pooled = new Map(pool.map((e) => [refIdOf(e.node), e.extra.score]));
      rescore = (ref) => pooled.get(ref);
    } else if (keywordOnly) {
      const raw = new Map([...fulltext, ...(factsFulltext ?? [])].map((h) => [refIdOf(h.node), h.raw_score]));
      const top = Math.max(0, ...raw.values());
      if (top > 0) rescore = (ref) => (raw.has(ref) ? pyRound(raw.get(ref)! / top, 6) : undefined);
    }
    if (rescore) {
      for (const f of facts.facts) f.score = rescore(f.ref_id) ?? f.score;
      for (const e of ranked) e.extra.score = rescore(refIdOf(e.node)) ?? e.extra.score;
      // Keyword only, each list is already in its pool's order; fused, it is not.
      if (semantic.length || facts.semantic.length) {
        facts.facts.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        ranked.sort((a, b) => b.extra.score - a.extra.score);
      }
    }
    facts.facts = facts.facts.slice(skip, skip + limit);
    const total = ranked.length;
    const page = ranked.slice(skip, skip + limit);
    const nodes = page.map((e) => serializeNode(e.node, { score: e.extra.score, match_type: e.extra.match_type }));
    if (p.include_edge_counts && nodes.length) {
      const counts = await this.edgeCounts(nodes.map((n) => n.ref_id), namespace, Boolean(p.namespace));
      for (const n of nodes) n.edges = counts[n.ref_id] ?? {};
    }
    return {
      nodes,
      ...(facts.facts.length ? { facts: facts.facts } : {}),
      total,
      truncated: fulltext.length >= cap || semantic.length >= cap || facts.truncated,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  /**
   * The keyword half for a query of words (src/graph/text-match.ts). Each
   * word is asked of the full-text index on its own, so Ladybug's own
   * analyser does the language work (word endings, possessives, punctuation,
   * its stop words, which find nothing) and its scores say how well a row
   * matches; a row's score is the sum over the words it matched, nodes and
   * facts in one pool, since both are rows of the same index. On top, only
   * what holds for any data:
   *   - a word the index finds nothing for is tried as a typo, or the start,
   *     of a word in the titles and `alt_names` of the entity and concept
   *     nodes (Lisbn → Lisbon), and a name the index never holds (a stop
   *     word that is someone's name: "Will") finds the nodes it names;
   *   - a word naming an edge type or one of its aliases (the schema's data:
   *     WORKS_AT's "job") finds that type's facts about the nodes found.
   */
  private async keyword(tq: TextQuery, reads: KeywordReads, sc: ScopeSql): Promise<{ nodes: Hit[]; facts: Hit[] }> {
    const { nodes, facts } = reads;
    const byWord = async (w: string) => ({ n: await nodes(w), f: facts ? await facts(w) : [] });
    const scores = new Map<string, { hit: Hit; fact: boolean; score: number }>();
    const add = (hits: Hit[], fact: boolean, weight: number, floor = 0) => {
      // A word counts once per row: its best meaning.
      const best = new Map<string, Hit>();
      for (const h of hits) if (!best.has(refIdOf(h.node)) || best.get(refIdOf(h.node))!.raw_score < h.raw_score) best.set(refIdOf(h.node), h);
      return [...best.values()].map((h) => ({ h, fact, s: weight * Math.max(h.raw_score, floor) }));
    };
    const top = { score: 0 };
    const vocabulary = await this.vocabulary(sc);
    for (const w of tq.terms) {
      const { n, f } = await byWord(w);
      let found = [...add(n, false, 1), ...add(f, true, 1)];
      if (!found.length) {
        // Nothing for the word itself: a word of the graph's names it may mean, or the nodes it names.
        const fixes = corrections(w, vocabulary.keys());
        for (const c of fixes) {
          const more = await byWord(c.word);
          found.push(...add(more.n, false, c.weight), ...add(more.f, true, c.weight));
        }
        const ids = [...new Set([w, ...fixes.map((c) => c.word)].flatMap((x) => [...(vocabulary.get(x) ?? [])]))];
        if (ids.length) {
          const named = await reads.nodesById(ids);
          const namedFacts = reads.factsOf ? await reads.factsOf(ids) : [];
          found.push(...add(named, false, 1, top.score || 1), ...add(namedFacts, true, 0.5, top.score || 1));
        }
      }
      const once = new Map<string, (typeof found)[number]>();
      for (const x of found) if (!once.has(refIdOf(x.h.node)) || once.get(refIdOf(x.h.node))!.s < x.s) once.set(refIdOf(x.h.node), x);
      for (const x of once.values()) {
        const id = refIdOf(x.h.node);
        const held = scores.get(id);
        scores.set(id, { hit: held?.hit ?? x.h, fact: x.fact, score: (held?.score ?? 0) + x.s });
        top.score = Math.max(top.score, scores.get(id)!.score);
      }
    }
    // A word naming an edge type (job → WORKS_AT, by an alias) finds that
    // type's facts about the nodes found, though their sentences never say it.
    const predicates = facts ? predicateWords((await this.engine.catalog.get()).edges, await this.engine.schemaSource.edgeAliases()) : undefined;
    const cued = predicates ? [...cuedPredicates(tq, predicates)] : [];
    const about = [...scores.values()].filter((x) => !x.fact).map((x) => refIdOf(x.hit.node));
    if (cued.length && about.length && reads.factsOfTypes) {
      for (const h of await reads.factsOfTypes(cued, about)) {
        const id = refIdOf(h.node);
        const held = scores.get(id);
        scores.set(id, { hit: held?.hit ?? h, fact: true, score: (held?.score ?? 0) + (top.score || 1) * 0.8 });
      }
    }
    const props = (h: Hit) => h.node.properties;
    // Ties go to the newer: the most recent of two equal answers is more likely current.
    const at = (h: Hit) => Number(props(h)["created_at"] ?? 0);
    const ranked = [...scores.values()].sort((a, b) => b.score - a.score || at(b.hit) - at(a.hit) || cmp(refIdOf(a.hit.node), refIdOf(b.hit.node)));
    const out = (fact: boolean) => ranked.filter((x) => x.fact === fact).map((x) => ({ ...x.hit, raw_score: x.score }));
    return { nodes: out(false), facts: out(true) };
  }

  /** The words of the entity and concept nodes' titles and other names, each
   *  with the nodes holding it: what a typo is checked against. */
  private async vocabulary(sc: ScopeSql): Promise<Map<string, Set<string>>> {
    const types = (await this.engine.schemaSource.ontology()).schemas
      .filter((s) => s.props["role"] === "entity" || s.props["role"] === "concept")
      .map((s) => s.type);
    if (!types.length) return new Map();
    const alts = ALT_NAMES in (await this.engine.catalog.get()).columns;
    const rows = await this.engine.query(
      `MATCH (n:Node) WHERE n.node_type IN $types AND ${LIVE("n")}${sc.node("n")} RETURN n.ref_id AS id, n.title AS title${alts ? `, n.${q(ALT_NAMES)} AS alts` : ""}`,
      { ...sc.params, types },
    );
    const out = new Map<string, Set<string>>();
    for (const r of rows) {
      for (const w of words([r["title"], ...(Array.isArray(r["alts"]) ? r["alts"] : [])].filter((x) => typeof x === "string").join(" "))) {
        (out.get(w) ?? out.set(w, new Set()).get(w)!).add(String(r["id"]));
      }
    }
    return out;
  }

  /** A fact search's filter over the search rows (the reader's scope, a
   *  namespace asked for, the time asked for) and the reads over them. */
  private async factQuery(p: SearchParams & { limit: number; skip: number }, sc: ScopeSql, timeRow: string, time: Params): Promise<FactQuery> {
    const where = [`node.node_type = '${EDGE_TEXT_TYPE}'`, live("node", p.include_deleted) + sc.node("node"), timeRow];
    const base: Params = { ...sc.params, ...time };
    const notBranch = this.branchClause("node", p.namespace, base);
    if (notBranch) where.push(notBranch);
    if (p.namespace !== undefined) base["namespace"] = await this.resolveNamespace(p.namespace);
    const filter = where.join(" AND ");
    const cap = fetchLimit(p.limit, p.skip);
    // The row's text and clocks ride along for the keyword ranking.
    const row = `{ref_id: node.edge_ref_id, edge_type: node.edge_type, source_ref_id: node.source_ref_id, target_ref_id: node.target_ref_id, search_text: node.search_text, created_at: coalesce(node.valid_at, node.created_at)}`;
    const asHit = (r: Row): Hit => ({ node: { labels: [EDGE_TEXT_TYPE], properties: (r["row"] as Record<string, unknown>) ?? {} }, raw_score: Number(r["score"]) });
    // The rows are a filter after the index's top-k, as a typed node search is: always over-fetched.
    const fts = (terms: string, conjunctive: boolean) =>
      overfetch(cap, async (k) =>
        (await this.engine.query(
          `CALL QUERY_FTS_INDEX('Node', 'node_fts', $q, conjunctive := $conjunctive, top := $k)
           WITH node, score WHERE ${filter}
           RETURN ${row} AS row, score`,
          { ...base, q: terms, conjunctive, k },
        )).map(asHit),
      );
    const of = async (ids: string[], types?: string[]) =>
      (await this.engine.query(
        `MATCH (node:Node) WHERE (node.source_ref_id IN $ids OR node.target_ref_id IN $ids)${types ? " AND node.edge_type IN $types" : ""} AND ${filter}
         RETURN ${row} AS row, 0.0 AS score LIMIT ${cap}`,
        { ...base, ids, ...(types ? { types } : {}) },
      )).map(asHit);
    return { filter, base, cap, row, asHit, fts, of };
  }

  /**
   * The facts a query finds (plans/graph-edge-search.md "Reads"): the
   * keyword and vector indexes hit the edges' search rows (`EdgeText`),
   * filtered after their top-k to the reader's namespaces, a namespace
   * asked for and the time asked for (the row holds its edge's clocks), and
   * fused as the nodes are. Each hit then fetches its edge and both ends,
   * which must be live data nodes the reader may see, as must the edge.
   * Ranked among facts only. `ranked` is the keyword half when the node
   * search already ran it (`keyword`).
   */
  private async searchFacts(
    qstr: string,
    fq: FactQuery,
    p: SearchParams & { limit: number; skip: number },
    sc: ScopeSql,
    layer: ReturnType<typeof retrieverLayer>,
    ranked?: Hit[],
  ): Promise<{ facts: FactEnvelope[]; truncated: boolean; fulltext: Hit[]; semantic: Hit[] }> {
    const { filter, base, cap, row, asHit } = fq;
    const fulltext = ranked ?? await layer("facts fulltext", async () => {
      let hits = await fq.fts(ftsTerms(qstr), true);
      if (hits.length === 0 && !isExactQuery(qstr) && ftsTerms(qstr).includes(" ")) hits = await fq.fts(ftsTerms(qstr), false);
      return hits;
    }, [] as Hit[]);
    const semantic = this.opts.embedder
      ? await layer("facts semantic", async () => {
          const [embedding] = await this.opts.embedder!.embed([qstr]);
          return overfetch(cap, async (k) =>
            (await this.engine.query(
              `CALL QUERY_VECTOR_INDEX('Node', 'node_vec', $embedding, $k, efs := ${VECTOR_EFS})
               WITH node, distance WHERE ${filter}
               RETURN ${row} AS row, 1 - distance AS score`,
              { ...base, embedding, k },
            )).map(asHit),
          ).then((hits) => hits.filter((h) => h.raw_score >= (this.opts.embedder!.minSimilarity ?? 0)));
        }, [] as Hit[])
      : [];
    const fused = fuseHits(fulltext, semantic, {}, fusionWeights(qstr));
    if (fused.length === 0) return { facts: [], truncated: false, fulltext, semantic };

    // Each hit's edge and ends, one statement per edge type.
    const tables = (await this.engine.catalog.get()).edges;
    const byType = new Map<string, Array<{ e: string; s: string; t: string }>>();
    for (const r of fused) {
      const x = r.node.properties;
      const type = String(x["edge_type"] ?? "");
      if (!EDGE_TYPE_NAME.test(type) || !tables.has(type)) continue;
      const list = byType.get(type) ?? [];
      list.push({ e: String(x["ref_id"]), s: String(x["source_ref_id"]), t: String(x["target_ref_id"]) });
      byType.set(type, list);
    }
    const end = (a: string) => `{ref_id: ${a}.ref_id, node_type: ${a}.node_type, title: coalesce(${a}.title, ${a}.name), deleted_at: ${a}.deleted_at}`;
    // A deleted fact, or one with a deleted end, shows only to `include_deleted`.
    const all = p.include_deleted;
    const found = new Map<string, Omit<FactEnvelope, "score" | "match_type">>();
    for (const [type, pairs] of byType) {
      const rows = await this.engine.query(
        `UNWIND $pairs AS p MATCH (s:Node {ref_id: p.s})-[r:${q(type)}]->(t:Node {ref_id: p.t})
         WHERE r.ref_id = p.e AND ${live("s", all)} AND ${live("t", all)} AND ${live("r", all)} AND ${DATA("s")} AND ${DATA("t")}${sc.node("s")}${sc.node("t")}${sc.edge("r")}
         RETURN r AS rel, ${end("s")} AS source, ${end("t")} AS target`,
        { pairs, ...sc.params },
      );
      for (const r of rows) {
        const rel = (r["rel"] as Record<string, unknown>) ?? {};
        const asEnd = (v: unknown): FactEnd => {
          const o = (v ?? {}) as Record<string, unknown>;
          return {
            ref_id: String(o["ref_id"]),
            node_type: typeof o["node_type"] === "string" ? o["node_type"] : undefined,
            ...(typeof o["title"] === "string" ? { title: o["title"] } : {}),
            ...(msOf(o["deleted_at"]) !== undefined ? { deleted_at: msOf(o["deleted_at"])! } : {}),
          };
        };
        const source = asEnd(r["source"]);
        const target = asEnd(r["target"]);
        // Hidden by its own delete, else by an end's.
        const deleted = msOf(rel["deleted_at"]) ?? source.deleted_at ?? target.deleted_at;
        const times: Partial<Record<"valid_at" | "invalid_at" | "expired_at", number>> = {};
        for (const k of ["valid_at", "invalid_at", "expired_at"] as const) if (msOf(rel[k]) !== undefined) times[k] = msOf(rel[k])!;
        found.set(String(rel["ref_id"]), {
          ref_id: String(rel["ref_id"]),
          edge_type: type,
          text: String(rel["text"] ?? ""),
          source,
          target,
          ...times,
          ...(typeof rel["superseded_by"] === "string" ? { superseded_by: rel["superseded_by"] } : {}),
          sources: Array.isArray(rel["sources"]) ? (rel["sources"] as unknown[]).map(String) : [],
          ...(typeof rel["namespace"] === "string" ? { namespace: rel["namespace"] } : {}),
          ...(deleted !== undefined ? { deleted_at: deleted } : {}),
        });
      }
    }
    const trust = p.trust ? await this.trustOf([...found.values()].map((f) => ({ ref_id: f.ref_id, edge_type: f.edge_type, subject: f.source.ref_id })), sc) : undefined;
    const facts: FactEnvelope[] = [];
    for (const r of fused) {
      const f = found.get(refIdOf(r.node));
      if (f) facts.push({ ...f, ...(trust?.has(f.ref_id) ? { trust: trust.get(f.ref_id)! } : {}), score: r.extra.score, match_type: r.extra.match_type });
    }
    // Every fact found: the caller ranks them with the nodes, then pages.
    return { facts, truncated: fulltext.length >= cap || semantic.length >= cap, fulltext, semantic };
  }

  /**
   * How far to trust each fact now (`fact-score.ts`), from its whole slot:
   * every edge of its type from its subject, current and ended, its claim's
   * evidence, and the Persons among their sources.
   * Nothing is stored. A fact whose type is not temporal is left out.
   */
  private async trustOf(facts: Array<{ ref_id: string; edge_type: string; subject: string }>, sc: ScopeSql): Promise<Map<string, FactTrust>> {
    const out = new Map<string, FactTrust>();
    if (!facts.length) return out;
    const run = (c: string, x?: Params) => this.engine.query(c, x);
    const tables = (await this.engine.catalog.get()).edges;
    const rules = new Map<string, ReturnType<typeof edgeRuleOf>>();
    for (const t of new Set(facts.map((f) => f.edge_type))) {
      const rule = edgeRuleOf((await edgeRule(run, t)) ?? {});
      if (rule.temporal) rules.set(t, rule);
    }
    // Every live edge of a type from these subjects, by subject: a deleted one never holds a slot.
    const slots = async (type: string, subjects: string[]): Promise<Map<string, SlotEdge[]>> => {
      const bySubject = new Map<string, SlotEdge[]>();
      if (!tables.has(type) || !EDGE_TYPE_NAME.test(type)) return bySubject;
      const rows = await this.engine.query(
        `UNWIND $ids AS id MATCH (s:Node {ref_id: id})-[r:${q(type)}]->(t:Node) WHERE ${LIVE("t")} AND ${EDGE_LIVE("r")}${sc.node("t")}${sc.edge("r")}
         RETURN id AS subject, r.ref_id AS ref_id, t.ref_id AS target, r.sources AS sources, r.valid_at AS valid_at, r.expired_at AS expired_at,
                r.superseded_by AS superseded_by, r.last_confirmed_at AS last_confirmed_at, r.created_at AS created_at`,
        { ids: subjects, ...sc.params },
      );
      const n = (v: unknown) => msOf(v) ?? null;
      for (const r of rows) {
        const list = bySubject.get(String(r["subject"])) ?? [];
        list.push({
          ref_id: String(r["ref_id"]),
          target: String(r["target"]),
          sources: Array.isArray(r["sources"]) ? (r["sources"] as unknown[]).map(String) : [],
          valid_at: n(r["valid_at"]),
          expired_at: n(r["expired_at"]),
          superseded_by: typeof r["superseded_by"] === "string" ? r["superseded_by"] : null,
          last_confirmed_at: n(r["last_confirmed_at"]),
          created_at: n(r["created_at"]),
        });
        bySubject.set(String(r["subject"]), list);
      }
      return bySubject;
    };
    const held: Array<{ type: string; subject: string; edges: SlotEdge[] }> = [];
    for (const type of rules.keys()) {
      const subjects = [...new Set(facts.filter((f) => f.edge_type === type).map((f) => f.subject))];
      const mine = await slots(type, subjects);
      for (const s of subjects) held.push({ type, subject: s, edges: mine.get(s) ?? [] });
    }
    // Each edge's claim evidence (plans/memory-truth-layer.md); an edge written
    // before claims has none, and is read from its sources.
    const claimOf = (type: string, subject: string, e: SlotEdge) => factClaimId(subject, type, e.target);
    const evidence = await factEvidence(run, [...new Set(held.flatMap((h) => h.edges.map((e) => claimOf(h.type, h.subject, e))))]);
    for (const h of held) {
      for (const e of h.edges) {
        const ev = evidence.get(claimOf(h.type, h.subject, e));
        if (ev?.length) e.evidence = ev;
      }
    }
    // The Persons among the sources and the evidence, and the user, for a fact no Person backs.
    const refs = [
      ...new Set([...held.flatMap((h) => h.edges.flatMap((e) => e.sources)), ...held.flatMap((h) => h.edges.flatMap((e) => (e.evidence ?? []).map((x) => x.said_by ?? "")))].filter((x) => x && !x.startsWith("run:"))),
    ];
    const owned = "is_owner" in (await this.engine.catalog.get()).columns;
    const people = new Map<string, Person>();
    if (refs.length) {
      const rows = await this.engine.query(
        `UNWIND $ids AS id MATCH (n:Node {ref_id: id}) WHERE n.node_type = '${PERSON_TYPE}'${sc.node("n")}
         RETURN id, coalesce(n.title, n.name) AS name, ${owned ? "n.is_owner = true" : "false"} AS owner`,
        { ids: refs, ...sc.params },
      );
      for (const r of rows) people.set(String(r["id"]), { ...(typeof r["name"] === "string" ? { name: r["name"] } : {}), owner: r["owner"] === true });
    }
    let user: { ref_id: string; name?: string } | undefined;
    if (owned) {
      const [r] = await this.engine.query(
        `MATCH (n:Node {node_type: '${PERSON_TYPE}'}) WHERE n.is_owner = true AND ${LIVE("n")}${sc.node("n")} RETURN n.ref_id AS ref_id, coalesce(n.title, n.name) AS name LIMIT 1`,
        sc.params,
      );
      if (r) user = { ref_id: String(r["ref_id"]), ...(typeof r["name"] === "string" ? { name: r["name"] } : {}) };
    }
    const now = Date.now();
    const wanted = new Set(facts.map((f) => f.ref_id));
    for (const h of held) {
      const rule = rules.get(h.type)!;
      const scored = scoreSlot({ subject: h.subject, edges: h.edges, one: rule.cardinality === "one", volatility: rule.volatility, people, user, now });
      for (const [id, t] of scored) if (wanted.has(id)) out.set(id, t);
    }
    return out;
  }

  // ── ontology: the Schema rows ───────────────────────────────────────────

  async listSchemas(opts: { domains?: string[]; includeDeleted?: boolean } = {}): Promise<{ schemas: SchemaEnvelope[]; edges: OntologyEdge[] }> {
    const ontology = await this.engine.schemaSource.ontology();
    let schemas = ontology.schemas.filter((s) => s.type !== THING_TYPE).map((s) => splitSchema(s.props));
    // A parent link to the root is ontology structure, left out with Thing.
    let edges: OntologyEdge[] = ontology.edges
      .filter((e) => e.source !== THING_TYPE && e.target !== THING_TYPE)
      .map((e) => ({ edge_type: e.edge, source_type: e.source, target_type: e.target }));
    if (opts.domains) {
      const wanted = new Set(opts.domains.map((d) => d.toLowerCase()));
      schemas = schemas.filter((s) => wanted.has(String(s["domain"] ?? "").toLowerCase()));
      const surviving = new Set(schemas.map((s) => s.type));
      edges = edges.filter((e) => surviving.has(e.source_type) && surviving.has(e.target_type));
    }
    return { schemas, edges };
  }

  async getSchema(type: string): Promise<SchemaEnvelope | null> {
    const row = await this.engine.schemaSource.schemaRow(type, { live: true });
    return row && row.type !== THING_TYPE ? splitSchema(row.props) : null;
  }
}
