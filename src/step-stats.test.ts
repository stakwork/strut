import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { stepStats } from "./step-stats.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore, stepRunKey } from "./store.js";
import { defineStep, flow, step, type RunEvent, type RunSummary } from "./core.js";
import { createRegistry } from "./steps/registry.js";
import { runWorkflow } from "./runner.js";
import { buildJournal } from "./journal.js";

const ev = (type: string, stepType: string, ts: string): RunEvent => ({ type, path: "p", stepType, ts }) as unknown as RunEvent;

describe("stepStats", () => {
  let dir: string;
  let ws: WorkspaceManager;
  const store = new MemoryRunStore();

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-step-stats-"));
    ws = new WorkspaceManager(dir);
    await ws.publishWorkflow("child", "v1", { steps: [{ id: "a", type: "http", config: { url: "x" } }] });
    await ws.publishWorkflow("parent", "v1", { steps: [{ id: "c", type: "subflow", config: { workflow: "child" } }] });
    await ws.publishWorkflow("agenty", "v1", { steps: [{ id: "g", type: "agent", config: { prompt: "p", agentTools: ["ht*"] } }] });
    await ws.publishWorkflow("other", "v1", { steps: [{ id: "l", type: "log", config: { message: "hi" } }] });

    await store.append("child", "1", ev("step.end", "http", "2026-09-01T00:00:00Z"));
    await store.append("parent", "2", ev("step.start", "http", "2026-09-02T00:00:00Z"));
    await store.append("parent", "2", ev("step.error", "http", "2026-09-02T00:00:01Z"));
    await store.append("agenty", "3", ev("step.end", "tool:http", "2026-09-03T00:00:00Z"));
    await store.append("agenty", "3", ev("step.replayed", "http", "2026-09-04T00:00:00Z"));
    await store.append("other", "4", ev("step.end", "http", "2026-09-05T00:00:00Z")); // not a user: never scanned
    await store.append(stepRunKey("http"), "5", ev("step.end", "http", "2026-09-06T00:00:00Z"));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it("lists the workflows that can run the step and counts its executions", async () => {
    const s = await stepStats(ws, store, "http");
    assert.deepEqual(
      s.workflows.sort((a, b) => a.name.localeCompare(b.name)),
      [{ name: "agenty", direct: true }, { name: "child", direct: true }, { name: "parent", direct: false }],
    );
    assert.deepEqual(s.runs, { total: 4, success: 3, error: 1, lastAt: "2026-09-06T00:00:00Z" });
  });

  it("reads a finished run's counts off its summary, not its log", async () => {
    const summary = { runId: "6", workflow: "child", startedAt: "", finishedAt: "", durationMs: 0, status: "success", input: {} } as RunSummary;
    await store.append("child", "6", ev("step.end", "http", "2026-09-07T00:00:00Z"));
    await store.finalize("child", "6", { ...summary, stepCounts: { http: { success: 0, error: 7, lastAt: "2026-09-08T00:00:00Z" } } });
    const s = await stepStats(ws, store, "http");
    assert.deepEqual(s.runs, { total: 11, success: 3, error: 8, lastAt: "2026-09-08T00:00:00Z" });
  });

  it("backfills a summary written before stepCounts existed", async () => {
    await store.append("child", "7", ev("step.end", "http", "2026-09-01T00:00:00Z"));
    await store.finalize("child", "7", { runId: "7", workflow: "child", startedAt: "", finishedAt: "", durationMs: 0, status: "success", input: {} });
    await stepStats(ws, store, "http");
    assert.deepEqual(store.getSummary("child", "7")?.stepCounts, { http: { success: 1, error: 0, lastAt: "2026-09-01T00:00:00Z" } });
  });

  it("reports nothing for an unused step", async () => {
    const s = await stepStats(ws, store, "wait");
    assert.deepEqual(s, { type: "wait", workflows: [], runs: { total: 0, success: 0, error: 0, lastAt: null } });
  });
});

describe("RunSummary.stepCounts", () => {
  it("counts every execution in the run, across a resume", async () => {
    let fail = true;
    const flaky = defineStep({
      type: "flaky",
      input: z.object({}),
      output: z.any(),
      async run() {
        if (fail) throw new Error("boom");
        return 1;
      },
    });
    const registry = await createRegistry([flaky]);
    const wf = flow("wf", {
      input: z.object({}),
      steps: [step("a", "log", { message: "hi" }), step("b", "flaky", {})],
    });
    const store = new MemoryRunStore();

    await runWorkflow(wf, {}, registry, { runId: "r1", store });
    assert.deepEqual(
      Object.fromEntries(Object.entries(store.getSummary("wf", "r1")!.stepCounts!).map(([k, v]) => [k, [v.success, v.error]])),
      { log: [1, 0], flaky: [0, 1] },
    );

    fail = false;
    const journal = buildJournal(store.getEvents("wf", "r1"));
    await runWorkflow(wf, {}, registry, { runId: "r1", store, journal, resume: true });
    // `a` was replayed, not re-run: still one execution. `b` failed, then succeeded.
    assert.deepEqual(
      Object.fromEntries(Object.entries(store.getSummary("wf", "r1")!.stepCounts!).map(([k, v]) => [k, [v.success, v.error]])),
      { log: [1, 0], flaky: [1, 1] },
    );
  });
});
