import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineStep, flow, step, type StepContext } from "./core.js";
import { runWorkflow } from "./runner.js";
import { createRegistry } from "./steps/registry.js";
import type { JobUpdateInput } from "./jobs.js";
import { bindGraph, createGraphChangeFeed, graphReporter, isQuietType, reportingGraph, type GraphChange } from "./graph-writes.js";
import graphChanges from "./steps/lib/graph/changes.js";

/** Writers shaped like the backend's: each call recorded, results as the real ones return them. */
class FakeNodes {
  calls: string[] = [];
  private n = 0;
  async write(input: { type: string }, _mode = "create") {
    this.calls.push("write");
    return { ref_id: `n${++this.n}`, node_key: "k", node_type: input.type, outcome: "created" };
  }
  async writeMany(inputs: Array<{ type: string }>) {
    this.calls.push("writeMany");
    // As the real writer does: the many-write is its own; `write` calls it on the WRITER.
    return inputs.map((i) => ({ ref_id: `n${++this.n}`, node_key: "k", node_type: i.type, outcome: i.type === "Same" ? "existing" : "created" }));
  }
  async update(ref_id: string) {
    this.calls.push("update");
    return { ref_id, node_key: "k", rekeyed: false };
  }
  async deleteNode(ref_id: string) {
    this.calls.push("deleteNode");
    return { edges: 1, ref_id };
  }
  prepare() {
    return "not a write";
  }
}

class FakeEdges {
  async write(input: { edge: string; source: string; target: string }) {
    return { ref_id: `e-${input.source}-${input.target}`, edge_key: "k", created: true, source_ref_id: input.source, target_ref_id: input.target };
  }
  async delete(ref: string) {
    return { ref_id: ref, edge: "PARENT_OF", source_ref_id: "q1", target_ref_id: "o1" };
  }
  async move(m: { ref_id: string; edge: string; direction: "forward" | "reverse"; to_ref_id: string }) {
    return { moved: true, ref_id: m.ref_id, from_ref_id: "old", to_ref_id: m.to_ref_id, edge_ref_id: "e-new", previous_edge_ref_id: "e-old" };
  }
}

const TYPES: Record<string, string> = { q1: "Question", o1: "Option", old: "Question", new: "Question", run1: "StrutRun" };
const reader = { getNode: async (ref: string) => (TYPES[ref] ? { node_type: TYPES[ref] } : null) };

function fakeGraph() {
  return { nodes: new FakeNodes(), edges: new FakeEdges(), reader, query: async () => [], kind: "fake" };
}

describe("graph writes, heard (plans/live-feeds.md §2, §3)", () => {
  it("the view reports each mutating call once, keeps everything else the backend's own", async () => {
    const changes: GraphChange[] = [];
    const r = { note: (c: Omit<GraphChange, "at">) => void changes.push({ ...c, at: "" }), flush: async () => {} };
    const g = fakeGraph();
    const view = reportingGraph(g, r);
    assert.notEqual(view, g);
    assert.equal(view.reader, g.reader);
    assert.equal(view.kind, "fake");
    await view.nodes.write({ type: "Question" });
    await view.nodes.writeMany([{ type: "Option" }, { type: "Same" }]);
    await view.nodes.update("q1");
    await view.nodes.deleteNode("o1");
    assert.equal(view.nodes.prepare(), "not a write");
    await view.edges.write({ edge: "PARENT_OF", source: "q1", target: "o1" });
    await view.edges.delete("e-x");
    await view.edges.move({ ref_id: "o1", edge: "PARENT_OF", direction: "reverse", to_ref_id: "new" });
    assert.deepEqual(g.nodes.calls, ["write", "writeMany", "update", "deleteNode"], "the writer did each write once");
    assert.deepEqual(
      changes.map((c) => [c.kind, c.op, c.ref_id, c.node_type ?? c.edge_type, c.source, c.target]),
      [
        ["node", "created", "n1", "Question", undefined, undefined],
        ["node", "created", "n2", "Option", undefined, undefined],
        // n3 "existing": nothing changed, nothing reported
        ["node", "updated", "q1", undefined, undefined, undefined],
        ["node", "deleted", "o1", "Option", undefined, undefined],
        ["edge", "created", "e-q1-o1", "PARENT_OF", "q1", "o1"],
        ["edge", "deleted", "e-x", "PARENT_OF", "q1", "o1"],
        ["edge", "deleted", "e-old", "PARENT_OF", "old", "o1"],
        ["edge", "created", "e-new", "PARENT_OF", "new", "o1"],
      ],
    );
  });

  it("the reporter types what it can, leaves strut's own types out, tells the job cumulatively and feeds the feed", async () => {
    const feed = createGraphChangeFeed();
    const sent: Array<[string, JobUpdateInput]> = [];
    const r = graphReporter({ runId: "r1", job: "j1", notify: (job, u) => void sent.push([job, u]), feed, reader, debounceMs: 60_000 });
    r.note({ kind: "node", op: "created", ref_id: "a", node_type: "Option" });
    r.note({ kind: "node", op: "updated", ref_id: "q1" }); // typed by a read
    r.note({ kind: "node", op: "created", ref_id: "run1", node_type: "StrutRun" }); // strut's own
    r.note({ kind: "edge", op: "created", ref_id: "e1", edge_type: "PARENT_OF", source: "q1", target: "a" });
    r.note({ kind: "edge", op: "created", ref_id: "e2", edge_type: "EXECUTED", source: "run1", target: "a" }); // an end is strut's
    await r.flush();
    const kept = (await feed.read()).changes;
    assert.deepEqual(kept.map((c) => [c.ref_id, c.node_type, c.types]), [["a", "Option", undefined], ["q1", "Question", undefined], ["e1", undefined, ["Question", "Option"]]]);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], ["j1", { kind: "graph", id: "r1", runId: "r1", state: "written", detail: { writes: 3, types: { Option: 1, Question: 1 }, refs: ["a", "q1"] } }]);
    r.note({ kind: "node", op: "created", ref_id: "b", node_type: "Option" });
    await r.flush();
    assert.deepEqual(sent[1]![1].detail, { writes: 4, types: { Option: 2, Question: 1 }, refs: ["a", "q1", "b"] }, "cumulative for the run");
    await r.flush();
    assert.equal(sent.length, 2, "nothing gathered, nothing sent");
  });

  it("sends a second after the last write without a flush", async () => {
    const sent: JobUpdateInput[] = [];
    const r = graphReporter({ runId: "r", job: "j", notify: (_j, u) => void sent.push(u), debounceMs: 20, maxDelayMs: 1_000 });
    r.note({ kind: "node", op: "created", ref_id: "a", node_type: "Option" });
    await new Promise((res) => setTimeout(res, 80));
    assert.equal(sent.length, 1);
  });

  it("the feed's types keep nodes of them and edges with an end of one (or untyped ends)", async () => {
    const feed = createGraphChangeFeed();
    feed.push([
      { kind: "node", op: "created", ref_id: "a", node_type: "Option", at: "" },
      { kind: "node", op: "created", ref_id: "b", node_type: "Person", at: "" },
      { kind: "edge", op: "created", ref_id: "e1", types: ["Question", "Option"], at: "" },
      { kind: "edge", op: "created", ref_id: "e2", types: ["Person", "Person"], at: "" },
      { kind: "edge", op: "deleted", ref_id: "e3", at: "" },
    ]);
    assert.deepEqual((await feed.read({ types: ["option"] })).changes.map((c) => c.ref_id), ["a", "e1", "e3"]);
    assert.equal(isQuietType("StrutJob"), true);
    assert.equal(isQuietType("Evidence"), true);
    assert.equal(isQuietType("Concept"), false);
  });

  it("bindGraph leaves a bag with no graph, or nobody to tell, as it is", () => {
    const plain = { secrets: {} };
    assert.equal(bindGraph(plain, { runId: "r", job: "j" }).services, plain);
    const noOne = { graph: fakeGraph() };
    assert.equal(bindGraph(noOne, { runId: "r" }).services, noOne, "no feed, no job");
    const withJob = { graph: fakeGraph(), jobs: { notify: () => {} } };
    assert.equal(bindGraph(withJob, { runId: "r" }).services, withJob, "a job notifier but no job");
    const bound = bindGraph(withJob, { runId: "r", job: "j" });
    assert.notEqual(bound.services, withJob);
    assert.equal(withJob.graph.nodes instanceof FakeNodes, true, "the consumer's bag is not mutated");
  });

  it("a run's writes — a step calling a graph step through ctx.registry — reach its job and the feed when the run ends", async () => {
    // A stand-in for graph/create-node: it writes through ctx.services.graph, as graphCtx hands it.
    const createNode = defineStep({
      type: "test/create-node",
      input: z.object({ type: z.string() }),
      output: z.object({ ref_id: z.string() }),
      async run(cfg, ctx) {
        const g = (ctx.services as { graph: ReturnType<typeof fakeGraph> }).graph;
        return { ref_id: (await g.nodes.write({ type: cfg.type })).ref_id };
      },
    });
    // A custom step that writes through another step, as canvas/bs-write does.
    const writeCards = defineStep({
      type: "test/write-cards",
      input: z.object({}),
      output: z.object({ refs: z.array(z.string()) }),
      async run(_cfg, ctx: StepContext) {
        const def = ctx.registry!["test/create-node"]!;
        const refs: string[] = [];
        for (const type of ["Question", "Option", "Option"]) refs.push(((await def.run(def.input.parse({ type }), ctx)) as { ref_id: string }).ref_id);
        return { refs };
      },
    });
    const registry = await createRegistry([createNode, writeCards]);
    const sent: Array<[string, JobUpdateInput]> = [];
    const graphChangesFeed = createGraphChangeFeed();
    const services = { graph: fakeGraph(), graphChanges: graphChangesFeed, jobs: { notify: (job: string, u: JobUpdateInput) => void sent.push([job, u]) } };
    const wf = flow("cards", { input: z.object({}), steps: [step("w", "test/write-cards", {})] });
    const res = await runWorkflow(wf, {}, registry, { services, job: "j-cards" });
    assert.equal(res.status, "success", res.status === "error" ? res.error.message : "");
    assert.equal(sent.length, 1, "sent at the run's end, not a second later");
    assert.equal(sent[0]![0], "j-cards");
    assert.deepEqual(sent[0]![1].detail, { writes: 3, types: { Question: 1, Option: 2 }, refs: ["n1", "n2", "n3"] });
    assert.equal(sent[0]![1].runId, res.runId);
    const read = await graphChanges.run({ types: ["Option"] }, { services: { graphChanges: graphChangesFeed } } as never);
    assert.deepEqual(read.changes.map((c) => c.ref_id), ["n2", "n3"]);
  });
});
