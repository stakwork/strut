import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { latestAttempt } from "./step-attempt";

const ev = (type: string, path: string, extra: Record<string, unknown> = {}) => ({ type, path, ...extra });
const types = (es: { type: string }[]) => es.map((e) => e.type);

describe("latestAttempt", () => {
  it("a step that failed and was run again from it: only the re-run", () => {
    const log = [
      ev("run.start", "wf"),
      ev("step.start", "wf/fetch"),
      ev("step.end", "wf/fetch"),
      ev("step.start", "wf/merged", { input: { n: 1 } }),
      ev("step.error", "wf/merged", { error: { message: "boom" } }),
      ev("run.error", "wf"),
      ev("run.resumed", "wf"),
      ev("step.replayed", "wf/fetch"),
      ev("step.start", "wf/merged", { input: { n: 2 } }),
      ev("step.end", "wf/merged", { output: "ok" }),
      ev("run.end", "wf"),
    ];
    const merged = latestAttempt(log, "wf/merged");
    assert.deepEqual(types(merged), ["step.start", "step.end"]);
    assert.deepEqual(merged[0], ev("step.start", "wf/merged", { input: { n: 2 } }));
    // A replayed step keeps the attempt it replays.
    assert.deepEqual(types(latestAttempt(log, "wf/fetch")), ["step.start", "step.end", "step.replayed"]);
  });

  it("a retry's attempt begins at its own step.start", () => {
    const log = [
      ev("step.start", "wf/a"),
      ev("step.retry", "wf/a"),
      ev("step.start", "wf/a"),
      ev("step.error", "wf/a"),
    ];
    assert.deepEqual(types(latestAttempt(log, "wf/a")), ["step.start", "step.error"]);
  });

  it("a step the re-run skipped is skipped, not its earlier error", () => {
    const log = [
      ev("step.start", "wf/b"),
      ev("step.error", "wf/b"),
      ev("run.resumed", "wf"),
      ev("step.skipped", "wf/b"),
    ];
    assert.deepEqual(types(latestAttempt(log, "wf/b")), ["step.skipped"]);
  });

  it("a step running again after an error is running", () => {
    const log = [ev("step.start", "wf/c"), ev("step.error", "wf/c"), ev("step.start", "wf/c")];
    assert.deepEqual(types(latestAttempt(log, "wf/c")), ["step.start"]);
  });

  it("only that path; nothing begun → every event at it", () => {
    const log = [ev("step.start", "wf/d"), ev("step.start", "wf/d/001-bash"), ev("step.replayed", "wf/e")];
    assert.deepEqual(types(latestAttempt(log, "wf/e")), ["step.replayed"]);
    assert.deepEqual(latestAttempt(log, "wf/none"), []);
  });
});
