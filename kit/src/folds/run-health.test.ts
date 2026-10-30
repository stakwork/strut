import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { foldRunHealth, type HealthEvent } from "./run-health.js";

const T0 = Date.UTC(2026, 9, 21, 9, 0, 0);
const ev = (s: number, type: string, path: string, extra: Partial<HealthEvent> = {}): HealthEvent => ({ ts: new Date(T0 + s * 1000).toISOString(), type, path, ...extra });
const usage = (n: number) => ({ inputTokens: n, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: n, totalTokens: 2 * n });

/** A run that went wrong in every way it can and still ended. */
const run: HealthEvent[] = [
  ev(0, "run.start", "wf"),
  // A fetch that failed once and then held.
  ev(0, "step.start", "wf/fetch", { stepType: "http" }),
  ev(1, "step.retry", "wf/fetch", { stepType: "http", iteration: 1 }),
  ev(1, "step.start", "wf/fetch", { stepType: "http" }),
  ev(2, "step.end", "wf/fetch", { stepType: "http", output: {} }),
  // A gate, a branch it skipped.
  ev(2, "step.start", "wf/gate", { stepType: "if" }),
  ev(2, "step.end", "wf/gate", { stepType: "if", output: false }),
  ev(2, "step.skipped", "wf/post", { stepType: "http" }),
  // An agent that goes past two failed tool calls.
  ev(3, "step.start", "wf/work", { stepType: "agent" }),
  ev(4, "step.start", "wf/work/001-bash", { stepType: "tool:bash" }),
  ev(5, "step.error", "wf/work/001-bash", { stepType: "tool:bash", error: { message: "exit 1" } }),
  ev(5, "step.start", "wf/work/002-bash", { stepType: "tool:bash" }),
  ev(6, "step.error", "wf/work/002-bash", { stepType: "tool:bash", error: { message: "exit 2" } }),
  ev(6, "step.start", "wf/work/003-graph_graph_get", { stepType: "tool:graph_graph_get" }),
  ev(7, "step.end", "wf/work/003-graph_graph_get", { stepType: "tool:graph_graph_get" }),
  ev(9, "step.end", "wf/work", { stepType: "agent", modelCalls: 4, usage: usage(10), cost: 0.5 }),
  // A step whose onError stood in for it.
  ev(9, "step.start", "wf/parse", { stepType: "exec" }),
  ev(10, "step.start", "wf/parse/onError", { stepType: "log" }),
  ev(10, "step.end", "wf/parse/onError", { stepType: "log" }),
  // A subflow whose child failed: one error, the child's.
  ev(10, "step.start", "wf/sub", { stepType: "subflow" }),
  ev(10, "step.start", "wf/sub/a", { stepType: "exec" }),
  ev(11, "step.error", "wf/sub/a", { stepType: "exec", error: { message: "boom" } }),
  ev(11, "step.error", "wf/sub", { stepType: "subflow", error: { message: "boom" } }),
  // Still running when the run failed.
  ev(10, "step.start", "wf/slow", { stepType: "exec" }),
  ev(12, "run.error", "wf", { error: { message: "boom" } }),
];

describe("foldRunHealth", () => {
  it("names what went wrong: the deepest failure, retries, a fallback, skips, branches, what was cut off", () => {
    const h = foldRunHealth(run);
    assert.equal(h.status, "error");
    assert.deepEqual(h.errors.map((e) => [e.label, e.stepType, e.message]), [["sub/a", "exec", "boom"]]);
    assert.deepEqual(h.retries.map((r) => [r.label, r.attempts, r.outcome]), [["fetch", 2, "success"]]);
    assert.deepEqual(h.recovered.map((r) => [r.label, r.stepType]), [["parse", "exec"]]);
    assert.deepEqual(h.skipped.map((s) => s.label), ["post"]);
    assert.deepEqual(h.branches.map((b) => [b.label, b.taken]), [["gate", "else"]]);
    assert.deepEqual(h.unfinished.map((s) => s.label), ["slow"]);
  });

  it("counts an agent's failed tool calls by tool, never as the run's errors", () => {
    const h = foldRunHealth(run);
    assert.deepEqual(h.tools, { calls: 3, failed: 2, byTool: [{ tool: "bash", calls: 2, failed: 2, last: "exit 2" }] });
  });

  it("keeps the log's own numbers", () => {
    const { stats } = foldRunHealth(run);
    assert.deepEqual({ ...stats, usage: stats.usage.totalTokens }, { events: run.length, steps: 6, replayed: 0, resumes: 0, pauses: 0, modelCalls: 4, usage: 20, cost: 0.5, durationMs: 12_000 });
  });

  it("calls nothing unfinished while the run is in flight, and counts a resume's replays", () => {
    const live = foldRunHealth(run.slice(0, -1));
    assert.equal(live.status, "running");
    assert.deepEqual(live.unfinished, []);
    const resumed = foldRunHealth([
      ...run,
      ev(20, "run.resumed", "wf"),
      ev(20, "step.replayed", "wf/fetch", { stepType: "http" }),
      ev(21, "run.end", "wf"),
    ]);
    assert.deepEqual([resumed.status, resumed.stats.resumes, resumed.stats.replayed], ["success", 1, 1]);
  });
});
