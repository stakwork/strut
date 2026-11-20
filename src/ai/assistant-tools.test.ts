import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RunSummary } from "../core.js";
import { MemoryRunStore } from "../store.js";
import { RUN_LIST_SCAN_MAX } from "../runs.js";
import { buildAssistantTools, type AssistantDeps } from "./assistant-tools.js";

describe("assistant list_runs", () => {
  it("looks through the newest RUN_LIST_SCAN_MAX runs, no further, and says so", async () => {
    const store = new MemoryRunStore();
    const total = RUN_LIST_SCAN_MAX + 300;
    const base = 1_790_000_000_000;
    for (let i = 0; i < total; i++) {
      const runId = String(base + i);
      // Only the OLDEST run failed: a status filter would read them all to find it.
      const status = i === 0 ? "error" : "success";
      await store.finalize("busy", runId, { runId, workflow: "busy", startedAt: new Date(base + i).toISOString(), finishedAt: "", durationMs: 0, status, input: {} } as RunSummary);
    }
    let reads = 0;
    const getRunSummary = store.getRunSummary.bind(store);
    store.getRunSummary = (w, r) => (reads++, getRunSummary(w, r));
    const tools = buildAssistantTools({ store, publicUrl: "http://strut.test", artifactRefs: async () => undefined } as unknown as AssistantDeps);
    const list = (args: Record<string, unknown>) =>
      tools["list_runs"]!.execute!({ workflow: "busy", limit: 20, ...args }, { toolCallId: "t", messages: [] }) as Promise<{ runs: Array<{ runId: string }>; total: number; note?: string }>;

    const failed = await list({ status: "error" });
    assert.deepEqual(failed.runs, []);
    assert.equal(reads, RUN_LIST_SCAN_MAX, "a rare status reads the newest RUN_LIST_SCAN_MAX summaries, not every one");
    assert.match(failed.note ?? "", /newest 1000 runs/);
    assert.equal(failed.total, total);

    reads = 0;
    const page = await list({});
    assert.equal(page.runs.length, 20);
    assert.equal(reads, 20);
    assert.equal(page.note, undefined, "a full page needs no note");

    reads = 0;
    assert.equal((await list({ limit: 100_000 })).runs.length, 500, "limit is capped as run/list caps it");
    assert.equal(reads, 500);
  });
});
