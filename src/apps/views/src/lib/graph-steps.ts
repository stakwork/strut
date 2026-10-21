// The graph as strut/views reads it — three registry steps through the one
// client, on the importing app's grants (`grants.steps`):
//   graph/graph-get-batched  up to 50 nodes by ref_id: type, name, properties, edge counts
//   graph/graph-neighbors    one node's neighbours, each with its edge and direction
//   graph/graph-search       hybrid search: hits with name, type, description
// The same steps on a Neo4j and on a Ladybug file.
import type { StrutClient } from "@strut/kit";

export const GET_BATCHED = "graph/graph-get-batched";
export const NEIGHBORS = "graph/graph-neighbors";
export const SEARCH = "graph/graph-search";
/** graph-get-batched's cap per call. */
export const BATCH_MAX = 50;

export interface GraphNode {
  ref_id: string;
  node_type: string;
  name: string;
  properties: Record<string, unknown>;
  /** `{ EDGE_TYPE: count }`. */
  edges: Record<string, number>;
}

export interface GraphNeighbor {
  ref_id: string;
  node_type: string;
  name: string;
  edge_type: string;
  /** forward: the asked node → this one. */
  direction: "forward" | "reverse";
  edges: Record<string, number>;
}

export interface GraphHit {
  ref_id: string;
  node_type: string;
  name: string;
  description?: string;
  edges?: Record<string, number>;
  file?: string;
}

/** A graph step answers a problem as a string (no graph wired, a bad
 *  argument) instead of throwing: make it one. */
export function answer<T>(step: string, v: unknown): T {
  if (typeof v === "string") throw new Error(`${step}: ${v}`);
  return v as T;
}

/** The embedding vectors are numbers no reader wants. */
export function readableProperties(p: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p ?? {})) if (!/embeddings?$/.test(k)) out[k] = v;
  return out;
}

/** Nodes by ref_id, in batches of 50; one that is gone comes back as `{ ref_id, error }`. */
export async function getNodes(client: StrutClient, refIds: string[]): Promise<Map<string, GraphNode | { ref_id: string; error: string }>> {
  const out = new Map<string, GraphNode | { ref_id: string; error: string }>();
  const unique = [...new Set(refIds)];
  for (let i = 0; i < unique.length; i += BATCH_MAX) {
    const r = answer<{ nodes: Array<GraphNode | { ref_id: string; error: string }> }>(GET_BATCHED, await client.run(GET_BATCHED, { ref_ids: unique.slice(i, i + BATCH_MAX) }));
    for (const n of r.nodes ?? []) out.set(n.ref_id, "error" in n ? n : { ...n, properties: readableProperties(n.properties) });
  }
  return out;
}

export async function getNeighbors(client: StrutClient, refId: string, opts: { edgeTypes?: string[]; nodeTypes?: string[] } = {}): Promise<GraphNeighbor[]> {
  const config: Record<string, unknown> = { ref_id: refId };
  if (opts.edgeTypes?.length) config["edge_type"] = opts.edgeTypes;
  if (opts.nodeTypes?.length) config["node_type"] = opts.nodeTypes;
  return answer<GraphNeighbor[]>(NEIGHBORS, await client.run(NEIGHBORS, config)) ?? [];
}

