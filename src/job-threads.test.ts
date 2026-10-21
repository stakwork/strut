import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { foldJobThreads, jobTotals, transcriptUrl, type ThreadRun } from "./job-threads.js";
import type { RunEvent, RunSummary } from "./core.js";
import type { SessionTurn } from "./session-store.js";

// The shape of a job on swarm38 (2026-10-12): turns of one agent thread,
// a sub-agent granted as a tool, a child run, a peer run, a run with no
// agent, a failed attempt. Nothing here names the seeded workflow: the
// fold reads markers (`messages`, `session`), the core `agent` type and
// strut's own `strut/run-workflow`.

let tick = 0;
const ts = () => new Date(Date.UTC(2026, 9, 12, 16, 0, tick++)).toISOString();
const ev = (runId: string, type: RunEvent["type"], path: string, extra: Partial<RunEvent> = {}): RunEvent =>
  ({ ts: ts(), runId, path, type, ...extra }) as RunEvent;
const usage = (out: number) => ({ inputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 100, outputTokens: out, totalTokens: 1110 + out });
const summary = (runId: string, workflow: string, status: RunSummary["status"], output?: unknown): RunSummary =>
  ({ runId, workflow, status, startedAt: ts(), finishedAt: ts(), durationMs: 1000, output }) as RunSummary;

/** Turn 0 of thread S: three tool calls, one graph read, a deliverable. */
const runA: ThreadRun = (() => {
  const at = ts();
  const events: RunEvent[] = [
    ev("A", "run.start", "job", { job: "J" }),
    ev("A", "step.start", "job/dir", { stepType: "job/dir" }),
    ev("A", "step.end", "job/dir", { stepType: "job/dir", output: { path: "/jobs/J" } }),
    ev("A", "step.start", "job/work", { stepType: "agent" }),
    ev("A", "step.start", "job/work/001-bash", { stepType: "tool:bash" }),
    ev("A", "step.end", "job/work/001-bash", { stepType: "tool:bash", output: "ok" }),
    ev("A", "step.start", "job/work/002-graph_graph_get", { stepType: "tool:graph/graph-get" }),
    ev("A", "step.end", "job/work/002-graph_graph_get", { stepType: "tool:graph/graph-get", output: {}, nodes: [{ ref_id: "n1", node_type: "Concept", name: "Job" }] }),
    ev("A", "step.start", "job/work/003-bash", { stepType: "tool:bash" }),
    ev("A", "step.end", "job/work/003-bash", { stepType: "tool:bash", output: "ok" }),
    ev("A", "step.end", "job/work", {
      stepType: "agent",
      durationMs: 86000,
      output: { result: "…", steps: 4, usage: usage(500), cost: 0.6, session: { id: "S", turn: 0, offset: 0 } },
      messages: [{ role: "system", content: "s" }, { role: "user", content: "plan it" }],
    }),
    ev("A", "step.end", "job/result", { stepType: "pack", output: { text: "planned", artifacts: [{ id: "plan", title: "Plan", path: "plan.html" }] } }),
    ev("A", "run.end", "job", { output: { text: "planned" } }),
  ];
  return {
    workflow: "job", runId: "A", at,
    summary: summary("A", "job", "success", { text: "planned" }),
    events,
    artifacts: [{ id: "plan", kind: "html", title: "Plan", url: "/jobs/J/files/plan.html" }],
  };
})();

/** Turn 1 of S: a sub-agent as a tool, a child run launched, a peer run. */
const runB: ThreadRun = (() => {
  const at = ts();
  const events: RunEvent[] = [
    ev("B", "run.start", "job", { job: "J" }),
    ev("B", "step.start", "job/work", { stepType: "agent" }),
    ev("B", "step.start", "job/work/001-pod_agent", { stepType: "tool:pod/agent" }),
    ev("B", "step.end", "job/work/001-pod_agent", { stepType: "tool:pod/agent", output: { output: "goose…" } }),
    ev("B", "step.start", "job/work/002-agent", { stepType: "tool:agent" }),
    ev("B", "step.start", "job/work/002-agent/001-bash", { stepType: "tool:bash" }),
    ev("B", "step.end", "job/work/002-agent/001-bash", { stepType: "tool:bash", output: "ok" }),
    ev("B", "step.end", "job/work/002-agent", {
      stepType: "tool:agent",
      output: { result: "reviewed", steps: 2, usage: usage(50), cost: 0.05 },
      messages: [{ role: "system", content: "s" }, { role: "user", content: "review" }],
    }),
    ev("B", "step.start", "job/work/003-meta_run_workflow", { stepType: "tool:meta/run-workflow" }),
    ev("B", "step.end", "job/work/003-meta_run_workflow", { stepType: "tool:meta/run-workflow", output: { runId: "C", status: "success" } }),
    ev("B", "step.start", "job/work/004-strut_run_workflow", { stepType: "tool:strut/run-workflow" }),
    ev("B", "step.end", "job/work/004-strut_run_workflow", {
      stepType: "tool:strut/run-workflow",
      durationMs: 9000,
      output: { peer: "acme", workflow: "explore", runId: "P1", status: "success", output: { cost: 0.5 } },
    }),
    ev("B", "step.end", "job/work", {
      stepType: "agent",
      durationMs: 385000,
      output: { result: "…", steps: 5, usage: usage(700), cost: 0.8, session: { id: "S", turn: 1, offset: 12 } },
      messages: [{ role: "system", content: "s" }, { role: "user", content: "build it" }],
    }),
    ev("B", "run.end", "job", { output: { text: "built" } }),
  ];
  return { workflow: "job", runId: "B", at, summary: summary("B", "job", "success", { text: "built" }), events };
})();

/** The child run turn 1 launched: a cold agent. */
const runC: ThreadRun = (() => {
  const at = ts();
  const events: RunEvent[] = [
    ev("C", "run.start", "explore", { job: "J", parentRunId: "B" }),
    ev("C", "step.start", "explore/agent", { stepType: "agent" }),
    ev("C", "step.end", "explore/agent", {
      stepType: "agent",
      output: { result: "found", steps: 1, usage: usage(20), cost: 0.02 },
      messages: [{ role: "system", content: "s" }, { role: "user", content: "explore" }],
    }),
    ev("C", "run.end", "explore", { output: "found" }),
  ];
  return { workflow: "explore", runId: "C", at, parentRunId: "B", summary: summary("C", "explore", "success", "found"), events };
})();

/** No agent at all: the run is the turn, and carries its deliverables. */
const runD: ThreadRun = (() => {
  const at = ts();
  const events: RunEvent[] = [
    ev("D", "run.start", "report", { job: "J" }),
    ev("D", "step.start", "report/render", { stepType: "exec" }),
    ev("D", "step.end", "report/render", { stepType: "exec", output: { code: 0 } }),
    ev("D", "run.end", "report", { output: { artifacts: [{ id: "report", title: "Report", path: "report.md" }] } }),
  ];
  return {
    workflow: "report", runId: "D", at,
    summary: summary("D", "report", "success", {}),
    events,
    artifacts: [{ id: "report", kind: "markdown", title: "Report", url: "/jobs/J/files/report.md" }],
  };
})();

/** A failed attempt commits nothing — no messages — and is still a turn. */
const runE: ThreadRun = (() => {
  const at = ts();
  const events: RunEvent[] = [
    ev("E", "run.start", "job", { job: "J" }),
    ev("E", "step.start", "job/work", { stepType: "agent" }),
    ev("E", "step.error", "job/work", { stepType: "agent", error: { message: "agent failed after 2 step(s): 400" } }),
    ev("E", "run.error", "job", { error: { message: "agent failed" } }),
  ];
  return { workflow: "job", runId: "E", at, summary: summary("E", "job", "error"), events };
})();

/** Still going: no summary, the step open. */
const runF: ThreadRun = (() => {
  const at = ts();
  const events: RunEvent[] = [
    ev("F", "run.start", "job", { job: "J" }),
    ev("F", "step.start", "job/work", { stepType: "agent" }),
    ev("F", "step.start", "job/work/001-bash", { stepType: "tool:bash" }),
  ];
  return { workflow: "job", runId: "F", at, summary: null, events };
})();

const turnLines: SessionTurn[] = [
  { turn: 0, at: "", offset: 0, count: 12, workflow: "job", runId: "A", path: "job/work", provider: "anthropic", model: "x", routed: true, context: { used: 76_000, limit: 1_000_000 } },
  { turn: 1, at: "", offset: 12, count: 9, workflow: "job", runId: "B", path: "job/work", provider: "anthropic", model: "x", routed: true, context: { used: 130_000, limit: 1_000_000 } },
];

describe("job threads (plans/jobs-sidebar.md §1)", () => {
  // Runs handed over in no particular order.
  const threads = foldJobThreads([runD, runB, runE, runA, runC, runF], turnLines);

  it("groups executions by session into one thread, turns in order, chronological at the top", () => {
    assert.deepEqual(
      threads.map((t) => [t.id, t.session, t.label, t.turns.length]),
      [["S", true, "work", 2], ["D/report", false, "report", 1], ["E/job/work", false, "work", 1], ["F/job/work", false, "work", 1]],
    );
    const s = threads[0]!;
    assert.deepEqual(s.turns.map((t) => [t.turn, t.offset, t.runId, t.status, t.toolCalls, t.durationMs]), [[0, 0, "A", "success", 3, 86000], [1, 12, "B", "success", 4, 385000]]);
    assert.equal(s.startedAt, s.turns[0]!.at);
    assert.equal(s.updatedAt, s.turns[1]!.at);
  });

  it("a turn carries its usage, cost, the thread's context after it, and a transcript link (`?full=1` for a session turn)", () => {
    const [t0, t1] = threads[0]!.turns;
    assert.deepEqual([t0!.usage, t0!.cost, t0!.context], [usage(500), 0.6, { used: 76_000, limit: 1_000_000 }]);
    assert.equal(t0!.transcript, "/workflows/job/runs/A/transcripts/job/work?full=1");
    assert.deepEqual([t1!.cost, t1!.context?.used], [0.8, 130_000]);
    assert.equal(transcriptUrl("wf", "1", "wf/each#3/agent"), "/workflows/wf/runs/1/transcripts/wf/each%233/agent");
  });

  it("what a turn spawned hangs under it: a sub-agent by path, a child run by its launch, a peer run by strut/run-workflow", () => {
    const t1 = threads[0]!.turns[1]!;
    assert.deepEqual(
      t1.spawned.map((th) => [th.id, th.session, th.label, th.turns[0]!.runId, th.turns[0]!.stepType]),
      // Chronological: the fixture's child run started after the peer call.
      [["B/job/work/002-agent", false, "agent", "B", "tool:agent"], ["B/job/work/004-strut_run_workflow", false, "@acme explore", "B", "tool:strut/run-workflow"], ["C/explore/agent", false, "agent", "C", "agent"]],
    );
    const sub = t1.spawned[0]!.turns[0]!;
    assert.deepEqual([sub.toolCalls, sub.cost, sub.transcript], [1, 0.05, "/workflows/job/runs/B/transcripts/job/work/002-agent"]);
    const peer = t1.spawned[1]!.turns[0]!;
    assert.deepEqual([peer.peer, peer.cost, peer.transcript, peer.durationMs], [{ id: "acme", workflow: "explore", runId: "P1", status: "success" }, 0.5, undefined, 9000]);
    assert.equal(threads[0]!.turns[0]!.spawned.length, 0);
  });

  it("a run with no agent is one turn at its root; a failed attempt is an error turn; an open one is running", () => {
    const [, d, e, f] = threads;
    assert.deepEqual([d!.turns[0]!.stepType, d!.turns[0]!.status, d!.turns[0]!.artifacts?.map((a) => a.id), d!.turns[0]!.transcript], ["run", "success", ["report"], undefined]);
    assert.deepEqual([e!.turns[0]!.status, e!.turns[0]!.transcript, e!.turns[0]!.usage], ["error", undefined, undefined]);
    assert.deepEqual([f!.turns[0]!.status, f!.turns[0]!.toolCalls], ["running", 1]);
  });

  it("the run's deliverables ride on its last top-level turn", () => {
    assert.deepEqual(threads[0]!.turns[0]!.artifacts?.map((a) => a.id), ["plan"]);
    assert.equal(threads[0]!.turns[1]!.artifacts, undefined);
  });

  it("totals: a thread's own turns; jobTotals the whole tree, each turn once", () => {
    const s = threads[0]!.totals;
    assert.deepEqual([s.turns, s.cost, s.toolCalls, s.usage.outputTokens, s.context?.used], [2, 1.4, 7, 1200, 130_000]);
    const all = jobTotals(threads);
    // 0.6 + 0.8 + 0.05 (sub-agent) + 0.02 (child) + 0.5 (peer)
    assert.equal(all.cost.toFixed(2), "1.97");
    assert.equal(all.turns, 2 + 1 + 1 + 1 + 1 + 1 + 1);
    assert.equal("context" in all, false);
  });

  it("nodes: a count always, the nodes themselves on request", () => {
    assert.equal(threads[0]!.turns[0]!.nodeCount, 1);
    assert.equal(threads[0]!.turns[0]!.nodes, undefined);
    const withNodes = foldJobThreads([runA], [], { nodes: true });
    assert.deepEqual(withNodes[0]!.turns[0]!.nodes, [{ ref_id: "n1", node_type: "Concept", name: "Job" }]);
  });

  it("a child run whose parent is not among the runs is top-level", () => {
    const alone = foldJobThreads([runC]);
    assert.deepEqual(alone.map((t) => t.id), ["C/explore/agent"]);
  });

  it("a build on a peer: the skipped local agent is no turn, and the peer's turns are ONE thread (its session there)", () => {
    // Two turns of a builder job whose work is on @acme (builder.yaml's
    // shape: `here` gates the local `build` off, `remote` runs it there).
    const turn = (runId: string, peerRun: string, n: number): ThreadRun => {
      const at = ts();
      const events: RunEvent[] = [
        ev(runId, "run.start", "builder", { job: "J" }),
        ev(runId, "step.start", "builder/here", { stepType: "if" }),
        ev(runId, "step.end", "builder/here", { stepType: "if", output: false }),
        ev(runId, "step.skipped", "builder/build", { stepType: "agent" }),
        ev(runId, "step.start", "builder/remote", { stepType: "strut/run-workflow" }),
        ev(runId, "step.end", "builder/remote#launch", { output: { peer: "acme", workflow: "builder", runId: peerRun } }),
        ev(runId, "step.end", "builder/remote", {
          stepType: "strut/run-workflow",
          durationMs: 20_000,
          output: { peer: "acme", workflow: "builder", runId: peerRun, status: "success", output: { text: "built", cost: 0.3, session: { id: "peer/J", turn: n, offset: 0 } } },
        }),
        ev(runId, "run.end", "builder", { output: { text: "built" } }),
      ];
      return { workflow: "builder", runId, at, summary: summary(runId, "builder", "success"), events };
    };
    const folded = foldJobThreads([turn("R2", "P2", 1), turn("R1", "P1", 0)]);
    assert.deepEqual(folded.map((t) => [t.id, t.label, t.turns.length]), [["@acme/peer/J", "@acme builder", 2]]);
    assert.deepEqual(
      folded[0]!.turns.map((t) => [t.turn, t.runId, t.status, t.cost, t.peer]),
      [
        [0, "R1", "success", 0.3, { id: "acme", workflow: "builder", runId: "P1", status: "success", session: "peer/J" }],
        [1, "R2", "success", 0.3, { id: "acme", workflow: "builder", runId: "P2", status: "success", session: "peer/J" }],
      ],
    );
  });
});
