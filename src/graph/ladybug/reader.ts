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
  cmp,
  envelope,
  excludeRegex,
  fetchLimit,
  fuseHits,
  fusionWeights,
  isExactQuery,
  overfetch,
  parseLinks,
  refIdOf,
  retrieverLayer,
  serializeEdge,
  serializeNode,
  splitSchema,
  type ConnectionCount,
  type EdgeEnvelope,
  type EdgeLink,
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
import { THING_TYPE } from "../strut-schemas.js";
import { namespaceName } from "./namespaces.js";
import type { LadybugSchemas } from "./engine.js";
import type { LadybugCatalog } from "./ontology.js";
import { mergedInto } from "./merge.js";
import { EDGE_TEXT_TYPE, MERGE_TYPE, SCHEMA_TYPE } from "./registry.js";

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
/** A data node: the ontology's Schema rows, the edges' search rows (`EdgeText`) and merge records are not read, walked or counted. */
const DATA = (alias: string) => `NOT ${alias}.node_type IN ['${SCHEMA_TYPE}', '${EDGE_TEXT_TYPE}', '${MERGE_TYPE}']`;

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
    return `EXISTS { MATCH (node)${rel}(x:Node) WHERE x.node_type = ${lit(type)} AND ${LIVE("x")} }`;
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
    return {
      node: (a) => `${ns ? ` AND ${a}.namespace IN $scope_ns` : ""}${hidden.length ? ` AND NOT ${a}.node_type IN $scope_hidden` : ""}`,
      edge: (a) => (ns ? ` AND ${a}.namespace IN $scope_ns` : ""),
      params: { ...(ns ? { scope_ns: ns } : {}), ...(hidden.length ? { scope_hidden: hidden } : {}) },
    };
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
  async getNode(ref_id: string): Promise<NodeEnvelope | null> {
    // A Schema row is read through the ontology views, never as a node.
    const sc = await this.sql();
    const read = async (id: string) =>
      this.engine.query(`MATCH (n:Node {ref_id: $ref_id}) WHERE ${LIVE("n")} AND ${DATA("n")}${sc.node("n")} RETURN ${await this.project("n")} AS n LIMIT 1`, { ref_id: id, ...sc.params });
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
      { type: canonical, key, ns: await this.resolveNamespace(namespace), ...sc.params },
    );
    return rows.length === 0 ? null : envelope(hitNode(rows[0]!["n"]));
  }

  async namesLike(type: string, qstr: string, limit = 8, namespace?: string): Promise<NameHit[]> {
    const frag = qstr.trim().toLowerCase();
    const schema = frag ? await this.engine.schemaSource.schemaRow(type, { live: true }) : null;
    if (!frag || !schema) return [];
    const ns = await this.resolveNamespace(namespace);
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
    const half = (dir: "out" | "in") =>
      this.engine.query(
        `MATCH (n:Node {ref_id: $ref_id})${dir === "out" ? "-[r]->" : "<-[r]-"}(m:Node) WHERE ${LIVE("m")} AND ${DATA("m")}${sc.node("n")}${sc.node("m")}${sc.edge("r")}
         RETURN label(r) AS edge_type, m.node_type AS target_type, count(*) AS cnt`,
        { ref_id, ...sc.params },
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
    const rows = await this.engine.query(
      `UNWIND $ids AS id MATCH (n:Node {ref_id: id})-[r]-(m:Node) WHERE ${LIVE("m")} AND ${DATA("m")}${sc.node("n")}${sc.node("m")}${sc.edge("r")}
       RETURN id AS ref_id, label(r) AS edge_type, count(*) AS cnt`,
      { ids: ref_ids, ...sc.params },
    );
    const out: Record<string, Record<string, number>> = {};
    for (const r of rows) (out[String(r["ref_id"])] ??= {})[String(r["edge_type"])] = Number(r["cnt"]);
    return out;
  }

  async neighbors(ref_id: string, p: NeighborsParams = {}): Promise<{ nodes: NodeEnvelope[]; edges: EdgeEnvelope[] }> {
    // A deleted source shows nothing, though its soft delete may have kept its edges.
    const sc = await this.sql();
    const where = [LIVE("source"), LIVE("node"), DATA("node") + sc.node("source") + sc.node("node") + sc.edge("r")];
    const params: Params = { ref_id, ...sc.params };
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
         WHERE b.ref_id IN $within AND b.ref_id <> id AND ${LIVE("a")} AND ${LIVE("b")} AND ${DATA("b")}${scoped}
         RETURN id AS source, label(r) AS edge_type, b.ref_id AS target`,
        { ids: ref_ids, within: all, ...sc.params },
      )),
      ...(await this.engine.query(
        `UNWIND $ids AS id MATCH (a:Node {ref_id: id})<-[r]-(b:Node)
         WHERE b.ref_id IN $within AND NOT b.ref_id IN $ids AND ${LIVE("a")} AND ${LIVE("b")} AND ${DATA("b")}${scoped}
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
       WHERE ${LIVE("p")} AND ${DATA("p")}${sc.node("p")}${sc.node("c")}${sc.edge("r")}
       RETURN id AS target, ${await this.project("p")} AS node`,
      { ids: ref_ids, ...sc.params },
    );
    return rows.map((r) => ({ target: String(r["target"]), node: serializeNode(hitNode(r["node"])) }));
  }

  // ── search ──────────────────────────────────────────────────────────────

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
    const links = await Promise.all(parseLinks(p.linked ?? []).map(async (l) => ({ ...l, type: await this.canonical(l.type) })));

    // A Schema row has no search text, so no index returns it; said anyway.
    // A namespace asked for narrows the reader's scope; none reads them all.
    const sc = await this.sql();
    const clauses = [LIVE("node"), DATA("node") + sc.node("node")];
    const base: Params = { ...sc.params };
    if (p.namespace !== undefined) {
      clauses.push("node.namespace = $namespace");
      base["namespace"] = namespace;
    }
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
    const widen = Boolean(types || excludeRe || linked || this.scope || p.namespace !== undefined);
    const filter = clauses.join(" AND ");
    const cap = fetchLimit(limit, skip);
    const warnings: string[] = [];
    const layer = retrieverLayer(warnings);
    const asHit = (r: Row): Hit => ({ node: hitNode(r["node"]), raw_score: Number(r["score"]) });
    const pnode = await this.project("node");

    const runFts = async (conjunctive: boolean, k: number): Promise<Hit[]> => {
      const rows = await this.engine.query(
        `CALL QUERY_FTS_INDEX('Node', 'node_fts', $q, conjunctive := $conjunctive, top := $k)
         WITH node, score WHERE ${filter}
         RETURN ${pnode} AS node, score`,
        { ...base, q: ftsTerms(qstr), conjunctive, k },
      );
      return rows.map(asHit);
    };
    const fulltext = await layer("fulltext", async () => {
      const query = (conjunctive: boolean) => (widen ? overfetch(cap, (k) => runFts(conjunctive, k)) : runFts(conjunctive, cap));
      // Every word required, like jarvis's `+` terms; on nothing, any word
      // — the analogue of the `~` fallback — except for an exact query.
      let hits = await query(true);
      if (hits.length === 0 && !isExactQuery(qstr) && ftsTerms(qstr).includes(" ")) hits = await query(false);
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
        return widen ? overfetch(cap, runVec) : runVec(cap);
      }, [] as Hit[]);
    }
    if (fieldQuery) warnings.push("input_q / output_q: a ladybug file keeps no per-field vectors; only q was searched");

    let ranked = fuseHits(fulltext, semantic, {}, fusionWeights(qstr));
    const titles = new Map<string, string>();
    for (const t of new Set(ranked.map((e) => e.node.labels[0]).filter((t): t is string => !!t))) {
      const key = (await this.engine.schemaSource.schemaRow(t))?.props["title_key"];
      titles.set(t, typeof key === "string" ? key : "name");
    }
    ranked = applyTitleBoost(ranked, qstr, (t) => (t ? titles.get(t) ?? "name" : "name"));
    ranked = applyUsageTiebreak(ranked);

    const total = ranked.length;
    const page = ranked.slice(skip, skip + limit);
    const nodes = page.map((e) => serializeNode(e.node, { score: e.extra.score, match_type: e.extra.match_type }));
    if (p.include_edge_counts && nodes.length) {
      const counts = await this.edgeCounts(nodes.map((n) => n.ref_id), namespace, Boolean(p.namespace));
      for (const n of nodes) n.edges = counts[n.ref_id] ?? {};
    }
    return { nodes, total, truncated: fulltext.length >= cap || semantic.length >= cap, ...(warnings.length ? { warnings } : {}) };
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
