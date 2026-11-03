// The run graph's DATA PATH (plans/apps.md §3.3), in strut. Hive built the
// trace on its server — the run log from strut, the nodes through stakgraph's
// Cypher proxy. Here the page builds it, through the one client and on the
// importing app's grants:
//   - the calls: `run/events` → `projectWithLaunches` (the accessed-nodes
//     marker on each `step.end`, @strut/kit);
//   - the nodes: `graph/graph-get-batched`, 50 refs a call, on either engine;
//   - the edges among them and their lineage along PARENT_OF:
//     `graph/graph-edges`, a call per 1,000 nodes that have edges; an app
//     that has not granted it reads them as before, a `graph/graph-neighbors`
//     per node and up the PARENT_OF chain for the ancestors (bounded:
//     `MAX_NEIGHBOR_READS`);
//   - a child run: `run/events` of the run its launching call names (the
//     `runId` in that call's output), projected under the call's path;
//   - a peer-tagged ref: never read here — another strut's graph holds it.
// The reader is incremental: a live run, or an opened child, reads only refs
// it has not read before.
import {
  LINEAGE_EDGE_TYPE,
  parseQualifiedRef,
  type RunGraphEdge,
  type RunGraphNode,
  type RunGraphNodeBody,
  type RunGraphNodeRef,
  type RunGraphPeer,
  type RunGraphTrace,
} from "@strut/kit/folds";
import type { StrutClient } from "@strut/kit";
import { errorText } from "../../lib/format";
import { EDGES_IDS_MAX, getEdges, getNeighbors, getNodes, type GraphNode } from "../../lib/graph-steps";

/** The most nodes a trace resolves: a run of a workspace graph touches thousands, and the
 *  view folds what a cell cannot draw (`layoutRunGraph`'s fold). Hive's `RUN_GRAPH_MAX_NODES` was 1,000. */
export const MAX_NODES = 5000;
/** The most `graph-neighbors` calls one trace makes for edges and lineage, when it reads them that way. */
export const MAX_NEIGHBOR_READS = 240;
/** How far up PARENT_OF the lineage climbs. */
const MAX_LINEAGE_DEPTH = 10;
/** Calls in flight at once. */
const CONCURRENCY = 6;

const edgeKey = (e: RunGraphEdge) => `${e.source}|${e.edge_type}|${e.target}`;
/** A refusal that means the app reads edges the old way: it has not granted graph-edges (or the strut has none). */
const NO_EDGES_STEP = /not granted to this app|not in the gallery's fixtures|step type .* not found|unknown step/i;

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

export type TraceGraph = Omit<RunGraphTrace, "calls">;

export class RunGraphReader {
  private nodes = new Map<string, RunGraphNode>();
  private edges = new Map<string, RunGraphEdge>();
  readonly bodies = new Map<string, RunGraphNodeBody>();
  private touched = new Set<string>();
  private neighborsRead = new Set<string>();
  private peers = new Map<string, RunGraphPeer>();
  private reads = 0;
  /** Edges and lineage through graph-edges, until a refusal says this app reads them a node at a time. */
  private batched = true;
  private truncated = false;
  private unread: { nodes?: string; edges?: string; lineage?: string } = {};

  constructor(private readonly client: StrutClient) {}

  /** Read what has not been read of `refs`. */
  async read(refs: RunGraphNodeRef[]): Promise<void> {
    const local: RunGraphNodeRef[] = [];
    for (const ref of refs) {
      // Read once; an ancestor a call goes on to touch is read whole.
      const known = this.nodes.get(ref.ref_id);
      if (known && !(known.ancestor && !ref.peer && !this.touched.has(ref.ref_id))) continue;
      if (ref.peer) {
        // In a peer's graph: a ref means something only against the graph that recorded it.
        this.nodes.set(ref.ref_id, this.fromLog(ref));
        if (!this.peers.has(ref.peer)) this.peers.set(ref.peer, { slug: ref.peer, read: false, reason: "a peer's run touched it; its graph is read on that strut server" });
        continue;
      }
      if (this.touched.size + local.length >= MAX_NODES) {
        this.truncated = true;
        continue;
      }
      local.push(ref);
    }
    for (const r of local) this.touched.add(r.ref_id);
    if (!local.length) return;

    let found: Map<string, GraphNode | { ref_id: string; error: string }>;
    try {
      found = await getNodes(this.client, local.map((r) => r.ref_id));
      delete this.unread.nodes;
    } catch (e) {
      this.unread.nodes = errorText(e);
      for (const r of local) this.nodes.set(r.ref_id, this.fromLog(r));
      return;
    }
    const withEdges: string[] = [];
    for (const r of local) {
      const n = found.get(r.ref_id);
      if (!n || "error" in n) {
        this.nodes.set(r.ref_id, this.fromLog(r));
        continue;
      }
      this.nodes.set(r.ref_id, this.fromGraph(n));
      this.bodies.set(r.ref_id, { ref_id: r.ref_id, node_type: n.node_type, labels: [], properties: n.properties });
      if (Object.values(n.edges ?? {}).some((c) => c > 0)) withEdges.push(r.ref_id);
    }
    await this.readEdges(withEdges);
  }

  /** Each node's edges to other touched nodes, and its parents along PARENT_OF, climbed. */
  private async readEdges(ids: string[]): Promise<void> {
    if (this.batched) {
      try {
        return await this.readEdgesBatched(ids);
      } catch (e) {
        if (!NO_EDGES_STEP.test(errorText(e))) {
          this.unread.edges = errorText(e);
          return;
        }
        this.batched = false;
      }
    }
    await this.readNeighbors(ids);
  }

  /** graph-edges, a call per 1,000 nodes: their edges among everything touched so far, and the lineage above them. */
  private async readEdgesBatched(ids: string[]): Promise<void> {
    const fresh = ids.filter((id) => !this.neighborsRead.has(id));
    if (!fresh.length) return;
    const among = [...this.touched];
    const chunks: string[][] = [];
    for (let i = 0; i < fresh.length; i += EDGES_IDS_MAX) chunks.push(fresh.slice(i, i + EDGES_IDS_MAX));
    await pool(chunks, CONCURRENCY, async (chunk) => {
      const out = await getEdges(this.client, chunk, { among, lineage: LINEAGE_EDGE_TYPE, depth: MAX_LINEAGE_DEPTH });
      for (const id of chunk) this.neighborsRead.add(id);
      for (const a of out.ancestors) {
        if (!this.nodes.has(a.ref_id)) this.nodes.set(a.ref_id, { ref_id: a.ref_id, node_type: a.node_type, name: a.name || a.ref_id.slice(0, 8), namespace: null, found: true, ancestor: true });
      }
      for (const e of out.edges) this.edges.set(edgeKey(e), e);
      if (out.truncated) this.unread.edges ??= "the run's nodes have more edges among them than one read returns";
    });
  }

  /** The old way: a graph-neighbors per node, then up the lineage a node at a time. */
  private async readNeighbors(ids: string[]): Promise<void> {
    const parents: string[] = [];
    await pool(ids, CONCURRENCY, async (id) => {
      if (this.neighborsRead.has(id)) return;
      if (this.reads >= MAX_NEIGHBOR_READS) {
        this.unread.edges ??= `the run touched more nodes than ${MAX_NEIGHBOR_READS} reads of their neighbours cover`;
        return;
      }
      this.reads++;
      this.neighborsRead.add(id);
      try {
        for (const n of await getNeighbors(this.client, id)) {
          const [source, target] = n.direction === "forward" ? [id, n.ref_id] : [n.ref_id, id];
          const edge = { source, target, edge_type: n.edge_type };
          if (n.edge_type === LINEAGE_EDGE_TYPE && target === id) {
            this.edges.set(edgeKey(edge), edge);
            if (!this.nodes.has(source)) {
              this.nodes.set(source, { ref_id: source, node_type: n.node_type, name: n.name || source.slice(0, 8), namespace: null, found: true, ancestor: true });
              parents.push(source);
            }
          } else if (this.touched.has(n.ref_id)) {
            this.edges.set(edgeKey(edge), edge);
          }
        }
      } catch (e) {
        this.unread.edges = errorText(e);
      }
    });
    await this.climb(parents, 1);
  }

  /** Up the lineage from nodes no call touched: their own parents, to the root. */
  private async climb(ids: string[], depth: number): Promise<void> {
    if (!ids.length || depth >= MAX_LINEAGE_DEPTH) return;
    const next: string[] = [];
    await pool(ids, CONCURRENCY, async (id) => {
      if (this.neighborsRead.has(id) || this.reads >= MAX_NEIGHBOR_READS) return;
      this.reads++;
      this.neighborsRead.add(id);
      try {
        for (const n of await getNeighbors(this.client, id, { edgeTypes: [LINEAGE_EDGE_TYPE] })) {
          if (n.direction !== "reverse") continue;
          const edge = { source: n.ref_id, target: id, edge_type: LINEAGE_EDGE_TYPE };
          this.edges.set(edgeKey(edge), edge);
          if (this.nodes.has(n.ref_id)) continue;
          this.nodes.set(n.ref_id, { ref_id: n.ref_id, node_type: n.node_type, name: n.name || n.ref_id.slice(0, 8), namespace: null, found: true, ancestor: true });
          next.push(n.ref_id);
        }
      } catch (e) {
        this.unread.lineage = errorText(e);
      }
    });
    await this.climb(next, depth + 1);
  }

  private fromLog(ref: RunGraphNodeRef): RunGraphNode {
    return {
      ref_id: ref.ref_id,
      node_type: ref.node_type ?? "Node",
      name: ref.name ?? parseQualifiedRef(ref.ref_id).refId.slice(0, 8),
      namespace: null,
      found: false,
      ...(ref.peer ? { peer: ref.peer } : {}),
    };
  }

  private fromGraph(n: GraphNode): RunGraphNode {
    const ns = n.properties["namespace"];
    return { ref_id: n.ref_id, node_type: n.node_type, name: (n.name || n.ref_id.slice(0, 8)).slice(0, 160), namespace: typeof ns === "string" ? ns : null, found: true };
  }

  /** The trace as read so far. An ancestor a call later touched is not an ancestor. */
  snapshot(): TraceGraph {
    const nodes = [...this.nodes.values()].map((n): RunGraphNode => {
      if (!n.ancestor || !this.touched.has(n.ref_id)) return n;
      const { ancestor: _a, ...rest } = n;
      return rest;
    });
    const unreadReason = this.unread.nodes ?? this.unread.edges ?? this.unread.lineage;
    return {
      nodes,
      edges: [...this.edges.values()],
      nodesRead: this.unread.nodes === undefined,
      edgesRead: this.unread.edges === undefined,
      lineageRead: this.unread.lineage === undefined,
      ...(unreadReason ? { unreadReason } : {}),
      truncated: this.truncated,
      ...(this.peers.size ? { peers: [...this.peers.values()] } : {}),
    };
  }
}
