// The graph nodes one step of a run read or wrote, folded from the run's
// events: the `nodes` on each `step.end` (the provenance marker — a node the
// caller NAMED, never a search hit; `withAccessedNodes` in src/core.ts) at the
// step's path and under it, which is where an agent's tool calls are.
// Pure: the flyout re-folds as a live run appends events.

export interface AccessedNode {
  ref_id: string;
  node_type?: string;
  name?: string;
}

interface NodeEvent {
  type: string;
  path: string;
  ts: string;
  stepType?: string;
  nodes?: AccessedNode[];
}

export interface NodeTouch {
  /** The step type that touched it, without `tool:`. */
  tool: string;
  path: string;
  ts: string;
}

export interface TouchedNode extends AccessedNode {
  /** Every call that touched it, in log order. */
  touches: NodeTouch[];
}

/** The type the list opens on. */
export const DEFAULT_NODE_TYPE = "Concept";
/** The filter that shows every node, typed or not. */
export const ALL_NODE_TYPES = "*";

/** Nodes touched at `stepPath` and below, in the order first touched. A node
 *  takes the type and name of the LATEST call that reported them. */
export function foldAccessedNodes(events: NodeEvent[], stepPath: string): TouchedNode[] {
  const byRef = new Map<string, TouchedNode>();
  for (const e of events) {
    if (e.type !== "step.end" || !Array.isArray(e.nodes)) continue;
    if (e.path !== stepPath && !e.path.startsWith(`${stepPath}/`)) continue;
    const tool = (e.stepType ?? "").replace(/^tool:/, "");
    for (const n of e.nodes) {
      if (!n || typeof n.ref_id !== "string" || !n.ref_id) continue;
      let node = byRef.get(n.ref_id);
      if (!node) byRef.set(n.ref_id, (node = { ref_id: n.ref_id, touches: [] }));
      if (n.node_type) node.node_type = n.node_type;
      if (n.name) node.name = n.name;
      node.touches.push({ tool, path: e.path, ts: e.ts });
    }
  }
  return [...byRef.values()];
}

/** How many nodes of each type, most first; untyped nodes count under "". */
export function nodeTypeCounts(nodes: TouchedNode[]): Array<{ type: string; count: number }> {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.node_type ?? "", (counts.get(n.node_type ?? "") ?? 0) + 1);
  return [...counts].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

export function filterNodes(nodes: TouchedNode[], type: string): TouchedNode[] {
  return type === ALL_NODE_TYPES ? nodes : nodes.filter((n) => (n.node_type ?? "") === type);
}

/** "graph-get ×2 · edit-node": the calls that touched a node, by tool, in
 *  the order each tool first did. The namespace is dropped (`graph/`). */
export function touchSummary(touches: NodeTouch[]): string {
  const counts = new Map<string, number>();
  for (const t of touches) {
    const tool = t.tool.slice(t.tool.lastIndexOf("/") + 1) || "step";
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  return [...counts].map(([tool, n]) => (n > 1 ? `${tool} ×${n}` : tool)).join(" · ");
}

/** What a row shows for a node: its name, else a short ref. */
export function nodeLabel(n: AccessedNode): string {
  return n.name || n.ref_id.slice(0, 8);
}
