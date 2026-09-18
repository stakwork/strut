import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { NodeEnvelope } from "../graph/search.js";
import type { Evaluate, EvalAnswer } from "../evaluate.js";
import type { WalkReader } from "../steps/lib/graph/walk.js";
import { graphWalkTool, type WalkProgress } from "./walk-tool.js";
import { chatEventOf } from "../createStrut.js";

// OFFLINE: the graph_walk chat tool over an in-memory graph and a scripted
// decider (every candidate relevant, expand the first option, never sufficient).

const node = (ref_id: string, node_type: string, properties: Record<string, unknown>): NodeEnvelope => ({ ref_id, node_type, properties });
const NODES: Record<string, NodeEnvelope> = {
  wf: node("wf", "StrutWorkflow", { name: "youtube-clip", description: "Clips a quote from a video" }),
  v1: node("v1", "StrutWorkflowVersion", { name: "youtube-clip@1" }),
  run: node("run", "StrutRun", { run_id: "r-1", workflow_name: "youtube-clip", run_status: "error", summary: "x".repeat(5000) }),
};
const EDGES: Array<[string, string, string]> = [
  ["v1", "VERSION_OF", "wf"],
  ["run", "EXECUTED", "v1"],
];

const reader: WalkReader = {
  async getNode(id) {
    return NODES[id] ?? null;
  },
  async neighbors(id) {
    const edges = EDGES.filter(([s, , t]) => s === id || t === id);
    return {
      nodes: [...new Set(edges.flatMap(([s, , t]) => [s, t]))].map((i) => NODES[i]!),
      edges: edges.map(([s, e, t]) => ({ source: s, target: t, ref_id: `${s}|${e}|${t}`, edge_type: e, properties: {} })),
    };
  },
  async search() {
    return { nodes: [NODES["wf"]!], total: 1, truncated: false };
  },
};

const evaluate: Evaluate = async ({ questions }) => {
  const answers: Record<string, EvalAnswer> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (id.startsWith("relevant_")) answers[id] = { type: "boolean", probability: 0.9 };
    else if (q.type === "choice") answers[id] = { type: "choice", choice: Object.keys(q.criteria).find((k) => k !== "none") ?? "none" };
    else answers[id] = { type: "boolean", probability: 0 };
  }
  return { answers: answers as any, usage: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, totalTokens: 2 } };
};

async function collect(t: ReturnType<typeof graphWalkTool>, input: Record<string, unknown>): Promise<WalkProgress[]> {
  const out: WalkProgress[] = [];
  const it = t.execute!(input as any, { toolCallId: "tc1", messages: [] } as any) as AsyncIterable<WalkProgress>;
  for await (const p of it) out.push(p);
  return out;
}

describe("graph_walk chat tool", () => {
  it("yields one `walking` per hop event, then one `done` without the hop trace", async () => {
    let asked: unknown;
    const t = graphWalkTool({ reader, evaluate: async (o) => ((asked = o), { evaluate, name: "typesafe/jev-latest" }) });
    const out = await collect(t, { goal: "does youtube-clip work?", query: "youtube-clip", maxHops: 12, maxNodes: 25, model: "haiku" });
    assert.equal((asked as { model?: string }).model, "haiku");

    assert.deepEqual(out[0], { status: "start", decider: "typesafe/jev-latest" });
    const walking = out.filter((p) => p.status === "walking");
    const done = out.at(-1)!;
    assert.equal(done.status, "done");
    assert.equal(out.filter((p) => p.status === "done").length, 1);
    // wf (seed) → v1 → run → exhausted: 3 hops, a start and an end each.
    assert.deepEqual(
      walking.map((p) => (p.status === "walking" ? `${p.event.type}#${p.event.iteration}` : "")),
      ["step.start#0", "step.end#0", "step.start#1", "step.end#1", "step.start#2", "step.end#2"],
    );
    assert.ok(!("hops" in done));
    if (done.status === "done") {
      assert.deepEqual(done.nodes.map((n) => n.ref_id).sort(), ["run", "v1", "wf"]);
      assert.equal(done.decider, "typesafe/jev-latest");
    }
  });

  it("the model reads goal, stopped and clipped nodes — no hops, no usage", async () => {
    const t = graphWalkTool({ reader, evaluate: async () => ({ evaluate, name: "haiku" }) });
    const out = await collect(t, { goal: "g", query: "youtube-clip", maxHops: 12, maxNodes: 25 });
    const m = (await t.toModelOutput!({ toolCallId: "tc1", input: {} as any, output: out.at(-1)! })) as { type: string; value: any };
    assert.equal(m.type, "json");
    assert.deepEqual(Object.keys(m.value).sort(), ["decider", "goal", "nodes", "stopped"]);
    const run = m.value.nodes.find((n: any) => n.ref_id === "run");
    assert.equal(run.via, "EXECUTED (reverse) from v1");
    assert.ok(run.properties.summary.length < 700);
  });

  it("refuses a call with neither query nor start", async () => {
    const t = graphWalkTool({ reader, evaluate: async () => ({ evaluate, name: "haiku" }) });
    await assert.rejects(collect(t, { goal: "g", maxHops: 3, maxNodes: 5 }), /needs `query`/);
  });

  it("stops between hops when the chat turn is aborted", async () => {
    const ac = new AbortController();
    const t = graphWalkTool({ reader, evaluate: async () => ({ evaluate, name: "haiku" }) });
    const it = t.execute!({ goal: "g", query: "youtube-clip", maxHops: 12, maxNodes: 25 } as any, { toolCallId: "tc1", messages: [], abortSignal: ac.signal } as any) as AsyncIterable<WalkProgress>;
    const seen: WalkProgress[] = [];
    await assert.rejects(
      (async () => {
        for await (const p of it) {
          seen.push(p);
          ac.abort();
        }
      })(),
    );
    assert.ok(seen.length < 6);
  });
});

describe("chatEventOf", () => {
  it("maps a preliminary tool-result to tool-progress and the final one to tool-output", () => {
    const part = { type: "tool-result", toolName: "graph_walk", toolCallId: "tc1", output: { status: "walking" } };
    assert.deepEqual(chatEventOf({ ...part, preliminary: true }), { type: "tool-progress", toolName: "graph_walk", toolCallId: "tc1", output: { status: "walking" } });
    assert.equal(chatEventOf(part)!.type, "tool-output");
    assert.equal(chatEventOf({ type: "text-delta", text: "" }), null);
    assert.deepEqual(chatEventOf({ type: "tool-error", toolName: "x", toolCallId: "t", error: new Error("boom") }), {
      type: "tool-output",
      toolName: "x",
      toolCallId: "t",
      output: "boom",
      isError: true,
    });
  });
});
