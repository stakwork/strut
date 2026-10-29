/**
 * The read surface over one Ladybug file (plans/ladybug-backend.md §6,
 * slice 3): `GraphReader` (`search.ts`) sized to the closed registry's ten
 * types. The same shapes as the Neo4j reader, so `graph-get` /
 * `graph-search` / `graph-neighbors`, the builder's `graph_get`, the run
 * flyout's nodes and the Run popover's typeahead read a file as they read
 * a swarm — and the same ranking: the retrievers here hand `Hit`s to the
 * shared `fuseHits` / `applyTitleBoost` / `applyUsageTiebreak`.
 *
 * What is different is the engine:
 *
 *   - one `Node` table, so a type is `node_type` and a hidden node is one
 *     with `deleted_at` (the file has no `is_muted`, no `status`);
 *   - types and schemas resolve from the registry, case-insensitively; an
 *     unknown type matches nothing, as on Neo4j;
 *   - one namespace: `default` resolves, anything else is
 *     `INVALID_NAMESPACE`, and `registerNamespace` is refused;
 *   - one domain: `strut` names the Strut types; any other `domains`
 *     entry is `INVALID_DOMAIN`;
 *   - one FTS index (`node_fts` over `Data_Bank` + `name`, BM25, porter) and
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
  DEFAULT_NAMESPACE,
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
  type GraphReader,
  type Hit,
  type HitNode,
  type Link,
  type NameHit,
  type NeighborsParams,
  type NodeEnvelope,
  type OntologyEdge,
  type SchemaEnvelope,
  type SearchParams,
  type SearchResult,
} from "../search.js";
import { STRUT_DOMAIN, getStrutSchema } from "../strut-schemas.js";
import { LADYBUG_EDGES, LADYBUG_EDGE_TYPES, LADYBUG_SCHEMAS, LADYBUG_STRUT_TYPES, ladybugSchema, nodeColumns } from "./registry.js";

export interface LadybugReaderOptions {
  /** The semantic half; without it search is keyword-only. */
  embedder?: Embedder;
}

type Engine = Pick<GraphEngine, "query" | "namespace">;

const q = (s: string) => `\`${s}\``;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const LIVE = (alias: string) => `${alias}.deleted_at IS NULL`;

/** A node as a struct of every column but the vector: 384 floats on every
 *  row of an over-fetch are weight the response strips anyway. */
function projection(alias: string): string {
  return `{${Object.keys(nodeColumns())
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

/** A registry type name as the registry spells it; an unknown one as given
 *  (it matches nothing, jarvis's silent-empty behaviour). */
function canonical(raw: string): string {
  return ladybugSchema(raw)?.type ?? raw.trim();
}

/** The flat row jarvis would hold for a registry schema, for `splitSchema`:
 *  the Strut types with their domain and display keys, the jarvis-named
 *  types with the keys the registry declares. */
function schemaRow(s: NodeSchema): Record<string, unknown> {
  const strut = getStrutSchema(s.type);
  return {
    type: s.type,
    parent: s.parent,
    node_key: s.node_key,
    index: s.index,
    title_key: s.title_key,
    description_key: s.description_key,
    ...(strut
      ? { domain: STRUT_DOMAIN, icon: strut.icon, shape: strut.shape, primary_color: strut.primary_color, secondary_color: strut.secondary_color, type_description: strut.type_description }
      : {}),
    ...s.attributes,
  };
}

/** `links` as one condition on `node`: a live edge of the type, in its
 *  direction, to a live node of the type. An edge type the file has no
 *  table for is `false` — `EXISTS` over a missing table is a binder error. */
export function ladybugLinkedClause(links: Link[]): string | null {
  const alts = links.map(({ edge, direction, type }) => {
    if (!LADYBUG_EDGE_TYPES.includes(edge)) return "false";
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

export class LadybugReader implements GraphReader {
  constructor(
    private readonly engine: Engine,
    private readonly opts: LadybugReaderOptions = {},
  ) {}

  // ── namespaces ──────────────────────────────────────────────────────────

  async listNamespaces(): Promise<string[]> {
    return [];
  }

  async registerNamespace(name: string): Promise<{ namespace: string; created: boolean }> {
    throw new GraphReadError("INVALID_INPUT", `a ladybug file holds one namespace, ${DEFAULT_NAMESPACE}; ${String(name)} cannot be registered`);
  }

  async resolveNamespace(namespace: string | undefined): Promise<string> {
    const ns = namespace ?? this.engine.namespace;
    if (ns.toLowerCase() === DEFAULT_NAMESPACE) return DEFAULT_NAMESPACE;
    throw new GraphReadError("INVALID_NAMESPACE", `namespace ${ns} is not registered: a ladybug file holds ${DEFAULT_NAMESPACE} only`);
  }

  // ── nodes ───────────────────────────────────────────────────────────────

  async getNode(ref_id: string): Promise<NodeEnvelope | null> {
    const rows = await this.engine.query(`MATCH (n:Node {ref_id: $ref_id}) WHERE ${LIVE("n")} RETURN ${projection("n")} AS n LIMIT 1`, { ref_id });
    return rows.length === 0 ? null : envelope(hitNode(rows[0]!["n"]));
  }

  async getNodeByKey(type: string, node_key: string, namespace?: string): Promise<NodeEnvelope | null> {
    await this.resolveNamespace(namespace);
    const rows = await this.engine.query(
      `MATCH (n:Node {node_type: $type, node_key: $node_key}) WHERE ${LIVE("n")} RETURN ${projection("n")} AS n LIMIT 1`,
      { type: canonical(type), node_key },
    );
    return rows.length === 0 ? null : envelope(hitNode(rows[0]!["n"]));
  }

  async namesLike(type: string, qstr: string, limit = 8, namespace?: string): Promise<NameHit[]> {
    const frag = qstr.trim().toLowerCase();
    const schema = ladybugSchema(type);
    if (!frag || !schema) return [];
    await this.resolveNamespace(namespace);
    const cap = Math.min(50, Math.max(1, Math.floor(Number(limit) || 8)));
    const rows = await this.engine.query(
      `MATCH (n:Node {node_type: $type})
       WHERE n.name IS NOT NULL AND lower(n.name) CONTAINS $frag AND ${LIVE("n")}
       RETURN n.ref_id AS ref_id, n.name AS name, n.description AS description
       ORDER BY CASE WHEN lower(n.name) STARTS WITH $frag THEN 0 ELSE 1 END, lower(n.name)
       LIMIT ${cap}`,
      { type: schema.type, frag },
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
    const half = (dir: "out" | "in") =>
      this.engine.query(
        `MATCH (n:Node {ref_id: $ref_id})${dir === "out" ? "-[r]->" : "<-[r]-"}(m:Node) WHERE ${LIVE("m")}
         RETURN label(r) AS edge_type, m.node_type AS target_type, count(*) AS cnt`,
        { ref_id },
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
    const rows = await this.engine.query(
      `UNWIND $ids AS id MATCH (n:Node {ref_id: id})-[r]-(m:Node) WHERE ${LIVE("m")}
       RETURN id AS ref_id, label(r) AS edge_type, count(*) AS cnt`,
      { ids: ref_ids },
    );
    const out: Record<string, Record<string, number>> = {};
    for (const r of rows) (out[String(r["ref_id"])] ??= {})[String(r["edge_type"])] = Number(r["cnt"]);
    return out;
  }

  async neighbors(ref_id: string, p: NeighborsParams = {}): Promise<{ nodes: NodeEnvelope[]; edges: EdgeEnvelope[] }> {
    // A deleted source shows nothing, though a manager's soft delete kept its edges.
    const where = [LIVE("source"), LIVE("node")];
    const params: Params = { ref_id };
    if (p.node_types?.length) {
      params["node_types"] = p.node_types.map(canonical);
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
    const half = async (dir: "forward" | "reverse"): Promise<Row[]> =>
      this.engine.query(
        `MATCH (source:Node {ref_id: $ref_id})${dir === "forward" ? "-[r]->" : "<-[r]-"}(node:Node)
         WHERE ${where.join(" AND ")}
         RETURN label(r) AS type, r AS rel, ${projection("node")} AS node, ${projection("source")} AS source`,
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
    for (const d of domains) if (d !== STRUT_DOMAIN.toLowerCase()) throw new GraphReadError("INVALID_DOMAIN", `unknown domain ${d}`);
    // `type` and `domains` are both a type list here: the one domain the
    // file has is the Strut types.
    let types = p.types?.length ? p.types.map(canonical) : undefined;
    if (domains.length) types = types ? types.filter((t) => LADYBUG_STRUT_TYPES.includes(t)) : [...LADYBUG_STRUT_TYPES];
    if (types && types.length === 0) return empty;
    const links = parseLinks(p.linked ?? []).map((l) => ({ ...l, type: canonical(l.type) }));

    const clauses = [LIVE("node")];
    const base: Params = {};
    if (types) {
      clauses.push("node.node_type IN $node_types");
      base["node_types"] = types;
    }
    const excludeRe = excludeRegex(p.exclude ?? []);
    if (excludeRe) {
      clauses.push("(node.file IS NULL OR NOT node.file =~ $exclude_re)");
      base["exclude_re"] = excludeRe;
    }
    const excludeTypes = p.exclude_types?.length ? p.exclude_types : undefined;
    if (excludeTypes) {
      clauses.push("NOT node.node_type IN $exclude_types");
      base["exclude_types"] = excludeTypes;
    }
    const linked = ladybugLinkedClause(links);
    if (linked) clauses.push(linked);
    // Every filter is a WHERE after the index's top-k (one index, no
    // routing), so any filter widens both halves.
    const widen = Boolean(types || excludeRe || excludeTypes || linked);
    const filter = clauses.join(" AND ");
    const cap = fetchLimit(limit, skip);
    const warnings: string[] = [];
    const layer = retrieverLayer(warnings);
    const asHit = (r: Row): Hit => ({ node: hitNode(r["node"]), raw_score: Number(r["score"]) });

    const runFts = async (conjunctive: boolean, k: number): Promise<Hit[]> => {
      const rows = await this.engine.query(
        `CALL QUERY_FTS_INDEX('Node', 'node_fts', $q, conjunctive := $conjunctive, top := $k)
         WITH node, score WHERE ${filter}
         RETURN ${projection("node")} AS node, score`,
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
            `CALL QUERY_VECTOR_INDEX('Node', 'node_vec', $embedding, $k)
             WITH node, distance WHERE ${filter}
             RETURN ${projection("node")} AS node, 1 - distance AS score`,
            { ...base, embedding, k },
          );
          return rows.map(asHit);
        };
        return widen ? overfetch(cap, runVec) : runVec(cap);
      }, [] as Hit[]);
    }
    if (fieldQuery) warnings.push("input_q / output_q: a ladybug file keeps no per-field vectors; only q was searched");

    let ranked = fuseHits(fulltext, semantic, {}, fusionWeights(qstr));
    ranked = applyTitleBoost(ranked, qstr, (t) => (t ? ladybugSchema(t)?.title_key ?? "name" : "name"));
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

  // ── ontology: the registry ──────────────────────────────────────────────

  async listSchemas(opts: { domains?: string[]; includeDeleted?: boolean } = {}): Promise<{ schemas: SchemaEnvelope[]; edges: OntologyEdge[] }> {
    let schemas = LADYBUG_SCHEMAS.map((s) => splitSchema(schemaRow(s)));
    let edges: OntologyEdge[] = LADYBUG_EDGES.map((e) => ({ edge_type: e.edge, source_type: e.source, target_type: e.target }));
    if (opts.domains) {
      const wanted = new Set(opts.domains.map((d) => d.toLowerCase()));
      schemas = schemas.filter((s) => wanted.has(String(s["domain"] ?? "").toLowerCase()));
      const surviving = new Set(schemas.map((s) => s.type));
      edges = edges.filter((e) => surviving.has(e.source_type) && surviving.has(e.target_type));
    }
    return { schemas, edges };
  }

  async getSchema(type: string): Promise<SchemaEnvelope | null> {
    const s = ladybugSchema(type);
    return s ? splitSchema(schemaRow(s)) : null;
  }
}
