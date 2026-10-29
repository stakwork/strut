/**
 * Reads that leave managed types out (plans/memory-in-workspace-graph.md
 * decision 8). A type whose schema names a manager (`managed_by`, the
 * writers' guard in `node-writer.ts`) is the manager's: memory's people,
 * facts and episodes are for the person's assistant, not for a job's graph
 * tools, an app, the chat builder or a peer on `/graph/*`.
 *
 * `ManagedReadFilter` is a `GraphReader` over another one: the same
 * answers, with every managed node left out —
 *
 *   - get, get-by-key and names: a managed node is not there;
 *   - search: the managed types go to the reader as `exclude_types`, a
 *     filter on the index's rows, so a page is as full as without them;
 *   - neighbors: from a managed node, nothing; from any other, its managed
 *     endpoints are excluded before the limit, so a walk never crosses in;
 *   - counts: edges to a managed node are not counted;
 *   - the ontology: a managed type's schema and its edge schemas are not
 *     there, and a search `linked` to one finds nothing.
 *
 * Until a Schema names a manager every call goes straight through. Raw
 * Cypher (`graph/query`, the builder's `graph_query`) is not filtered but
 * refused while anything is managed (`query.ts`, `hideManaged`): its rows
 * carry no type to filter by.
 *
 * `graphView` is what a step is handed as `ctx.services.graph`: the reads
 * through this filter, the writers (which refuse a managed type without
 * its manager's key) and no engine handle.
 *
 * No runtime imports: the steps load this beside `graphCtx`.
 */
import type { GraphBackend } from "./backend.js";
import type { Params, Row } from "./bolt.js";
import type { EdgeWriter } from "./edge-writer.js";
import type { NodeWriter } from "./node-writer.js";
import type { SchemaResolver } from "./schema-resolver.js";
import type {
  ConnectionCount,
  EdgeEnvelope,
  GraphReader,
  NameHit,
  NeighborsParams,
  NodeEnvelope,
  OntologyEdge,
  SchemaEnvelope,
  SearchParams,
  SearchResult,
} from "./search.js";

/** Where the managed types come from: the backend's `SchemaResolver`. */
export interface ManagedTypes {
  managedTypes(): Promise<ReadonlyMap<string, string>>;
}

const lower = (types: ReadonlyMap<string, string>) => new Set([...types.keys()].map((t) => t.toLowerCase()));
const isHidden = (hidden: ReadonlySet<string>, type: string | undefined) => !!type && hidden.has(type.toLowerCase());

export class ManagedReadFilter implements GraphReader {
  constructor(
    private readonly inner: GraphReader,
    private readonly source: ManagedTypes,
  ) {}

  /** The managed types: canonical names, and their lowercase set. */
  private async managed(): Promise<{ names: string[]; hidden: ReadonlySet<string> }> {
    const types = (await this.source.managedTypes?.()) ?? new Map<string, string>();
    return { names: [...types.keys()], hidden: lower(types) };
  }

  listNamespaces(): Promise<string[]> {
    return this.inner.listNamespaces();
  }
  registerNamespace(name: string): Promise<{ namespace: string; created: boolean }> {
    return this.inner.registerNamespace(name);
  }
  resolveNamespace(namespace: string | undefined): Promise<string> {
    return this.inner.resolveNamespace(namespace);
  }
  async listSchemas(opts?: { domains?: string[]; includeDeleted?: boolean }): Promise<{ schemas: SchemaEnvelope[]; edges: OntologyEdge[] }> {
    const { hidden } = await this.managed();
    const out = await this.inner.listSchemas(opts);
    if (!hidden.size) return out;
    return {
      schemas: out.schemas.filter((s) => !isHidden(hidden, s.type)),
      edges: out.edges.filter((e) => !isHidden(hidden, e.source_type) && !isHidden(hidden, e.target_type)),
    };
  }
  async getSchema(type: string): Promise<SchemaEnvelope | null> {
    const { hidden } = await this.managed();
    if (isHidden(hidden, type)) return null;
    const s = await this.inner.getSchema(type);
    return s && isHidden(hidden, s.type) ? null : s;
  }

  async getNode(ref_id: string): Promise<NodeEnvelope | null> {
    const { hidden } = await this.managed();
    const n = await this.inner.getNode(ref_id);
    return n && isHidden(hidden, n.node_type) ? null : n;
  }

  async getNodeByKey(type: string, node_key: string, namespace?: string): Promise<NodeEnvelope | null> {
    const { hidden } = await this.managed();
    if (isHidden(hidden, type)) return null;
    const n = await this.inner.getNodeByKey(type, node_key, namespace);
    return n && isHidden(hidden, n.node_type) ? null : n;
  }

  async namesLike(type: string, q: string, limit?: number, namespace?: string): Promise<NameHit[]> {
    const { hidden } = await this.managed();
    if (isHidden(hidden, type)) return [];
    return (await this.inner.namesLike(type, q, limit, namespace)).filter((h) => !isHidden(hidden, h.node_type));
  }

  async connectionCounts(ref_id: string, namespace?: string): Promise<ConnectionCount[]> {
    const { hidden } = await this.managed();
    const counts = await this.inner.connectionCounts(ref_id, namespace);
    return hidden.size ? counts.filter((c) => !isHidden(hidden, c.target_type)) : counts;
  }

  /** Without managed types, the reader's own counts; with them, each
   *  node's connection counts summed by edge type, managed ends left out. */
  async edgeCounts(ref_ids: string[], namespace: string, pinNamespace?: boolean): Promise<Record<string, Record<string, number>>> {
    const { hidden } = await this.managed();
    if (!hidden.size) return this.inner.edgeCounts(ref_ids, namespace, pinNamespace);
    const out: Record<string, Record<string, number>> = {};
    for (const id of ref_ids) {
      for (const c of await this.inner.connectionCounts(id, namespace)) {
        if (isHidden(hidden, c.target_type)) continue;
        const m = (out[id] ??= {});
        m[c.edge_type] = (m[c.edge_type] ?? 0) + c.count;
      }
    }
    return out;
  }

  async neighbors(ref_id: string, p: NeighborsParams = {}): Promise<{ nodes: NodeEnvelope[]; edges: EdgeEnvelope[] }> {
    const { names, hidden } = await this.managed();
    if (!hidden.size) return this.inner.neighbors(ref_id, p);
    const node_types = p.node_types?.filter((t) => !isHidden(hidden, t));
    if (p.node_types?.length && !node_types?.length) return { nodes: [], edges: [] };
    const data = await this.inner.neighbors(ref_id, {
      ...p,
      ...(node_types ? { node_types } : {}),
      exclude_node_types: [...(p.exclude_node_types ?? []), ...names],
      include_edge_counts: false,
    });
    // From a managed node there is nothing to show: the source rides in `nodes`.
    if (data.nodes.some((n) => n.ref_id === ref_id && isHidden(hidden, n.node_type))) return { nodes: [], edges: [] };
    const gone = new Set(data.nodes.filter((n) => isHidden(hidden, n.node_type)).map((n) => n.ref_id));
    const nodes = data.nodes.filter((n) => !gone.has(n.ref_id));
    const edges = data.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target));
    if (p.include_edge_counts && nodes.length) {
      const counts = await this.edgeCounts(nodes.map((n) => n.ref_id), p.namespace ?? (await this.inner.resolveNamespace(undefined)), Boolean(p.namespace));
      for (const n of nodes) n.edges = counts[n.ref_id] ?? {};
    }
    return { nodes, edges };
  }

  async search(p: SearchParams): Promise<SearchResult> {
    const { names, hidden } = await this.managed();
    if (!hidden.size) return this.inner.search(p);
    const types = p.types?.filter((t) => !isHidden(hidden, t));
    if (p.types?.length && !types?.length) return { nodes: [], total: 0, truncated: false };
    // `linked: ["ABOUT<Person"]` would tell which nodes a managed one points at.
    if (p.linked?.some((l) => isHidden(hidden, l.split(/[<>]/).pop()?.trim()))) return { nodes: [], total: 0, truncated: false };
    const res = await this.inner.search({
      ...p,
      ...(types ? { types } : {}),
      exclude_types: [...(p.exclude_types ?? []), ...names],
      include_edge_counts: false,
    });
    const nodes = res.nodes.filter((n) => !isHidden(hidden, n.node_type));
    if (p.include_edge_counts && nodes.length) {
      const counts = await this.edgeCounts(nodes.map((n) => n.ref_id), p.namespace ?? (await this.inner.resolveNamespace(undefined)), Boolean(p.namespace));
      for (const n of nodes) n.edges = counts[n.ref_id] ?? {};
    }
    return { ...res, nodes };
  }
}

/** A raw query refused because the graph holds types the caller may not read. */
export class ManagedReadRefused extends Error {
  constructor() {
    super(
      "raw graph queries are off on this graph: it holds managed types (memory's) this caller may not read — use the typed reads (graph/graph-search, graph/graph-get, graph/graph-neighbors, graph/find)",
    );
    this.name = "ManagedReadRefused";
  }
}

/**
 * The deployment's graph as every step sees it (`ctx.services.graph`):
 * reads that leave managed types out, the writers, the schemas' lookups and
 * `query`, which is refused while anything is managed. Each is a bound
 * method, so nothing reaches the engine, the driver, the config (its
 * credentials) or the unfiltered reader. Strut's own `graph/*` steps get the
 * backend behind it (`rawGraphOf`, through `graphCtx`) and filter by
 * caller; a manager's steps get their key where the host wires them.
 */
export interface GraphView {
  readonly kind: GraphBackend["kind"];
  readonly namespace: string;
  readonly reader: GraphReader;
  readonly nodes: Pick<NodeWriter, "write" | "writeMany" | "update" | "softDelete" | "deleteNode">;
  readonly edges: Pick<EdgeWriter, "write" | "writeMany" | "update" | "delete" | "move">;
  readonly schemas: Pick<SchemaResolver, "schema" | "resolveType" | "managedTypes">;
  query(cypher: string, params?: Params): Promise<Row[]>;
  /** A no-op: the backend is the server's, shared with the workspace. */
  close(): Promise<void>;
}

const behind = new WeakMap<object, GraphBackend>();

function bound<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Pick<T, K> {
  return Object.freeze(Object.fromEntries(keys.map((k) => [k, (o[k] as (...a: unknown[]) => unknown).bind(o)]))) as Pick<T, K>;
}

export function graphView(raw: GraphBackend): GraphView {
  const filter = new ManagedReadFilter(raw.reader, raw.schemas);
  const reads = Object.getOwnPropertyNames(ManagedReadFilter.prototype).filter((k) => k !== "constructor" && k !== "managed") as Array<keyof GraphReader>;
  const view: GraphView = Object.freeze({
    kind: raw.kind,
    namespace: raw.namespace,
    reader: bound(filter, reads) as GraphReader,
    nodes: bound(raw.nodes, ["write", "writeMany", "update", "softDelete", "deleteNode"] as const),
    edges: bound(raw.edges, ["write", "writeMany", "update", "delete", "move"] as const),
    schemas: bound(raw.schemas, ["schema", "resolveType", "managedTypes"] as const),
    async query(cypher: string, params?: Params) {
      if ((await raw.schemas.managedTypes()).size) throw new ManagedReadRefused();
      return raw.query(cypher, params);
    },
    close: async () => undefined,
  });
  behind.set(view, raw);
  return view;
}

/** The backend behind a `graphView`, for strut's own graph steps; undefined
 *  for anything else (a backend handed in as it is, in tests). Not exported
 *  from the package. */
export function rawGraphOf(g: unknown): GraphBackend | undefined {
  return g && typeof g === "object" ? behind.get(g) : undefined;
}
