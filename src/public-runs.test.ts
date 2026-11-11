/**
 * Free public runs (plans/paid-runs.md work item 3; §3 the door, §6 the
 * run, §7 the run's cap and the daily cap): `POST /public/workflows/:name/run`,
 * the run token, the launcher's reads and cancel, the charge at the end.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { bytesToHex, ecdsaPublicKey, verify, type Policy } from "gatekey";
import { createStrut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { defineStep, withUsage, type RunEvent, type StepContext } from "./core.js";
import { createRegistry } from "./steps/registry.js";
import { FakeWallet } from "./payments/fake-wallet.js";
import { lightningCapability } from "./payments/lightning.js";
import { MemoryLedgerStore } from "./payments/ledger-memory.js";
import { usdToMicros } from "./payments/ledger.js";
import { createPublicRuns, dailyRoom, publicRunsPath, secondsToUtcMidnight } from "./public-runs.js";
import { stepAuth } from "./llm.js";
import { createMothership } from "./mothership.js";
import { MemorySecretStore } from "./secret-store.js";
import { resolveRunCap } from "./run-cap.js";
import { mintDelegation } from "./test-util/mint-delegation.js";

const KEY = "public-runs-key";
const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const json = { "content-type": "application/json" };

/** Spends what its config says, after waiting what its config says (a
 *  checkpoint every 10 ms, so a cancel lands). */
const spend = defineStep({
  type: "test/spend",
  input: z.object({ cost: z.number().optional(), ms: z.number().optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext<unknown>) {
    const end = Date.now() + (cfg.ms ?? 0);
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 10));
      await ctx.control?.checkpoint();
    }
    return withUsage({ spent: cfg.cost ?? 0 }, cfg.cost ? { modelCalls: 1, usage: {}, cost: cfg.cost } : undefined);
  },
});

/** Opens the session its config names and says which id it got. */
const session = defineStep({
  type: "test/session",
  input: z.object({ id: z.string() }),
  output: z.any(),
  async run(cfg, ctx: StepContext<unknown>) {
    const sessions = (ctx.services as { sessions: { open(id: string, h: { runId: string; path: string }): Promise<{ id: string; release(): void }> } }).sessions;
    const s = await sessions.open(cfg.id, { runId: ctx.runId, path: ctx.path });
    s.release();
    return { opened: s.id, job: ctx.job ?? null, actor: ctx.actor ?? null, principal: ctx.principal ?? null, cap: ctx.maxCostUsd ?? null };
  },
});

/** Writes two files and declares one of them. */
const files = defineStep({
  type: "test/files",
  input: z.object({}).passthrough(),
  output: z.any(),
  async run(_cfg, ctx: StepContext<unknown>) {
    const artifacts = (ctx.services as { artifacts: { write(runId: string, p: string, c: string): Promise<unknown> } }).artifacts;
    await artifacts.write(ctx.runId, "out.txt", "the output");
    await artifacts.write(ctx.runId, "notes/secret.txt", "not declared");
    return { artifacts: [{ id: "out", title: "Out", path: "out.txt" }, { id: "site", title: "Site", url: "https://example.com/x" }] };
  },
});

/** Asks `llmAuth` what a model call of this step would carry. */
const asks = defineStep({
  type: "test/asks",
  input: z.object({}).passthrough(),
  output: z.any(),
  async run(_cfg, ctx: StepContext<unknown>) {
    const a = stepAuth(ctx);
    const grant = a.llmAuth ? await a.llmAuth({ ...a.auth!, provider: "anthropic" }) : undefined;
    return { macaroon: grant?.headers?.["x-macaroon"] ?? null, cap: ctx.maxCostUsd ?? null };
  },
});

const INPUT = "input:\n  cost: { type: number, default: 0 }\n  ms: { type: number, default: 0 }\n";
const WORKFLOWS: Record<string, string> = {
  spend: `name: spend\n${INPUT}steps:\n  - id: s\n    type: test/spend\n    config:\n      cost: "{{ input.cost }}"\n      ms: "{{ input.ms }}"\n`,
  sessions: `name: sessions\ninput:\n  session: { type: string }\nsteps:\n  - id: s\n    type: test/session\n    config:\n      id: "{{ input.session }}"\n`,
  files: `name: files\ninput:\n  q: { type: string, required: false }\nsteps:\n  - id: f\n    type: test/files\n    config: {}\n`,
  asks: `name: asks\ninput:\n  q: { type: string, required: false }\nsteps:\n  - id: a\n    type: test/asks\n    config: {}\n`,
  private: `name: private\n${INPUT}steps:\n  - id: s\n    type: test/spend\n    config: {}\n`,
  "acme/echo": `name: acme/echo\n${INPUT}steps:\n  - id: s\n    type: test/spend\n    config: {}\n`,
};

describe("free public runs", () => {
  let dir: string;
  let savedKey: string | undefined;
  const open: Array<{ close(): Promise<void> }> = [];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-public-runs-"));
    savedKey = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = KEY;
  });
  afterEach(async () => {
    for (const s of open.splice(0)) await s.close();
    if (savedKey === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = savedKey;
    await rm(dir, { recursive: true, force: true });
  });

  const boot = async (o: { runnable?: unknown[]; workflows?: unknown[]; maxInFlight?: number; wallet?: boolean; principal?: string; llmAuth?: ReturnType<typeof createMothership>["llmAuth"]; file?: boolean } = {}) => {
    const strut = await createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")),
      ...(o.file ? { autoResume: false } : { store: new MemoryRunStore() }),
      serveUi: false,
      scheduler: false,
      registry: await createRegistry([spend, session, files, asks]),
      ...(o.wallet
        ? { services: { lightning: lightningCapability(new FakeWallet()) }, payments: { rate: async () => ({ usdPerBtc: 100_000, at: new Date().toISOString(), source: "test" }) } }
        : {}),
      publicRuns: { ...(o.maxInFlight ? { maxInFlight: o.maxInFlight } : {}), ...(o.principal ? { principal: o.principal } : {}) },
      ...(o.llmAuth ? { llmAuth: o.llmAuth } : {}),
    });
    open.push(strut);
    for (const [name, yaml] of Object.entries(WORKFLOWS)) await strut.workspace.createWorkflow(name, yaml);
    await strut.workspace.setWorkflowOwner("spend", "owner-1");
    if (o.runnable) {
      const res = await strut.app.request("/public-view", { method: "PUT", headers: auth, body: JSON.stringify({ runnable: o.runnable, ...(o.workflows ? { workflows: o.workflows } : {}) }) });
      assert.equal(res.status, 200, await res.clone().text());
    }
    const launch = (name: string, body: unknown = {}, headers: Record<string, string> = {}) =>
      strut.app.request(`/public/workflows/${encodeURIComponent(name)}/run`, { method: "POST", headers: { ...json, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    const launched = async (name: string, body: unknown = {}) => {
      const res = await launch(name, body);
      assert.equal(res.status, 202, await res.clone().text());
      return (await res.json()) as { runId: string; token: string; existing?: boolean };
    };
    const read = (name: string, runId: string, q = "", headers: Record<string, string> = {}) =>
      strut.app.request(`/public/workflows/${encodeURIComponent(name)}/runs/${runId}${q}`, { headers });
    const ended = async (name: string, runId: string, token: string) => {
      const res = await read(name, runId, `?t=${encodeURIComponent(token)}&wait=10`);
      assert.equal(res.status, 200, await res.clone().text());
      return (await res.json()) as Record<string, any>;
    };
    return { strut, launch, launched, read, ended };
  };

  it("anyone runs a free workflow; the run token reads it back and nothing else does; the private routes refuse the token; past the daily cap is 429", async () => {
    const { strut, launch, launched, read, ended } = await boot({ runnable: [{ kind: "workflow", name: "spend", dailyCapUsd: 5 }] });
    // An anonymous launch: no credential at all.
    const first = await launched("spend", { input: { cost: 2 } });
    assert.ok(first.runId && first.token);
    const view = await ended("spend", first.runId, first.token);
    assert.equal(view.status, "success");
    assert.deepEqual(view.output, { spent: 2 });
    assert.equal(view.charged, 0, "a free run is charged nothing");
    assert.equal(view.totals.cost, 2, "its cost is the seller's, shown");
    assert.equal(view.origin, "public");
    for (const k of ["actor", "principal", "stepCounts"]) assert.equal(view[k], undefined, k);
    // Bearer works as well as ?t=.
    assert.equal((await read("spend", first.runId, "", { authorization: `Bearer ${first.token}` })).status, 200);
    // Nothing else reads it: no token, a wrong one, another run's.
    assert.equal((await read("spend", first.runId)).status, 404);
    assert.equal((await read("spend", first.runId, "?t=nope")).status, 404);
    const second = await launched("spend", { input: { cost: 1 } });
    await ended("spend", second.runId, second.token);
    assert.equal((await read("spend", first.runId, `?t=${second.token}`)).status, 404);
    // The private run routes refuse the token, as a query and as a Bearer.
    for (const path of [`/workflows/spend/runs/${first.runId}`, `/workflows/spend/runs/${first.runId}/events`, `/artifacts/${first.runId}`]) {
      assert.equal((await strut.app.request(`${path}?t=${first.token}`)).status, 401, path);
      assert.equal((await strut.app.request(path, { headers: { authorization: `Bearer ${first.token}` } })).status, 401, path);
    }
    // The run is recorded as a public one: no actor, the owner pays.
    const summary = (await strut.store.getRunSummary("spend", first.runId))!;
    assert.equal(summary.origin, "public");
    assert.equal(summary.actor, undefined);
    assert.equal(summary.principal, "owner-1");
    // $3 spent of $5: with no per-run cap, the next run's cap is a tenth of
    // the daily cap ($0.50, under the $2 left), and once the day is spent
    // the launch is a 429 until tomorrow (UTC).
    const ledger = await strut.ledger();
    assert.equal((await ledger.today("workflow:spend")).cost, usdToMicros(3));
    assert.equal((await ledger.today("workflow:spend")).calls, 2);
    const third = await launched("spend", { input: { cost: 2 } });
    await ended("spend", third.runId, third.token);
    const start = (await strut.store.getRunEvents("spend", third.runId)).find((e) => e.type === "run.start")!;
    assert.equal(start.maxCostUsd, 0.5, "with no per-run cap, a tenth of the daily cap");
    const refused = await launch("spend", { input: { cost: 1 } });
    assert.equal(refused.status, 429);
    assert.match(((await refused.json()) as { error: string }).error, /spent its daily cap \(\$5\.00\)/);
    const after = Number(refused.headers.get("retry-after"));
    assert.ok(after > 0 && after <= 86_400, String(after));
    // Credentials are ignored: the key is not a way past the cap.
    assert.equal((await launch("spend", { input: {} }, { authorization: `Bearer ${KEY}` })).status, 429);
  });

  it("the body is input and key alone, validated against the input: block; an item nobody made runnable is 404", async () => {
    const { launch } = await boot({ runnable: [{ kind: "workflow", name: "spend", dailyCapUsd: 5 }] });
    for (const extra of [{ params: { x: 1 } }, { job: "j" }, { callback: { url: "https://x" } }, { attachments: [] }, { settings: {} }, { runId: "1" }]) {
      const res = await launch("spend", { input: {}, ...extra });
      assert.equal(res.status, 400, JSON.stringify(extra));
      assert.match(((await res.json()) as { error: string }).error, new RegExp(`drop ${Object.keys(extra)[0]}`));
    }
    assert.equal((await launch("spend", { input: { cost: "lots" } })).status, 400, "a bad input");
    assert.equal((await launch("spend", "{nope")).status, 400, "not JSON");
    assert.equal((await launch("spend", [1])).status, 400, "not an object");
    assert.equal((await launch("spend", { key: "" })).status, 400, "an empty key");
    assert.equal((await launch("spend", { input: { pad: "x".repeat(300 * 1024) } })).status, 413, "over 256 KB");
    assert.equal((await launch("private", {})).status, 404, "not runnable");
    assert.equal((await launch("acme/echo", {})).status, 404, "a slashed name, not runnable");
    assert.equal((await launch("nope", {})).status, 404, "not here");
  });

  it("twenty launches at once never pass the daily cap: three fit, seventeen are 429", async () => {
    const { strut, launch, ended } = await boot({ runnable: [{ kind: "workflow", name: "spend", capUsd: 1, dailyCapUsd: 3 }] });
    const answers = await Promise.all(Array.from({ length: 20 }, () => launch("spend", { input: { cost: 1, ms: 200 } })));
    const ok = answers.filter((r) => r.status === 202);
    assert.equal(ok.length, 3);
    assert.equal(answers.filter((r) => r.status === 429).length, 17);
    const runs = (await Promise.all(ok.map((r) => r.json()))) as Array<{ runId: string; token: string }>;
    for (const r of runs) await ended("spend", r.runId, r.token);
    assert.equal((await (await strut.ledger()).today("workflow:spend")).cost, usdToMicros(3));
    assert.equal((await launch("spend", { input: {} })).status, 429, "and the day is spent");
  });

  it("with a daily cap and no per-run cap, ten run at once — each may spend a tenth of the day's cap", async () => {
    const { strut, launch, launched, ended } = await boot({ runnable: [{ kind: "workflow", name: "spend", dailyCapUsd: 5 }], maxInFlight: 20 });
    const answers = await Promise.all(Array.from({ length: 12 }, () => launch("spend", { input: { cost: 0.25, ms: 200 } })));
    const ok = answers.filter((r) => r.status === 202);
    assert.equal(ok.length, 10, "ten fit, not one");
    const refused = answers.filter((r) => r.status === 429);
    assert.equal(refused.length, 2);
    assert.match(((await refused[0]!.json()) as { error: string }).error, /set aside for runs in flight/);
    const runs = (await Promise.all(ok.map((r) => r.json()))) as Array<{ runId: string; token: string }>;
    for (const r of runs) {
      await ended("spend", r.runId, r.token);
      const start = (await strut.store.getRunEvents("spend", r.runId)).find((e) => e.type === "run.start")!;
      assert.equal(start.maxCostUsd, 0.5, "each run's cap is a tenth of the daily cap");
    }
    // $2.50 spent, nothing in flight: the next launch runs.
    const next = await launched("spend", { input: {} });
    await ended("spend", next.runId, next.token);
  });

  it("a workflow whose name carries a slash launches and reads back by its encoded name", async () => {
    const { strut, launched, ended } = await boot({ runnable: [{ kind: "workflow", name: "acme/echo" }] });
    const r = await launched("acme/echo", { input: {} });
    assert.equal((await ended("acme/echo", r.runId, r.token)).status, "success");
    const cancel = await strut.app.request(`/public/workflows/acme%2Fecho/runs/${r.runId}/cancel`, { method: "POST", headers: { authorization: `Bearer ${r.token}` } });
    assert.equal(cancel.status, 409, "open by name, and the run already ended");
  });

  it("the server's limit on public runs in flight", async () => {
    const { launch, launched, ended } = await boot({ runnable: [{ kind: "workflow", name: "spend" }], maxInFlight: 2 });
    const a = await launched("spend", { input: { ms: 300 } });
    const b = await launched("spend", { input: { ms: 300 } });
    const refused = await launch("spend", { input: {} });
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get("retry-after"), "30");
    assert.match(((await refused.json()) as { error: string }).error, /too many public runs in flight on this server \(2\)/);
    await ended("spend", a.runId, a.token);
    await ended("spend", b.runId, b.token);
    await launched("spend", { input: {} });
  });

  it("the same key from the same caller returns the run in flight, and sets nothing more aside", async () => {
    const { strut, launch, launched, ended } = await boot({ runnable: [{ kind: "workflow", name: "spend", capUsd: 1, dailyCapUsd: 1 }] });
    const first = await launched("spend", { input: { ms: 300 }, key: "k1" });
    const again = await launched("spend", { input: { ms: 300 }, key: "k1" });
    assert.equal(again.runId, first.runId);
    assert.equal(again.existing, true);
    assert.equal(again.token, first.token);
    assert.equal((await launch("spend", { input: {}, key: "k2" })).status, 429, "another key is another run, past the cap");
    await ended("spend", first.runId, first.token);
    assert.equal((await (await strut.ledger()).today("workflow:spend")).calls, 1);
  });

  it("a priced item with no credit token is a 402, and counts nothing in flight", async () => {
    const { launch } = await boot({ wallet: true, runnable: [{ kind: "workflow", name: "spend", base: 0.5 }], maxInFlight: 1 });
    // With room for one run, the 402 again (not the in-flight limit): the
    // refusal let the admission go. Priced runs: src/public-priced.test.ts.
    assert.equal((await launch("spend", { input: {} })).status, 402);
    assert.equal((await launch("spend", { input: {} })).status, 402);
  });

  it("results: output shows the launcher the summary and the declared files; results: run, the events and every file", async () => {
    const out = await boot({ runnable: [{ kind: "workflow", name: "files" }] });
    const r = await out.launched("files", {});
    const view = await out.ended("files", r.runId, r.token);
    assert.deepEqual(view.artifacts, [
      { id: "out", title: "Out", url: `/public/workflows/files/runs/${r.runId}/files/out.txt` },
      { id: "site", title: "Site", url: "https://example.com/x" },
    ]);
    const t = `?t=${r.token}`;
    assert.equal((await out.read("files", r.runId, `/files/out.txt${t}`)).status, 200);
    assert.equal(await (await out.read("files", r.runId, `/files/out.txt${t}`)).text(), "the output");
    assert.equal((await out.read("files", r.runId, `/files/notes/secret.txt${t}`)).status, 404, "not declared");
    assert.deepEqual(((await (await out.read("files", r.runId, `/files${t}`)).json()) as { files: string[] }).files, ["out.txt"]);
    assert.equal((await out.read("files", r.runId, `/events${t}`)).status, 404);
    assert.equal((await out.read("files", r.runId, `/transcripts/files/f${t}`)).status, 404);
    await out.strut.close();
    open.length = 0;

    const all = await boot({ runnable: [{ kind: "workflow", name: "files", results: "run" }] });
    const s = await all.launched("files", {});
    const whole = await all.ended("files", s.runId, s.token);
    assert.ok(whole.stepCounts, "the summary as a public run shows it");
    const u = `?t=${s.token}`;
    const events = (await (await all.read("files", s.runId, `/events${u}`)).json()) as RunEvent[];
    assert.ok(events.some((e) => e.type === "run.start"));
    assert.ok(events.every((e) => e.principal === undefined && e.actor === undefined));
    assert.deepEqual(((await (await all.read("files", s.runId, `/files${u}`)).json()) as { files: string[] }).files.sort(), ["notes/secret.txt", "out.txt"]);
    assert.equal((await all.read("files", s.runId, `/files/notes/secret.txt${u}`)).status, 200);
  });

  it("cancel takes that run's token and stops that run; another run's token is refused", async () => {
    const { strut, launched, ended } = await boot({ runnable: [{ kind: "workflow", name: "spend", capUsd: 1, dailyCapUsd: 5 }] });
    const a = await launched("spend", { input: { ms: 5000, cost: 1 } });
    const b = await launched("spend", { input: { ms: 5000 } });
    const cancel = (runId: string, token?: string) =>
      strut.app.request(`/public/workflows/spend/runs/${runId}/cancel`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });
    assert.equal((await cancel(a.runId)).status, 404, "no token");
    assert.equal((await cancel(a.runId, b.token)).status, 404, "another run's token");
    // Wait for run.start, so the cancel finds it live.
    while (!(await strut.store.getRunEvents("spend", a.runId)).length) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await cancel(a.runId, a.token)).status, 202);
    const view = await ended("spend", a.runId, a.token);
    assert.equal(view.status, "cancelled");
    assert.equal(view.charged, 0);
    assert.equal((await (await strut.ledger()).today("workflow:spend")).calls, 1, "a cancelled run is charged, its cost counted");
    // The other run goes on.
    assert.equal((await strut.app.request(`/public/workflows/spend/runs/${b.runId}?t=${b.token}`)).status, 200);
    assert.equal(((await (await strut.app.request(`/public/workflows/spend/runs/${b.runId}?t=${b.token}`)).json()) as { status: string }).status, "running");
    assert.equal((await cancel(b.runId, b.token)).status, 202);
    await ended("spend", b.runId, b.token);
  });

  it("a public run opens its sessions under public/<runId>/, has no job and no actor, and bills the host's public principal", async () => {
    const { launched, ended } = await boot({ runnable: [{ kind: "workflow", name: "sessions", results: "run" }], principal: "public-runs" });
    const r = await launched("sessions", { input: { session: "tom-1/abc" } });
    const view = await ended("sessions", r.runId, r.token);
    assert.equal(view.output.opened, `public/${r.runId}/tom-1/abc`, "a name a stranger chose is never a local thread");
    assert.equal(view.output.job, null);
    assert.equal(view.output.actor, null);
    assert.equal(view.output.principal, "public-runs");
  });

  it("the run's cap reaches llmAuth: the Mothership's link carries the smallest of the item's, the workflow's and what is left of the day", async () => {
    const orgPriv = randomBytes(32);
    orgPriv[0] = 1;
    const policy: Policy = { type: "single", key: { alg: "ecdsa-secp256k1-sha256", key: bytesToHex(ecdsaPublicKey(orgPriv)) } };
    const d = mintDelegation({ actor: "owner-1", orgPriv, userPriv: randomBytes(32) });
    const ms = createMothership({ dataDir: "/nonexistent", store: new MemorySecretStore() });
    await ms.delegations.put("owner-1", { macaroon: d.macaroon, delegationId: d.delegationId, apiKey: "vk", baseUrl: "https://gw.example", exp: d.exp });
    const { strut, launched, ended } = await boot({ llmAuth: ms.llmAuth, runnable: [{ kind: "workflow", name: "asks", results: "run", capUsd: 3, dailyCapUsd: 7 }] });
    ms.mount({ app: new Hono(), workspace: strut.workspace });
    await strut.workspace.setWorkflowOwner("asks", "owner-1");
    await strut.workspace.setWorkflowRunCap("asks", 20);
    const capOf = async () => {
      const r = await launched("asks", {});
      const view = await ended("asks", r.runId, r.token);
      return { cap: view.output.cap as number, link: verify(view.output.macaroon as string, policy, new Date()).effective_caveats.max_cost_usd };
    };
    assert.deepEqual(await capOf(), { cap: 3, link: 3 }, "the item's per-run cap");
    await strut.workspace.setWorkflowRunCap("asks", 2);
    assert.deepEqual(await capOf(), { cap: 2, link: 2 }, "the workflow's own, when smaller");
    await strut.workspace.setWorkflowRunCap("asks", 20);
    // $6.50 spent today: what is left of the $7 day is the smallest.
    const ledger = await strut.ledger();
    await ledger.charge({ runId: "earlier", subject: "workflow:asks", cost: usdToMicros(6.5), outcome: "success", price: { base: 0, markup: 0 } });
    assert.deepEqual(await capOf(), { cap: 0.5, link: 0.5 }, "what is left of the daily cap");
  });
});

describe("the run's cap, resolved", () => {
  it("the smaller of the run's own cap and the workflow's; a bad one is an error", () => {
    assert.equal(resolveRunCap(10, {}, 100, 3), 3);
    assert.equal(resolveRunCap(2, {}, 100, 3), 2);
    assert.equal(resolveRunCap(undefined, { STRUT_RUN_MAX_COST_USD: "4" }, 100, 9), 4);
    assert.equal(resolveRunCap(undefined, {}, 100), 100);
    assert.throws(() => resolveRunCap(10, {}, 100, 0), /positive number/);
    assert.throws(() => resolveRunCap(10, {}, 100, Number.NaN), /positive number/);
  });
});

describe("public runs: the charge, once, across a restart", () => {
  const putSummary = (store: MemoryRunStore, workflow: string, runId: string, status: "success" | "error", cost: number) =>
    store.summaries.set(`${workflow}/${runId}`, { runId, workflow, status, origin: "public", totals: { modelCalls: 1, usage: {}, cost } } as never);
  const ev = (runId: string, type: RunEvent["type"], more: Partial<RunEvent> = {}): RunEvent => ({ ts: new Date().toISOString(), runId, path: "w", type, ...more });

  it("on file until charged; at boot every run on file counts in flight, and the reconcile charges what is not live — once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-public-runs-file-"));
    try {
      const store = new MemoryRunStore();
      const ledger = new MemoryLedgerStore();
      const file = publicRunsPath(dir);
      const a = createPublicRuns({ ledger: async () => ledger, store, file });
      const item = { kind: "workflow" as const, name: "w", capUsd: 1, dailyCapUsd: 10 };
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const got = await a.admit(item, { workflowCapUsd: 100 });
        assert.equal(got.ok, true);
        ids.push((got as { runId: string }).runId);
      }
      assert.equal(((JSON.parse(await readFile(file, "utf-8"))) as unknown[]).length, 5, "on file before it launches");
      // A dies. What its runs left: one ended (summary), one whose log ended
      // with no summary, one cut off mid-run, one that never started, one a
      // resume relaunched.
      const [ended, logEnded, cutOff, never, resumed] = ids as [string, string, string, string, string];
      putSummary(store, "w", ended, "success", 0.5);
      for (const e of [ev(logEnded, "run.start", { origin: "public" }), ev(logEnded, "step.end", { cost: 0.25, modelCalls: 1, usage: {} }), ev(logEnded, "run.end", { output: {} })]) store.events.set(`w/${logEnded}`, [...(store.events.get(`w/${logEnded}`) ?? []), e]);
      for (const e of [ev(cutOff, "run.start", { origin: "public" }), ev(cutOff, "step.end", { cost: 0.125, modelCalls: 1, usage: {} })]) store.events.set(`w/${cutOff}`, [...(store.events.get(`w/${cutOff}`) ?? []), e]);
      store.events.set(`w/${resumed}`, [ev(resumed, "run.start", { origin: "public" })]);

      const b = createPublicRuns({ ledger: async () => ledger, store, file, maxInFlight: 5 });
      await b.load();
      assert.equal(b.inFlight(), 5, "every run on file counts in flight at boot");
      assert.equal((await b.admit(item, { workflowCapUsd: 100 })).ok, false, "the limit counts them");
      const out = await b.reconcile((_w, runId) => runId === resumed);
      assert.deepEqual(
        Object.fromEntries(out.map((r) => [r.runId, r.action])),
        { [ended]: "charged", [logEnded]: "charged", [cutOff]: "charged", [never]: "dropped", [resumed]: "live" },
      );
      const today = await ledger.today("workflow:w");
      assert.equal(today.calls, 3);
      assert.equal(today.cost, usdToMicros(0.875));
      assert.equal(today.failed, 1, "a run cut off and never resumed is charged as an error, at what its log spent");
      // The resumed run ends: charged once; a second end, and a second
      // reconcile, write nothing.
      putSummary(store, "w", resumed, "success", 1);
      await b.ended("w", resumed);
      await b.ended("w", resumed);
      await b.reconcile(() => false);
      const after = await ledger.today("workflow:w");
      assert.equal(after.calls, 4);
      assert.equal(after.cost, usdToMicros(1.875));
      assert.equal(b.inFlight(), 0);
      assert.deepEqual(JSON.parse(await readFile(file, "utf-8")), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a public run cut off by a restart is resumed as a public run and charged once, for its whole cost", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-public-runs-resume-"));
    const saved = process.env["STRUT_API_KEY"];
    delete process.env["STRUT_API_KEY"];
    try {
      const ws = join(dir, "ws");
      const registry = await createRegistry([spend, session]);
      const yaml = `name: two\n${INPUT}steps:\n  - id: a\n    type: test/spend\n    config:\n      cost: 1.5\n  - id: b\n    type: test/spend\n    config:\n      cost: 0.5\n`;
      const first = await createStrut({ workspace: new WorkspaceManager(ws), serveUi: false, scheduler: false, registry, autoResume: false });
      await first.workspace.createWorkflow("two", yaml);
      const runId = "1800000000000";
      // What a dead process left: `run.start` (public, its cap), step a's
      // end with its cost, no end; and the run on file, not yet charged.
      const t = new Date().toISOString();
      await first.store.append("two", runId, { ts: t, runId, path: "two", type: "run.start", origin: "public", input: { cost: 0, ms: 0 }, maxCostUsd: 4 });
      await first.store.append("two", runId, { ts: t, runId, path: "two/a", type: "step.start", stepType: "test/spend" });
      await first.store.append("two", runId, { ts: t, runId, path: "two/a", type: "step.end", stepType: "test/spend", output: { spent: 1.5 }, cost: 1.5, modelCalls: 1, usage: {} });
      await first.close();
      await mkdir(join(ws, "payments"), { recursive: true, mode: 0o700 });
      await writeFile(publicRunsPath(ws), JSON.stringify([{ workflow: "two", runId, subject: "workflow:two", cap: usdToMicros(4), at: Date.now() }]));

      const second = await createStrut({ workspace: new WorkspaceManager(ws), serveUi: false, scheduler: false, registry, autoResume: { delayMs: 0 } });
      try {
        const deadline = Date.now() + 10_000;
        let summary = await second.store.getRunSummary("two", runId);
        while (!summary && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25));
          summary = await second.store.getRunSummary("two", runId);
        }
        assert.ok(summary, "resumed and finished");
        assert.equal(summary.origin, "public");
        const events = await second.store.getRunEvents("two", runId);
        assert.ok(events.some((e) => e.type === "run.resumed"));
        // Charged once the run is let go; wait for the file to empty.
        while (Date.now() < deadline && JSON.parse(await readFile(publicRunsPath(ws), "utf-8")).length) await new Promise((r) => setTimeout(r, 25));
        assert.deepEqual(JSON.parse(await readFile(publicRunsPath(ws), "utf-8")), []);
        const today = await (await second.ledger()).today("workflow:two");
        assert.equal(today.calls, 1);
        assert.equal(today.cost, usdToMicros(2), "the whole run's cost, before and after the restart");
      } finally {
        await second.close();
      }
      // A third boot finds nothing to charge again.
      const third = await createStrut({ workspace: new WorkspaceManager(ws), serveUi: false, scheduler: false, registry, autoResume: { delayMs: 0 } });
      try {
        await new Promise((r) => setTimeout(r, 200));
        assert.equal((await (await third.ledger()).today("workflow:two")).calls, 1);
      } finally {
        await third.close();
      }
    } finally {
      if (saved === undefined) delete process.env["STRUT_API_KEY"];
      else process.env["STRUT_API_KEY"] = saved;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dailyRoom: a full cap while the day holds one, never a sliver; the last of the day to one run alone", () => {
    const $ = usdToMicros;
    const base = { daily: $(5), full: $(1) };
    assert.deepEqual(dailyRoom({ ...base, today: 0, held: $(3), inFlight: 3 }), { ok: true, cap: $(1) });
    // $4.70 spent or held, runs in flight: $0.30 is left — a sliver the
    // gateway would stop partway, so wait for a run to end.
    assert.deepEqual(dailyRoom({ ...base, today: $(0.7), held: $(4), inFlight: 4 }), { ok: false, spent: false });
    // Nothing in flight and $0.30 left: the last run of the day, with that.
    assert.deepEqual(dailyRoom({ ...base, today: $(4.7), held: 0, inFlight: 0 }), { ok: true, cap: $(0.3) });
    assert.deepEqual(dailyRoom({ ...base, today: $(5), held: 0, inFlight: 0 }), { ok: false, spent: true });
    // A per-run cap over the daily cap: one run at a time, all day.
    const big = { daily: $(5), full: $(8) };
    assert.deepEqual(dailyRoom({ ...big, today: $(1), held: 0, inFlight: 0 }), { ok: true, cap: $(4) });
    assert.deepEqual(dailyRoom({ ...big, today: $(1), held: $(4), inFlight: 1 }), { ok: false, spent: false });
  });

  it("a charge that fails at the run's end is tried again, not left until the next boot", async () => {
    const store = new MemoryRunStore();
    const ledger = new MemoryLedgerStore();
    let failures = 2;
    const flaky = new Proxy(ledger, {
      get(t, prop, r) {
        if (prop === "charge") {
          return async (input: Parameters<MemoryLedgerStore["charge"]>[0]) => {
            if (failures-- > 0) throw new Error("the ledger is busy");
            return t.charge(input);
          };
        }
        const v = Reflect.get(t, prop, r) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const runs = createPublicRuns({ ledger: async () => flaky, store, settleRetryMs: [5] });
    const item = { kind: "workflow" as const, name: "w", dailyCapUsd: 10 };
    const got = await runs.admit(item, { workflowCapUsd: 100 });
    assert.equal(got.ok, true);
    const runId = (got as { runId: string }).runId;
    store.summaries.set(`w/${runId}`, { runId, workflow: "w", status: "success", origin: "public", totals: { modelCalls: 1, usage: {}, cost: 0.5 } } as never);
    await runs.ended("w", runId);
    assert.equal(runs.inFlight(), 1, "the first charge failed: still counted");
    for (let i = 0; i < 50 && runs.inFlight() > 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(runs.inFlight(), 0, "charged on a retry");
    assert.equal((await ledger.today("workflow:w")).cost, usdToMicros(0.5));
  });

  it("a runs file that does not read is moved aside, and the server still boots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-public-runs-bad-"));
    try {
      const file = publicRunsPath(dir);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, "[{\"workflow\": \"w\", \"ru");
      const runs = createPublicRuns({ ledger: async () => new MemoryLedgerStore(), store: new MemoryRunStore(), file });
      await runs.load();
      assert.equal(runs.inFlight(), 0);
      await assert.rejects(readFile(file, "utf-8"), /ENOENT/, "moved aside");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("secondsToUtcMidnight", () => {
    assert.equal(secondsToUtcMidnight(Date.parse("2026-11-10T23:59:00Z")), 60);
    assert.equal(secondsToUtcMidnight(Date.parse("2026-11-10T00:00:00Z")), 86_400);
  });
});
