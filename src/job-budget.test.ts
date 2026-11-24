/**
 * A budget on a job (stadeum plans/experiments.md, "A budget on a job"): a
 * cap on the model calls of the job and every run under it, kept at the
 * gateway and by strut. The record's arithmetic; the runner recording each
 * run's cost and refusing a new run under a spent job; the Mothership's link
 * of the job's own between the delegation and each run (and a grant); the
 * launcher and `PUT /jobs/:id/budget`; the index showing it; the wake telling
 * a spent job's end with no model turn. OFFLINE — no gateway, no provider.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { bytesToHex, ecdsaPublicKey, verify, type Policy } from "gatekey";
import * as v1 from "gatekey-v1";

import {
  budgetSpentMessage,
  jobBudgetOf,
  jobBudgetProblem,
  jobRoot,
  jobsCapability,
  jobSpentUsd,
  parseBudgetUsd,
  readJobRecord,
  recordJobRunCost,
  setJobBudget,
  type JobRun,
} from "./jobs.js";
import { createJobIndex } from "./job-index.js";
import { createMothership, explainJobSpent, jobLinkId } from "./mothership.js";
import { MemorySecretStore } from "./secret-store.js";
import { MemoryRunStore } from "./store.js";
import { createWakes, type WakeEnd } from "./wake.js";
import { createStrut } from "./createStrut.js";
import { WorkspaceManager, type WorkspaceStore } from "./workspace.js";
import type { LlmAuthContext } from "./llm.js";
import { defineStep, flow, step, withUsage, type StepRegistry } from "./core.js";
import { runWorkflow } from "./runner.js";
import { mintDelegation, mintDelegationV1 } from "./test-util/mint-delegation.js";

const run = (runId: string, cost?: number, parentRunId?: string): JobRun => ({
  workflow: "job",
  runId,
  at: "2026-11-24T00:00:00.000Z",
  ...(cost !== undefined ? { cost } : {}),
  ...(parentRunId ? { parentRunId } : {}),
});

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "strut-job-budget-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("job budget: the record", () => {
  it("spend is the top-level runs' recorded cost — a child's is in its parent's — and `except` leaves one run out", () => {
    const runs = [run("a", 1.5), run("b", 2), run("c", 0.75, "b"), run("d")];
    assert.equal(jobSpentUsd(runs), 3.5);
    assert.equal(jobSpentUsd(runs, "b"), 1.5);
    assert.equal(jobSpentUsd(undefined), 0);
  });

  it("a budget: what is spent and what is left, never below zero; none without one", () => {
    assert.equal(jobBudgetOf({ runs: [run("a", 3)] }), undefined);
    assert.deepEqual(jobBudgetOf({ budgetUsd: 10, runs: [run("a", 3)] }), { usd: 10, spentUsd: 3, leftUsd: 7 });
    assert.deepEqual(jobBudgetOf({ budgetUsd: 10, runs: [run("a", 12)] }), { usd: 10, spentUsd: 12, leftUsd: 0 });
  });

  it("a spent job's refusal opens job_budget_spent: and says what it spent of what", () => {
    assert.equal(jobBudgetProblem("j", { budgetUsd: 10, runs: [run("a", 3)] }), undefined);
    assert.equal(jobBudgetProblem("j", { runs: [run("a", 300)] }), undefined, "no budget, no refusal");
    const line = jobBudgetProblem("j", { budgetUsd: 100, runs: [run("a", 100)] })!;
    assert.match(line, /^job_budget_spent: job "j" has spent \$100 of its \$100 budget/);
    assert.equal(budgetSpentMessage("j", { usd: 50, spentUsd: 50.456 }).includes("$50.46 of its $50 budget"), true);
  });

  it("a budget is a positive number of dollars or null: anything else is an error, never 'no budget'", () => {
    assert.equal(parseBudgetUsd(100), 100);
    assert.equal(parseBudgetUsd(0.5), 0.5);
    assert.equal(parseBudgetUsd(null), null);
    for (const bad of [0, -1, "100", Number.NaN, Infinity, undefined, {}]) assert.throws(() => parseBudgetUsd(bad), /positive number of dollars/, String(bad));
  });

  it("setJobBudget writes it (making the record when there is none) and null removes it; recordJobRunCost writes a run's line", async () => {
    const root = jobRoot(dataDir, "exp-1");
    await setJobBudget(root, "exp-1", 100);
    assert.equal((await readJobRecord(root))!.budgetUsd, 100);
    const jobs = jobsCapability(dataDir);
    await jobs.recordRun("exp-1", { workflow: "job", runId: "r1" });
    await recordJobRunCost(root, "r1", 4.25);
    await recordJobRunCost(root, "nope", 9);
    assert.deepEqual(await jobs.budget!("exp-1"), { usd: 100, spentUsd: 4.25, leftUsd: 95.75 });
    await recordJobRunCost(root, "r1", 6);
    assert.equal((await jobs.budget!("exp-1"))!.spentUsd, 6, "a resumed run's line takes its whole cost again");
    assert.deepEqual(await jobs.setBudget!("exp-1", 5), { usd: 5, spentUsd: 6, leftUsd: 0 });
    assert.equal(await jobs.setBudget!("exp-1", null), undefined);
    assert.equal((await readJobRecord(root))!.budgetUsd, undefined);
    await assert.rejects(() => setJobBudget(root, "exp-1", 0), /positive number/);
  });
});

describe("job budget: the runner", () => {
  /** A step that spent `cost` on model calls, as the agent and llm steps mark it. */
  const spend = defineStep({
    type: "spend",
    input: z.object({ cost: z.number() }),
    output: z.any(),
    async run(cfg) {
      return withUsage({ ok: true }, { modelCalls: 1, usage: { inputTokens: 1, outputTokens: 1 } as never, cost: cfg.cost });
    },
  });
  const registry = { spend } as unknown as StepRegistry;
  const wf = flow("job", { input: z.object({ cost: z.number() }), steps: [step("s", "spend", { cost: "{{ input.cost }}" })] });

  it("records each run's cost on its line, and refuses a new run once the spend reaches the budget", async () => {
    const jobs = jobsCapability(dataDir);
    const services = { jobs };
    await jobs.setBudget!("exp", 10);
    const a = await runWorkflow(wf, { cost: 6 }, registry, { services, job: "exp" });
    assert.equal(a.status, "success");
    assert.deepEqual(await jobs.budget!("exp"), { usd: 10, spentUsd: 6, leftUsd: 4 });
    // Left $4: the next run starts (the gateway holds it to what is left).
    const b = await runWorkflow(wf, { cost: 5 }, registry, { services, job: "exp" });
    assert.equal(b.status, "success");
    assert.equal((await jobs.budget!("exp"))!.leftUsd, 0);
    // Spent: nothing more starts under the job.
    const c = await runWorkflow(wf, { cost: 1 }, registry, { services, job: "exp" });
    assert.equal(c.status, "error");
    assert.match(c.error!.message, /^job_budget_spent: job "exp" has spent \$11 of its \$10 budget/);
    assert.equal((await readJobRecord(jobRoot(dataDir, "exp")))!.runs!.length, 2, "a refused run is not one of the job's");
    // A person raises it: it goes on.
    await jobs.setBudget!("exp", 20);
    assert.equal((await runWorkflow(wf, { cost: 1 }, registry, { services, job: "exp" })).status, "success");
    // A run outside any job, and a job with no budget, are never refused.
    assert.equal((await runWorkflow(wf, { cost: 1 }, registry, { services })).status, "success");
    await jobs.setBudget!("exp", 5);
    assert.equal((await runWorkflow(wf, { cost: 1 }, registry, { services, job: "exp", origin: "verify" })).status, "success", "a check is the job's judging, not its work");
    await jobs.setBudget!("exp", null);
    assert.equal((await runWorkflow(wf, { cost: 1 }, registry, { services, job: "exp" })).status, "success");
  });
});

// ── The gateway: the Mothership's link of the job's own ────────────────────

const ACTOR = "evan-cmx123";
const orgPriv = randomBytes(32);
orgPriv[0] = 1;
const userPriv = randomBytes(32);
const policy: Policy = { type: "single", key: { alg: "ecdsa-secp256k1-sha256", key: bytesToHex(ecdsaPublicKey(orgPriv)) } };
const policyV1: v1.Policy = { type: "single", key: { alg: "ecdsa-secp256k1-sha256", key: bytesToHex(ecdsaPublicKey(orgPriv)) } };

const stepCtx = (over: Partial<LlmAuthContext> = {}): LlmAuthContext => ({
  kind: "step",
  provider: "anthropic",
  runId: "1700000000000",
  workflow: "job",
  stepPath: "job/agent",
  actor: ACTOR,
  principal: ACTOR,
  ...over,
});

describe("job budget: the gateway", () => {
  let savedCap: string | undefined;
  beforeEach(() => {
    savedCap = process.env["STRUT_RUN_MAX_COST_USD"];
    delete process.env["STRUT_RUN_MAX_COST_USD"];
  });
  afterEach(() => {
    if (savedCap === undefined) delete process.env["STRUT_RUN_MAX_COST_USD"];
    else process.env["STRUT_RUN_MAX_COST_USD"] = savedCap;
  });

  const build = async (o: { v1?: boolean; ceiling?: number; runCap?: number; grantsUrl?: string; fetch?: typeof globalThis.fetch } = {}) => {
    const ms = createMothership({ dataDir, store: new MemorySecretStore(), ...(o.grantsUrl ? { grantsUrl: o.grantsUrl, fetch: o.fetch } : {}) });
    const meta = o.runCap ? { active: "v1", versions: {}, maxRunCostUsd: o.runCap } : null;
    ms.mount({ app: new Hono(), workspace: { getWorkflowMetadata: async () => meta } as unknown as WorkspaceStore });
    const d = o.v1
      ? mintDelegationV1({ actor: ACTOR, orgPriv, userPriv, ...(o.ceiling ? { ceiling: o.ceiling } : {}) })
      : mintDelegation({ actor: ACTOR, orgPriv, userPriv, ...(o.ceiling ? { ceiling: o.ceiling } : {}) });
    await ms.delegations.put(ACTOR, { macaroon: d.macaroon, delegationId: d.delegationId, apiKey: "vk", baseUrl: "https://gw.example", exp: d.exp });
    return { ms, d };
  };

  it("a run with no job, or a job with no budget: the chain is as before — delegation, run, step", async () => {
    const { ms } = await build();
    const plain = verify((await ms.llmAuth(stepCtx()))!.headers!["x-macaroon"]!, policy, new Date());
    assert.equal(plain.chain.length, 4);
    const noBudget = verify((await ms.llmAuth(stepCtx({ job: "no-budget", runId: "2" })))!.headers!["x-macaroon"]!, policy, new Date());
    assert.equal(noBudget.chain.length, 4);
  });

  it("a job with a budget: a block of the job's own above the run, the same for every run, capped at the budget; the run capped at what is left", async () => {
    const { ms, d } = await build();
    const jobs = jobsCapability(dataDir);
    await jobs.setBudget!("exp/1", 100);
    await jobs.recordRun("exp/1", { workflow: "job", runId: "r-old" });
    await recordJobRunCost(jobRoot(dataDir, "exp/1"), "r-old", 64);

    const chainOf = async (runId: string) =>
      verify((await ms.llmAuth(stepCtx({ job: "exp/1", runId })))!.headers!["x-macaroon"]!, policy, new Date()).chain.map((l) => [l.run_id, l.max_cost_usd]);
    const a = await chainOf("r-a");
    assert.deepEqual(a.slice(1), [[d.delegationId, 10_000], [jobLinkId("exp/1"), 100], ["r-a", 36], ["r-a", 36]]);
    assert.ok(!jobLinkId("exp/1").includes("/"), "no slash reaches a gateway route");
    const b = await chainOf("r-b");
    assert.deepEqual(b[2], a[2], "every run of the job shares the job's counter");

    // The run's OWN recorded cost (a resume) is not taken off what it has left.
    await jobs.recordRun("exp/1", { workflow: "job", runId: "r-a" });
    await recordJobRunCost(jobRoot(dataDir, "exp/1"), "r-a", 30);
    assert.equal((await chainOf("r-a"))[3]![1], 36);
    // A raised budget links the run again: $136 left, so the run's own cap
    // (the $100 default) is the smaller.
    await jobs.setBudget!("exp/1", 200);
    assert.deepEqual((await chainOf("r-a")).slice(2, 4), [[jobLinkId("exp/1"), 200], ["r-a", 100]]);
  });

  it("a job that has spent its budget gets no link: the call fails job_budget_spent: before it leaves", async () => {
    const { ms } = await build();
    const jobs = jobsCapability(dataDir);
    await jobs.setBudget!("spent", 10);
    await jobs.recordRun("spent", { workflow: "job", runId: "r1" });
    await recordJobRunCost(jobRoot(dataDir, "spent"), "r1", 10);
    await assert.rejects(() => ms.llmAuth(stepCtx({ job: "spent", runId: "r2" })), /^Error: job_budget_spent: job "spent" has spent \$10 of its \$10 budget/);
  });

  it("v1: the job's link narrows the delegation (never above its ceiling) and the run's narrows the job's", async () => {
    // A budget above the ceiling: the job's link stops at the ceiling.
    const { ms } = await build({ v1: true, ceiling: 50, runCap: 20 });
    const jobs = jobsCapability(dataDir);
    await jobs.setBudget!("exp", 80);
    let header = (await ms.llmAuth(stepCtx({ job: "exp" })))!.headers!["x-macaroon"]!;
    assert.deepEqual(v1.decodeMacaroon(header).attenuations.map((a) => [a.caveats.run_id, a.caveats.max_cost_usd]), [
      [jobLinkId("exp"), 50],
      ["1700000000000", 20],
      ["1700000000000", 20],
    ]);
    assert.doesNotThrow(() => v1.verify(header, policyV1, new Date()));
    // A budget below the run's cap: the run's link narrows to what the job has left.
    await jobs.setBudget!("exp", 8);
    header = (await ms.llmAuth(stepCtx({ job: "exp", runId: "2" })))!.headers!["x-macaroon"]!;
    assert.deepEqual(v1.decodeMacaroon(header).attenuations.map((a) => [a.caveats.run_id, a.caveats.max_cost_usd]), [
      [jobLinkId("exp"), 8],
      ["2", 8],
      ["2", 8],
    ]);
    assert.doesNotThrow(() => v1.verify(header, policyV1, new Date()));
  });

  it("v1, no workflow cap: the $100 default above a $50 ceiling is still refused — unless the job has less than that left", async () => {
    const { ms } = await build({ v1: true, ceiling: 50 });
    await assert.rejects(() => ms.llmAuth(stepCtx()), /exceeds the delegation ceiling/);
    await jobsCapability(dataDir).setBudget!("small", 30);
    const header = (await ms.llmAuth(stepCtx({ job: "small", runId: "3" })))!.headers!["x-macaroon"]!;
    assert.deepEqual(v1.decodeMacaroon(header).attenuations.map((a) => a.caveats.max_cost_usd), [30, 30, 30]);
  });

  it("a grant made in a job's run sits under the job's link, capped at what is left", async () => {
    const posted: Array<{ macaroon: string; max_cost_usd: number }> = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      posted.push(body);
      return Response.json({ id: `pk-${posted.length}`, key: "sk", address: "https://gw.example/" });
    }) as unknown as typeof globalThis.fetch;
    const { ms } = await build({ grantsUrl: "https://host.example/keys", fetch });
    const jobs = jobsCapability(dataDir);
    await jobs.setBudget!("pods", 20);
    await jobs.recordRun("pods", { workflow: "job", runId: "r1" });
    await recordJobRunCost(jobRoot(dataDir, "pods"), "r1", 5);
    await ms.grants!.forPrincipal!(ACTOR, "pods").grant({ name: "pod", hours: 1 });
    const chain = verify(posted[0]!.macaroon, policy, new Date()).chain.map((l) => [l.run_id, l.max_cost_usd]);
    assert.deepEqual(chain[2], [jobLinkId("pods"), 20]);
    assert.equal(chain[3]![1], 15);
    assert.equal(posted[0]!.max_cost_usd, 15, "the host holds the key to the same cap");
    await recordJobRunCost(jobRoot(dataDir, "pods"), "r1", 25);
    await assert.rejects(() => ms.grants!.forPrincipal!(ACTOR, "pods").grant({ name: "pod", hours: 1 }), /job_budget_spent:/);
  });

  it("the gateway's refusal naming the job's link reads job_budget_spent:; any other is left alone", () => {
    const err = Object.assign(new Error("402"), { responseBody: `run ${jobLinkId("exp")} over cap` });
    assert.match(explainJobSpent(err, "exp")!, /^job_budget_spent: job "exp" reached its budget at the gateway/);
    assert.equal(explainJobSpent(new Error("402 run 1700 over cap"), "exp"), undefined);
  });
});

// ── The index, the wake, the doors ─────────────────────────────────────────

describe("job budget: where it shows", () => {
  it("GET /jobs and /jobs/:id carry the spend, and the budget with what is left", async () => {
    const jobs = jobsCapability(dataDir);
    await jobs.recordRun("exp", { workflow: "job", runId: "r1" });
    await recordJobRunCost(jobRoot(dataDir, "exp"), "r1", 64);
    const index = createJobIndex({ dataDir, store: new MemoryRunStore() });
    let [row] = await index.list();
    assert.equal(row!.spentUsd, 64);
    assert.equal(row!.budget, undefined);
    await jobs.setBudget!("exp", 100);
    [row] = await index.list();
    assert.deepEqual(row!.budget, { usd: 100, spentUsd: 64, leftUsd: 36 });
    const view = (await index.get("exp", { threads: false }))!;
    assert.deepEqual(view.budget, { usd: 100, spentUsd: 64, leftUsd: 36 });
    assert.equal(view.runs[0]!.cost, 64, "each run's cost on its row");
  });

  it("the wake: a job its budget stopped is told in a fixed line — no model turn — and any other end wakes as before", async () => {
    const launched: unknown[] = [];
    const wakes = createWakes({
      dataDir,
      enabled: true,
      max: 30,
      store: {
        getRunEvents: async () => [{ type: "run.start", ts: "", runId: "t0", path: "orchestrator", wakeAsked: true } as never],
        getRunSummary: async () => null,
        getRunCallback: async () => null,
        getRunJobCallback: async () => null,
      },
      sessions: { load: async () => null },
      holder: () => undefined,
      liveOn: () => [],
      isLive: () => false,
      getWorkflow: async () => ({ name: "orchestrator", params: { wake: "{each}{job}{/each}" } }) as never,
      launch: (_flow, r) => {
        launched.push(r);
        return "wake-1";
      },
    });
    const end = (over: Partial<WakeEnd>): WakeEnd => ({
      runId: "j-run-1",
      workflow: "job",
      job: "exp",
      status: "error",
      error: "job_budget_spent: …",
      artifacts: [],
      startedBy: { workflow: "orchestrator", runId: "t0", session: "c-1" },
      ...over,
    });
    assert.equal(await wakes.jobEnded("c-1", end({ budgetSpent: budgetSpentMessage("exp", { usd: 100, spentUsd: 100 }) })), "capped");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(launched.length, 0, "no turn for a spent job");
    assert.equal(await wakes.jobEnded("c-1", end({ runId: "j-run-2", status: "success", error: undefined })), "launched");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(launched.length, 1);
  });

  it("PUT /jobs/:id/budget sets, raises and removes it; a bad figure is a 400; the launcher refuses a spent job and takes job/start's budget", async () => {
    const strut = await createStrut({
      workspace: new WorkspaceManager(dataDir),
      store: new MemoryRunStore(),
      dataDir,
      serveUi: false,
      enableChat: false,
      scheduler: false,
      // No `job` workflow: a launch that gets past the budget fails no_workflow, and runs nothing.
      job: false,
      builder: false,
    });
    const jobs = (strut.services as { jobs: ReturnType<typeof jobsCapability> }).jobs;
    assert.ok(jobs.launch, "a server's bag launches jobs");
    await jobs.recordRun("exp", { workflow: "job", runId: "r1" });
    await recordJobRunCost(jobRoot(dataDir, "exp"), "r1", 30);
    const put = (body: unknown) =>
      strut.app.request("/jobs/exp/budget", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let res = await put({ usd: 25 });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { job: "exp", budget: { usd: 25, spentUsd: 30, leftUsd: 0 } });
    assert.equal((await put({ usd: 0 })).status, 400);
    assert.equal((await put({ usd: "100" })).status, 400);
    assert.equal((await put({})).status, 400);
    assert.equal((await strut.app.request("/jobs/nope/budget", { method: "PUT", body: JSON.stringify({ usd: 1 }) })).status, 404);
    const view = (await (await strut.app.request("/jobs/exp?threads=0")).json()) as { budget?: unknown; spentUsd?: number };
    assert.deepEqual(view.budget, { usd: 25, spentUsd: 30, leftUsd: 0 });
    assert.equal(view.spentUsd, 30);

    // The launcher (job/start, job/continue): a spent job is refused at once;
    // a budget named on the launch goes on the record first.
    await assert.rejects(() => jobs.launch!({ job: "exp", input: { prompt: "go on" }, from: "nobody" }), /^Error: job_budget_spent:/);
    // Past the budget it fails further on — this strut has no `job` workflow — but the budget is on the record first.
    await assert.rejects(() => jobs.launch!({ job: "exp", input: { prompt: "go on" }, from: "nobody", budgetUsd: 50 }), /no_workflow:/);
    assert.equal((await readJobRecord(jobRoot(dataDir, "exp")))!.budgetUsd, 50, "raised by the launch that named it");
    res = await put({ usd: null });
    assert.deepEqual(await res.json(), { job: "exp", budget: null });
  });
});
