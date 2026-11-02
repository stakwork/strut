import { describe, it } from "node:test";
import assert from "node:assert/strict";
// The server's own walk produces the `graph/walk` events folded here, so a
// change to the hop event shape that would blind the view fails here.
import { runWalk, type WalkReader } from "../../../../src/steps/lib/graph/walk.js";
import type { NodeEnvelope } from "../../../../src/graph/search.js";
import type { Evaluate, EvalAnswer } from "../../../../src/evaluate.js";
import type { StepContext } from "../../../../src/core.js";
import { findWalks, foldWalkGraph, foldWalkTrail, latestWalk, listedNodes, toolResultsByCall, walkBeats, walkFrame, walkHopStop, walkTrailSummary, type WalkLogEvent } from "./index.js";
import { replayStart, replayAdvance, replayWait } from "../replay.js";

// A law Concept tree (PARENT_OF, parent → child).
const TREE: Record<string, [string, string[]]> = {
  law: ["Law", ["corp", "lit", "emp", "ip"]],
  corp: ["Corporate / M&A", ["nda", "spa", "loi"]],
  lit: ["Litigation", []],
  emp: ["Employment", []],
  ip: ["Intellectual property", []],
  nda: ["NDA", ["draft", "negotiate", "precedents"]],
  spa: ["Share purchase agreement", []],
  loi: ["Letter of intent", []],
  draft: ["Drafting rules", ["matrix", "clauses", "redline"]],
  negotiate: ["Negotiation playbook", []],
  precedents: ["NDA precedents", []],
  matrix: ["Deviation matrix (Google Sheet)", []],
  clauses: ["Clause library", []],
  redline: ["Redline conventions", []],
};
const RELEVANCE: Record<string, number> = {
  law: 0.9, corp: 0.92, lit: 0.1, emp: 0.15, ip: 0.3, nda: 0.95, spa: 0.4, loi: 0.35,
  draft: 0.93, negotiate: 0.72, precedents: 0.5, matrix: 0.97, clauses: 0.81, redline: 0.6,
};
const byName = new Map(Object.entries(TREE).map(([ref, [name]]) => [name, ref]));
const concept = (ref: string): NodeEnvelope => ({ ref_id: ref, node_type: "Concept", properties: { name: TREE[ref]![0] } });
const EDGES = Object.entries(TREE).flatMap(([parent, [, kids]]) => kids.map((kid) => ({ source: parent, target: kid })));

const reader: WalkReader = {
  async getNode(id) {
    return TREE[id] ? concept(id) : null;
  },
  async neighbors(id) {
    const edges = EDGES.filter((e) => e.source === id || e.target === id);
    return {
      nodes: [...new Set(edges.flatMap((e) => [e.source, e.target]))].map(concept),
      edges: edges.map((e) => ({ source: e.source, target: e.target, ref_id: `${e.source}|${e.target}`, edge_type: "PARENT_OF", properties: {} })),
    };
  },
  async search() {
    return { nodes: [concept("law")], total: 1, truncated: false };
  },
};

/** Relevance from the table; next = the most relevant option; enough once the matrix is in view. */
const evaluate: Evaluate = async ({ state, questions }) => {
  const st = state as { candidates: Array<{ id: string; name: string }> };
  const answers: Record<string, EvalAnswer> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (id.startsWith("relevant_")) {
      const c = st.candidates.find((x) => x.id === id.slice("relevant_".length))!;
      answers[id] = { type: "boolean", probability: RELEVANCE[byName.get(c.name)!]! };
    } else if (q.type === "choice") {
      const options = Object.entries(q.criteria).filter(([k]) => k !== "none");
      const score = (label: unknown) => RELEVANCE[byName.get(String(label).replace(/^Concept: /, "").replace(/ \(via .*$/, ""))!] ?? 0;
      options.sort((a, b) => score(b[1]) - score(a[1]));
      answers[id] = { type: "choice", choice: options[0]?.[0] ?? "none" };
    } else answers[id] = { type: "boolean", probability: st.candidates.some((c) => c.name.startsWith("Deviation")) ? 0.9 : 0.2 };
  }
  return { answers: answers as never, usage: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, totalTokens: 2 } };
};

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const T = (s: number) => new Date(T0 + s * 1000).toISOString();

/** A `legal` run whose `gather` step is a graph/walk down the tree. */
async function walkRun(): Promise<WalkLogEvent[]> {
  const events: WalkLogEvent[] = [
    { type: "run.start", path: "legal", ts: T(0) },
    { type: "step.start", path: "legal/gather", stepType: "graph/walk", ts: T(1), input: { goal: "How should this NDA deviate from our standard?", start: ["law"], edge_type: ["PARENT_OF"], maxHops: 8 } },
  ];
  let s = 2;
  const ctx = { path: "legal/gather", emit: async (e: WalkLogEvent) => void events.push({ ...e, ts: T(s++) }) } as unknown as StepContext;
  const out = await runWalk({ goal: "nda", start: ["law"], edge_type: ["PARENT_OF"], maxHops: 8, maxNodes: 25, threshold: 0.7 }, { reader, evaluate, ctx });
  events.push({ type: "step.end", path: "legal/gather", stepType: "graph/walk", ts: T(s++), output: out });
  events.push({ type: "run.end", path: "legal", ts: T(s) });
  return events;
}

const names = (refs: Array<{ name: string }>) => refs.map((r) => r.name);

describe("findWalks + foldWalkTrail: a graph/walk step", () => {
  it("reads the trail down the tree, each choice beside the candidates it dropped", async () => {
    const walks = findWalks(await walkRun());
    assert.equal(walks.length, 1);
    const w = walks[0]!;
    assert.equal(w.kind, "walk");
    assert.equal(w.path, "legal/gather");
    assert.equal(w.label, "gather");
    assert.equal(w.status, "done");
    assert.equal(w.stopped, "sufficient");
    assert.equal(w.goal, "How should this NDA deviate from our standard?");
    const t = foldWalkTrail(w.hops);
    assert.deepEqual(names(t.path), ["Law", "Corporate / M&A", "NDA", "Drafting rules", "Deviation matrix (Google Sheet)"]);
    assert.equal(t.steps.length, 5);
    assert.equal(t.steps[0]!.from, null, "the seeds come from nowhere");
    const nda = t.steps[2]!;
    assert.equal(nda.from?.name, "Corporate / M&A");
    assert.deepEqual(nda.candidates.map((c) => [c.name, c.state]), [["NDA", "chosen"], ["Share purchase agreement", "dropped"], ["Letter of intent", "dropped"]]);
    assert.equal(nda.candidates[1]!.relevance, 0.4);
    assert.equal(nda.candidates[0]!.via?.edge_type, "PARENT_OF");
    // Kept but not chosen: in the bundle, not on the trail.
    const draft = t.steps[3]!;
    assert.deepEqual(draft.candidates.map((c) => c.state), ["chosen", "kept", "dropped"]);
    assert.equal(draft.sufficient, 0.2);
    assert.equal(t.steps[4]!.sufficient, 0.9);
    assert.ok(t.steps.every((s) => !s.pending && !s.jump));
    assert.equal(t.kept, 7);
    assert.equal(walkTrailSummary(t, { stopped: w.stopped }), "5 hops · 7 kept · stopped: sufficient");
  });

  it("a prefix is the walk so far: a hop's candidates are judged before one is chosen", async () => {
    const w = findWalks(await walkRun())[0]!;
    const t = foldWalkTrail(w.hops.slice(0, 5)); // hop 2's start: Corporate's children listed
    assert.equal(t.steps.length, 3);
    const last = t.steps[2]!;
    assert.equal(last.pending, true);
    assert.equal(last.chosen, null);
    assert.ok(last.candidates.every((c) => c.state === "considering"));
    assert.deepEqual(names(t.path), ["Law", "Corporate / M&A"]);
    assert.equal(walkTrailSummary(t, { live: true }), "3 hops · 2 kept · walking…");
  });

  it("is running until its step ends, and cut off if the run ended first", async () => {
    const events = await walkRun();
    const cut = events.slice(0, 7);
    assert.equal(findWalks(cut)[0]!.status, "running");
    const ended = [...cut, { type: "run.cancelled", path: "legal" }];
    assert.equal(findWalks(ended)[0]!.status, "error");
    const failed = [...events.slice(0, 2), { type: "step.end", path: "legal/gather", stepType: "graph/walk", output: "graph/walk failed: needs `start` (ref_ids) or `query`" }];
    assert.deepEqual([findWalks(failed)[0]!.status, findWalks(failed)[0]!.error], ["error", "graph/walk failed: needs `start` (ref_ids) or `query`"]);
  });

  it("the graph fold reads the same hops: edges by arrival, verdicts, next", async () => {
    const w = findWalks(await walkRun())[0]!;
    const g = foldWalkGraph(w.hops, { stopped: "sufficient" });
    assert.equal(g.nodes.size, 14);
    assert.equal(g.edges.length, 13);
    assert.equal(g.nodes.get("lit")!.state, "dropped");
    assert.equal(g.nodes.get("matrix")!.state, "kept");
    assert.equal(g.done, true);
  });
});

/** An agent tool call, as the agent step's emit writes it. */
let callNo = 0;
function call(agent: string, tool: string, s: number, input: unknown, end: { output: unknown; nodes?: unknown[] }): WalkLogEvent[] {
  const n = ++callNo;
  const path = `${agent}/${String(n).padStart(3, "0")}-${tool}`;
  const id = `call-${n}`;
  return [
    { type: "step.start", path, stepType: `tool:${tool}`, toolCallId: id, ts: T(s), input },
    { type: "step.end", path, stepType: `tool:${tool}`, toolCallId: id, ts: T(s + 0.5), output: typeof end.output === "string" ? end.output : JSON.stringify(end.output), ...(end.nodes ? { nodes: end.nodes } : {}) },
  ];
}
const brief = (ref: string) => ({ ref_id: ref, node_type: "Concept", name: TREE[ref]![0] });
/** graph_graph_get with `children`, as the step returns it. */
const get = (agent: string, s: number, ref: string) =>
  call(agent, "graph_graph_get", s, { ref_id: ref, children: "PARENT_OF" }, {
    output: { ...brief(ref), properties: { name: TREE[ref]![0] }, edges: {}, children: TREE[ref]![1].map((k) => ({ ...brief(k), description: "" })) },
    nodes: [brief(ref)],
  });

describe("findWalks + foldWalkTrail: an agent walking by its own tool calls", () => {
  const A = "legal/explore";
  const agentRun = (): WalkLogEvent[] => [
    { type: "run.start", path: "legal", ts: T(0) },
    { type: "step.start", path: A, stepType: "agent", ts: T(1), input: { prompt: "Find the house rule for an NDA's deviations.\nThen fill the sheet." } },
    ...call(A, "graph_graph_search", 2, { q: "law" }, { output: [{ ...brief("law"), description: "", edges: {} }, { ...brief("lit"), description: "", edges: {} }] }),
    ...get(A, 3, "law"),
    ...get(A, 4, "corp"),
    ...call(A, "bash", 5, { command: "ls" }, { output: "notes.md" }),
    ...get(A, 6, "nda"),
    ...get(A, 7, "draft"),
    ...get(A, 8, "matrix"),
    { type: "step.end", path: A, stepType: "agent", ts: T(9), output: { result: "done" } },
    { type: "run.end", path: "legal", ts: T(10) },
  ];

  it("a listing opens a choice, the next node read closes it", () => {
    const walks = findWalks(agentRun());
    assert.equal(walks.length, 1);
    const w = walks[0]!;
    assert.deepEqual([w.kind, w.path, w.label, w.status], ["agent", A, "explore", "done"]);
    assert.equal(w.goal, "Find the house rule for an NDA's deviations. Then fill the sheet.");
    const t = foldWalkTrail(w.hops);
    assert.deepEqual(names(t.path), ["Law", "Corporate / M&A", "NDA", "Drafting rules", "Deviation matrix (Google Sheet)"]);
    // The search's hits are the first choice: the seeds.
    assert.equal(t.steps[0]!.from, null);
    assert.deepEqual(t.steps[0]!.candidates.map((c) => [c.name, c.state]), [["Law", "chosen"], ["Litigation", "dropped"]]);
    const corp = t.steps[1]!;
    assert.equal(corp.from?.name, "Law");
    assert.deepEqual(corp.candidates.map((c) => c.state), ["chosen", "dropped", "dropped", "dropped"]);
    assert.deepEqual(corp.candidates[0]!.via, { from: "law", edge_type: "PARENT_OF", direction: "forward" });
    assert.equal(corp.candidates[0]!.relevance, undefined, "an agent's choice has no score");
    // The leaf listed no children: nothing left open.
    assert.equal(t.steps.length, 5);
    assert.equal(walkTrailSummary(t), "5 hops · 15 considered", "no decider, nothing kept by score");
    assert.ok(t.steps.every((s) => !s.pending && !s.jump));
  });

  it("live, the last listing is still being chosen from", () => {
    const events = agentRun();
    const upTo = events.findIndex((e) => e.path?.endsWith("-graph_graph_get") && e.type === "step.end" && (e.nodes as Array<{ ref_id: string }>)[0]!.ref_id === "nda");
    const w = findWalks(events.slice(0, upTo + 1))[0]!;
    assert.equal(w.status, "running");
    const t = foldWalkTrail(w.hops);
    const last = t.steps.at(-1)!;
    assert.equal(last.pending, true);
    assert.equal(last.from?.name, "NDA");
    assert.deepEqual(names(last.candidates), ["Drafting rules", "Negotiation playbook", "NDA precedents"]);
  });

  it("a node read that no listing offered is a jump; an agent that only searched walked nowhere", () => {
    const B = "legal/hop";
    const events: WalkLogEvent[] = [
      ...get(B, 1, "law"),
      ...call(B, "graph_graph_get", 2, { ref_id: "matrix" }, { output: { ...brief("matrix") }, nodes: [brief("matrix")] }),
      ...call("legal/searcher", "graph_graph_search", 3, { q: "nda" }, { output: [{ ...brief("nda") }] }),
    ];
    const walks = findWalks(events);
    assert.deepEqual(walks.map((w) => w.path), [B]);
    const t = foldWalkTrail(walks[0]!.hops);
    assert.deepEqual(names(t.path), ["Law", "Deviation matrix (Google Sheet)"]);
    // Law's children were listed and none taken; the matrix is a hop of its own.
    assert.equal(t.steps[1]!.chosen, null);
    assert.ok(t.steps[1]!.candidates.every((c) => c.state === "dropped"));
    assert.equal(t.steps[2]!.from?.name, "Law");
    assert.deepEqual(names(t.steps[2]!.candidates), ["Deviation matrix (Google Sheet)"]);
  });

  it("reads a cut preview's complete entries, and the transcript's whole result once there is one", () => {
    const full = { ...brief("nda"), properties: { docs: "x".repeat(2000) }, edges: {}, children: TREE["nda"]![1].map((k) => brief(k)) };
    const preview = JSON.stringify(full).slice(0, 1500) + "\n[… truncated for event log …]";
    assert.deepEqual(names(listedNodes(preview)), ["NDA"], "the docs pushed the children out of the preview");
    const cut = JSON.stringify([brief("spa"), brief("loi"), brief("nda")]).slice(0, 150);
    assert.deepEqual(names(listedNodes(cut)), ["Share purchase agreement", "Letter of intent"]);

    const C = "legal/reader";
    const events: WalkLogEvent[] = [
      ...get(C, 1, "corp"),
      ...call(C, "graph_graph_get", 2, { ref_id: "nda", children: "PARENT_OF" }, { output: preview, nodes: [brief("nda")] }),
      ...get(C, 3, "draft"),
    ];
    const ndaCall = events[3]!.toolCallId!;
    const live = foldWalkTrail(findWalks(events)[0]!.hops);
    assert.equal(live.steps.at(-1)!.jump, false);
    assert.equal(live.steps.at(-1)!.chosen, null, "Drafting rules was read, but nothing listed it: the preview cut it");
    const transcript = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: ndaCall, toolName: "graph_graph_get", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: ndaCall, toolName: "graph_graph_get", output: { type: "json", value: full } }] },
    ];
    const results = toolResultsByCall(transcript);
    assert.deepEqual(names(listedNodes(results.get(ndaCall))), names(full.children));
    const done = foldWalkTrail(findWalks(events, { results })[0]!.hops);
    assert.deepEqual(names(done.path), ["Corporate / M&A", "NDA", "Drafting rules"]);
    assert.deepEqual(done.steps[2]!.candidates.map((c) => c.state), ["chosen", "dropped", "dropped"]);
    // A text result is JSON text.
    const text = toolResultsByCall({ messages: [{ role: "tool", content: [{ type: "tool-result", toolCallId: "t", output: { type: "text", value: JSON.stringify([brief("ip")]) } }] }] });
    assert.deepEqual(names(listedNodes(text.get("t"))), ["Intellectual property"]);
  });

  it("a graph/walk an agent called is a walk of its own, and the latest is the default", async () => {
    const walk = await walkRun();
    const asTool = walk
      .filter((e) => e.path?.startsWith("legal/gather"))
      .map((e) => ({ ...e, path: e.path!.replace("legal/gather", `${A}/009-graph_graph_walk`), ...(e.stepType === "graph/walk" ? { stepType: "tool:graph_graph_walk" } : {}) }));
    const events = [...agentRun().slice(0, -2), ...asTool, ...agentRun().slice(-2)];
    const walks = findWalks(events);
    assert.deepEqual(walks.map((w) => [w.kind, w.label]), [["agent", "explore"], ["walk", "graph_graph_walk"]]);
    assert.equal(foldWalkTrail(walks[0]!.hops).path.length, 5, "the walk's hops are not the agent's");
    assert.equal(latestWalk(walks)?.kind, "walk");
  });

  it("the graph fold draws an agent's walk too: edges from the listing's edge type", () => {
    const g = foldWalkGraph(findWalks(agentRun())[0]!.hops);
    assert.deepEqual(g.edges.find((e) => e.target === "nda"), { source: "corp", target: "nda", type: "PARENT_OF" });
    assert.equal(g.nodes.get("nda")!.state, "kept");
    assert.equal(g.nodes.get("spa")!.state, "dropped");
  });
});

describe("walk replay frames: the walk from its log alone, beat by beat", () => {
  it("a hop is two beats — its candidates, then its choice — in the walk's order, at its times", async () => {
    const w = findWalks(await walkRun())[0]!;
    const beats = walkBeats(w.hops);
    assert.equal(beats.length, 10);
    assert.deepEqual(beats.slice(0, 4).map((b) => [b.hop, b.kind, b.label]), [
      [0, "candidates", "seeds: 1 candidate"],
      [0, "choice", "chose Law"],
      [1, "candidates", "Law: 4 candidates"],
      [1, "choice", "chose Corporate / M&A"],
    ]);
    assert.deepEqual(beats.map((b) => b.at), w.hops.map((h) => Date.parse(h.ts!)));
    assert.ok(beats.every((b, i) => i === 0 || b.at! > beats[i - 1]!.at!), "in the run's order");
  });

  it("a finished run replays exactly as it was live: at every point of its log, the live trail is the replay's frame", async () => {
    const log = await walkRun();
    const whole = findWalks(log)[0]!;
    let checked = 0;
    for (let n = 1; n <= log.length; n++) {
      const live = findWalks(log.slice(0, n))[0];
      if (!live) continue;
      const frame = walkFrame(whole.hops, live.hops.length);
      assert.deepEqual(frame.trail, foldWalkTrail(live.hops), `after ${n} events of the log`);
      checked++;
    }
    assert.ok(checked >= 10);
    const mid = walkFrame(whole.hops, 5);
    assert.deepEqual([mid.hop, mid.hops, mid.beat?.label], [3, 5, "Corporate / M&A: 3 candidates"]);
    assert.equal(mid.trail.steps.at(-1)!.pending, true);
    assert.deepEqual(walkFrame(whole.hops, 0), { trail: foldWalkTrail([]), beat: null, hop: 0, hops: 5 });
  });

  it("a step is one hop: it lands where a hop's choice has shown, never between its candidates and its choice", async () => {
    const beats = walkBeats(findWalks(await walkRun())[0]!.hops);
    assert.equal(walkHopStop(beats, 0, 1), 2);
    assert.equal(walkHopStop(beats, 2, 1), 4);
    assert.equal(walkHopStop(beats, 3, 1), 4, "from mid-hop, on to its choice");
    assert.equal(walkHopStop(beats, 4, -1), 2);
    assert.equal(walkHopStop(beats, 3, -1), 2, "from mid-hop, back to the hop before");
    assert.equal(walkHopStop(beats, 0, -1), 0);
    assert.equal(walkHopStop(beats, 10, 1), 10);
    assert.equal(walkHopStop(beats, 10, -1), 8);
  });

  it("played on the kit's clock, every beat shows in order at the run's pace — an agent's too", async () => {
    const times = walkBeats(findWalks(await walkRun())[0]!.hops).map((b) => b.at);
    let c = replayStart(times.length, false, true);
    const shown: number[] = [];
    for (let wait = replayWait(c, times); wait !== null; wait = replayWait(c, times)) {
      c = replayAdvance(c, times.length, false);
      shown.push(c.at);
    }
    assert.deepEqual(shown, Array.from({ length: times.length }, (_, i) => i + 1));
    const agent = walkBeats(findWalks([
      ...get("legal/ag", 1, "law"),
      ...get("legal/ag", 30, "corp"),
    ])[0]!.hops);
    assert.deepEqual(agent.map((b) => b.kind), ["candidates", "choice", "candidates", "choice", "candidates"]);
    assert.equal(agent[2]!.at! - agent[1]!.at!, 0, "a read and the listing it brought are one moment");
    assert.equal(agent[3]!.at! - agent[2]!.at!, 29_000, "the agent took 29 s to choose");
    assert.equal(replayWait({ at: 3, mode: "play" }, agent.map((b) => b.at)), 4_000, "an idle stretch cut short");
  });
});
