import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { flow, step } from "../../core.js";
import { runWorkflow } from "../../runner.js";
import { coreRegistry } from "../registry.js";
import { MemoryRunStore } from "../../store.js";

describe("pack (core)", () => {
  it("returns the resolved config as the step output — the workflow's return value", async () => {
    const wf = flow("pack-test", {
      input: z.object({ repo: z.string() }),
      steps: [
        step("a", "log", { message: "one" }),
        step("b", "log", { message: "two" }, { depends: [] }),
        step("result", "pack", {
          repo: "{{ input.repo }}",
          first: "{{ a }}",
          second: "{{ b }}",
          n: "{{ 1 + 2 }}",
          nested: { ok: true, list: ["{{ input.repo }}", "x"] },
        }, { depends: ["a", "b"] }),
      ],
    });
    const result = await runWorkflow(wf, { repo: "stakgraph" }, coreRegistry(), { store: new MemoryRunStore() });
    assert.equal(result.status, "success", JSON.stringify(result.error));
    assert.deepEqual(result.output, {
      repo: "stakgraph",
      first: "one",
      second: "two",
      n: 3,
      nested: { ok: true, list: ["stakgraph", "x"] },
    });
  });
});

describe("$runId in template scope", () => {
  it("resolves to the run's id at the top level and inside a foreach body", async () => {
    const wf = flow("runid-test", {
      input: z.object({}),
      steps: [
        step("each", "foreach", { items: [1, 2], body: { id: "inner", type: "pack", config: { r: "{{ $runId }}", i: "{{ $index }}" } } }),
        step("result", "pack", { link: "/artifacts/{{ $runId }}/clip.mp4", inner: "{{ each }}" }, { depends: ["each"] }),
      ],
    });
    const result = await runWorkflow(wf, {}, coreRegistry(), { store: new MemoryRunStore() });
    assert.equal(result.status, "success", JSON.stringify(result.error));
    assert.deepEqual(result.output, {
      link: `/artifacts/${result.runId}/clip.mp4`,
      inner: [
        { r: result.runId, i: 0 },
        { r: result.runId, i: 1 },
      ],
    });
  });
});
