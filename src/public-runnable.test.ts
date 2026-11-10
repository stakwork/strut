import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createStrut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { defineStep, type RunSummary } from "./core.js";
import { hostConfigFromEnv } from "./server.js";
import { createRegistry } from "./steps/registry.js";
import { ledgerPath, priceOf, usdToMicros } from "./payments/ledger.js";
import { FakeWallet } from "./payments/fake-wallet.js";
import { lightningCapability } from "./payments/lightning.js";
import { normalizeSurface, PUBLIC_FILE, readSurface, runnableShapeProblem, surfaceProblem } from "./public-surface.js";
import { recentCosts, runnableReserve } from "./public-runnable.js";

describe("the runnable record", () => {
  it("is a list of items with prices; each problem names its item", () => {
    assert.equal(
      surfaceProblem({
        runnable: [
          { kind: "workflow", name: "cve/scan", dailyCapUsd: 5 },
          { kind: "workflow", name: "voxel/character", base: 0.1, markup: 1.2, capUsd: 5, results: "run" },
          { kind: "step", name: "cve/lookup", base: 0.01 },
        ],
      }),
      undefined,
    );
    assert.match(surfaceProblem({ runnable: {} })!, /runnable is a list of/);
    assert.match(surfaceProblem({ runnable: [{ kind: "app", name: "x" }] })!, /kind: workflow \| step/);
    assert.match(surfaceProblem({ runnable: [{ kind: "workflow", name: "x", price: 1 }] })!, /workflow "x": unknown field "price"/);
    assert.match(surfaceProblem({ runnable: [{ kind: "workflow", name: "x", base: -1 }] })!, /workflow "x": base is a number, 0 or more/);
    assert.match(surfaceProblem({ runnable: [{ kind: "workflow", name: "x", markup: "2" }] })!, /markup is a number/);
    assert.match(runnableShapeProblem({ kind: "workflow", name: "x", capUsd: Number.POSITIVE_INFINITY })!, /capUsd is a number/);
    assert.match(runnableShapeProblem({ kind: "workflow", name: "x", dailyCapUsd: Number.NaN })!, /dailyCapUsd is a number/);
    assert.match(surfaceProblem({ runnable: [{ kind: "workflow", name: "x", capUsd: 0 }] })!, /above 0/);
    assert.match(surfaceProblem({ runnable: [{ kind: "workflow", name: "x", dailyCapUsd: 0 }] })!, /refuses every run/);
    assert.match(surfaceProblem({ runnable: [{ kind: "step", name: "s", results: "run" }] })!, /results is a workflow's/);
    assert.match(surfaceProblem({ runnable: [{ kind: "workflow", name: "x", results: "all" }] })!, /"output" or "run"/);
  });

  it("normalizes: zero prices and the default results dropped, each item once", () => {
    assert.deepEqual(
      normalizeSurface({
        runnable: [
          { kind: "workflow", name: "a", base: 0, markup: 0, results: "output", dailyCapUsd: 5 },
          { kind: "workflow", name: "a", base: 9 },
          { kind: "step", name: "a", base: 1 },
        ],
      }).runnable,
      [
        { kind: "workflow", name: "a", dailyCapUsd: 5 },
        { kind: "step", name: "a", base: 1 },
      ],
    );
  });

  it("an older public.json, with no runnable list, reads as none and stays valid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-runnable-old-"));
    try {
      await writeFile(join(dir, PUBLIC_FILE), JSON.stringify({ concepts: [], workflows: [{ name: "w", runs: true }], steps: [], types: [], apps: [] }));
      const s = await readSurface(dir);
      assert.deepEqual(s.runnable, []);
      assert.deepEqual(s.workflows, [{ name: "w", runs: true }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the reserve is base + markup × the per-run cap", () => {
    assert.equal(runnableReserve({ kind: "workflow", name: "x" }), 0);
    assert.equal(runnableReserve({ kind: "workflow", name: "x", base: 0.5 }), usdToMicros(0.5));
    assert.equal(runnableReserve({ kind: "workflow", name: "x", markup: 1.5, capUsd: 5 }), usdToMicros(7.5));
    assert.equal(runnableReserve({ kind: "workflow", name: "x", base: 0.1, markup: 1.2, capUsd: 5 }), usdToMicros(6.1));
  });
});

describe("recent costs, from run summaries", () => {
  it("counts the window's runs and reads their totals: the average and the highest", async () => {
    const store = new MemoryRunStore();
    const now = Date.parse("2026-11-10T12:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    const put = (at: number, cost?: number) => {
      const runId = String(at);
      store.summaries.set(`w/${runId}`, {
        runId,
        workflow: "w",
        status: "success",
        ...(cost !== undefined ? { totals: { modelCalls: 1, usage: {}, cost } } : {}),
      } as unknown as RunSummary);
    };
    put(now - 40 * day, 99); // outside the 30 days
    put(now - 3 * day, 0.2);
    put(now - 2 * day, 0.6);
    put(now - day); // called no model
    store.events.set(`w/${now - 1000}`, []); // in flight: counted, not measured
    const r = await recentCosts(store, "w", { now });
    assert.equal(r.days, 30);
    assert.equal(r.runs, 4);
    assert.equal(r.measured, 3);
    assert.ok(Math.abs(r.average - 0.8 / 3) < 1e-9);
    assert.equal(r.highest, 0.6);
    assert.deepEqual(await recentCosts(store, "none", { now }), { days: 30, runs: 0, measured: 0, average: 0, highest: 0 });
  });
});

describe("PUT /public-view: what anyone may run", () => {
  const KEY = "runnable-key";
  const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
  let dir: string;
  let savedKey: string | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-runnable-"));
    savedKey = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = KEY;
  });
  afterEach(async () => {
    if (savedKey === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = savedKey;
    await rm(dir, { recursive: true, force: true });
  });

  const writer = defineStep({ type: "test/write", effect: "write", input: z.object({}).passthrough(), output: z.any(), async run() { return {}; } });

  const WITH_INPUT = "input:\n  q: { type: string }\n";
  const boot = async (o: { wallet?: boolean; principal?: string; store?: MemoryRunStore; file?: boolean } = {}) => {
    const strut = await createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")),
      ...(o.file ? {} : { store: o.store ?? new MemoryRunStore() }),
      serveUi: false,
      scheduler: false,
      registry: await createRegistry([writer]),
      ...(o.wallet ? { services: { lightning: lightningCapability(new FakeWallet()) } } : {}),
      ...(o.principal ? { publicRuns: { principal: o.principal } } : {}),
    });
    const ws = strut.workspace;
    await ws.createWorkflow("plain", `name: plain\n${WITH_INPUT}steps:\n  - id: say\n    type: log\n    config:\n      message: "{{ input.q }}"\n`);
    await ws.createWorkflow("noinput", "name: noinput\nsteps:\n  - id: say\n    type: log\n    config:\n      message: hi\n");
    await ws.createWorkflow("graded", `name: graded\nsealed: true\n${WITH_INPUT}steps:\n  - id: say\n    type: log\n    config:\n      message: hi\n`);
    await ws.createWorkflow("wraps-graded", `name: wraps-graded\n${WITH_INPUT}steps:\n  - id: inner\n    type: subflow\n    config:\n      workflow: graded\n`);
    await ws.createWorkflow("asks", `name: asks\n${WITH_INPUT}steps:\n  - id: ask\n    type: llm\n    config:\n      prompt: "{{ input.q }}"\n`);
    await ws.createWorkflow("acts", `name: acts\n${WITH_INPUT}steps:\n  - id: w\n    type: test/write\n    config: {}\n  - id: sh\n    type: exec\n    config:\n      cmd: echo\n`);
    const put = (body: unknown) => strut.app.request("/public-view", { method: "PUT", headers: auth, body: JSON.stringify(body) });
    const refused = async (runnable: unknown[], re: RegExp) => {
      const res = await put({ runnable });
      assert.equal(res.status, 400, JSON.stringify(runnable));
      const body = (await res.json()) as { error: string; problems?: string[] };
      assert.match(body.error, re);
    };
    return { strut, put, refused };
  };

  it("refuses what may not be run by a stranger, naming the item", async () => {
    const { refused } = await boot();
    await refused([{ kind: "workflow", name: "gone" }], /no workflow "gone"/);
    await refused([{ kind: "workflow", name: "graded" }], /workflow "graded" is sealed/);
    await refused([{ kind: "workflow", name: "wraps-graded" }], /workflow "wraps-graded" reaches the sealed workflow "graded"/);
    await refused([{ kind: "workflow", name: "noinput" }], /workflow "noinput" declares no input: block/);
    await refused([{ kind: "workflow", name: "plain", markup: 1.5 }], /workflow "plain": a markup needs a per-run cap/);
    await refused([{ kind: "workflow", name: "plain", base: 0.5 }], /workflow "plain" is priced, and this server has no wallet/);
    await refused([{ kind: "workflow", name: "asks", dailyCapUsd: 5 }], /workflow "asks" spends .* no owner/);
    await refused([{ kind: "step", name: "nope/step" }], /no step "nope\/step"/);
    for (const t of ["agent", "llm", "exec", "acp/prompt"]) await refused([{ kind: "step", name: t }], /spends or runs a shell/);
    for (const t of ["subflow", "foreach", "loop", "if"]) await refused([{ kind: "step", name: t }], /runs other steps/);
    await refused([{ kind: "step", name: "meta/run-workflow" }], /step "meta\/run-workflow" is sealed/);
    // Every item is checked: one good item does not carry a bad one.
    await refused([{ kind: "workflow", name: "plain" }, { kind: "workflow", name: "noinput" }], /noinput/);
  });

  it("a spending workflow needs someone to pay, and when free a daily cap; an owner or the host's principal pays", async () => {
    const { strut, put, refused } = await boot();
    await strut.workspace.setWorkflowOwner("asks", "tom-1");
    await refused([{ kind: "workflow", name: "asks" }], /workflow "asks" is free and spends: set a daily cap/);
    assert.equal((await put({ runnable: [{ kind: "workflow", name: "asks", dailyCapUsd: 5 }] })).status, 200);

    const host = await boot({ principal: "public-runs" });
    assert.equal((await host.put({ runnable: [{ kind: "workflow", name: "asks", dailyCapUsd: 5 }] })).status, 200);
  });

  it("with a wallet a priced item saves; the record changes and no workflow version is published", async () => {
    const { strut, put } = await boot({ wallet: true });
    const versions = (await strut.workspace.listWorkflows()).find((w) => w.name === "plain")!.versions.length;
    const res = await put({ workflows: [{ name: "plain" }], runnable: [{ kind: "workflow", name: "plain", base: 0.1, markup: 1.2, capUsd: 5 }, { kind: "step", name: "test/write", base: 0.01 }] });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { surface: { runnable: unknown[] } };
    assert.deepEqual(body.surface.runnable, [
      { kind: "workflow", name: "plain", base: 0.1, markup: 1.2, capUsd: 5 },
      { kind: "step", name: "test/write", base: 0.01 },
    ]);
    assert.deepEqual((await readSurface(join(dir, "ws"))).runnable, body.surface.runnable);
    assert.equal((await strut.workspace.listWorkflows()).find((w) => w.name === "plain")!.versions.length, versions);
  });

  it("GET /public lists what anyone may run — without its definition — with its reserve and what the ledger says recent runs were charged", async () => {
    const { strut, put } = await boot({ wallet: true });
    assert.equal((await put({ runnable: [{ kind: "workflow", name: "plain", base: 0.1, markup: 2, capUsd: 5 }, { kind: "step", name: "test/write" }] })).status, 200);
    const ledger = await strut.ledger();
    const price = priceOf({ base: 0.1, markup: 2 });
    await ledger.firstUse({ id: "tok", paymentHash: "h", askedMsat: 1000, settledMsat: 1000, credit: usdToMicros(20), rate: 70_000, expires: Date.now() + 1e10 });
    for (const [runId, cost] of [["r1", 0.2], ["r2", 0.4]] as const) {
      const h = await ledger.hold({ token: "tok", reserve: usdToMicros(10.1), subject: "workflow:plain", runId });
      assert.ok(h.ok);
      await ledger.charge({ runId, subject: "workflow:plain", token: "tok", cost: usdToMicros(cost), outcome: "success", price });
    }
    const res = await strut.app.request("/public");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { workflows: unknown[]; runnable: Array<Record<string, unknown>> };
    assert.deepEqual(body.workflows, [], "runnable is not readable: its definition stays private");
    assert.deepEqual(body.runnable[0], {
      kind: "workflow",
      name: "plain",
      base: 0.1,
      markup: 2,
      capUsd: 5,
      reserve: 10.1,
      results: "output",
      input: { q: { type: "string" } },
      // (0.1 + 2 × 0.2) and (0.1 + 2 × 0.4): $0.50 and $0.90.
      recent: { days: 30, runs: 2, average: 0.7 },
    });
    const step = body.runnable[1]!;
    assert.equal(step["kind"], "step");
    assert.equal(step["reserve"], 0);
    assert.equal(step["capUsd"], null);
    assert.equal((step["input"] as { type?: string }).type, "object");
    assert.deepEqual(step["recent"], { days: 30, runs: 0, average: 0 });
  });

  it("GET /public-view/runnable: what the closure can do, what its runs cost here, and what the save will ask", async () => {
    const store = new MemoryRunStore();
    const { strut } = await boot({ store });
    const now = Date.now();
    store.summaries.set(`asks/${now - 1000}`, { runId: String(now - 1000), workflow: "asks", status: "success", totals: { modelCalls: 1, usage: {}, cost: 0.25 } } as unknown as RunSummary);
    const get = async (q: string) => {
      const res = await strut.app.request(`/public-view/runnable?${q}`, { headers: auth });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const asks = await get("workflow=asks");
    assert.equal(asks.status, 200);
    assert.deepEqual(asks.body["can"], { spends: true, acts: false, code: false });
    assert.deepEqual(asks.body["costs"], { days: 30, runs: 1, measured: 1, average: 0.25, highest: 0.25 });
    assert.equal(asks.body["input"], true);
    assert.equal(asks.body["owner"], undefined);
    assert.equal(asks.body["wallet"], false);
    assert.equal(asks.body["gateway"], false);
    assert.deepEqual((await get("workflow=acts")).body["can"], { spends: false, acts: true, code: true });
    assert.equal((await get("workflow=noinput")).body["input"], false);
    assert.deepEqual((await get("step=test/write")).body["can"], { spends: false, acts: true, code: false });
    assert.equal((await get("workflow=gone")).status, 404);
    assert.equal((await get("")).status, 400);
  });

  it("the ledger opens on first use: a strut that sells nothing makes no file, and close() folds it", async () => {
    const { strut, put } = await boot({ file: true });
    assert.equal((await put({ runnable: [] })).status, 200);
    assert.equal((await strut.app.request("/public")).status, 200);
    const file = ledgerPath(join(dir, "ws"));
    assert.equal(existsSync(file), false, "nothing runnable: no ledger");
    assert.equal((await put({ runnable: [{ kind: "workflow", name: "plain" }] })).status, 200);
    assert.equal((await strut.app.request("/public")).status, 200);
    assert.equal(existsSync(file), true);
    await strut.close();
  });

  it("STRUT_HOST_CONFIG names the public principal", async () => {
    const file = join(dir, "host.json");
    await writeFile(file, JSON.stringify({ publicRuns: { principal: "public-runs" } }));
    assert.deepEqual(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }).publicRuns, { principal: "public-runs" });
    await writeFile(file, JSON.stringify({ publicRuns: { principal: "" } }));
    assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /"publicRuns" must be \{ principal\?: string \}/);
    await writeFile(file, JSON.stringify({ publicRuns: { owner: "x" } }));
    assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /publicRuns/);
  });
});
