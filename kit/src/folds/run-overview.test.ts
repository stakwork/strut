import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { foldRunOverview, runAppLabel, type OverviewEvent } from "./run-overview.js";

const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);
const ev = (s: number, type: string, path: string, extra: Partial<OverviewEvent> = {}): OverviewEvent => ({
  ts: new Date(T0 + s * 1000).toISOString(),
  type,
  path,
  ...extra,
});
const usage = (n: number) => ({ inputTokens: n, cacheReadTokens: 10 * n, cacheWriteTokens: 0, outputTokens: n, totalTokens: 12 * n });

/** A job-shaped run: a directory step, an agent that calls a sub-agent and
 *  waits on a child run, an llm summary, a pack. */
const jobRun: OverviewEvent[] = [
  ev(0, "run.start", "job", { actor: "evan-1", job: "settings-fix" }),
  ev(0, "step.start", "job/dir", { stepType: "job/dir" }),
  ev(1, "step.end", "job/dir", { stepType: "job/dir", output: { path: "/x" } }),
  ev(1, "step.start", "job/work", { stepType: "agent" }),
  ev(2, "step.start", "job/work/001-bash", { stepType: "tool:bash" }),
  ev(3, "step.end", "job/work/001-bash", { stepType: "tool:bash", output: "ok" }),
  ev(4, "step.start", "job/work/002-agent", { stepType: "tool:agent" }),
  ev(5, "step.start", "job/work/002-agent/001-bash", { stepType: "tool:bash" }),
  ev(6, "step.end", "job/work/002-agent/001-bash", { stepType: "tool:bash", output: "ok" }),
  ev(30, "step.end", "job/work/002-agent", { stepType: "tool:agent", output: '{"result":"x… [… truncated', modelCalls: 4, usage: usage(10), cost: 0.5 }),
  ev(31, "step.start", "job/work/003-meta_run_workflow", { stepType: "tool:meta_run_workflow", input: { name: "pod-pr", input: {} } }),
  ev(60, "step.end", "job/work/003-meta_run_workflow", { stepType: "tool:meta_run_workflow", output: '{"runId":"1790000000001","status":"success","output":{…', modelCalls: 2, usage: usage(5), cost: 0.25 }),
  ev(61, "step.end", "job/work", { stepType: "agent", output: { result: "done", cost: 1, steps: 6 }, modelCalls: 6, usage: usage(20), cost: 1 }),
  ev(61, "step.start", "job/summarize", { stepType: "llm" }),
  ev(63, "step.end", "job/summarize", { stepType: "llm", output: { text: "s", cost: 0.125 }, modelCalls: 1, usage: usage(1), cost: 0.125 }),
  ev(63, "step.start", "job/pack", { stepType: "pack" }),
  ev(64, "step.end", "job/pack", { stepType: "pack", output: {} }),
  ev(64, "run.end", "job", { output: {} }),
];

describe("foldRunOverview", () => {
  it("adds up what the run spent — sub-agents and waited-on runs included — and how long it took", () => {
    const o = foldRunOverview(jobRun);
    assert.equal(o.status, "success");
    assert.equal(o.durationMs, 64_000);
    assert.equal(o.cost, 1.875);
    assert.equal(o.modelCalls, 13);
    assert.equal(o.toolCalls, 4);
    assert.equal(o.steps, 4);
    assert.equal(o.usage.cacheReadTokens, 360);
    assert.equal(o.actor, "evan-1");
    assert.equal(o.job, "settings-fix");
    assert.deepEqual(o.longest, { label: "work", share: 60 / 64 });
  });

  it("lists the top-level steps, and under each the work it started that a person opens", () => {
    const o = foldRunOverview(jobRun);
    assert.deepEqual(
      o.rows.map((r) => [r.depth, r.label, r.kind, r.cost]),
      [
        [0, "dir", "step", 0],
        [0, "work", "agent", 1],
        [1, "agent", "subagent", 0.5],
        [1, "pod-pr", "run", 0.25],
        [0, "summarize", "llm", 0.125],
        [0, "pack", "step", 0],
      ],
    );
    const work = o.rows.find((r) => r.label === "work")!;
    assert.equal(work.toolCalls, 3, "its own calls, not the sub-agent's");
    assert.deepEqual([work.start, work.end], [1000, 61_000]);
    const child = o.rows.find((r) => r.kind === "run")!;
    assert.deepEqual(child.child, { runId: "1790000000001", workflow: "pod-pr" });
    assert.equal(child.parent, "work");
  });

  it("reads an agent's and an llm step's own output in a log from before the spend fields", () => {
    const o = foldRunOverview([
      ev(0, "run.start", "old"),
      ev(0, "step.start", "old/a", { stepType: "agent" }),
      ev(5, "step.end", "old/a", { stepType: "agent", output: { result: "r", steps: 3, usage: usage(2), cost: 0.3 } }),
      ev(5, "step.start", "old/b", { stepType: "llm" }),
      ev(6, "step.end", "old/b", { stepType: "llm", output: { text: "t", usage: usage(1), cost: 0.1 } }),
      ev(6, "run.end", "old"),
    ]);
    assert.equal(o.cost, 0.4);
    assert.equal(o.modelCalls, 4);
  });

  it("folds a foreach's iterations into its row", () => {
    const o = foldRunOverview([
      ev(0, "run.start", "fe"),
      ev(0, "step.start", "fe/each", { stepType: "foreach" }),
      ...[0, 1, 2].flatMap((i) => [
        ev(i, "step.start", `fe/each#${i}`, { stepType: "llm" }),
        ev(i + 1, "step.end", `fe/each#${i}`, { stepType: "llm", modelCalls: 1, cost: 0.5 }),
      ]),
      ev(3, "step.end", "fe/each", { stepType: "foreach", output: [] }),
      ev(3, "run.end", "fe"),
    ]);
    assert.equal(o.rows.length, 1);
    assert.deepEqual([o.rows[0]!.label, o.rows[0]!.kind, o.rows[0]!.count, o.rows[0]!.cost], ["each", "loop", 3, 1.5]);
    assert.equal(o.cost, 1.5);
  });

  it("keeps each row's own tokens", () => {
    const o = foldRunOverview(jobRun);
    assert.deepEqual(o.rows.map((r) => [r.label, r.usage.totalTokens]), [["dir", 0], ["work", 240], ["agent", 120], ["pod-pr", 60], ["summarize", 12], ["pack", 0]]);
  });

  /** A subflow whose agent calls a sub-agent, and a foreach of agents run in parallel. */
  const report: OverviewEvent[] = [
    ev(0, "run.start", "r"),
    ev(0, "step.start", "r/sub", { stepType: "subflow" }),
    ev(1, "step.start", "r/sub/inner", { stepType: "subflow" }),
    ev(1, "step.start", "r/sub/inner/a", { stepType: "agent" }),
    ev(2, "step.start", "r/sub/inner/a/001-agent", { stepType: "tool:agent" }),
    ev(3, "step.start", "r/sub/inner/a/001-agent/001-bash", { stepType: "tool:bash" }),
    ev(4, "step.end", "r/sub/inner/a/001-agent/001-bash", { stepType: "tool:bash" }),
    ev(5, "step.end", "r/sub/inner/a/001-agent", { stepType: "tool:agent", modelCalls: 2, usage: usage(1), cost: 0.1 }),
    ev(6, "step.end", "r/sub/inner/a", { stepType: "agent", modelCalls: 3, usage: usage(2), cost: 0.2 }),
    ev(6, "step.end", "r/sub/inner", { stepType: "subflow" }),
    ev(6, "step.end", "r/sub", { stepType: "subflow" }),
    ev(6, "step.start", "r/each", { stepType: "foreach" }),
    ...[0, 1].flatMap((i) => [
      ev(6, "step.start", `r/each#${i}`, { stepType: "agent" }),
      ev(7, "step.start", `r/each#${i}/001-llm`, { stepType: "tool:llm" }),
      ev(8, "step.end", `r/each#${i}/001-llm`, { stepType: "tool:llm", modelCalls: 1, usage: usage(1), cost: 0.01 }),
      ev(10 + i, "step.end", `r/each#${i}`, { stepType: "agent", modelCalls: 2, usage: usage(3), cost: 0.3 }),
    ]),
    ev(11, "step.end", "r/each", { stepType: "foreach" }),
    ev(11, "run.end", "r"),
  ];

  it("with `tree`, puts each row under the nearest row above it, at its true depth", () => {
    assert.deepEqual(
      foldRunOverview(report).rows.map((r) => [r.depth, r.label, r.count]),
      [[0, "sub", 1], [1, "a", 1], [1, "agent", 1], [0, "each", 2], [1, "llm", 2]],
      "by default: everything one level under its top-level step",
    );
    assert.deepEqual(
      foldRunOverview(report, undefined, { tree: true }).rows.map((r) => [r.depth, r.label, r.parent ?? null]),
      [[0, "sub", null], [1, "inner", "sub"], [2, "a", "inner"], [3, "agent", "a"], [0, "each", null], [1, "llm", "each"]],
    );
  });

  it("with `split`, shows a foreach's iterations as rows of their own, side by side, each with its own spend", () => {
    const o = foldRunOverview(report, undefined, { tree: true, split: true });
    assert.deepEqual(o.rows.slice(4).map((r) => [r.depth, r.label, r.count, r.start, r.end, r.cost]), [
      [0, "each", 1, 6000, 11_000, 0],
      [1, "each#0", 1, 6000, 10_000, 0.3],
      [2, "llm", 1, 7000, 8000, 0.01],
      [1, "each#1", 1, 6000, 11_000, 0.3],
      [2, "llm", 1, 7000, 8000, 0.01],
    ]);
    assert.equal(o.cost, foldRunOverview(report).cost, "the totals do not change");
  });

  it("runs a live run's clock and its open rows up to now", () => {
    const now = T0 + 90_000;
    const o = foldRunOverview(jobRun.slice(0, 5), now);
    assert.equal(o.status, "running");
    assert.equal(o.durationMs, 90_000);
    const work = o.rows.find((r) => r.label === "work")!;
    assert.deepEqual([work.status, work.end], ["running", 90_000]);
  });

  it("names the deepest step a failure came from, never a tool call the agent went past", () => {
    const o = foldRunOverview([
      ev(0, "run.start", "f"),
      ev(0, "step.start", "f/sub", { stepType: "subflow" }),
      ev(1, "step.start", "f/sub/a", { stepType: "agent" }),
      ev(2, "step.error", "f/sub/a/001-bash", { stepType: "tool:bash", error: { message: "exit 1" } }),
      ev(3, "step.error", "f/sub/a", { stepType: "agent", error: { message: "boom" } }),
      ev(3, "step.error", "f/sub", { stepType: "subflow", error: { message: "boom" } }),
      ev(3, "run.error", "f", { error: { message: "boom" } }),
    ]);
    assert.equal(o.status, "error");
    assert.deepEqual(o.error, { path: "f/sub/a", message: "boom" });
    assert.deepEqual(o.rows.map((r) => [r.label, r.status]), [["sub", "error"], ["a", "error"]]);
  });

  it("never counts a replayed step's spend again", () => {
    const o = foldRunOverview([
      ev(0, "run.start", "r"),
      ev(0, "step.start", "r/a", { stepType: "agent" }),
      ev(5, "step.end", "r/a", { stepType: "agent", output: { cost: 1, steps: 2 }, modelCalls: 2, cost: 1 }),
      ev(6, "run.error", "r", { error: { message: "later" } }),
      ev(10, "run.resumed", "r"),
      ev(10, "step.replayed", "r/a", { stepType: "agent", output: { cost: 1, steps: 2 } }),
      ev(11, "run.end", "r"),
    ]);
    assert.equal(o.status, "success");
    assert.equal(o.cost, 1);
  });
});

describe("the app a run worked for", () => {
  it("is a workspace app at a version; the overview carries it from run.start, and a badge names it", () => {
    const app = { name: "bench", version: "v2" };
    const o = foldRunOverview([ev(0, "run.start", "wf", { app }), ev(1, "run.end", "wf")]);
    assert.deepEqual(o.app, app);
    assert.equal(runAppLabel(app), "bench");
  });
});

describe("the files a run was launched with", () => {
  it("come from run.start; a run without any has none", () => {
    const attachments = [{ name: "brief.pdf", mediaType: "application/pdf", size: 1234, path: "attachments/brief.pdf" }];
    const o = foldRunOverview([ev(0, "run.start", "wf", { attachments }), ev(1, "run.end", "wf")]);
    assert.deepEqual(o.attachments, attachments);
    assert.equal(foldRunOverview([ev(0, "run.start", "wf", { attachments: [] }), ev(1, "run.end", "wf")]).attachments, undefined);
  });
});
