import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRetention, formatRetention, createRetention, fleetRetentionFromEnv } from "./retention.js";
import { FileRunStore, MemoryRunStore, type RunStore } from "./store.js";
import { flowFromYaml, renderWorkflowYaml, assertValidWorkflowYaml } from "./workspace.js";
import { validateWorkflowYaml } from "./validate.js";
import { logEvicted, type RunSummary } from "./core.js";

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

function sweeper(store: RunStore, retain: unknown, fallback?: { windowMs: number } | { runs: number }, extra: Partial<Parameters<typeof createRetention>[0]> = {}) {
  const flow = retain === undefined ? {} : { retain: parseRetention(retain) as never };
  return createRetention({
    store,
    workspace: { listWorkflows: async () => [{ name: "w" }], getWorkflow: async () => flow },
    ...(fallback ? { fallback } : {}),
    isLive: (_w: string, id: string) => id === "5", // the scenario's in-flight run
    ...extra,
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

const roots = new WeakMap<object, string>();

/** A run that died with its process: a log, no summary. `lastWriteHoursAgo` is the log's mtime. */
async function seedCrashed(store: RunStore, id: string, lastWriteHoursAgo: number, opts: { paused?: boolean; parent?: string } = {}) {
  const ts = (h: number) => new Date(NOW - h * HOUR).toISOString();
  await store.append("w", id, { type: "run.start", ts: ts(lastWriteHoursAgo + 1), runId: id, ...(opts.parent ? { parentRunId: opts.parent } : {}) } as never);
  await store.append("w", id, { type: "step.start", ts: ts(lastWriteHoursAgo), runId: id } as never);
  if (opts.paused) await store.append("w", id, { type: "run.paused", ts: ts(lastWriteHoursAgo), runId: id } as never);
  const root = roots.get(store);
  if (root) {
    const when = new Date(NOW - lastWriteHoursAgo * HOUR);
    await utimes(join(root, "workflows", "w", "runs", id, "events.jsonl"), when, when);
  }
}

for (const [label, make] of [["memory", async () => new MemoryRunStore() as RunStore], ["file", async () => { const root = await mkdtemp(join(tmpdir(), "ret-")); const st = new FileRunStore(root); roots.set(st, root); return st as RunStore; }]] as const) {
  test(`sweep (${label}): window eviction keeps summary, skips running and waiting`, async () => {
    const store = await make();
    await scenario(store);
    const log = mock.method(console, "log", () => {});
    try {
      assert.equal(await sweeper(store, "1h").sweep(), 2);
      assert.equal(await sweeper(store, "1h").sweep(), 0); // idempotent, and quiet
    } finally {
      log.mock.restore();
    }
    assert.deepEqual(log.mock.calls.map((c) => c.arguments[0]), ["[retention] evicted 2 run log(s): w 2"]);
    for (const id of ["1", "2"]) {
      const s = await store.getRunSummary("w", id);
      assert.equal(logEvicted(s), true);
      assert.ok(s?.parts?.log?.evictedAt);
      assert.deepEqual(await store.getRunEvents("w", id), []);
    }
    assert.ok(!logEvicted(await store.getRunSummary("w", "3")));
    assert.equal((await store.getRunEvents("w", "3")).length, 1);
    assert.ok(!logEvicted(await store.getRunSummary("w", "4")));
    assert.equal((await store.getRunEvents("w", "5")).length, 1);
  });

  test(`sweep (${label}): count eviction`, async () => {
    const store = await make();
    await scenario(store);
    assert.equal(await sweeper(store, { runs: 1 }).sweep(), 2); // newest finished: 3; evicts 2 and 1
    assert.ok(!logEvicted(await store.getRunSummary("w", "3")));
    assert.equal(logEvicted(await store.getRunSummary("w", "1")), true);
  });

  test(`sweep (${label}): kept and artifact-referenced runs are skipped`, async () => {
    const store = await make();
    await seed(store, "2", summary("2", 5, { kept: true } as never));
    await seed(store, "3", summary("3", 5));
    await seed(store, "4", summary("4", 5, { output: { artifacts: [{ id: "x", url: "/artifacts/3/out.txt" }] } }));
    await seed(store, "5", summary("5", 5, { output: { url: "/artifacts/5/self.txt" } })); // its own: not a reference
    const evicted = await sweeper(store, "1h").sweep();
    assert.equal(evicted, 2); // 4 and 5
    for (const id of ["2", "3"]) assert.ok(!logEvicted(await store.getRunSummary("w", id)), id);
    assert.equal(logEvicted(await store.getRunSummary("w", "5")), true);
  });

  test(`sweep (${label}): env default applies, workflow retain overrides, unset evicts nothing`, async () => {
    const mk = async () => { const s = await make(); await scenario(s); return s; };
    assert.equal(await sweeper(await mk(), undefined).sweep(), 0);
    assert.equal(await sweeper(await mk(), undefined, { windowMs: HOUR }).sweep(), 2);
    assert.equal(await sweeper(await mk(), "100h", { windowMs: HOUR }).sweep(), 0);
    assert.equal(await sweeper(await mk(), { runs: 2 }, { windowMs: HOUR }).sweep(), 1);
  });
}


for (const [label, make] of [["memory", async () => new MemoryRunStore() as RunStore], ["file", async () => { const root = await mkdtemp(join(tmpdir(), "ret-")); const st = new FileRunStore(root); roots.set(st, root); return st as RunStore; }]] as const) {
  test(`crashed (${label}): evicted with a minimal summary`, async () => {
    const store = await make();
    await seedCrashed(store, "7", 3, { parent: "6" });
    assert.equal(await sweeper(store, "1h").sweep(), 1);
    const s = await store.getRunSummary("w", "7");
    assert.equal(s?.crashed, true);
    assert.equal(logEvicted(s), true);
    assert.equal(s?.status, "error");
    assert.equal(s?.parentRunId, "6");
    assert.equal(s?.finishedAt, new Date(NOW - 3 * HOUR).toISOString());
    assert.equal(s?.startedAt, new Date(NOW - 4 * HOUR).toISOString());
    assert.deepEqual(await store.getRunEvents("w", "7"), []);
    const root = roots.get(store);
    if (root) assert.deepEqual(await readdir(join(root, "workflows", "w", "runs", "7")), ["run.json"]);
    assert.equal(await sweeper(store, "1h").sweep(), 0);
  });

  test(`crashed (${label}): live, recent, paused and unsettled runs are untouched`, async () => {
    const store = await make();
    await seedCrashed(store, "1", 3); // live
    await seedCrashed(store, "2", 0.5); // written inside the window
    await seedCrashed(store, "3", 3, { paused: true }); // a human paused it
    await seedCrashed(store, "4", 3); // about to be resumed
    const live = (_w: string, id: string) => id === "1";
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    const r = sweeper(store, "1h", undefined, { isLive: live, resumeSettled: settled });
    const pending = r.sweep();
    await new Promise((res) => setTimeout(res, 20));
    for (const id of ["1", "2", "3", "4"]) assert.equal(await store.getRunSummary("w", id), null, `${id} before settle`);
    settle();
    assert.equal(await pending, 1); // only 4
    for (const id of ["1", "2", "3"]) assert.equal(await store.getRunSummary("w", id), null, id);
    assert.equal((await store.getRunSummary("w", "4"))?.crashed, true);
  });

  test(`crashed (${label}): count form counts it in order and needs 1h of silence`, async () => {
    const store = await make();
    await seed(store, "1", summary("1", 9));
    await seedCrashed(store, "2", 2); // stale: counted, 2nd newest
    await seed(store, "3", summary("3", 0.2));
    await seedCrashed(store, "4", 0.5); // inside the floor: neither counted nor touched
    assert.equal(await sweeper(store, { runs: 2 }).sweep(), 1); // newest two counted: 3, 2 → evicts 1
    assert.equal(logEvicted(await store.getRunSummary("w", "1")), true);
    assert.equal(await store.getRunSummary("w", "2"), null);
    assert.equal(await store.getRunSummary("w", "4"), null);
    assert.equal(await sweeper(store, { runs: 1 }).sweep(), 1); // now 2 is beyond the newest 1
    assert.equal((await store.getRunSummary("w", "2"))?.crashed, true);
    assert.equal(await store.getRunSummary("w", "4"), null);
  });

  test(`crashed (${label}): an artifact reference holds`, async () => {
    const store = await make();
    await seedCrashed(store, "2", 3); // referenced
    await seedCrashed(store, "3", 3);
    await seed(store, "9", summary("9", 0.1, { output: { url: "/artifacts/2/x.txt" } }));
    const n = await sweeper(store, "1h").sweep();
    assert.equal(n, 1);
    assert.equal(await store.getRunSummary("w", "2"), null);
    assert.equal((await store.getRunSummary("w", "3"))?.crashed, true);
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
  assert.equal(logEvicted(await store.getRunSummary("w", "1")), true);
});

test("a summary retention's first build wrote (`logEvicted` + `evictedAt`) reads as parts.log", async () => {
  const root = await mkdtemp(join(tmpdir(), "ret-"));
  const store = new FileRunStore(root);
  const at = new Date(NOW).toISOString();
  await store.finalize("w", "1", { ...summary("1", 5), logEvicted: true, evictedAt: at } as never);
  await store.finalize("w", "2", { ...summary("2", 5), logEvicted: true } as never);
  const one = await store.getRunSummary("w", "1");
  assert.deepEqual(one?.parts, { log: { evictedAt: at } });
  assert.ok(!("logEvicted" in one!) && !("evictedAt" in one!));
  // No `evictedAt` (never written without it, but read safely): the run's finish.
  assert.equal((await store.getRunSummary("w", "2"))?.parts?.log?.evictedAt, summary("2", 5).finishedAt);
  // A sweep counts it as evicted and leaves it as it is.
  assert.equal(await sweeper(store, "1h").sweep(), 0);
});

test("STRUT_RETENTION is the fleet default, STRUT_RUN_RETENTION its first name", () => {
  assert.equal(fleetRetentionFromEnv({}), undefined);
  assert.deepEqual(fleetRetentionFromEnv({ STRUT_RETENTION: "7d" }), { retention: { windowMs: 7 * 24 * HOUR }, env: "STRUT_RETENTION" });
  assert.deepEqual(fleetRetentionFromEnv({ STRUT_RUN_RETENTION: "20" }), { retention: { runs: 20 }, env: "STRUT_RUN_RETENTION" });
  // Both set: the new name wins.
  assert.deepEqual(fleetRetentionFromEnv({ STRUT_RETENTION: "1h", STRUT_RUN_RETENTION: "20" }), { retention: { windowMs: HOUR }, env: "STRUT_RETENTION" });
  const warn = mock.method(console, "warn", () => {});
  try {
    assert.equal(fleetRetentionFromEnv({ STRUT_RETENTION: "soon" }), undefined);
  } finally {
    warn.mock.restore();
  }
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /ignoring STRUT_RETENTION="soon"/);
});
