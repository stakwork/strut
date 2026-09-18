import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accessedNodesOf, type StepContext } from "../../../core.js";
import type { NodeEnvelope, NeighborsParams, SearchParams } from "../../../graph/search.js";
import type { Evaluate, EvalAnswer, EvalQuestion } from "../../../evaluate.js";
import walk, { runWalk, type WalkReader } from "./walk.js";

// OFFLINE: the walk over an in-memory graph and a scripted decider — no
// Neo4j, no model. The live counterpart (real reader, scripted decider) is
// in graph-steps.test.ts.

// wf ←VERSION_OF─ v1, v2 ; wf ─USES_STEP→ st ; run ─EXECUTED→ v2
const LONG = "timeout after 30s ".repeat(200); // > PROPERTY_MAX
const node = (ref_id: string, node_type: string, properties: Record<string, unknown>): NodeEnvelope => ({ ref_id, node_type, properties });
const GRAPH = {
  nodes: {
    wf: node("wf", "StrutWorkflow", { name: "deliver", description: "Delivers legal memos nightly" }),
    v1: node("v1", "StrutWorkflowVersion", { name: "deliver@1", content_hash: "c-1" }),
    v2: node("v2", "StrutWorkflowVersion", { name: "deliver@2", content_hash: "c-2" }),
    st: node("st", "StrutStep", { name: "harvey/fetch-docs", docs: "Fetches documents from the DMS" }),
    run: node("run", "StrutRun", { run_id: "run-9", status: "error", error: LONG }),
  } as Record<string, NodeEnvelope>,
  edges: [
    ["v1", "VERSION_OF", "wf"],
    ["v2", "VERSION_OF", "wf"],
    ["wf", "USES_STEP", "st"],
    ["run", "EXECUTED", "v2"],
  ] as Array<[string, string, string]>,
};

function fakeReader() {
  const calls = { neighbors: [] as Array<[string, NeighborsParams | undefined]>, search: [] as SearchParams[] };
  const reader: WalkReader = {
    async getNode(id) {
      return GRAPH.nodes[id] ?? null;
    },
    async neighbors(id, p) {
      calls.neighbors.push([id, p]);
      const edges = GRAPH.edges.filter(([s, e, t]) => (s === id || t === id) && (!p?.edge_types || p.edge_types.includes(e)));
      const ids = [...new Set(edges.flatMap(([s, , t]) => [s, t]))];
      return {
        nodes: ids.map((i) => ({ ...GRAPH.nodes[i]!, edges: { X: 1 } })),
        edges: edges.map(([s, e, t]) => ({ source: s, target: t, ref_id: `${s}|${e}|${t}`, edge_type: e, properties: {} })),
      };
    },
    async search(p) {
      calls.search.push(p);
      return { nodes: [GRAPH.nodes["wf"]!], total: 1, truncated: false };
    },
  };
  return { reader, calls };
}

/** A decider driven by a per-hop script: relevance by candidate, which
 *  option to expand next, and how sufficient the bundle is. Defaults: every
 *  candidate relevant (0.9), expand the first option offered (a new candidate
 *  before the frontier), not sufficient. */
interface HopScript {
  relevant?: (c: { id: string; type: string; name: string }) => number;
  next?: string;
  /** Per-option probabilities for `next`, keyed by option key (what an evaluation model reports). */
  nextProbabilities?: Record<string, number>;
  sufficient?: number;
}
function scripted(script: (hop: number, state: any, questions: Record<string, EvalQuestion>) => HopScript) {
  const calls: Array<{ state: any; questions: Record<string, EvalQuestion> }> = [];
  const evaluate: Evaluate = async ({ state, questions }) => {
    const hop = calls.length;
    calls.push({ state, questions });
    const s = script(hop, state, questions);
    const answers: Record<string, EvalAnswer> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (id.startsWith("relevant_")) {
        const cand = (state as any).candidates.find((c: any) => c.id === id.slice("relevant_".length));
        answers[id] = { type: "boolean", probability: s.relevant ? s.relevant(cand) : 0.9 };
      } else if (id === "next" && q.type === "choice") {
        const keys = Object.keys(q.criteria);
        answers[id] = {
          type: "choice",
          choice: s.next ?? keys.find((k) => k !== "none") ?? "none",
          ...(s.nextProbabilities ? { probabilities: s.nextProbabilities } : {}),
        };
      } else if (id === "sufficient") {
        answers[id] = { type: "boolean", probability: s.sufficient ?? 0 };
      }
    }
    return { answers: answers as any, usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10, totalTokens: 110 } };
  };
  return { evaluate, calls };
}

function ctxWithEvents() {
  const events: any[] = [];
  const ctx = {
    runId: "r1", path: "wf/gather", scope: {}, input: undefined,
    emit: async (e: any) => { events.push(e); },
    services: undefined,
  } as unknown as StepContext;
  return { ctx, events };
}

const BASE = { goal: "why is deliver failing?", maxHops: 12, maxNodes: 25, threshold: 0.5 };

describe("graph/walk: runWalk (offline)", () => {
  it("seeds from start, keeps by threshold, orders by relevance, stops when sufficient", async () => {
    const { reader } = fakeReader();
    const rel: Record<string, number> = { wf: 0.95, v1: 0.3, v2: 0.9, st: 0.7, run: 0.8 };
    const { evaluate, calls } = scripted((hop, state) => ({
      relevant: (c) => rel[state.candidates.find((x: any) => x.id === c.id).name === "deliver" ? "wf" : nameToId(c.name)]!,
      // hop 1 sees wf's neighbors; expand v2 (deliver@2) so hop 2 sees the run
      next: hop === 1 ? optionFor(state, "deliver@2") : undefined,
      nextProbabilities: hop === 1 ? { c0: 0.1, c1: 0.8, c2: 0.05, none: 0.05 } : undefined,
      sufficient: hop === 2 ? 0.9 : 0,
    }));
    const { ctx, events } = ctxWithEvents();

    const out = await runWalk({ ...BASE, start: ["wf"] }, { reader, evaluate, ctx });

    assert.equal(out.stopped, "sufficient");
    assert.deepEqual(out.nodes.map((n) => [n.ref_id, n.relevance, n.hop]), [["wf", 0.95, 0], ["v2", 0.9, 1], ["run", 0.8, 2], ["st", 0.7, 1]], "kept, most relevant first; v1 (0.3) dropped");
    assert.deepEqual(out.nodes[1]!.via, { from: "wf", edge_type: "VERSION_OF", direction: "reverse" });
    assert.deepEqual(out.nodes[2]!.via, { from: "v2", edge_type: "EXECUTED", direction: "reverse" });
    assert.equal(out.nodes[0]!.via, undefined, "a seed has no via");
    assert.equal((out.nodes[2]!.properties["error"] as string).length, 2001, "long property clipped for the bundle");
    assert.deepEqual(out.hops.map((h) => [h.hop, h.expanded?.ref_id, h.candidates, h.kept, h.next?.ref_id, h.sufficient]), [
      [0, undefined, 1, ["wf"], "wf", 0],
      [1, "wf", 3, ["v2", "st"], "v2", 0],
      [2, "v2", 1, ["run"], "run", 0.9],
    ]);
    assert.deepEqual(out.hops[1]!.verdicts, [
      { ref_id: "v1", relevance: 0.3, kept: false },
      { ref_id: "v2", relevance: 0.9, kept: true },
      { ref_id: "st", relevance: 0.7, kept: true },
    ], "every candidate judged, with the verdict");
    assert.deepEqual(out.hops[1]!.next_probabilities, { v1: 0.1, v2: 0.8, st: 0.05, none: 0.05 }, "option keys mapped back to ref_ids");
    assert.equal(out.hops[0]!.next_probabilities, undefined, "absent when the decider reports none");
    assert.equal(out.usage.inputTokens, 300, "usage accumulates over the three decisions");

    // The decider's view: hop 2 offers the new candidate first, then the frontier's best, then none.
    const q2 = calls[2]!.questions["next"] as any;
    assert.deepEqual(Object.keys(q2.criteria), ["c0", "f0", "f1", "none"]);
    assert.match(q2.criteria.c0, /^StrutRun: run-9 \(via EXECUTED, reverse\)/);
    assert.deepEqual(calls[2]!.state.frontier.map((f: any) => [f.name, f.relevance]), [["harvey/fetch-docs", 0.7], ["deliver@1", 0.3]]);
    assert.deepEqual(calls[2]!.state.gathered.map((g: any) => g.name), ["deliver", "deliver@2", "harvey/fetch-docs"]);
    assert.deepEqual(calls[2]!.state.expanded, { type: "StrutWorkflowVersion", name: "deliver@2", snippet: "" });
    assert.deepEqual(calls[1]!.state.candidates[0], { id: "c0", type: "StrutWorkflowVersion", name: "deliver@1", via: "VERSION_OF (reverse)", connections: { X: 1 }, snippet: "" });

    // Provenance: expanded + kept, deduped.
    assert.deepEqual(accessedNodesOf(out)!.map((n) => n.ref_id), ["wf", "v2", "run", "st"]);

    // One nested span per hop, under the step's path, carrying the nodes it read.
    assert.deepEqual(events.map((e) => [e.type, e.path]), [
      ["step.start", "wf/gather/001-hop"], ["step.end", "wf/gather/001-hop"],
      ["step.start", "wf/gather/002-hop"], ["step.end", "wf/gather/002-hop"],
      ["step.start", "wf/gather/003-hop"], ["step.end", "wf/gather/003-hop"],
    ]);
    assert.equal(events[2].stepType, "walk:hop");
    assert.deepEqual([events[2].iteration, events[3].iteration], [1, 1]);
    // step.start: the subgraph this hop discovered — each candidate with the edge it arrived by.
    assert.deepEqual(events[2].input, {
      hop: 1,
      expanded: { ref_id: "wf", node_type: "StrutWorkflow", name: "deliver" },
      candidates: [
        { ref_id: "v1", node_type: "StrutWorkflowVersion", name: "deliver@1", via: { from: "wf", edge_type: "VERSION_OF", direction: "reverse" } },
        { ref_id: "v2", node_type: "StrutWorkflowVersion", name: "deliver@2", via: { from: "wf", edge_type: "VERSION_OF", direction: "reverse" } },
        { ref_id: "st", node_type: "StrutStep", name: "harvey/fetch-docs", via: { from: "wf", edge_type: "USES_STEP", direction: "forward" } },
      ],
      frontier: [],
    });
    assert.deepEqual(events[4].input.candidates.map((c: any) => c.ref_id), ["run"]);
    assert.deepEqual(events[4].input.frontier, [{ ref_id: "st", relevance: 0.7 }, { ref_id: "v1", relevance: 0.3 }], "the frontier under consideration, best first");
    // step.end: the verdicts (the hop record itself).
    assert.deepEqual(events[3].nodes.map((n: any) => n.ref_id), ["wf", "v1", "v2", "st"]);
    assert.deepEqual(events[3].output, out.hops[1]);
    assert.ok(typeof events[3].durationMs === "number");
  });

  it("seeds from a query through the reader's search, with the type filter, namespace and seed limit", async () => {
    const { reader, calls } = fakeReader();
    const { evaluate } = scripted(() => ({ next: "none" }));
    const out = await runWalk({ ...BASE, query: "  deliver ", node_type: ["StrutWorkflow"], namespace: "ns" }, { reader, evaluate });
    assert.deepEqual(calls.search, [{ q: "deliver", types: ["StrutWorkflow"], namespace: "ns", limit: 5, include_edge_counts: true }]);
    assert.deepEqual(out.nodes.map((n) => n.ref_id), ["wf"]);
    assert.equal(out.stopped, "exhausted", "the decider chose none");
  });

  it("fetches neighbors with the traversal filters, offers each node once, and stops at maxHops", async () => {
    const { reader, calls } = fakeReader();
    const { evaluate, calls: decisions } = scripted(() => ({}));
    const out = await runWalk({ ...BASE, start: ["wf"], edge_type: ["VERSION_OF"], node_type: ["StrutWorkflowVersion"], namespace: "ns", maxHops: 3 }, { reader, evaluate });

    assert.deepEqual(calls.neighbors[0], ["wf", {
      edge_types: ["VERSION_OF"], node_types: ["StrutWorkflowVersion"], exclude_node_types: ["Hint", "Memory", "Clip", "Turn"],
      limit: 50, namespace: "ns", include_edge_counts: true,
    }]);
    assert.equal(out.stopped, "hops");
    assert.deepEqual(out.hops.map((h) => [h.hop, h.expanded?.ref_id, h.candidates, h.next?.ref_id]), [
      [0, undefined, 1, "wf"],
      [1, "wf", 2, "v1"],
      [2, "v1", 0, "v2"], // v1's only neighbor is wf, already seen: nothing new; next comes from the frontier
    ]);
    assert.deepEqual(Object.keys((decisions[2]!.questions["next"] as any).criteria), ["f0", "none"]);
    assert.equal(calls.neighbors.length, 2, "no fetch for a hop the budget won't judge");
    assert.deepEqual(out.nodes.map((n) => n.ref_id), ["wf", "v1", "v2"]);
  });

  it("stops at maxNodes, on `none`, and when nothing is left to judge", async () => {
    const { reader } = fakeReader();
    const capped = await runWalk({ ...BASE, start: ["wf"], maxNodes: 1 }, { reader, evaluate: scripted(() => ({})).evaluate });
    assert.deepEqual([capped.stopped, capped.hops.length, capped.nodes.length], ["nodes", 1, 1]);

    const none = await runWalk({ ...BASE, start: ["wf"] }, { reader, evaluate: scripted(() => ({ next: "none" })).evaluate });
    assert.deepEqual([none.stopped, none.hops.length], ["exhausted", 1]);

    const { evaluate, calls } = scripted(() => ({}));
    const missing = await runWalk({ ...BASE, start: ["nope"] }, { reader, evaluate });
    assert.deepEqual([missing.stopped, missing.hops, missing.nodes, calls.length], ["exhausted", [], [], 0]);
    assert.deepEqual(accessedNodesOf(missing) ?? [], [], "nothing read, nothing kept");
  });

  it("a hop's failure is emitted as step.error and rethrown", async () => {
    const { reader } = fakeReader();
    const { ctx, events } = ctxWithEvents();
    const evaluate: Evaluate = async () => { throw new Error("decider down"); };
    await assert.rejects(runWalk({ ...BASE, start: ["wf"] }, { reader, evaluate, ctx }), /decider down/);
    assert.deepEqual(events.map((e) => [e.type, e.path, e.iteration]), [["step.start", "wf/gather/001-hop", 0], ["step.error", "wf/gather/001-hop", 0]]);
    assert.equal(events[1].error.message, "decider down");
  });

  it("needs start or query", async () => {
    const { reader } = fakeReader();
    await assert.rejects(runWalk({ ...BASE }, { reader, evaluate: scripted(() => ({})).evaluate }), /needs `start` \(ref_ids\) or `query`/);
  });
});

describe("graph/walk: evidence labels and edge attributes", () => {
  // claim ─EVIDENCED_BY{strength}→ e1 (+1), e2 (−1), e3 (planned slot: no strength)
  // e1, e2 ─HAS_SOURCE{context}→ run
  const CLAIM = "The clip covers caption text that answers the prompt.";
  const nodes: Record<string, NodeEnvelope> = {
    claim: node("claim", "Claim", { name: CLAIM, claim_text: CLAIM }),
    e1: node("e1", "Evidence", { name: CLAIM, content: "quote_len=85 in_full=True word_frac=1.00" }),
    e2: node("e2", "Evidence", { name: CLAIM, content: "quote_len=85  in_transcript=False" }),
    e3: node("e3", "Evidence", { name: CLAIM }),
    // e1's claim and verdict again, on another run: folds into e1
    e4: node("e4", "Evidence", { name: CLAIM, content: "quote_len=85 in_full=True word_frac=0.98" }),
    run: node("run", "StrutRun", { run_id: "r1", summary: "success · 7 steps" }),
  };
  const edges: Array<[string, string, string, Record<string, unknown>]> = [
    ["claim", "EVIDENCED_BY", "e1", { strength: 1, date_added_to_graph: 5 }],
    ["claim", "EVIDENCED_BY", "e2", { strength: -1 }],
    ["claim", "EVIDENCED_BY", "e3", {}],
    ["claim", "EVIDENCED_BY", "e4", { strength: 1 }],
    ["e1", "HAS_SOURCE", "run", { context: "x".repeat(500) }],
    ["e2", "HAS_SOURCE", "run", {}],
    ["e4", "HAS_SOURCE", "run", {}],
  ];
  const reader: WalkReader = {
    async getNode(id) {
      return nodes[id] ?? null;
    },
    async neighbors(id, p) {
      const es = edges.filter(([s, e, t]) => (s === id || t === id) && (!p?.edge_types || p.edge_types.includes(e)));
      return {
        nodes: [...new Set(es.flatMap(([s, , t]) => [s, t]))].map((i) => nodes[i]!),
        edges: es.map(([s, e, t, properties]) => ({ source: s, target: t, ref_id: `${s}|${e}|${t}`, edge_type: e, properties })),
      };
    },
    async search() {
      return { nodes: [], total: 0, truncated: false };
    },
  };
  const walkFrom = async (start: string) => {
    const { evaluate, calls } = scripted((hop) => (hop === 0 ? {} : { next: "none" }));
    await runWalk({ ...BASE, start: [start], maxHops: 2 }, { reader, evaluate });
    return calls[1]!.state.candidates as Array<{ name: string; snippet: string; via: string }>;
  };

  it("from the claim: labels lead with the EVIDENCED_BY verdict and the result; the claim moves to the snippet; strength shown on via", async () => {
    const c = await walkFrom("claim");
    assert.deepEqual(c.map((x) => x.name), [
      "supports (1): quote_len=85 in_full=True word_frac=1.00",
      "refutes (-1): quote_len=85 in_transcript=False",
      `no verdict: ${CLAIM}`,
    ]);
    assert.ok(c.every((x) => x.snippet === `claim: ${CLAIM}`));
    assert.deepEqual(c.map((x) => x.via), ['EVIDENCED_BY (forward) {"strength":1}', 'EVIDENCED_BY (forward) {"strength":-1}', "EVIDENCED_BY (forward)"]);
  });

  it("from a run over HAS_SOURCE: the verdict is looked up; long edge attributes are clipped", async () => {
    const c = await walkFrom("run");
    assert.deepEqual(c.map((x) => x.name.split(":")[0]), ["supports (1)", "refutes (-1)"]);
    assert.match(c[0]!.via, /^HAS_SOURCE \(reverse\) \{"context":"x{160}…"\}$/);
    assert.equal(c[1]!.via, "HAS_SOURCE (reverse)");
  });

  it("evidence with the same claim and verdict is judged once: the rest fold into it (event, verdicts, bundle, provenance)", async () => {
    const { ctx, events } = ctxWithEvents();
    const { evaluate, calls } = scripted((hop) => (hop === 0 ? {} : { next: "none" }));
    const out = await runWalk({ ...BASE, start: ["claim"], maxHops: 2 }, { reader, evaluate, ctx });
    const shown = calls[1]!.state.candidates as Array<{ id: string; name: string; similar_results?: number }>;
    assert.deepEqual(shown.map((c) => c.similar_results), [1, undefined, undefined]);
    assert.deepEqual(Object.keys(calls[1]!.questions).filter((k) => k.startsWith("relevant_")), ["relevant_c0", "relevant_c1", "relevant_c2"]);
    const start = events.find((e) => e.type === "step.start" && e.iteration === 1)!;
    assert.deepEqual(start.input.candidates.find((c: any) => c.ref_id === "e4"), {
      ref_id: "e4",
      node_type: "Evidence",
      name: "supports (1): quote_len=85 in_full=True word_frac=0.98",
      via: { from: "claim", edge_type: "EVIDENCED_BY", direction: "forward", properties: { strength: 1 } },
      merged_into: "e1",
    });
    assert.deepEqual(out.hops[1]!.verdicts.find((v) => v.ref_id === "e4"), { ref_id: "e4", relevance: 0.9, kept: true });
    assert.deepEqual(out.nodes.find((n) => n.ref_id === "e1")!.merged, [{ ref_id: "e4", name: "supports (1): quote_len=85 in_full=True word_frac=0.98" }]);
    assert.ok(!out.nodes.some((n) => n.ref_id === "e4"));
    assert.ok(accessedNodesOf(out)!.some((n) => n.ref_id === "e4"));
  });

  it("a later hop's repeat folds into the group from an earlier hop and is not offered again", async () => {
    // e1 (seed) → claim → e2, e3, e4: e4 repeats e1
    const { evaluate, calls } = scripted((hop) => (hop < 2 ? { next: "c0" } : { next: "none" })); // e1, then its one neighbor: the claim
    const out = await runWalk({ ...BASE, start: ["e1"], edge_type: ["EVIDENCED_BY"], maxHops: 3 }, { reader, evaluate });
    assert.deepEqual(calls[2]!.state.candidates.map((c: any) => c.name.split(":")[0]), ["refutes (-1)", "no verdict"]);
    assert.deepEqual(calls[2]!.state.gathered.find((g: any) => g.name.startsWith("supports")).similar_results, 1);
    assert.deepEqual(out.nodes.find((n) => n.ref_id === "e1")!.merged?.map((m) => m.ref_id), ["e4"]);
  });
});

describe("graph/walk: step definition", () => {
  it("defaults the budgets and threshold", () => {
    const cfg = walk.input.parse({ goal: "g", query: "q" });
    assert.deepEqual([cfg.maxHops, cfg.maxNodes, cfg.threshold], [12, 25, 0.7]);
  });

  it("run() refuses a config with neither start nor query before touching the backend", async () => {
    assert.equal(await walk.run(walk.input.parse({ goal: "g" })), "graph/walk failed: needs `start` (ref_ids) or `query`");
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

function nameToId(name: string): string {
  return { "deliver@1": "v1", "deliver@2": "v2", "harvey/fetch-docs": "st", "run-9": "run" }[name] ?? "wf";
}

/** The option key (c<i>/f<i>) under which a node is offered this hop. */
function optionFor(state: any, name: string): string {
  const all = [...state.candidates, ...state.frontier];
  return all.find((x: any) => x.name === name).id;
}
