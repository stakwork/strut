import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ALL_NODE_TYPES, DEFAULT_NODE_TYPE, filterNodes, foldAccessedNodes, nodeLabel, nodeTypeCounts, touchSummary } from "./accessed-nodes";
import { withAccessedNodes, accessedNodesOf } from "../../src/core.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const ev = (i: number, type: string, path: string, extra: Record<string, unknown> = {}) => ({
  ts: new Date(Date.UTC(2026, 8, 1, 20, 0, i)).toISOString(),
  runId: "1",
  type,
  path,
  ...extra,
});

/** One agent step (`wf/plan`) with four tool calls, beside another agent. */
const events = [
  ev(0, "step.start", "wf/plan", { stepType: "agent" }),
  ev(1, "step.end", "wf/plan/001-graph_graph_search", { stepType: "tool:graph/graph-search", output: "[…]" }),
  ev(2, "step.end", "wf/plan/002-graph_graph_get", { stepType: "tool:graph/graph-get", nodes: [{ ref_id: A, node_type: "Concept", name: "Billing" }] }),
  ev(3, "step.end", "wf/plan/003-graph_edit_node", { stepType: "tool:graph/edit-node", nodes: [{ ref_id: A, node_type: "Concept", name: "Billing & invoices" }] }),
  ev(4, "step.end", "wf/plan/004-graph_move_node", { stepType: "tool:graph/move-node", nodes: [{ ref_id: B, node_type: "Feature" }, { ref_id: C }, { ref_id: A }] }),
  ev(5, "step.end", "wf/plan/005-graph_graph_get", { stepType: "tool:graph/graph-get", nodes: [{ ref_id: A, node_type: "Concept", name: "Billing & invoices" }] }),
  ev(6, "step.end", "wf/plan", { stepType: "agent", output: { result: "ok" } }),
  ev(7, "step.end", "wf/planner/001-graph_graph_get", { stepType: "tool:graph/graph-get", nodes: [{ ref_id: C, node_type: "Concept", name: "Other agent's" }] }),
];

describe("foldAccessedNodes", () => {
  const nodes = foldAccessedNodes(events, "wf/plan");

  it("folds the step's tool calls, in the order first touched, never a sibling step's", () => {
    assert.deepEqual(
      nodes.map((n) => [n.ref_id, n.node_type, n.name, n.touches.length]),
      [
        [A, "Concept", "Billing & invoices", 4],
        [B, "Feature", undefined, 1],
        [C, undefined, undefined, 1],
      ],
    );
    assert.deepEqual(nodes[0]!.touches.map((t) => t.path.slice("wf/plan/".length)), ["002-graph_graph_get", "003-graph_edit_node", "004-graph_move_node", "005-graph_graph_get"]);
  });

  it("a graph step run by the workflow itself reports on its own event", () => {
    const own = foldAccessedNodes([ev(0, "step.end", "wf/read", { stepType: "graph/graph-get", nodes: [{ ref_id: A, node_type: "Concept", name: "Billing" }] })], "wf/read");
    assert.deepEqual(own.map((n) => [n.name, touchSummary(n.touches)]), [["Billing", "graph-get"]]);
  });

  it("a node another strut's run touched keeps its peer tag", () => {
    const far = foldAccessedNodes(
      [ev(0, "step.end", "wf/ask", { stepType: "strut/run-workflow", nodes: [{ ref_id: A, node_type: "Concept", name: "Billing", peer: "cloud" }, { ref_id: B }] })],
      "wf/ask",
    );
    assert.deepEqual(far.map((n) => [n.ref_id, n.peer]), [[A, "cloud"], [B, undefined]]);
  });

  it("a sub-agent's reads are under the agent that called it", () => {
    const sub = foldAccessedNodes([ev(0, "step.end", "wf/plan/003-agent/001-graph_graph_get", { stepType: "tool:graph/graph-get", nodes: [{ ref_id: A }] })], "wf/plan");
    assert.equal(sub.length, 1);
  });

  it("counts types, filters by one, and says which tools touched a node", () => {
    assert.deepEqual(nodeTypeCounts(nodes), [{ type: "", count: 1 }, { type: "Concept", count: 1 }, { type: "Feature", count: 1 }]);
    assert.deepEqual(filterNodes(nodes, DEFAULT_NODE_TYPE).map((n) => n.ref_id), [A]);
    assert.deepEqual(filterNodes(nodes, ALL_NODE_TYPES).length, 3);
    assert.deepEqual(filterNodes(nodes, "").map((n) => n.ref_id), [C]);
    assert.equal(touchSummary(nodes[0]!.touches), "graph-get ×2 · edit-node · move-node");
    assert.deepEqual(nodes.map(nodeLabel), ["Billing & invoices", "22222222", "33333333"]);
  });

  it("reads what the engine writes: the marker's entries are the event's `nodes`", () => {
    const marked = withAccessedNodes({ ok: true }, [{ ref_id: A, node_type: "Concept", name: " Billing " }, { ref_id: A }, { ref_id: B }]);
    const [first] = foldAccessedNodes([ev(0, "step.end", "wf/read", { stepType: "graph/graph-get", nodes: accessedNodesOf(marked) })], "wf/read");
    assert.deepEqual([first!.ref_id, first!.node_type, first!.name], [A, "Concept", "Billing"]);
  });
});
