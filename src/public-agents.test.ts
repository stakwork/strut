/**
 * An agent as a buyer (plans/paid-runs.md work item 8, §10 "An agent over
 * MCP"): `POST /public/mcp` serves list_public, run_workflow, call_tool,
 * get_run and get_credit beside a visitor page's `step_run`, over the SAME
 * doors as the HTTP routes. An unpaid priced call's RESULT is `{
 * payment_required }`; the agent pays the fake wallet's invoice and calls
 * again with `payment`, or the connection's `Authorization: L402`. A retry of
 * the same launch is the same run while it is in flight, never a second
 * reserve; a long run answers a handle `get_run` waits on; credit bought on
 * one connection is spent on another. And `GET /llms.txt` lists what anyone
 * may run here, with its price.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createStrut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { defineStep, withUsage } from "./core.js";
import { createRegistry } from "./steps/registry.js";
import { FakeWallet } from "./payments/fake-wallet.js";
import { lightningCapability } from "./payments/lightning.js";
import { STEP_RUN_TOOL } from "./apps/tools.js";
import { buildPublicAgentTools, defaultLaunchKey, priceWords } from "./public-agents.js";
import type { PublicDoors } from "./public-routes.js";
import type { ExchangeRate } from "./payments/rate.js";

const KEY = "public-agents-key";
const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const RATE = 100_000; // dollars per bitcoin: $1 is 1000 sats

/** Held by a test that keeps a run in flight. */
let gate: Promise<void> = Promise.resolve();

/** Writes a file into the run's artifacts and declares it, spending what
 *  its config says; waits on the gate when told to. */
const make = defineStep({
  type: "test/make",
  input: z.object({ text: z.string(), cost: z.number().optional(), hold: z.boolean().optional() }),
  output: z.any(),
  async run(cfg, ctx) {
    if (cfg.hold) await gate;
    const artifacts = (ctx.services as { artifacts?: { write(runId: string, path: string, content: string): Promise<unknown> } }).artifacts;
    await artifacts?.write(ctx.runId, "out.txt", cfg.text);
    return withUsage({ text: cfg.text, artifacts: [{ id: "out", title: "Out", path: "out.txt" }] }, cfg.cost ? { modelCalls: 1, usage: {}, cost: cfg.cost } : undefined);
  },
});

/** A tool anyone may call: echoes its note, spending what it is told. */
const echo = defineStep({
  type: "test/echo",
  description: "Echo a note back",
  input: z.object({ note: z.string(), cost: z.number().optional() }),
  output: z.any(),
  async run(cfg) {
    return withUsage({ note: cfg.note }, cfg.cost ? { modelCalls: 1, usage: {}, cost: cfg.cost } : undefined);
  },
});

const wf = (name: string) =>
  `name: ${name}\ndescription: Makes ${name}\ninput:\n  text: { type: string, description: What to write }\n  cost: { type: number, default: 0 }\n  hold: { type: boolean, default: false }\nsteps:\n  - id: m\n    type: test/make\n    config:\n      text: "{{ input.text }}"\n      cost: "{{ input.cost }}"\n      hold: "{{ input.hold }}"\n`;

describe("an agent over MCP buys and runs (plans/paid-runs.md §10)", () => {
  let root: string;
  let saved: string | undefined;
  let strut: Awaited<ReturnType<typeof createStrut>>;
  const wallet = new FakeWallet();
  const store = new MemoryRunStore();

  /** One JSON-RPC request to `/public/mcp`, as an agent's client sends it. */
  const rpc = async (method: string, params: unknown, headers: Record<string, string> = {}) => {
    const res = await strut.app.request("/public/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const lines = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
    const body = lines.find((l) => l.id === 1) ?? (lines.length ? lines[lines.length - 1] : JSON.parse(text));
    return { body, notifications: lines.filter((l) => l.method) };
  };
  /** A tool's call: its result as JSON, and whether it was an error. */
  const tool = async (name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const { body } = await rpc("tools/call", { name, arguments: args }, headers);
    const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: !!result.isError, out: JSON.parse(result.content[0]!.text) as Record<string, any> };
  };
  const ledgerHolds = async () => (await strut.ledger()).list({ kind: "hold" });

  before(async () => {
    saved = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = KEY;
    root = await mkdtemp(join(tmpdir(), "strut-public-agents-"));
    const workspace = new WorkspaceManager(join(root, "ws"));
    strut = await createStrut({
      workspace, store, registry: await createRegistry([make, echo]),
      scheduler: false, serveUi: false, views: false,
      job: false, orchestrator: false, builder: false, browserWorkflows: false, privacyWorkflows: false,
      services: { lightning: lightningCapability(wallet) },
      payments: { rate: async (): Promise<ExchangeRate> => ({ usdPerBtc: RATE, at: new Date().toISOString(), source: "test" }) },
    });
    for (const name of ["free", "priced", "metered"]) {
      await workspace.publishWorkflowByContent(name, wf(name));
      await workspace.setWorkflowOwner(name, "owner-1");
    }
    const put = await strut.app.request("/public-view", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        runnable: [
          { kind: "workflow", name: "free", dailyCapUsd: 5 },
          { kind: "workflow", name: "priced", base: 0.5 },
          { kind: "workflow", name: "metered", base: 0.1, markup: 2, capUsd: 1, results: "run" },
          { kind: "step", name: "test/echo", base: 0.02 },
        ],
      }),
    });
    assert.equal(put.status, 200, await put.clone().text());
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    if (saved === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = saved;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("tools/list: the five tools for an agent, and the page's step_run beside them, still app-only", async () => {
    const { body } = await rpc("tools/list", {});
    const tools = body.result.tools as Array<{ name: string; _meta?: { ui?: { visibility?: string[] } }; inputSchema: Record<string, unknown> }>;
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["call_tool", "get_credit", "get_run", "list_public", "run_workflow", STEP_RUN_TOOL].sort());
    assert.deepEqual(tools.find((t) => t.name === STEP_RUN_TOOL)!._meta, { ui: { visibility: ["app"] } });
    for (const t of tools.filter((x) => x.name !== STEP_RUN_TOOL)) assert.equal(t._meta, undefined, `${t.name} is a model's`);
    const { body: init } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent", version: "0" } });
    assert.match(init.result.instructions, /list_public/);
    assert.match(init.result.instructions, /payment_required/);
  });

  it("list_public: what anyone may run, its price, reserve, recent charges and input", async () => {
    const { isError, out } = await tool("list_public", {});
    assert.equal(isError, false);
    const byName = Object.fromEntries((out["runnable"] as Array<Record<string, any>>).map((r) => [r["name"], r]));
    assert.deepEqual(Object.keys(byName).sort(), ["free", "metered", "priced", "test/echo"]);
    assert.equal(byName["priced"]!["base"], 0.5);
    assert.equal(byName["priced"]!["reserve"], 0.5);
    assert.equal(byName["metered"]!["reserve"], 2.1, "base + markup × capUsd");
    assert.equal(byName["priced"]!["call_with"], "run_workflow");
    assert.equal(byName["test/echo"]!["call_with"], "call_tool");
    assert.deepEqual(byName["free"]!["input"]["text"], { type: "string", description: "What to write" });
    assert.deepEqual(byName["free"]!["recent"], { days: 30, runs: 0, average: 0 });
    assert.deepEqual((await tool("list_public", { query: "echo" })).out["runnable"].map((r: { name: string }) => r.name), ["test/echo"]);
  });

  it("run_workflow, free: launches through the public launcher, waits for the run, and answers its output with links that carry the run token", async () => {
    const { isError, out } = await tool("run_workflow", { workflow: "free", input: { text: "hello" }, wait: 10 });
    assert.equal(isError, false, JSON.stringify(out));
    assert.equal(out["run"]["status"], "success");
    assert.deepEqual(out["run"]["output"], { text: "hello", artifacts: [{ id: "out", title: "Out", path: "out.txt" }] });
    assert.equal(out["run"]["charged"], 0, "a free run is charged nothing");
    assert.equal(out["key"], defaultLaunchKey("free", { text: "hello" }), "a key made from the workflow and input");
    assert.equal(out["next"], undefined);
    const link = out["run"]["artifacts"][0]["url"] as string;
    assert.match(link, /^http:\/\/localhost\/public\/workflows\/free\/runs\/\d+\/files\/out\.txt\?t=/);
    const file = await strut.app.request(link.replace("http://localhost", ""));
    assert.equal(file.status, 200);
    assert.equal(await file.text(), "hello");
    const start = (await store.getRunEvents("free", out["run_id"])).find((e) => e.type === "run.start")!;
    assert.equal(start.origin, "public");
    // get_run reads it back by its token; another token reads nothing.
    const got = await tool("get_run", { workflow: "free", run_id: out["run_id"], token: out["token"] });
    assert.equal(got.out["run"]["status"], "success");
    const bad = await tool("get_run", { workflow: "free", run_id: out["run_id"], token: "nope" });
    assert.equal(bad.isError, true);
    assert.match(bad.out["error"], /no run/);
    // A run's input is checked as the HTTP door checks it.
    const refused = await tool("run_workflow", { workflow: "free", input: {} });
    assert.equal(refused.isError, true);
    assert.match(refused.out["error"], /input: text/);
    assert.match((await tool("run_workflow", { workflow: "nope", input: { text: "x" } })).out["error"], /not open to anyone/);
  });

  it("run_workflow, a long run: answers a handle with `next`; get_run waits; the same launch sent again while it is in flight is the same run", async () => {
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    try {
      const first = await tool("run_workflow", { workflow: "free", input: { text: "slow", hold: true }, wait: 0 });
      assert.equal(first.isError, false, JSON.stringify(first.out));
      assert.match(first.out["next"], /get_run/);
      assert.equal(first.out["run"]["charged"], undefined, "not ended");
      // A retry — no key named, the same input — returns the run in flight.
      const again = await tool("run_workflow", { workflow: "free", input: { text: "slow", hold: true }, wait: 0 });
      assert.equal(again.out["run_id"], first.out["run_id"]);
      assert.equal(again.out["existing"], true);
      // A distinct key is another run.
      const other = await tool("run_workflow", { workflow: "free", input: { text: "slow", hold: true }, key: "second", wait: 0 });
      assert.notEqual(other.out["run_id"], first.out["run_id"]);
      open();
      const done = await tool("get_run", { workflow: "free", run_id: first.out["run_id"], token: first.out["token"], wait: 10 });
      assert.equal(done.out["run"]["status"], "success");
      assert.equal(done.out["next"], undefined);
      await tool("get_run", { workflow: "free", run_id: other.out["run_id"], token: other.out["token"], wait: 10 });
    } finally {
      open?.();
      gate = Promise.resolve();
    }
  });

  it("run_workflow, priced: payment_required as a RESULT; paid with the preimage, the same call launches against the credit, once", async () => {
    const invoicesBefore = wallet.calls.filter((c) => c.method === "makeInvoice").length;
    const asked = await tool("run_workflow", { workflow: "priced", input: { text: "paid" } });
    assert.equal(asked.isError, false, "an unpaid call is a result, not an error");
    const p = asked.out["payment_required"] as Record<string, any>;
    assert.ok(p["macaroon"] && p["invoice"]);
    assert.equal(p["usd"], 0.5);
    assert.equal(p["sats"], 500);
    assert.match(asked.out["next"], /payment: "<macaroon>:<preimage hex>"/);
    assert.equal(wallet.calls.filter((c) => c.method === "makeInvoice").length, invoicesBefore + 1);
    assert.equal((await store.listRuns("priced")).length, 0, "nothing launched");

    const credential = `${p["macaroon"]}:${wallet.settle(p["invoice"])}`;
    const holds = (await ledgerHolds()).length;
    const ran = await tool("run_workflow", { workflow: "priced", input: { text: "paid" }, payment: credential, wait: 10 });
    assert.equal(ran.isError, false, JSON.stringify(ran.out));
    assert.equal(ran.out["run"]["status"], "success");
    assert.equal(ran.out["run"]["charged"], 0.5);
    assert.equal(ran.out["credit"]["held_usd"], 0.5);
    assert.equal((await ledgerHolds()).length, holds + 1, "one reserve set aside");
    // The balance, read on another connection with the same credential.
    const credit = await tool("get_credit", { payment: credential });
    assert.equal(credit.isError, false, JSON.stringify(credit.out));
    assert.equal(credit.out["paid_usd"], 0.5);
    assert.equal(credit.out["spent_usd"], 0.5);
    assert.equal(credit.out["remaining_usd"], 0);
    // Short now: the next run asks for more, carrying what is left.
    const more = await tool("run_workflow", { workflow: "priced", input: { text: "again" }, payment: credential });
    assert.equal(more.out["payment_required"]["reason"], "short");
    assert.equal(more.out["payment_required"]["carries"], true);
  });

  it("the connection's own Authorization: L402 header pays, and a payer with no preimage claims with the macaroon alone", async () => {
    const asked = await tool("run_workflow", { workflow: "priced", input: { text: "phone" }, key: "phone-1" });
    const p = asked.out["payment_required"] as Record<string, any>;
    assert.equal(asked.out["key"], "phone-1");
    // Not paid yet: the claim says so, and nothing launches.
    const pending = await tool("run_workflow", { workflow: "priced", input: { text: "phone" }, key: "phone-1", payment: p["macaroon"] });
    assert.ok(pending.out["payment_pending"], JSON.stringify(pending.out));
    assert.equal((await tool("get_credit", { payment: p["macaroon"] })).out["state"], "pending");
    // A person paid the QR code from a phone: the agent never saw a preimage.
    wallet.settle(p["invoice"]);
    const claimed = await tool("get_credit", { payment: p["macaroon"] });
    assert.equal(claimed.out["state"], "settled");
    const credential = claimed.out["credential"] as string;
    assert.ok(credential.startsWith(`${p["macaroon"]}:`));
    assert.equal(claimed.out["credit"]["remaining_usd"], 0.5);
    // On a connection that presents it as its header, no argument needed.
    const ran = await tool("run_workflow", { workflow: "priced", input: { text: "phone" }, key: "phone-1", wait: 10 }, { authorization: `L402 ${credential}` });
    assert.equal(ran.isError, false, JSON.stringify(ran.out));
    assert.equal(ran.out["run"]["status"], "success");
    assert.equal((await tool("get_credit", {}, { authorization: `L402 ${credential}` })).out["spent_usd"], 0.5);
    // A macaroon alone as payment, once settled, launches too, and hands back the whole credential.
    const asked2 = await tool("run_workflow", { workflow: "priced", input: { text: "phone-2" } });
    const p2 = asked2.out["payment_required"] as Record<string, any>;
    wallet.settle(p2["invoice"]);
    const ran2 = await tool("run_workflow", { workflow: "priced", input: { text: "phone-2" }, payment: p2["macaroon"], wait: 10 });
    assert.equal(ran2.out["run"]["status"], "success", JSON.stringify(ran2.out));
    assert.ok((ran2.out["credential"] as string).startsWith(`${p2["macaroon"]}:`));
  });

  it("a paid launch whose answer was lost, sent again with the same credential and key while in flight: the same run, one reserve", async () => {
    const asked = await tool("run_workflow", { workflow: "priced", input: { text: "lost", hold: true } });
    const p = asked.out["payment_required"] as Record<string, any>;
    const credential = `${p["macaroon"]}:${wallet.settle(p["invoice"])}`;
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    try {
      const holds = (await ledgerHolds()).length;
      const first = await tool("run_workflow", { workflow: "priced", input: { text: "lost", hold: true }, payment: credential, wait: 0 });
      assert.equal(first.isError, false, JSON.stringify(first.out));
      const retry = await tool("run_workflow", { workflow: "priced", input: { text: "lost", hold: true }, payment: credential, wait: 0 });
      assert.equal(retry.out["run_id"], first.out["run_id"]);
      assert.equal(retry.out["existing"], true);
      assert.equal((await ledgerHolds()).length, holds + 1, "never a second reserve");
      open();
      assert.equal((await tool("get_run", { workflow: "priced", run_id: first.out["run_id"], token: first.out["token"], wait: 10 })).out["run"]["charged"], 0.5);
    } finally {
      open?.();
      gate = Promise.resolve();
    }
  });

  it("a metered run whose launcher reads the whole run: charged base + markup × cost", async () => {
    const asked = await tool("run_workflow", { workflow: "metered", input: { text: "m", cost: 0.25 } });
    const p = asked.out["payment_required"] as Record<string, any>;
    assert.equal(p["usd"], 2.1, "the reserve");
    const credential = `${p["macaroon"]}:${wallet.settle(p["invoice"])}`;
    const ran = await tool("run_workflow", { workflow: "metered", input: { text: "m", cost: 0.25 }, payment: credential, wait: 10 });
    assert.equal(ran.out["run"]["charged"], 0.6, "0.1 + 2 × 0.25");
    assert.ok(ran.out["run"]["stepCounts"] !== undefined || ran.out["run"]["status"] === "success");
    assert.equal((await tool("get_credit", { payment: credential })).out["remaining_usd"], 1.5, "what the run did not use stays");
  });

  it("call_tool: a priced step is a payment_required result, then its output and what it was charged", async () => {
    const asked = await tool("call_tool", { type: "test/echo", config: { note: "hi" } });
    assert.equal(asked.isError, false);
    const p = asked.out["payment_required"] as Record<string, any>;
    assert.equal(p["usd"], 0.02);
    const credential = `${p["macaroon"]}:${wallet.settle(p["invoice"])}`;
    const got = await tool("call_tool", { type: "test/echo", config: { note: "hi" }, payment: credential });
    assert.equal(got.isError, false, JSON.stringify(got.out));
    assert.deepEqual(got.out["output"], { note: "hi" });
    assert.equal(got.out["credit"]["charged_usd"], 0.02);
    const bad = await tool("call_tool", { type: "test/echo", config: { nope: 1 }, payment: credential });
    assert.equal(bad.isError, true);
    assert.match(bad.out["error"], /config/);
    assert.match((await tool("call_tool", { type: "test/make", config: {} })).out["error"], /not open to anyone/);
  });

  it("a credential this server never minted is refused by name, never treated as unpaid", async () => {
    const bad = await tool("run_workflow", { workflow: "priced", input: { text: "x" }, payment: "AgEEc3RydXQ:00" });
    assert.equal(bad.isError, true);
    assert.match(bad.out["error"], /invalid_token/);
    const credit = await tool("get_credit", { payment: "AgEEc3RydXQ:00" });
    assert.equal(credit.isError, true);
  });

  it("GET /llms.txt: what anyone may run here and its price, open to anyone, the MCP door named", async () => {
    const res = await strut.app.request("/llms.txt");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/markdown/);
    const md = await res.text();
    assert.match(md, /^# strut server at localhost/m);
    assert.match(md, /claude mcp add --transport http localhost http:\/\/localhost\/public\/mcp/);
    assert.match(md, /- \[free\]\(http:\/\/localhost\/public\/workflows\/free\/run\): free; \d+ in the last 30 days, \$0\.00 charged on average; input: `text` \(string\), `cost` \(number, optional\), `hold` \(boolean, optional\)/);
    assert.match(md, /- \[priced\]\(http:\/\/localhost\/public\/workflows\/priced\/run\): \$0\.50 a run; needs \$0\.50 of credit to start; \d+ in the last 30 days, \$0\.50 charged on average/);
    assert.match(md, /- \[metered\]\(.*\): \$0\.10 \+ 2× what a run costs, at most \$1\.00 of cost; needs \$2\.10 of credit to start/);
    assert.match(md, /- \[test\/echo\]\(http:\/\/localhost\/public\/steps\/test\/echo\/run\): Echo a note back — \$0\.02 a call; needs \$0\.02 of credit to start/);
    assert.match(md, /## Paying/);
  });
});

describe("the agent tools hold no call past a client's patience", () => {
  /** Doors whose run is in flight for `reads` reads, then ends. */
  const fakeDoors = (reads: number): PublicDoors => {
    let n = 0;
    const view = () => (++n > reads ? { runId: "r1", status: "success", output: { ok: true }, charged: 0 } : { runId: "r1", status: "running" });
    return {
      launch: async () => ({ status: 202, body: { runId: "r1", token: "tok" } }),
      call: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return { status: 200, body: { output: { done: true } } };
      },
      run: async ({ token }) => (token === "tok" ? { status: 200, body: view() } : { status: 404, body: { error: "no run" } }),
      credit: async () => ({ status: 404, body: { error: "no credit" } }),
      claim: async () => ({ status: 404, body: { error: "no credit" } }),
      runnable: async () => [],
      listing: async () => ({ workflows: [], steps: [], concepts: [], types: [], apps: [], runnable: [] }),
    };
  };
  const drain = async (gen: unknown): Promise<unknown[]> => {
    const out: unknown[] = [];
    for await (const y of gen as AsyncIterable<unknown>) out.push(y);
    return out;
  };

  it("run_workflow yields progress while its run goes on, then the result; past `wait`, a handle with `next`", async () => {
    const tools = buildPublicAgentTools({ doors: fakeDoors(3), who: "a", publicUrl: "https://s.example/", progressEveryMs: 1 });
    const ys = await drain(await tools["run_workflow"]!.execute!({ workflow: "w", input: {}, wait: 5 }, { toolCallId: "1", messages: [] }));
    assert.ok(ys.length >= 2, "progress before the result");
    assert.deepEqual(ys.slice(0, -1).map((y) => (y as { status: string }).status), Array(ys.length - 1).fill("running"));
    const last = ys.at(-1) as Record<string, any>;
    assert.equal(last["run"]["status"], "success");
    assert.equal(last["token"], "tok");

    const held = buildPublicAgentTools({ doors: fakeDoors(1000), who: "a", publicUrl: "https://s.example", progressEveryMs: 1 });
    const handle = (await drain(await held["run_workflow"]!.execute!({ workflow: "w", input: {}, wait: 0 }, { toolCallId: "1", messages: [] }))).at(-1) as Record<string, any>;
    assert.equal(handle["run_id"], "r1");
    assert.match(handle["next"], /get_run/);
  });

  it("call_tool yields progress while the call runs, then its output", async () => {
    const tools = buildPublicAgentTools({ doors: fakeDoors(0), who: "a", publicUrl: "https://s.example", progressEveryMs: 20 });
    const ys = await drain(await tools["call_tool"]!.execute!({ type: "t", config: {} }, { toolCallId: "1", messages: [] }));
    assert.ok(ys.length >= 2, `beats then the output: ${JSON.stringify(ys)}`);
    assert.deepEqual(ys.at(-1), { output: { done: true } });
  });

  it("priceWords: free, fixed, metered, both — and the reserve and recent charges", () => {
    const r = { kind: "workflow" as const, capUsd: null, reserve: 0, recent: { days: 30, runs: 0, average: 0 } };
    assert.equal(priceWords({ ...r, base: 0, markup: 0 }), "free");
    assert.equal(priceWords({ ...r, base: 0.5, markup: 0, reserve: 0.5 }), "$0.50 a run; needs $0.50 of credit to start");
    assert.equal(priceWords({ ...r, base: 0, markup: 1.5, capUsd: 2, reserve: 3, recent: { days: 30, runs: 4, average: 0.75 } }), "1.5× what a run costs, at most $2.00 of cost; needs $3.00 of credit to start; 4 in the last 30 days, $0.75 charged on average");
    assert.equal(priceWords({ ...r, kind: "step", base: 0.005, markup: 0, reserve: 0.005 }), "$0.005 a call; needs $0.005 of credit to start");
  });
});
