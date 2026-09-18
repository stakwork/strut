import { describe, it } from "node:test";
import assert from "node:assert/strict";
// The server's own walk + tool bridge produce the events folded here, so a
// change to the hop event shape that would blind the graph fails here.
import { walkProgress } from "../../src/ai/walk-tool.js";
import type { NodeEnvelope } from "../../src/graph/search.js";
import type { Evaluate, EvalAnswer } from "../../src/evaluate.js";
import type { WalkReader } from "../../src/steps/lib/graph/walk.js";
import { foldWalk, hopEvents, verdictOf, walkSummary } from "./walk-graph";

// wf ←VERSION_OF─ v1 ; cl ─ABOUT→ v1 ; cl ─EVIDENCED_BY{-1}→ e1, e2 (same claim + verdict → e2 folds into e1) ;
// cl ─EVIDENCED_BY{1}→ e3 ; noise ─VERSION_OF→ wf (dropped)
const node = (ref_id: string, node_type: string, properties: Record<string, unknown>): NodeEnvelope => ({ ref_id, node_type, properties });
const NODES: Record<string, NodeEnvelope> = {
  wf: node("wf", "StrutWorkflow", { name: "youtube-clip" }),
  v1: node("v1", "StrutWorkflowVersion", { name: "youtube-clip@1" }),
  noise: node("noise", "StrutWorkflowVersion", { name: "noise" }),
  cl: node("cl", "Claim", { name: "quote is in the transcript" }),
  e1: node("e1", "Evidence", { name: "quote is in the transcript", content: "quote not in transcript" }),
  e2: node("e2", "Evidence", { name: "quote is in the transcript", content: "quote not in transcript" }),
  e3: node("e3", "Evidence", { name: "quote is in the transcript", content: "found at 01:02" }),
};
const EDGES: Array<[string, string, string, Record<string, unknown>?]> = [
  ["v1", "VERSION_OF", "wf"],
  ["noise", "VERSION_OF", "wf"],
  ["cl", "ABOUT", "v1"],
  ["cl", "EVIDENCED_BY", "e1", { strength: -1 }],
  ["cl", "EVIDENCED_BY", "e2", { strength: -1 }],
  ["cl", "EVIDENCED_BY", "e3", { strength: 1 }],
];
const reader: WalkReader = {
  async getNode(id) {
    return NODES[id] ?? null;
  },
  async neighbors(id, p) {
    const edges = EDGES.filter(([s, e, t]) => (s === id || t === id) && (!p?.edge_types || p.edge_types.includes(e)));
    return {
      nodes: [...new Set(edges.flatMap(([s, , t]) => [s, t]))].map((i) => NODES[i]!),
      edges: edges.map(([s, e, t, props]) => ({ source: s, target: t, ref_id: `${s}|${e}|${t}`, edge_type: e, properties: props ?? {} })),
    };
  },
  async search() {
    return { nodes: [NODES["wf"]!], total: 1, truncated: false };
  },
};
// Everything relevant but `noise`; expand the first option; never sufficient.
const evaluate: Evaluate = async ({ state, questions }) => {
  const answers: Record<string, EvalAnswer> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (id.startsWith("relevant_")) {
      const c = (state as any).candidates.find((x: any) => x.id === id.slice("relevant_".length));
      answers[id] = { type: "boolean", probability: c.name === "noise" ? 0.1 : 0.9 };
    } else if (q.type === "choice") answers[id] = { type: "choice", choice: Object.keys(q.criteria).find((k) => k !== "none") ?? "none" };
    else answers[id] = { type: "boolean", probability: 0 };
  }
  return { answers: answers as any, usage: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, totalTokens: 2 } };
};

async function walkOutputs(): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const p of walkProgress({ goal: "does it work?", query: "youtube-clip", maxHops: 12, maxNodes: 25, threshold: 0.7 }, { reader, evaluate })) out.push(p);
  return out;
}

describe("foldWalk", () => {
  it("grows the walk graph: seeds, edges by arrival, verdicts, merged evidence, refutes", async () => {
    const outputs = await walkOutputs();
    const s = foldWalk(outputs);
    assert.equal(s.done, true);
    assert.equal(s.stopped, "exhausted");
    // Insertion order = discovery order; e2 folded into e1, never a node.
    assert.deepEqual([...s.nodes.keys()], ["wf", "v1", "noise", "cl", "e1", "e3"]);
    assert.equal(s.nodes.get("wf")!.via, undefined);
    assert.deepEqual(s.edges.find((e) => e.target === "cl"), { source: "v1", target: "cl", type: "ABOUT" });
    assert.equal(s.edges.length, 5); // every non-seed node, one edge each
    assert.equal(s.nodes.get("noise")!.state, "dropped");
    assert.equal(s.nodes.get("cl")!.state, "kept");
    assert.equal(s.nodes.get("cl")!.relevance, 0.9);
    assert.equal(s.nodes.get("e1")!.verdict, "refutes");
    assert.equal(s.nodes.get("e1")!.mergedCount, 1);
    assert.equal(s.nodes.get("e3")!.verdict, "supports");
    // The final result carries kept nodes' properties.
    assert.equal(s.nodes.get("v1")!.properties?.["name"], "youtube-clip@1");
    assert.match(walkSummary(s, false), /^hop \d+ · 5 kept$/);
  });

  it("a prefix folds to the walk so far: current, next, live header", async () => {
    const outputs = await walkOutputs();
    // Through hop 1's step.end: wf's neighbors judged, next chosen.
    const s = foldWalk(outputs.slice(0, 4));
    assert.equal(s.done, false);
    assert.equal(s.hop, 1);
    assert.equal(s.current, "wf");
    assert.equal(s.next, "v1");
    assert.deepEqual([...s.nodes.keys()], ["wf", "v1", "noise"]);
    assert.equal(walkSummary(s, true), "hop 2 · 2 kept · walking…");
    assert.equal(hopEvents(outputs), outputs.length - 1);
  });

  it("reads the verdict from the edge strength, else the label", () => {
    assert.equal(verdictOf({ node_type: "Evidence", name: "supports (1): ok", via: { from: "c", edge_type: "EVIDENCED_BY", direction: "forward", properties: { strength: -0.5 } } }), "refutes");
    assert.equal(verdictOf({ node_type: "Evidence", name: "refutes (-1): nope" }), "refutes");
    assert.equal(verdictOf({ node_type: "Evidence", name: "no verdict: x" }), undefined);
    assert.equal(verdictOf({ node_type: "Claim", name: "refutes everything" }), undefined);
  });
});
