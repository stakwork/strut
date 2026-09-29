import { useState } from "preact/hooks";
import * as api from "../api";
import { errorMessage } from "../helpers";
import { nodeTypeFilter } from "../storage";
import { ALL_NODE_TYPES, filterNodes, nodeLabel, nodeTypeCounts, touchSummary, type TouchedNode } from "../accessed-nodes";
import { ValueFields } from "./ValueFields";

// ── The Nodes section of the run flyout ────────────────────────────────────
//
// The graph nodes a step chose to read or write, from the run log (which
// node, its type, its name, which calls). Filtered to one node type —
// Concept until the user picks another. A row opens the node's content in
// place, read from the graph as it is NOW: the log never held it.

type Loaded = { node: api.GraphNode } | { error: string } | "loading";

export function AccessedNodes(props: { nodes: TouchedNode[] }) {
  const [filter, setFilter] = useState(nodeTypeFilter.get);
  const [open, setOpen] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});

  const pick = (type: string) => {
    nodeTypeFilter.set(type);
    setFilter(type);
  };
  const toggle = (refId: string) => {
    if (open === refId) return setOpen(null);
    setOpen(refId);
    if (loaded[refId] && loaded[refId] !== "loading") return;
    setLoaded((l) => ({ ...l, [refId]: "loading" }));
    api.getGraphNode(refId).then(
      (node) => setLoaded((l) => ({ ...l, [refId]: { node } })),
      (err) => setLoaded((l) => ({ ...l, [refId]: { error: errorMessage(err) } })),
    );
  };

  const counts = nodeTypeCounts(props.nodes);
  // The chosen type keeps its chip when this step touched none of it.
  const chips = counts.some((c) => c.type === filter) || filter === ALL_NODE_TYPES ? counts : [{ type: filter, count: 0 }, ...counts];
  const shown = filterNodes(props.nodes, filter);

  return (
    <div class="flyout-section">
      <div class="flyout-section-title">Nodes</div>
      <div class="nodes-filter">
        {chips.map((c) => (
          <button key={c.type} class={`nodes-chip${c.type === filter ? " is-active" : ""}`} onClick={() => pick(c.type)}>
            {c.type || "untyped"} <span class="nodes-chip-count">{c.count}</span>
          </button>
        ))}
        <button class={`nodes-chip${filter === ALL_NODE_TYPES ? " is-active" : ""}`} onClick={() => pick(ALL_NODE_TYPES)}>
          All <span class="nodes-chip-count">{props.nodes.length}</span>
        </button>
      </div>
      {shown.length === 0 && <div class="nodes-empty">No {filter || "untyped"} nodes were read or written.</div>}
      {shown.map((n) => {
        const state = open === n.ref_id ? loaded[n.ref_id] : undefined;
        return (
          <div key={n.ref_id} class={`node-row${open === n.ref_id ? " is-open" : ""}`}>
            <button class="node-row-head" onClick={() => toggle(n.ref_id)} aria-expanded={open === n.ref_id}>
              <span class="node-row-name">{nodeLabel(n)}</span>
              {filter === ALL_NODE_TYPES && n.node_type && <span class="node-row-type">{n.node_type}</span>}
              <span class="node-row-tools">{touchSummary(n.touches)}</span>
            </button>
            {state !== undefined && (
              <div class="node-row-body">
                {state === "loading" && <div class="nodes-empty">Loading…</div>}
                {state !== "loading" && "error" in state && <div class="nodes-empty">{state.error}</div>}
                {state !== "loading" && "node" in state && <ValueFields value={{ ...state.node.properties, ref_id: state.node.ref_id }} blockClass="flyout-json node-content" />}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
