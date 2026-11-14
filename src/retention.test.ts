import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRetention, formatRetention, createRetention } from "./retention.js";
import { FileRunStore, MemoryRunStore, type RunStore } from "./store.js";
import { flowFromYaml, renderWorkflowYaml, assertValidWorkflowYaml } from "./workspace.js";
import { validateWorkflowYaml } from "./validate.js";
import type { RunSummary } from "./core.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-14T12:00:00Z");

test("parseRetention: durations, counts, invalid", () => {
  assert.deepEqual(parseRetention("30m"), { windowMs: 30 * 60_000 });
  assert.deepEqual(parseRetention("1h"), { windowMs: HOUR });
  assert.deepEqual(parseRetention("7d"), { windowMs: 7 * 24 * HOUR });
  assert.deepEqual(parseRetention({ runs: 20 }), { runs: 20 });
  for (const bad of ["", "abc", "0h", "20", 20, { runs: 0 }, { runs: 1.5 }, { runs: "3" }, { runs: 3, x: 1 }, [], true])
    assert.ok("error" in parseRetention(bad), JSON.stringify(bad));
  assert.deepEqual(parseRetention("20", { allowBare: true }), { runs: 20 });
  assert.deepEqual(parseRetention("runs:20", { allowBare: true }), { runs: 20 });
  assert.ok("error" in parseRetention("0", { allowBare: true }));
  assert.equal(formatRetention({ windowMs: HOUR }), "1h");
  assert.equal(formatRetention({ runs: 3 }), "runs:3");
});

test("retain: YAML load, validator and render round-trip", () => {
  const steps = [{ id: "a", type: "log", config: { message: "hi" } }];
  assert.deepEqual(flowFromYaml("w", "v1", renderWorkflowYaml("w", { steps, retain: "1h" })).retain, { windowMs: HOUR });
  assert.deepEqual(flowFromYaml("w", "v1", renderWorkflowYaml("w", { steps, retain: { runs: 5 } })).retain, { runs: 5 });
  assert.equal(flowFromYaml("w", "v1", renderWorkflowYaml("w", { steps })).retain, undefined);
  const yamlWith = (r: string) => `name: w\nretain: ${r}\nsteps:\n  - id: a\n    type: log\n    config:\n      message: hi\n`;
  assertValidWorkflowYaml(yamlWith("1h"));
  assertValidWorkflowYaml(yamlWith("{ runs: 3 }"));
  assert.throws(() => assertValidWorkflowYaml(yamlWith("soon")), /retain/);
  assert.throws(() => flowFromYaml("w", "v1", yamlWith("{ runs: 0 }")), /retain/);
  const v = validateWorkflowYaml(yamlWith("soon"), { registry: {} as never });
  assert.ok(!v.ok && v.errors.some((e) => /retain/.test(e.message)));
  assert.ok(!validateWorkflowYaml(yamlWith("1h"), { registry: {} as never }).errors.some((e) => /retain/.test(e.message)));
});

const summary = (runId: string, ageHours: number, extra: Partial<RunSummary> = {}): RunSummary => ({
  runId, workflow: "w", startedAt: new Date(NOW - ageHours * HOUR).toISOString(), finishedAt: new Date(NOW - ageHours * HOUR).toISOString(),
  durationMs: 1, status: "success", input: {}, ...extra,
});

async function seed(store: RunStore, id: string, s: RunSummary) {
  await store.append("w", id, { type: "run.start", ts: s.startedAt, runId: id } as never);
  await store.finalize("w", id, s);
}

function sweeper(store: RunStore, retain: unknown, fallback?: { windowMs: number } | { runs: number }, hasClaims?: (w: string, r: string) => Promise<boolean>) {
  const flow = retain === undefined ? {} : { retain: parseRetention(retain) as never };
  return createRetention({
    store,
    workspace: { listWorkflows: async () => [{ name: "w" }], getWorkflow: async () => flow },
    ...(fallback ? { fallback } : {}),
    ...(hasClaims ? { hasClaims } : {}),
    now: () => NOW,
  });
}

async function scenario(store: RunStore) {
  await seed(store, "1", summary("1", 5));
  await seed(store, "2", summary("2", 3));
  await seed(store, "3", summary("3", 0.5));
  await seed(store, "4", summary("4", 10, { status: "waiting" }));
  await store.append("w", "5", { type: "run.start", ts: new Date(NOW - 20 * HOUR).toISOString(), runId: "5" } as never); // in flight: no summary
}

for (const [label, make] of [["memory", async () => new MemoryRunStore() as RunStore], ["file", async () => new FileRunStore(await mkdtemp(join(tmpdir(), "ret-")))]] as const) {
  test(`sweep (${label}): window eviction keeps summary, skips running and waiting`, async () => {
    const store = await make();
    await scenario(store);
    assert.equal(await sweeper(store, "1h").sweep(), 2);
    for (const id of ["1", "2"]) {
      const s = await store.getRunSummary("w", id);
      assert.equal(s?.logEvicted, true);
      assert.ok(s?.evictedAt);
      assert.deepEqual(await store.getRunEvents("w", id), []);
    }
    assert.ok(!(await store.getRunSummary("w", "3"))?.logEvicted);
    assert.equal((await store.getRunEvents("w", "3")).length, 1);
    assert.ok(!(await store.getRunSummary("w", "4"))?.logEvicted);
    assert.equal((await store.getRunEvents("w", "5")).length, 1);
    assert.equal(await sweeper(store, "1h").sweep(), 0); // idempotent
  });

  test(`sweep (${label}): count eviction`, async () => {
    const store = await make();
    await scenario(store);
    assert.equal(await sweeper(store, { runs: 1 }).sweep(), 2); // newest finished: 3; evicts 2 and 1
    assert.ok(!(await store.getRunSummary("w", "3"))?.logEvicted);
    assert.equal((await store.getRunSummary("w", "1"))?.logEvicted, true);
  });

  test(`sweep (${label}): claimed, kept and artifact-referenced runs are skipped`, async () => {
    const store = await make();
    await seed(store, "1", summary("1", 5));
    await seed(store, "2", summary("2", 5, { kept: true } as never));
    await seed(store, "3", summary("3", 5));
    await seed(store, "4", summary("4", 5, { output: { artifacts: [{ id: "x", url: "/artifacts/3/out.txt" }] } }));
    await seed(store, "5", summary("5", 5, { output: { url: "/artifacts/5/self.txt" } })); // its own: not a reference
    const evicted = await sweeper(store, "1h", undefined, async (_w, id) => id === "1").sweep();
    assert.equal(evicted, 2); // 4 and 5
    for (const id of ["1", "2", "3"]) assert.ok(!(await store.getRunSummary("w", id))?.logEvicted, id);
    assert.equal((await store.getRunSummary("w", "5"))?.logEvicted, true);
  });

  test(`sweep (${label}): env default applies, workflow retain overrides, unset evicts nothing`, async () => {
    const mk = async () => { const s = await make(); await scenario(s); return s; };
    assert.equal(await sweeper(await mk(), undefined).sweep(), 0);
    assert.equal(await sweeper(await mk(), undefined, { windowMs: HOUR }).sweep(), 2);
    assert.equal(await sweeper(await mk(), "100h", { windowMs: HOUR }).sweep(), 0);
    assert.equal(await sweeper(await mk(), { runs: 2 }, { windowMs: HOUR }).sweep(), 1);
  });
}

test("FileRunStore.evictRun leaves only run.json in the run directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "ret-"));
  const store = new FileRunStore(root);
  await seed(store, "1", summary("1", 5));
  await store.setRunCallback("w", "1", "http://x");
  await store.evictRun("w", "1", new Date(NOW).toISOString());
  assert.deepEqual(await readdir(join(root, "workflows", "w", "runs", "1")), ["run.json"]);
  await assert.rejects(stat(join(root, "workflows", "w", "runs", "1", "events.jsonl")));
  assert.equal((await store.getRunSummary("w", "1"))?.logEvicted, true);
});
