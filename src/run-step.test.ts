import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineStep, type StepRegistry } from "./core.js";
import { coreRegistry } from "./steps/registry.js";
import { runSingleStep, runStep, cassettePath } from "./run-step.js";
import { FileRunStore, MemoryRunStore, stepRunKey } from "./store.js";
import { standardServices, type FetchLike } from "./capabilities.js";

// A fake fetch returning canned JSON, recording how many times it was called.
function fakeFetch(
  handler: (url: string, init: any) => unknown,
): FetchLike & { count: number } {
  const fn = (async (url: string, init: any = {}) => {
    fn.count++;
    const body = handler(url, init);
    const text = JSON.stringify(body);
    return {
      status: 200,
      ok: true,
      headers: {
        forEach(cb: (value: string, key: string) => void) {
          cb("application/json", "content-type");
        },
      },
      async text() {
        return text;
      },
    };
  }) as any;
  fn.count = 0;
  return fn;
}

// An adapter-style step: reads a secret + calls http through ctx.services.
const listCharges = defineStep({
  type: "stripe/list-charges",
  input: z.object({ customer: z.string() }),
  output: z.any(),
  async run(cfg, ctx) {
    const svc = ctx.services as ReturnType<typeof standardServices>;
    const key = await svc.secrets.get("STRIPE_KEY");
    const res = await svc.http("https://api.stripe.com/v1/charges", {
      query: { customer: cfg.customer },
      headers: { authorization: `Bearer ${key}` },
    });
    return { ids: (res.body as { data: Array<{ id: string }> }).data.map((c) => c.id) };
  },
});

function registry(): StepRegistry {
  return { "stripe/list-charges": listCharges } as StepRegistry;
}

describe("runSingleStep", () => {
  it("runs a step in isolation and returns output + events", async () => {
    const services = standardServices({
      fetchImpl: fakeFetch(() => ({ data: [{ id: "ch_1" }] })),
      secretsSource: { STRIPE_KEY: "sk_test" },
    });
    const res = await runSingleStep("stripe/list-charges", registry(), services, {
      config: { customer: "{{ input.customer }}" },
      input: { customer: "cus_1" },
    });
    assert.equal(res.status, "success");
    assert.deepEqual(res.output, { ids: ["ch_1"] });
    assert.ok(res.events.some((e) => e.type === "step.end"));
  });

  it("errors clearly for an unknown step type", async () => {
    const res = await runSingleStep("nope", registry(), {});
    assert.equal(res.status, "error");
    assert.match(res.error!.message, /not found/);
  });

  it("records a fixture (secret scrubbed), then replays offline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-cassette-"));
    const path = cassettePath(dir, "stripe/list-charges");

    // RECORD — live fetch hit once, fixture written.
    const live = fakeFetch(() => ({ data: [{ id: "ch_7" }, { id: "ch_8" }] }));
    const recRes = await runSingleStep(
      "stripe/list-charges",
      registry(),
      standardServices({ fetchImpl: live, secretsSource: { STRIPE_KEY: "sk_live_secret" } }),
      { config: { customer: "cus_42" }, cassette: { mode: "record", path } },
    );
    assert.equal(recRes.status, "success");
    assert.deepEqual(recRes.output, { ids: ["ch_7", "ch_8"] });
    assert.equal(live.count, 1);
    assert.equal(recRes.recorded, 1); // one http call captured (secrets.get isn't recorded)

    // Fixture on disk must not contain the real secret.
    const raw = await readFile(path, "utf-8");
    assert.ok(!raw.includes("sk_live_secret"), "secret leaked to cassette file");
    assert.ok(raw.includes("{{secret:STRIPE_KEY}}"));

    // REPLAY — fetch that throws proves no network is touched.
    const dead = fakeFetch(() => {
      throw new Error("network must not be called in replay");
    });
    const repRes = await runSingleStep(
      "stripe/list-charges",
      registry(),
      standardServices({ fetchImpl: dead, secretsSource: {} }), // no creds present
      { config: { customer: "cus_42" }, cassette: { mode: "replay", path } },
    );
    assert.equal(repRes.status, "success");
    assert.deepEqual(repRes.output, { ids: ["ch_7", "ch_8"] });
    assert.equal(dead.count, 0);
  });

  it("the built-in http step routes through services.http (so it's recordable)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-http-"));
    const path = cassettePath(dir, "http");

    // RECORD — fake fetch behind services.http; the core http step uses it.
    const live = fakeFetch(() => ({ hello: "world" }));
    const rec = await runSingleStep("http", coreRegistry(), standardServices({ fetchImpl: live }), {
      config: { url: "https://api.example.com/data" },
      cassette: { mode: "record", path },
    });
    assert.equal(rec.status, "success");
    assert.deepEqual(rec.output, { status: 200, body: { hello: "world" } });
    assert.equal(rec.recorded, 1);
    assert.equal(live.count, 1);

    // REPLAY — offline, no network touched.
    const dead = fakeFetch(() => {
      throw new Error("no network in replay");
    });
    const rep = await runSingleStep("http", coreRegistry(), standardServices({ fetchImpl: dead }), {
      config: { url: "https://api.example.com/data" },
      cassette: { mode: "replay", path },
    });
    assert.equal(rep.status, "success");
    assert.deepEqual(rep.output, { status: 200, body: { hello: "world" } });
    assert.equal(dead.count, 0);
  });
});

// ── run_step leaves a record — only when it matters (plans/claims.md §3) ────

const echo = defineStep({
  type: "clip/compute-times",
  input: z.object({ start: z.number() }),
  output: z.any(),
  async run(cfg) {
    return { start: cfg.start, end: cfg.start + 19 };
  },
});
const echoRegistry = () => ({ "clip/compute-times": echo }) as StepRegistry;
/** Just what `runStep` reads from a workspace. */
const hashWorkspace = (hashes: Record<string, string>) => ({
  getActiveStepHashes: async () => hashes,
  getWorkflow: async () => {
    throw new Error("no workflows here");
  },
  getWorkflowVersion: async () => {
    throw new Error("no workflows here");
  },
});
const claimsOn = (...types: string[]) => ({
  claimsFor: async (subject: { kind: string; type?: string }) => (subject.kind === "step" && types.includes(subject.type!) ? [{ id: "c1" } as never] : []),
});

describe("runStep", () => {
  it("records stepHashes / cassette on run.start, and keeps nothing for a scratch step", async () => {
    const store = new MemoryRunStore();
    const r = await runStep(
      "clip/compute-times",
      echoRegistry(),
      {},
      { config: { start: 12 } },
      { store, workspace: hashWorkspace({ "clip/compute-times": "aaaabbbbcccc", "other/step": "ffff00001111" }), claims: claimsOn() },
    );
    assert.equal(r.status, "success");
    assert.deepEqual(r.output, { start: 12, end: 31 });
    const start = r.events.find((e) => e.type === "run.start")!;
    assert.deepEqual(start.stepHashes, { "clip/compute-times": "aaaabbbbcccc" }, "only the steps the flow can execute");
    assert.equal(start.cassette, undefined);
    assert.equal(start.origin, undefined);
    assert.equal(r.kept, undefined);
    assert.deepEqual(await store.listRuns(stepRunKey("clip/compute-times")), []);
    assert.equal(store.events.size, 0, "a step without a contract leaves nothing behind");
  });

  it("a step with an active claim keeps its run under step:<type> — events + summary, same run id", async () => {
    const store = new MemoryRunStore();
    const r = await runStep(
      "clip/compute-times",
      echoRegistry(),
      {},
      { config: { start: 1 } },
      { store, workspace: hashWorkspace({ "clip/compute-times": "aaaabbbbcccc" }), claims: claimsOn("clip/compute-times") },
    );
    assert.equal(r.kept, "step:clip/compute-times");
    assert.deepEqual(await store.listRuns("step:clip/compute-times"), [r.runId]);
    const events = await store.getRunEvents("step:clip/compute-times", r.runId);
    assert.deepEqual(events, r.events);
    assert.ok(events.every((e) => e.runId === r.runId));
    const summary = (await store.getRunSummary("step:clip/compute-times", r.runId))!;
    assert.deepEqual(
      [summary.workflow, summary.status, summary.output, summary.runId],
      ["step:clip/compute-times", "success", { start: 1, end: 20 }, r.runId],
    );
    // Absent from every workflow listing, by construction.
    assert.deepEqual(await store.listRuns("__run_step__"), []);
    assert.deepEqual(await store.listRuns("clip/compute-times"), []);
  });

  it("keep: true persists without claims (and on a filesystem workspace: no claims layer at all)", async () => {
    const store = new MemoryRunStore();
    const r = await runStep("clip/compute-times", echoRegistry(), {}, { config: { start: 1 }, keep: true }, { store, claims: null });
    assert.equal(r.kept, "step:clip/compute-times");
    assert.equal(r.events.find((e) => e.type === "run.start")!.stepHashes, undefined, "no workspace → no hashes → never evidence");
    const off = await runStep("clip/compute-times", echoRegistry(), {}, { config: { start: 1 } }, { store, claims: null });
    assert.equal(off.kept, undefined);
    assert.equal((await store.listRuns("step:clip/compute-times")).length, 1);
  });

  it("a failed run is kept too (a claim can be about failing loudly); an unknown type keeps nothing", async () => {
    const store = new MemoryRunStore();
    const deps = { store, workspace: hashWorkspace({}), claims: claimsOn("clip/compute-times", "nope") };
    const bad = await runStep("clip/compute-times", echoRegistry(), {}, { config: { start: "x" } as never }, deps);
    assert.equal(bad.status, "error");
    assert.equal(bad.kept, "step:clip/compute-times");
    assert.equal((await store.getRunSummary("step:clip/compute-times", bad.runId))!.status, "error");
    const unknown = await runStep("nope", echoRegistry(), {}, {}, deps);
    assert.deepEqual([unknown.status, unknown.kept, unknown.events.length], ["error", undefined, 0]);
  });

  it("an unreachable claims graph never fails the run — it is just not kept", async () => {
    const store = new MemoryRunStore();
    const claims = {
      claimsFor: async () => {
        throw new Error("bolt down");
      },
    };
    const r = await runStep("clip/compute-times", echoRegistry(), {}, { config: { start: 1 } }, { store, claims });
    assert.deepEqual([r.status, r.kept], ["success", undefined]);
  });

  it("the cassette mode rides on run.start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-runstep-"));
    const r = await runStep(
      "clip/compute-times",
      echoRegistry(),
      {},
      { config: { start: 1 }, cassette: { mode: "record", path: cassettePath(dir, "clip/compute-times") } },
      { store: new MemoryRunStore(), claims: null },
    );
    assert.equal(r.events.find((e) => e.type === "run.start")!.cassette, "record");
  });

  it("FileRunStore: step:<type> lands in steps/<type>/runs/, the prefix never reaches disk, nested types do not leak", async () => {
    const root = await mkdtemp(join(tmpdir(), "strut-steprun-"));
    const store = new FileRunStore(root);
    const deps = { store, claims: claimsOn("clip/compute-times", "clip") };
    const r = await runStep("clip/compute-times", echoRegistry(), {}, { config: { start: 1 } }, deps);
    assert.ok((await stat(join(root, "steps", "clip", "compute-times", "runs", r.runId, "events.jsonl"))).isFile());
    assert.ok((await stat(join(root, "steps", "clip", "compute-times", "runs", r.runId, "run.json"))).isFile());
    assert.deepEqual(await readdir(root), ["steps"], "no workflows/ dir, no `step:` anywhere on disk");
    assert.deepEqual(await store.listRuns("step:clip/compute-times"), [r.runId]);
    assert.deepEqual(await store.getRunEvents("step:clip/compute-times", r.runId), r.events);
    assert.deepEqual(await store.listRuns("step:clip"), [], "a parent namespace is not a step with runs");
    assert.deepEqual(await store.listRuns("clip/compute-times"), []);
    assert.equal(await store.lastRunAt("step:clip/compute-times"), Number(r.runId));
    await assert.rejects(store.listRuns("step:../../etc"), /Invalid run store key/);
    await assert.rejects(store.append("check:a/../b", "1", r.events[0]!), /Invalid run store key/);
  });
});
