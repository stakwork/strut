/**
 * Public tools (plans/paid-runs.md work item 6; §3's table, §6 "A tool",
 * decision 15): `POST /public/steps/:type/run { config }` — free, or charged
 * by the rule against a credit token — run once against an allowlist bag,
 * never kept as a run. Against the fake wallet and a step whose reported
 * cost the test sets.
 */
import { describe, it, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createStrut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { defineStep, withUsage, type StepContext } from "./core.js";
import { createRegistry } from "./steps/registry.js";
import { FakeWallet } from "./payments/fake-wallet.js";
import { lightningCapability } from "./payments/lightning.js";
import { MemoryLedgerStore } from "./payments/ledger-memory.js";
import { usdToMicros } from "./payments/ledger.js";
import type { ExchangeRate } from "./payments/rate.js";
import { addCaveat, decodeIdentifier, macaroonFromBase64, macaroonToBase64 } from "./l402.js";
import { createPublicTools, guardedHttp, inputTemplates, publicToolServices, withoutCredentials, PUBLIC_TOOL_RESULT_MAX_CHARS } from "./public-tools.js";
import { PUBLIC_POST } from "./public-routes.js";
import { PUBLIC_PATH as EXPORTED_PATH, PUBLIC_POST as EXPORTED_POST } from "./index.js";
import type { GraphBackend } from "./graph/backend.js";
import type { LedgerStore } from "./payments/ledger.js";
import { seedConceptSchema, testBackends } from "./graph/test-util.js";
import { seedStrutDomain } from "./graph/schema-seed.js";

const KEY = "public-tools-key";
const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const json = { "content-type": "application/json" };
const RATE = 100_000; // dollars per bitcoin: $1 is 1000 sats
const fixedRate = async (): Promise<ExchangeRate> => ({ usdPerBtc: RATE, at: new Date().toISOString(), source: "test" });

/** Await `p` with the event loop held open. The service's own timers (a
 *  call's time limit, a refused charge's retry) are unref'd, so they never
 *  keep a server alive; a test that waits on one alone would let Node 22's
 *  runner see an idle loop and cancel the file. */
async function heldOpen<T>(p: Promise<T>): Promise<T> {
  const keep = setInterval(() => undefined, 1000);
  try {
    return await p;
  } finally {
    clearInterval(keep);
  }
}

/** Released by a test that holds calls in flight. */
let gate: Promise<void> = Promise.resolve();

/** A tool whose reported cost, failure and size its config sets. */
const tool = (type: string) =>
  defineStep({
    type,
    description: `test tool ${type}`,
    input: z.object({ cost: z.number().optional(), fail: z.boolean().optional(), big: z.boolean().optional(), wait: z.boolean().optional(), note: z.string().default("hi") }),
    output: z.any(),
    async run(cfg, ctx: StepContext<unknown>) {
      if (cfg.wait) await gate;
      if (cfg.fail) {
        // A call it made before it failed, reported as a tool call's end.
        if (cfg.cost) await ctx.emit({ ts: new Date().toISOString(), runId: ctx.runId, path: `${ctx.path}/001-api`, type: "step.end", stepType: "tool:api", cost: cfg.cost, modelCalls: 1, usage: {} } as never);
        throw new Error("the API said no");
      }
      const out = { note: cfg.note, ...(ctx.maxCostUsd !== undefined ? { cap: ctx.maxCostUsd } : {}), ...(cfg.big ? { blob: "x".repeat(PUBLIC_TOOL_RESULT_MAX_CHARS + 10) } : {}) };
      return withUsage(out, cfg.cost ? { modelCalls: 1, usage: {}, cost: cfg.cost } : undefined);
    },
  });
/** Reaches for what a public tool's bag does not hold. */
const reach = defineStep({
  type: "tool/reach",
  input: z.object({ what: z.enum(["shell", "graph-write", "artifacts", "sessions", "runs", "launch"]) }),
  output: z.any(),
  async run(cfg, ctx: StepContext<unknown>) {
    const bag = ctx.services as Record<string, any>;
    if (cfg.what === "shell") return bag["shell"].run({ cmd: "true" });
    if (cfg.what === "graph-write") return bag["graph"].nodes.write({ type: "Concept", data: { name: "x" } });
    if (cfg.what === "artifacts") return bag["artifacts"].write(ctx.runId, "a.txt", "x");
    if (cfg.what === "runs") return bag["runs"].list({ workflow: "private" });
    if (cfg.what === "launch") return bag["runs"].launch({ workflow: "private", input: {} });
    return bag["sessions"].open("s", { runId: ctx.runId, path: ctx.path });
  },
});
/** A step whose caller names the secret it reads: never callable by anyone. */
const named = defineStep({
  type: "tool/named",
  input: z.object({ url: z.string(), tokenSecret: z.string().default("GITHUB_TOKEN") }),
  output: z.any(),
  async run() {
    return { ok: true };
  },
});
const STEPS = ["tool/free", "tool/fixed", "tool/metered", "tool/both", "tool/other"].map(tool);

class WatchedStore extends MemoryRunStore {
  writes = 0;
  override async append(...a: Parameters<MemoryRunStore["append"]>) {
    this.writes++;
    return super.append(...a);
  }
  override async finalize(...a: Parameters<MemoryRunStore["finalize"]>) {
    this.writes++;
    return super.finalize(...a);
  }
}

interface Challenge402 {
  usd: number;
  sats: number;
  invoice: string;
  macaroon: string;
  remaining_usd: number;
  reason?: string;
  carries?: boolean;
  description: string;
}

describe("public tools", () => {
  let dir: string;
  let savedKey: string | undefined;
  const open: Array<{ close(): Promise<void> }> = [];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-public-tools-"));
    savedKey = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = KEY;
    gate = Promise.resolve();
  });
  afterEach(async () => {
    for (const s of open.splice(0)) await s.close();
    if (savedKey === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = savedKey;
    await rm(dir, { recursive: true, force: true });
  });

  const boot = async (runnable: unknown[], o: { steps?: string[] } = {}) => {
    const wallet = new FakeWallet();
    const store = new WatchedStore();
    const strut = await createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")),
      store,
      serveUi: false,
      scheduler: false,
      registry: await createRegistry([...STEPS, reach, named]),
      services: { lightning: lightningCapability(wallet) },
      payments: { rate: fixedRate },
    });
    open.push(strut);
    const put = await strut.app.request("/public-view", { method: "PUT", headers: auth, body: JSON.stringify({ runnable, ...(o.steps ? { steps: o.steps } : {}) }) });
    assert.equal(put.status, 200, await put.clone().text());
    let addr = 0;
    const call = (type: string, body: unknown = {}, credential?: string, o2: { address?: string } = {}) =>
      strut.app.request(
        `/public/steps/${type}/run`,
        {
          method: "POST",
          headers: { ...json, "x-forwarded-for": o2.address ?? `198.51.100.${++addr % 250}`, ...(credential ? { authorization: `L402 ${credential}` } : {}) },
          body: JSON.stringify(body),
        },
        // Through a proxy on loopback, which names each caller.
        { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
      );
    const ok = async (res: Response) => {
      assert.equal(res.status, 200, await res.clone().text());
      return (await res.json()) as { output: Record<string, unknown>; credit?: Record<string, number | string> };
    };
    const challenged = async (res: Response) => {
      assert.equal(res.status, 402, await res.clone().text());
      return (await res.json()) as Challenge402;
    };
    const pay = (c: Challenge402) => `${c.macaroon}:${wallet.settle(c.invoice)}`;
    const buy = async (usd: number) => {
      const res = await strut.app.request("/public/credit", { method: "POST", headers: json, body: JSON.stringify({ usd }) });
      return pay(await challenged(res));
    };
    const credit = async (credential: string) => {
      const res = await strut.app.request("/public/credit", { headers: { authorization: `L402 ${credential}` } });
      assert.equal(res.status, 200, await res.clone().text());
      return (await res.json()) as Record<string, any>;
    };
    return { strut, store, wallet, call, ok, challenged, pay, buy, credit };
  };

  it("a free step answers its output at once, needs no token, and is counted in the ledger with its cost — never in the run store", async () => {
    const { strut, store, call, ok } = await boot([{ kind: "step", name: "tool/free" }]);
    const a = await ok(await call("tool/free", { config: { cost: 0.3, note: "cve" } }));
    assert.deepEqual(a, { output: { note: "cve" } });
    const b = await ok(await call("tool/free"));
    assert.deepEqual(b.output, { note: "hi" }, "no config: the step's defaults");
    const day = await (await strut.ledger()).today("step:tool/free");
    assert.deepEqual({ calls: day.calls, failed: day.failed, earned: day.earned, cost: day.cost }, { calls: 2, failed: 0, earned: 0, cost: usdToMicros(0.3) });
    assert.equal(store.writes, 0, "nothing reaches the run store");
    assert.equal(store.events.size + store.summaries.size, 0);
  });

  it("with a daily cap and no per-call cap, ten calls run at once — each may spend a tenth of the day's cap", async () => {
    const { strut, call, ok } = await boot([{ kind: "step", name: "tool/free", dailyCapUsd: 5 }]);
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    let settled = 0;
    const pending = Array.from({ length: 12 }, () => call("tool/free", { config: { wait: true, cost: 0.25 } }).finally(() => settled++));
    // The two refused answer at once; the ten admitted wait on the gate.
    const deadline = Date.now() + 10_000;
    while (settled < 2) {
      if (Date.now() > deadline) throw new Error("no call was refused");
      await new Promise((r) => setTimeout(r, 10));
    }
    release();
    const answers = await Promise.all(pending);
    const done = answers.filter((r) => r.status === 200);
    assert.equal(done.length, 10, answers.map((r) => r.status).join(","));
    const refused = answers.filter((r) => r.status === 429);
    assert.equal(refused.length, 2);
    assert.match(((await refused[0]!.json()) as { error: string }).error, /set aside for calls in flight/);
    for (const r of done) assert.equal((await r.json()).output.cap, 0.5, "each call's cap is a tenth of the daily cap");
    assert.equal((await (await strut.ledger()).today("step:tool/free")).cost, usdToMicros(2.5));
    // $2.50 spent, nothing in flight: the next call runs, with a whole cap.
    assert.equal((await ok(await call("tool/free", { config: {} }))).output["cap"], 0.5);
  });

  it("the pricing rule: base alone, markup alone, both; a call that reports no cost is charged its base", async () => {
    const { call, ok, buy, credit } = await boot([
      { kind: "step", name: "tool/fixed", base: 0.5 },
      { kind: "step", name: "tool/metered", markup: 2, capUsd: 1 },
      { kind: "step", name: "tool/both", base: 0.1, markup: 1.5, capUsd: 2 },
    ]);
    const cred = await buy(20);
    const fixed = await ok(await call("tool/fixed", { config: { cost: 2 } }, cred));
    assert.equal(fixed.credit!["charged_usd"], 0.5, "base alone, whatever it cost");
    assert.equal(fixed.credit!["remaining_usd"], 19.5);
    assert.equal((await ok(await call("tool/fixed", { config: {} }, cred))).credit!["charged_usd"], 0.5, "no cost reported: its base");
    assert.equal((await ok(await call("tool/metered", { config: { cost: 0.3 } }, cred))).credit!["charged_usd"], 0.6, "markup alone: 2 × 0.30");
    assert.equal((await ok(await call("tool/metered", { config: {} }, cred))).credit!["charged_usd"], 0, "metered, no cost reported: its base, nothing");
    const both = await ok(await call("tool/both", { config: { cost: 1 } }, cred));
    assert.equal(both.credit!["charged_usd"], 1.6, "both: 0.10 + 1.5 × 1");
    assert.equal(both.credit!["remaining_usd"], 16.8, "20 − 0.50 − 0.50 − 0.60 − 1.60");
    assert.ok(typeof both.credit!["remaining_sats"] === "number" && typeof both.credit!["expires"] === "string");
    const bal = await credit(cred);
    assert.deepEqual({ spent: bal.spent_usd, held: bal.held_usd }, { spent: 3.2, held: 0 });
  });

  it("a throw is charged its cost and no base, and answers its error; a result over 5 MB likewise; never more than the reserve", async () => {
    const { strut, call, buy } = await boot([{ kind: "step", name: "tool/both", base: 0.1, markup: 1.5, capUsd: 2 }]);
    const cred = await buy(20);
    const thrown = await call("tool/both", { config: { fail: true, cost: 0.4 } }, cred);
    assert.equal(thrown.status, 500);
    const t = (await thrown.json()) as { error: string; code: string; credit: Record<string, number> };
    assert.equal(t.code, "step_failed");
    assert.match(t.error, /the API said no/);
    assert.equal(t.credit["charged_usd"], 0.4, "its cost, no markup, no base");
    const nothing = (await (await call("tool/both", { config: { fail: true } }, cred)).json()) as { credit: Record<string, number> };
    assert.equal(nothing.credit["charged_usd"], 0, "a throw that spent nothing: nothing");
    const big = await call("tool/both", { config: { big: true, cost: 0.2 } }, cred);
    assert.equal(big.status, 500);
    const b = (await big.json()) as { code: string; error: string; credit: Record<string, number>; output?: unknown };
    assert.equal(b.code, "result_too_big");
    assert.match(b.error, /over the 5 MB cap/);
    assert.equal(b.output, undefined);
    assert.equal(b.credit["charged_usd"], 0.2, "charged like a throw: its cost");
    // The rule asks 0.10 + 1.5 × 10 = 15.10; the reserve is 0.10 + 1.5 × 2.
    const over = (await (await call("tool/both", { config: { cost: 10 } }, cred)).json()) as { credit: Record<string, number> };
    assert.equal(over.credit["charged_usd"], 3.1, "never more than the reserve");
    const ledger = await strut.ledger();
    assert.deepEqual(await ledger.today("step:tool/both"), {
      key: "step:tool/both",
      calls: 4,
      failed: 3,
      earned: usdToMicros(0.4 + 0.2 + 3.1),
      cost: usdToMicros(0.4 + 0.2 + 10),
    });
  });

  it("a tool's calls show in GET /earnings by item: a step:<type> row beside a workflow's", async () => {
    const { strut, call, ok, buy } = await boot([{ kind: "step", name: "tool/fixed", base: 0.5 }]);
    await strut.workspace.createWorkflow("hello", "name: hello\ninput:\n  who: { type: string, default: x }\nsteps:\n  - id: s\n    type: log\n    config:\n      message: hi\n");
    const put = await strut.app.request("/public-view", { method: "PUT", headers: auth, body: JSON.stringify({ runnable: [{ kind: "step", name: "tool/fixed", base: 0.5 }, { kind: "workflow", name: "hello" }] }) });
    assert.equal(put.status, 200, await put.clone().text());
    const launched = (await (await strut.app.request("/public/workflows/hello/run", { method: "POST", headers: json, body: JSON.stringify({ input: {} }) })).json()) as { runId: string; token: string };
    assert.equal((await strut.app.request(`/public/workflows/hello/runs/${launched.runId}?t=${encodeURIComponent(launched.token)}&wait=10`)).status, 200);
    const cred = await buy(2);
    await ok(await call("tool/fixed", { config: { cost: 0.3 } }, cred));
    await ok(await call("tool/fixed", { config: {} }, cred));
    const res = await strut.app.request("/earnings", { headers: auth });
    assert.equal(res.status, 200, await res.clone().text());
    const view = (await res.json()) as { rows: Array<{ key: string; calls: number; failed: number; earned: number; cost: number }> };
    const step = view.rows.find((r) => r.key === "step:tool/fixed");
    assert.deepEqual(step && { calls: step.calls, failed: step.failed, earned: step.earned, cost: step.cost }, { calls: 2, failed: 0, earned: 1, cost: 0.3 });
    const wf = view.rows.find((r) => r.key === "workflow:hello");
    assert.ok(wf, view.rows.map((r) => r.key).join(", "));
    assert.equal(wf!.calls, 1);
  });

  it("a token one cent short is a 402 for the shortfall that carries; the top-up runs", async () => {
    const { call, ok, challenged, pay, buy, credit } = await boot([{ kind: "step", name: "tool/fixed", base: 0.5 }]);
    const none = await challenged(await call("tool/fixed", { config: {} }));
    assert.deepEqual({ usd: none.usd, sats: none.sats, remaining: none.remaining_usd, description: none.description }, { usd: 0.5, sats: 500, remaining: 0, description: "tool/fixed: credit for one call" });
    const a = await buy(0.49);
    const short = await challenged(await call("tool/fixed", { config: {} }, a));
    assert.deepEqual({ usd: short.usd, sats: short.sats, remaining: short.remaining_usd, reason: short.reason, carries: short.carries }, { usd: 0.01, sats: 10, remaining: 0.49, reason: "short", carries: true });
    const b = pay(short);
    const done = await ok(await call("tool/fixed", { config: {} }, b));
    assert.deepEqual({ charged: done.credit!["charged_usd"], remaining: done.credit!["remaining_usd"] }, { charged: 0.5, remaining: 0 });
    assert.equal((await credit(a)).replaced, true);
  });

  it("a narrowed token is held to its caveats: another item's is 403, one whose max charge is under the reserve is 403", async () => {
    const { call, ok, buy } = await boot([
      { kind: "step", name: "tool/fixed", base: 0.5 },
      { kind: "step", name: "tool/other", base: 0.5 },
    ]);
    const a = await buy(5);
    const [mac, preimage] = a.split(":") as [string, string];
    const narrow = (...caveats: string[]) => `${macaroonToBase64(caveats.reduce((m, c) => addCaveat(m, c), macaroonFromBase64(mac)))}:${preimage}`;
    const onlyOther = narrow("strut_capabilities=step:tool/other");
    const notThis = await call("tool/fixed", { config: {} }, onlyOther);
    assert.equal(notThis.status, 403);
    assert.equal(((await notThis.json()) as { code: string }).code, "token_not_for_this");
    const capped = await call("tool/fixed", { config: {} }, narrow("strut_max_charge=400000"));
    assert.equal(capped.status, 403);
    assert.equal(((await capped.json()) as { code: string }).code, "token_over_max_charge");
    assert.equal((await ok(await call("tool/other", { config: {} }, onlyOther))).credit!["charged_usd"], 0.5);
    const workflowOnly = await call("tool/other", { config: {} }, narrow("strut_capabilities=workflow:tool/other"));
    assert.equal(workflowOnly.status, 403, "a capability names its kind");
  });

  it("twenty calls at once on a token that covers three reserves: three run, seventeen are 402, and the token is never overdrawn", async () => {
    const { strut, call, buy, credit } = await boot([{ kind: "step", name: "tool/fixed", base: 1 }]);
    const cred = await buy(3);
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const pending = Array.from({ length: 20 }, () => call("tool/fixed", { config: { wait: true } }, cred));
    // Three holds land while the rest are answered 402.
    const deadline = Date.now() + 10_000;
    const tokenId = decodeIdentifier(macaroonFromBase64(cred.split(":")[0]!).id).tokenId;
    while (((await (await strut.ledger()).token(tokenId))?.held ?? 0) < usdToMicros(3)) {
      if (Date.now() > deadline) throw new Error("the holds never landed");
      await new Promise((r) => setTimeout(r, 10));
    }
    const mid = await credit(cred);
    assert.deepEqual({ held: mid.held_usd, remaining: mid.remaining_usd }, { held: 3, remaining: 0 });
    release();
    const answers = await Promise.all(pending);
    assert.equal(answers.filter((r) => r.status === 200).length, 3, answers.map((r) => r.status).join(","));
    assert.equal(answers.filter((r) => r.status === 402).length, 17);
    const bal = await credit(cred);
    assert.deepEqual({ spent: bal.spent_usd, held: bal.held_usd, remaining: bal.remaining_usd }, { spent: 3, held: 0, remaining: 0 });
    assert.equal((await (await strut.ledger()).today("step:tool/fixed")).calls, 3);
  });

  it("the body is { config } alone, at most 256 KB; a config the step's schema refuses is 400 naming the field; an item nobody opened is 404", async () => {
    const { call, strut } = await boot([{ kind: "step", name: "tool/free" }]);
    assert.equal((await call("tool/free", { config: {}, key: "k" })).status, 400);
    assert.equal((await call("tool/free", [])).status, 400);
    const bad = await call("tool/free", { config: { cost: "lots" } });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /config\.cost/);
    assert.equal((await call("tool/free", { config: "x" })).status, 400);
    const huge = await strut.app.request("/public/steps/tool/free/run", { method: "POST", headers: json, body: JSON.stringify({ config: { note: "x".repeat(300 * 1024) } }) });
    assert.equal(huge.status, 413);
    assert.equal((await call("tool/fixed", { config: {} })).status, 404, "a step not in runnable");
    assert.equal((await call("tool/nope", { config: {} })).status, 404);
  });

  it("a stranger's {{ inside a value is text: passed to the step as it came, never evaluated", async () => {
    const { call, ok } = await boot([{ kind: "step", name: "tool/free" }]);
    for (const note of ["{{ $settings }}", "<b>{{ user.name }}</b> {% if x %}", "{{ input }} and {{ 1 + 1 }}", "{{"]) {
      assert.deepEqual((await ok(await call("tool/free", { config: { note } }))).output, { note }, note);
    }
  });

  it("a step whose config names a secret is never callable: refused at the save, and a config naming one is 400", async () => {
    const { strut, call } = await boot([{ kind: "step", name: "tool/free" }]);
    for (const name of ["tool/named", "http/verify", "git/checkout", "browser/open"]) {
      const put = await strut.app.request("/public-view", { method: "PUT", headers: auth, body: JSON.stringify({ runnable: [{ kind: "step", name }] }) });
      assert.equal(put.status, 400, name);
      assert.match(((await put.json()) as { error: string }).error, /takes a secret's name in its config/, name);
    }
    const walk = await strut.app.request("/public-view", { method: "PUT", headers: auth, body: JSON.stringify({ runnable: [{ kind: "step", name: "graph/walk" }] }) });
    assert.equal(walk.status, 400, "graph/walk asks a model at every hop: it spends");
    assert.match(((await walk.json()) as { error: string }).error, /spends/);
    for (const config of [{ secretsEnv: ["ANTHROPIC_API_KEY"] }, { tokenSecret: "GITHUB_TOKEN" }, { secrets: { Authorization: "Bearer {ANTHROPIC_API_KEY}" } }]) {
      const res = await call("tool/free", { config });
      assert.equal(res.status, 400, JSON.stringify(config));
      assert.match(((await res.json()) as { error: string }).error, /names a secret/);
    }
  });

  it("the save refusals are asked again at the call: a step sealed after the save is 404", async () => {
    const saved = process.env["STRUT_SEALED"];
    const { call } = await boot([{ kind: "step", name: "tool/free" }]);
    try {
      assert.equal((await call("tool/free", { config: {} })).status, 200);
      process.env["STRUT_SEALED"] = "tool/*";
      assert.equal((await call("tool/free", { config: {} })).status, 404);
    } finally {
      if (saved === undefined) delete process.env["STRUT_SEALED"];
      else process.env["STRUT_SEALED"] = saved;
    }
  });

  it("the bag holds no shell, no artifacts, no sessions and no graph writer, reads no run outside the public view and launches nothing: a step reaching for one fails", async () => {
    const { strut, call, store } = await boot([{ kind: "step", name: "tool/reach" }]);
    await strut.workspace.createWorkflow("private", "name: private\nsteps:\n  - id: s\n    type: log\n    config:\n      message: hi\n");
    await strut.run("private", {});
    const writes = store.writes;
    for (const what of ["runs", "launch"]) {
      const res = await call("tool/reach", { config: { what } });
      assert.equal(res.status, 500, what);
      assert.match(((await res.json()) as { error: string }).error, /not in the public view|not available in the public view/, what);
    }
    assert.equal(store.writes, writes, "nothing launched");
    for (const what of ["shell", "graph-write", "artifacts", "sessions"]) {
      const res = await call("tool/reach", { config: { what } });
      assert.equal(res.status, 500, what);
      assert.equal(((await res.json()) as { code: string }).code, "step_failed", what);
    }
    assert.equal(store.writes, writes);
  });

  it("GET /public lists a runnable step's input as the JSON Schema a caller builds config from", async () => {
    const { strut } = await boot([{ kind: "step", name: "tool/fixed", base: 0.5 }]);
    const listed = ((await (await strut.app.request("/public")).json()) as { runnable: Array<{ kind: string; name: string; input: Record<string, any>; reserve: number }> }).runnable;
    const fixed = listed.find((r) => r.name === "tool/fixed")!;
    assert.equal(fixed.kind, "step");
    assert.equal(fixed.reserve, 0.5);
    assert.equal(fixed.input["type"], "object");
    assert.deepEqual(Object.keys(fixed.input["properties"]).sort(), ["big", "cost", "fail", "note", "wait"]);
    assert.equal(fixed.input["properties"]["note"]["default"], "hi");
    assert.ok(!(fixed.input["required"] ?? []).includes("note"), "a field with a default is the caller's to leave out");
  });

  it("the tool route is in PUBLIC_POST as the package exports it, and so is every POST strut mounts under /public", async () => {
    const { strut } = await boot([{ kind: "step", name: "tool/free" }]);
    assert.equal(EXPORTED_POST, PUBLIC_POST, "a host gate in front of strut passes exactly what strut's own gate does");
    for (const path of ["/public/steps/tool/free/run", "/public/steps/x/run", "/public/steps/acme/cve/lookup/run"]) {
      assert.ok(EXPORTED_POST.test(path), path);
      assert.ok(EXPORTED_PATH.test(path), path);
    }
    for (const path of ["/public/steps/x/schema", "/public/steps/run", "/public/steps/x/run/extra", "/steps/x/run"]) assert.ok(!EXPORTED_POST.test(path), path);
    const posts = [...new Set(strut.app.routes.filter((r) => r.method === "POST" && r.path.startsWith("/public")).map((r) => r.path.replace(/:[A-Za-z]+(\{[^}]*\})?/g, "x")))];
    assert.ok(posts.includes("/public/steps/x/run"), posts.join(", "));
    for (const path of posts) assert.ok(EXPORTED_POST.test(path), path);
    // And strut's own gate, which opens the same list, answers it with no credential.
    const res = await strut.app.request("/public/steps/tool/free/run", { method: "POST", headers: json, body: JSON.stringify({ config: {} }) });
    assert.equal(res.status, 200);
  });

  it("the drain refuses a call; the gate opens the route by name", async () => {
    const { strut, call } = await boot([{ kind: "step", name: "tool/free" }]);
    assert.ok(PUBLIC_POST.test("/public/steps/tool/free/run"));
    assert.ok(PUBLIC_POST.test("/public/steps/x/run"));
    assert.ok(!PUBLIC_POST.test("/public/steps/x/schema"));
    assert.equal((await strut.app.request("/drain", { method: "PUT", headers: auth, body: JSON.stringify({ reason: "update" }) })).status, 200);
    assert.equal((await call("tool/free", { config: {} })).status, 503);
    assert.equal((await strut.app.request("/drain", { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await call("tool/free", { config: {} })).status, 200);
  });
});

describe("the public tool service", () => {
  it("a crash between the hold and the charge: reconcile frees a step call's hold, but never one in flight here", async () => {
    const ledger = new MemoryLedgerStore();
    await ledger.firstUse({ id: "tok", paymentHash: "h", askedMsat: 10_000_000, settledMsat: 10_000_000, credit: usdToMicros(10), rate: RATE, expires: Date.now() + 86_400_000 });
    // A dead process's hold, and a workflow's (item 5's to reconcile).
    assert.ok((await ledger.hold({ token: "tok", reserve: usdToMicros(1), subject: "step:tool/fixed", runId: "dead-call" })).ok);
    assert.ok((await ledger.hold({ token: "tok", reserve: usdToMicros(2), subject: "workflow:fixed", runId: "a-run" })).ok);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const slow = defineStep({ type: "tool/slow", input: z.object({}), output: z.any(), run: async () => (await hold, { ok: true }) });
    const registry = await createRegistry([slow]);
    const fakeCredit = {
      verify: async () => ({ ok: true as const, token: { tokenId: "tok", narrowed: false, quote: { validUntil: Number.MAX_SAFE_INTEGER }, holder: { capabilities: [], maxCharge: [], validUntil: [] } } as never }),
      use: async (t: never) => ({ ok: true as const, token: t, balance: (await ledger.token("tok"))!, created: false }),
      view: async () => undefined,
    };
    const tools = createPublicTools({
      ledger: async () => ledger,
      surface: { runnable: async (kind, name) => (kind === "step" && name === "tool/slow" ? { kind, name, base: 0.5 } : undefined) },
      registry: () => registry,
      services: () => ({}),
      credit: fakeCredit as never,
    });
    const inFlight = tools.call({ type: "tool/slow", config: {}, presented: { macaroon: "m", preimage: "p" }, address: "a" });
    while (tools.inFlight() === 0 || (await ledger.openHolds()).length < 3) await new Promise((r) => setTimeout(r, 5));
    const freed = await tools.reconcile();
    assert.deepEqual(freed.map((f) => [f.callId, f.action]), [["dead-call", "freed"]]);
    const open = (await ledger.openHolds()).map((h) => h.subject).sort();
    assert.deepEqual(open, ["step:tool/slow", "workflow:fixed"], "the call in flight and the workflow's keep theirs");
    release();
    const a = await inFlight;
    assert.equal(a.status, 200);
    assert.deepEqual((await ledger.openHolds()).map((h) => h.subject), ["workflow:fixed"]);
    const t = (await ledger.token("tok"))!;
    assert.deepEqual({ spent: t.spent, held: t.held }, { spent: usdToMicros(0.5), held: usdToMicros(2) }, "the dead call charged nothing; the live one its base");
    assert.deepEqual(await tools.reconcile(), [], "nothing twice");
  });

  it("a free step's daily cap: a call in flight counts at its cap, never a sliver; the day's last call goes alone; a spent day is 429 until midnight", async () => {
    const ledger = new MemoryLedgerStore();
    let release!: () => void;
    let hold = new Promise<void>((r) => (release = r));
    const spend = defineStep({
      type: "tool/spend",
      input: z.object({ cost: z.number(), wait: z.boolean().optional() }),
      output: z.any(),
      run: async (cfg, ctx: StepContext<unknown>) => {
        if (cfg.wait) await hold;
        return withUsage({ cap: ctx.maxCostUsd }, { modelCalls: 1, usage: {}, cost: cfg.cost });
      },
    });
    const registry = await createRegistry([spend]);
    const tools = createPublicTools({
      ledger: async () => ledger,
      surface: { runnable: async (kind, name) => (name === "tool/spend" ? { kind, name, dailyCapUsd: 1, capUsd: 0.6 } : undefined) },
      registry: () => registry,
      services: () => ({}),
    });
    const cap = (a: Awaited<ReturnType<typeof tools.call>>) => (a.body as { output: { cap: number } }).output.cap;
    // One call in flight at its cap (0.60): 0.40 is left, under a whole cap,
    // so a second is refused rather than given a sliver.
    const first = tools.call({ type: "tool/spend", config: { cost: 0.2, wait: true }, address: "a" });
    while (tools.inFlight() < 1) await new Promise((r) => setTimeout(r, 5));
    const second = await tools.call({ type: "tool/spend", config: { cost: 0 }, address: "b" });
    assert.equal(second.status, 429);
    assert.match((second.body as { error: string }).error, /set aside for calls in flight/);
    release();
    assert.equal(cap(await first), 0.6);
    // 0.20 spent: a whole cap fits.
    const whole = await tools.call({ type: "tool/spend", config: { cost: 0.7 }, address: "a" });
    assert.equal(cap(whole), 0.6);
    // 0.90 spent: the last 0.10 of the day goes to one call alone.
    hold = new Promise((r) => (release = r));
    const last = tools.call({ type: "tool/spend", config: { cost: 0.1, wait: true }, address: "a" });
    while (tools.inFlight() < 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal((await tools.call({ type: "tool/spend", config: { cost: 0 }, address: "b" })).status, 429, "not beside it");
    release();
    assert.equal(Math.round(cap(await last) * 100) / 100, 0.1);
    const spent = await tools.call({ type: "tool/spend", config: { cost: 0 }, address: "a" });
    assert.equal(spent.status, 429);
    assert.match((spent.body as { error: string }).error, /spent its daily cap/);
    assert.ok(Number(spent.headers!["retry-after"]) > 0);
    assert.equal((await ledger.today("step:tool/spend")).cost, usdToMicros(1));
  });

  it("the server's limit on calls in flight is a 429", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const slow = defineStep({ type: "tool/slow", input: z.object({}), output: z.any(), run: async () => (await hold, { ok: true }) });
    const registry = await createRegistry([slow]);
    const tools = createPublicTools({
      ledger: async () => new MemoryLedgerStore(),
      surface: { runnable: async (kind, name) => ({ kind, name }) },
      registry: () => registry,
      services: () => ({}),
      maxInFlight: 2,
    });
    const two = [tools.call({ type: "tool/slow", address: "a" }), tools.call({ type: "tool/slow", address: "a" })];
    while (tools.inFlight() < 2) await new Promise((r) => setTimeout(r, 5));
    const third = await tools.call({ type: "tool/slow", address: "a" });
    assert.equal(third.status, 429);
    release();
    assert.deepEqual((await Promise.all(two)).map((a) => a.status), [200, 200]);
    assert.equal(tools.inFlight(), 0);
  });

  it("the bag is an allowlist: http, secrets, runs, and a graph that reads but never writes", async () => {
    const graph = {
      kind: "ladybug",
      namespace: "default",
      cfg: {},
      dialect: { kind: "ladybug" },
      schemas: { schema: async () => null, createEdgeSchema: async () => ({}) },
      reader: { getNode: async () => null },
      nodes: { write: async () => ({}) },
      lbug: { readOnly: async () => ({ run: async () => ({ columns: ["n"], rows: [{ n: 1 }], truncated: false }), close: async () => undefined }) },
    };
    const http = guardedHttp();
    const bag = publicToolServices({ http: 1, secrets: 2, shell: 3, artifacts: 4, sessions: 5, jobs: 6, peers: 7, lightning: 8, onRunEnd: 9, onRunEvent: 10, graph }, { graph: graph as never, http, runs: { list: 1 } });
    assert.deepEqual(Object.keys(bag).sort(), ["graph", "http", "runs", "secrets"]);
    assert.equal(bag["http"], http, "the guarded http, never the bag's own");
    const g = bag["graph"] as Record<string, any>;
    assert.equal(g["reader"], graph.reader);
    assert.equal(g["dialect"], graph.dialect);
    assert.equal(g["lbug"], undefined, "the engine's handles are not on it");
    await assert.rejects(g["nodes"].write({}), /not available to a public tool/);
    await assert.rejects(g["edges"].write({}), /not available to a public tool/);
    await assert.rejects(g["tx"](async () => 1), /not available to a public tool/);
    await assert.rejects(g["schemas"].createEdgeSchema("A", "E", "B"), /not available to a public tool/);
    assert.equal(await g["schemas"].schema("X"), null, "the schema reads pass");
    assert.deepEqual(await g["query"]("MATCH (n) RETURN n"), [{ n: 1 }], "a read runs on the engine's read-only connection");
    await assert.rejects(g["query"]("CREATE (n:Node {x: 1})"), /read-only Cypher/);
    await assert.rejects(g["query"]("MATCH (n) SET n.x = 1"), /read-only Cypher/);
    const none = publicToolServices({}, {})["graph"] as Record<string, unknown>;
    assert.equal(none["nodes"], undefined, "no graph: its writers read as absent");
    assert.throws(() => none["reader"], /no graph/);
  });

  it("the guarded http reaches no loopback, private, link-local or metadata address, nor one a redirect leads to", async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(url);
      if (url.startsWith("https://bounce.example/")) return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const lookup = async (host: string) => (host === "inside.example" ? ["10.1.2.3"] : ["93.184.216.34"]);
    const http = guardedHttp({ fetch: fake, lookup });
    for (const url of ["http://127.0.0.1:3000/workflows", "http://localhost:7474/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://10.0.0.5/", "http://inside.example/", "file:///etc/passwd"]) {
      await assert.rejects(http(url), /private|local|reserved|Only http/, url);
    }
    await assert.rejects(http("https://bounce.example/x"), /private or reserved/, "a redirect to the metadata service");
    assert.deepEqual(await http("https://api.example/cves?q=lodash").then((r) => r.body), { ok: true });
    assert.ok(!seen.some((u) => u.includes("169.254")), "nothing private was fetched");
  });

  it("a redirect to another origin carries no Authorization, Cookie or Proxy-Authorization; a same-origin one keeps them", async () => {
    const got: Record<string, Record<string, string>> = {};
    const fake = (async (url: string, init?: RequestInit) => {
      got[url] = { ...((init?.headers ?? {}) as Record<string, string>) };
      if (url === "https://vendor.example/a") return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/b" } });
      if (url === "https://vendor.example/same") return new Response(null, { status: 307, headers: { location: "/next" } });
      if (url === "http://vendor.example/scheme") return new Response(null, { status: 302, headers: { location: "https://vendor.example/secure" } });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const http = guardedHttp({ fetch: fake, lookup: async () => ["93.184.216.34"] });
    const headers = { Authorization: "Bearer OWNER_KEY", COOKIE: "s=1", "proxy-authorization": "Basic x", "x-api-version": "2" };
    await http("https://vendor.example/a", { headers });
    assert.equal(got["https://vendor.example/a"]!["Authorization"], "Bearer OWNER_KEY", "the first hop is the host the step named");
    assert.deepEqual(got["https://elsewhere.example/b"], { "x-api-version": "2" }, "another origin: no credential, in any case");
    await http("https://vendor.example/same", { headers });
    assert.equal(got["https://vendor.example/next"]!["Authorization"], "Bearer OWNER_KEY", "the same origin keeps them");
    await http("http://vendor.example/scheme", { headers });
    assert.equal(got["https://vendor.example/secure"]!["Authorization"], undefined, "another scheme is another origin");
    assert.deepEqual(withoutCredentials(new Headers({ Authorization: "a", Cookie: "c", Accept: "x" })), { accept: "x" });
  });

  it("a call past its time is stopped: 504, charged its cost and no base, its slot free", async () => {
    const ledger = new MemoryLedgerStore();
    const stuck = defineStep({ type: "tool/stuck", input: z.object({}), output: z.any(), run: () => new Promise(() => undefined) });
    const registry = await createRegistry([stuck]);
    const tools = createPublicTools({
      ledger: async () => ledger,
      surface: { runnable: async (kind, name) => ({ kind, name }) },
      registry: () => registry,
      services: () => ({}),
      timeoutMs: 100,
    });
    const started = Date.now();
    // Only the call's own time limit, an unref'd timer, ends this wait.
    const a = await heldOpen(tools.call({ type: "tool/stuck", address: "a" }));
    assert.equal(a.status, 504);
    assert.equal((a.body as { code: string }).code, "timeout");
    assert.ok(Date.now() - started < 5000, "the caller is answered at the limit");
    assert.equal(tools.inFlight(), 0);
    assert.deepEqual(await ledger.today("step:tool/stuck"), { key: "step:tool/stuck", calls: 1, failed: 1, earned: 0, cost: 0 });
  });

  it("one address gets a share of the calls in flight; another still gets in", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const slow = defineStep({ type: "tool/slow", input: z.object({}), output: z.any(), run: async () => (await hold, { ok: true }) });
    const registry = await createRegistry([slow]);
    const tools = createPublicTools({
      ledger: async () => new MemoryLedgerStore(),
      surface: { runnable: async (kind, name) => ({ kind, name }) },
      registry: () => registry,
      services: () => ({}),
      perAddress: 2,
    });
    const two = [tools.call({ type: "tool/slow", address: "a" }), tools.call({ type: "tool/slow", address: "a" })];
    while (tools.inFlight() < 2) await new Promise((r) => setTimeout(r, 5));
    const third = await tools.call({ type: "tool/slow", address: "a" });
    assert.equal(third.status, 429);
    assert.match((third.body as { error: string }).error, /from this address/);
    const other = tools.call({ type: "tool/slow", address: "b" });
    while (tools.inFlight() < 3) await new Promise((r) => setTimeout(r, 5));
    release();
    assert.deepEqual((await Promise.all([...two, other])).map((x) => x.status), [200, 200, 200]);
  });

  it("a charge the ledger refuses is tried again until it lands, and the boot reconcile leaves its hold alone meanwhile", async () => {
    const real = new MemoryLedgerStore();
    await real.firstUse({ id: "tok", paymentHash: "h", askedMsat: 10_000_000, settledMsat: 10_000_000, credit: usdToMicros(10), rate: RATE, expires: Date.now() + 86_400_000 });
    let refusals = 3;
    const flaky = new Proxy(real, {
      get(t, prop, r) {
        if (prop === "charge") return async (input: Parameters<LedgerStore["charge"]>[0]) => {
          if (refusals-- > 0) throw new Error("database is locked");
          return t.charge(input);
        };
        const v = Reflect.get(t, prop, r) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) as LedgerStore;
    const fixed = defineStep({ type: "tool/fixed", input: z.object({}), output: z.any(), run: async () => ({ ok: true }) });
    const registry = await createRegistry([fixed]);
    const fakeCredit = {
      verify: async () => ({ ok: true as const, token: { tokenId: "tok", narrowed: false, quote: { validUntil: Number.MAX_SAFE_INTEGER }, holder: { capabilities: [], maxCharge: [], validUntil: [] } } as never }),
      use: async (t: never) => ({ ok: true as const, token: t, balance: (await real.token("tok"))!, created: false }),
      view: async () => undefined,
    };
    const tools = createPublicTools({
      ledger: async () => flaky,
      surface: { runnable: async (kind, name) => ({ kind, name, base: 0.5 }) },
      registry: () => registry,
      services: () => ({}),
      credit: fakeCredit as never,
      chargeRetryMs: 20,
    });
    try {
      const a = await tools.call({ type: "tool/fixed", presented: { macaroon: "m", preimage: "p" }, address: "a" });
      assert.equal(a.status, 200, "the answer stands");
      assert.equal((await real.openHolds()).length, 1, "the hold waits on its charge");
      assert.deepEqual(await tools.reconcile(), [], "never freed while its charge is pending");
      const deadline = Date.now() + 5000;
      while ((await real.openHolds()).length) {
        if (Date.now() > deadline) throw new Error("the charge never landed");
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal((await real.token("tok"))!.spent, usdToMicros(0.5), "charged once, by the rule");
    } finally {
      tools.close();
    }
  });

  it("inputTemplates reads each key from the input as a sole expression", () => {
    assert.deepEqual(inputTemplates({ a: 1, "my-key": 2, 'q"uote': 3 }), { a: '{{ input["a"] }}', "my-key": '{{ input["my-key"] }}', 'q"uote': '{{ input["q\\"uote"] }}' });
  });
});

for (const tb of testBackends()) describe(`a public tool reads the whole graph (${tb.name})`, { skip: tb.skip }, () => {
  let b: GraphBackend;
  let dir: string;
  before(async () => {
    b = await tb.open();
  });
  after(async () => {
    await tb.close(b);
  });
  beforeEach(async () => {
    await tb.wipe(b);
    await seedStrutDomain(b);
    await seedConceptSchema(b);
    dir = await mkdtemp(join(tmpdir(), "strut-public-tools-graph-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a node outside the Public view is readable, and a graph write fails", async () => {
    const store = new MemoryRunStore();
    const strut = await createStrut({ workspace: new WorkspaceManager(join(dir, "ws")), graph: b, store, serveUi: false, scheduler: false, concepts: false, views: false, jamie: false, knowledge: false });
    try {
      const secret = (await b.nodes.write({ type: "Concept", data: { name: "Secret", description: "Not public" } })).ref_id;
      const put = await strut.app.request("/public-view", { method: "PUT", headers: json, body: JSON.stringify({ runnable: [{ kind: "step", name: "graph/graph-get" }, { kind: "step", name: "graph/create-node" }] }) });
      assert.equal(put.status, 200, await put.clone().text());
      assert.equal((await strut.app.request(`/public/graph/nodes/${secret}`)).status, 404, "the Public view does not show it");
      const got = await strut.app.request("/public/steps/graph/graph-get/run", { method: "POST", headers: json, body: JSON.stringify({ config: { ref_id: secret } }) });
      assert.equal(got.status, 200, await got.clone().text());
      assert.match(JSON.stringify(await got.json()), /Secret/);
      const before = await b.reader.namesLike("Concept", "Leak");
      const wrote = await strut.app.request("/public/steps/graph/create-node/run", { method: "POST", headers: json, body: JSON.stringify({ config: { node_type: "Concept", node_data: { name: "Leak", description: "x" } } }) });
      assert.equal(wrote.status, 500, "a graph step's failure, answered as text to a model, is a failed call here");
      assert.match(((await wrote.json()) as { error: string }).error, /not available to a public tool/);
      assert.deepEqual(await b.reader.namesLike("Concept", "Leak"), before, "nothing was written");
      assert.equal(store.events.size + store.summaries.size, 0);
    } finally {
      await strut.close();
    }
  });

  it("graph/find reads through the read-only query; a graph step's failure is a failed call, charged no base", async () => {
    const store = new MemoryRunStore();
    const wallet = new FakeWallet();
    const strut = await createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")),
      graph: b,
      store,
      serveUi: false,
      scheduler: false,
      concepts: false,
      views: false,
      jamie: false,
      knowledge: false,
      services: { lightning: lightningCapability(wallet) },
      payments: { rate: fixedRate },
    });
    try {
      await b.nodes.write({ type: "Concept", data: { name: "Hidden Page", description: "Not public" } });
      const put = await strut.app.request("/public-view", { method: "PUT", headers: json, body: JSON.stringify({ runnable: [{ kind: "step", name: "graph/find" }, { kind: "step", name: "graph/graph-get", base: 0.25 }] }) });
      assert.equal(put.status, 200, await put.clone().text());
      const found = await strut.app.request("/public/steps/graph/find/run", { method: "POST", headers: json, body: JSON.stringify({ config: { node_type: "Concept", where: { name: "Hidden Page" } } }) });
      assert.equal(found.status, 200, await found.clone().text());
      assert.match(JSON.stringify(await found.json()), /Hidden Page/);
      const c = (await (await strut.app.request("/public/credit", { method: "POST", headers: json, body: JSON.stringify({ usd: 1 }) })).json()) as Challenge402;
      const cred = `${c.macaroon}:${wallet.settle(c.invoice)}`;
      const missing = await strut.app.request("/public/steps/graph/graph-get/run", { method: "POST", headers: { ...json, authorization: `L402 ${cred}` }, body: JSON.stringify({ config: { ref_id: "no-such-node" } }) });
      assert.equal(missing.status, 500, await missing.clone().text());
      const m = (await missing.json()) as { code: string; error: string; credit: { charged_usd: number; remaining_usd: number } };
      assert.equal(m.code, "step_failed");
      assert.match(m.error, /node not found: no-such-node/);
      assert.deepEqual({ charged: m.credit.charged_usd, remaining: m.credit.remaining_usd }, { charged: 0, remaining: 1 }, "its cost, nothing; no base");
    } finally {
      await strut.close();
    }
  });
});

describe("a public tool call across a restart", () => {
  it("a hold a dead process left between a call's hold and its charge is freed at boot, once; a call after it charges as usual", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-public-tools-restart-"));
    const saved = process.env["STRUT_API_KEY"];
    delete process.env["STRUT_API_KEY"];
    const registry = await createRegistry(STEPS);
    const wallet = new FakeWallet();
    const make = (o: { autoResume: false | { delayMs: number } }) =>
      createStrut({
        workspace: new WorkspaceManager(join(dir, "ws")),
        serveUi: false,
        scheduler: false,
        registry,
        autoResume: o.autoResume,
        services: { lightning: lightningCapability(wallet) },
        payments: { rate: fixedRate },
      });
    try {
      const first = await make({ autoResume: false });
      assert.equal((await first.app.request("/public-view", { method: "PUT", headers: json, body: JSON.stringify({ runnable: [{ kind: "step", name: "tool/fixed", base: 0.5 }] }) })).status, 200);
      const c = (await (await first.app.request("/public/credit", { method: "POST", headers: json, body: JSON.stringify({ usd: 5 }) })).json()) as Challenge402;
      const cred = `${c.macaroon}:${wallet.settle(c.invoice)}`;
      const tokenId = decodeIdentifier(macaroonFromBase64(c.macaroon).id).tokenId;
      assert.equal((await first.app.request("/public/credit", { headers: { authorization: `L402 ${cred}` } })).status, 200, "its first use");
      // What a process that died mid-call left: the reserve set aside, no charge.
      assert.ok((await (await first.ledger()).hold({ token: tokenId, reserve: usdToMicros(0.5), subject: "step:tool/fixed", runId: "1800000000009" })).ok);
      await first.close();

      const second = await make({ autoResume: { delayMs: 0 } });
      try {
        const l = await second.ledger();
        const deadline = Date.now() + 10_000;
        while ((await l.openHolds()).length) {
          if (Date.now() > deadline) throw new Error("the hold was never freed");
          await new Promise((r) => setTimeout(r, 25));
        }
        const t = (await l.token(tokenId))!;
        assert.deepEqual({ spent: t.spent, held: t.held }, { spent: 0, held: 0 }, "the call never answered: charged nothing");
        const res = await second.app.request("/public/steps/tool/fixed/run", { method: "POST", headers: { ...json, authorization: `L402 ${cred}` }, body: JSON.stringify({ config: {} }) });
        assert.equal(res.status, 200, await res.clone().text());
        assert.equal(((await res.json()) as { credit: { remaining_usd: number } }).credit.remaining_usd, 4.5);
      } finally {
        await second.close();
      }
      const third = await make({ autoResume: { delayMs: 0 } });
      try {
        await new Promise((r) => setTimeout(r, 200));
        const l = await third.ledger();
        assert.equal((await l.token(tokenId))!.spent, usdToMicros(0.5));
        assert.deepEqual(await l.today("step:tool/fixed"), { key: "step:tool/fixed", calls: 2, failed: 1, earned: usdToMicros(0.5), cost: 0 }, "the freed hold is one failed call, charged nothing");
      } finally {
        await third.close();
      }
    } finally {
      if (saved === undefined) delete process.env["STRUT_API_KEY"];
      else process.env["STRUT_API_KEY"] = saved;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
