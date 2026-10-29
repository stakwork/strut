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
 *   - counts: edges to a managed node are not counted.
 *
 * Until a Schema names a manager every call goes straight through.
 * `withoutManagedRows` is the same for raw Cypher rows (`graph_query`,
 * `graph/query`): a row holding a managed node, by its `node_type` or its
 * label, is dropped. An aggregate over managed nodes still passes —
 * accepted on a personal graph.
 *
 * No runtime imports: the steps load this beside `graphCtx`.
 */
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
  listSchemas(opts?: { domains?: string[]; includeDeleted?: boolean }): Promise<{ schemas: SchemaEnvelope[]; edges: OntologyEdge[] }> {
    return this.inner.listSchemas(opts);
  }
  getSchema(type: string): Promise<SchemaEnvelope | null> {
    return this.inner.getSchema(type);
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

/** Does `v` hold a node of a hidden type: a Ladybug node struct (its
 *  `node_type`), a Neo4j node (`labels`), at any depth? */
function holdsHidden(v: unknown, hidden: ReadonlySet<string>): boolean {
  if (Array.isArray(v)) return v.some((x) => holdsHidden(x, hidden));
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o["node_type"] === "string" && hidden.has(o["node_type"].toLowerCase())) return true;
  if (Array.isArray(o["labels"]) && o["labels"].some((l) => typeof l === "string" && hidden.has(l.toLowerCase()))) return true;
  return Object.values(o).some((x) => holdsHidden(x, hidden));
}

/** Raw query rows without the ones that hold a managed node. */
export function withoutManagedRows<R extends Record<string, unknown>>(rows: R[], managed: ReadonlyMap<string, string>): R[] {
  if (!managed.size) return rows;
  const hidden = lower(managed);
  return rows.filter((r) => !holdsHidden(r, hidden));
}
