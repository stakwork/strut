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
import { buildPublicAgentTools, defaultLaunchKey, priceWords, publicLlmsTxt } from "./public-agents.js";
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
    assert.equal(out["key"], undefined, "a free launch gets no key unless the agent names one: its callers may share an address");
    assert.match(out["run"]["url"], /^http:\/\/localhost\/public\/workflows\/free\/runs\/\d+\?t=/, "the run over HTTP, its token on it");
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

  it("run_workflow, a long free run: answers a handle with `next`; get_run waits; the agent's own key joins the run in flight, no key is a run of its own", async () => {
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    try {
      const first = await tool("run_workflow", { workflow: "free", input: { text: "slow", hold: true }, key: "mine", wait: 0 });
      assert.equal(first.isError, false, JSON.stringify(first.out));
      assert.match(first.out["next"], /get_run/);
      assert.equal(first.out["run"]["charged"], undefined, "not ended");
      // A retry under the agent's own key returns the run in flight.
      const again = await tool("run_workflow", { workflow: "free", input: { text: "slow", hold: true }, key: "mine", wait: 0 });
      assert.equal(again.out["run_id"], first.out["run_id"]);
      assert.equal(again.out["existing"], true);
      // No key on a free launch: another caller at the same address (a hosted agent's vendor) never joins it.
      const stranger = await tool("run_workflow", { workflow: "free", input: { text: "slow", hold: true }, wait: 0 });
      assert.notEqual(stranger.out["run_id"], first.out["run_id"]);
      assert.equal(stranger.out["existing"], undefined);
      open();
      const done = await tool("get_run", { workflow: "free", run_id: first.out["run_id"], token: first.out["token"], wait: 10 });
      assert.equal(done.out["run"]["status"], "success");
      assert.equal(done.out["next"], undefined);
      await tool("get_run", { workflow: "free", run_id: stranger.out["run_id"], token: stranger.out["token"], wait: 10 });
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
      assert.equal(first.out["key"], defaultLaunchKey("priced", { text: "lost", hold: true, cost: 0 }), "a priced launch's default key: the parsed input, keys sorted");
      // The retry writes the fields in another order: the same run.
      const retry = await tool("run_workflow", { workflow: "priced", input: { hold: true, text: "lost" }, payment: credential, wait: 0 });
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

  it("a lost answer after the run ENDED: get_credit lists the run with its token, get_run reads it, and nothing is paid twice", async () => {
    const asked = await tool("run_workflow", { workflow: "priced", input: { text: "ended" } });
    const p = asked.out["payment_required"] as Record<string, any>;
    const credential = `${p["macaroon"]}:${wallet.settle(p["invoice"])}`;
    const ran = await tool("run_workflow", { workflow: "priced", input: { text: "ended" }, payment: credential, wait: 10 });
    assert.equal(ran.out["run"]["charged"], 0.5);
    // The agent never saw that answer. Before calling again it reads its credit:
    const credit = await tool("get_credit", { payment: credential });
    const runs = credit.out["runs"] as Array<Record<string, any>>;
    assert.equal(runs.length, 1, JSON.stringify(runs));
    assert.equal(runs[0]!["kind"], "workflow");
    assert.equal(runs[0]!["name"], "priced");
    assert.equal(runs[0]!["runId"], ran.out["run_id"]);
    assert.equal(runs[0]!["status"], "success");
    assert.equal(runs[0]!["charged_usd"], 0.5);
    assert.equal(runs[0]!["token"], ran.out["token"]);
    assert.match(runs[0]!["url"], /^http:\/\/localhost\/public\/workflows\/priced\/runs\/\d+\?t=/);
    const got = await tool("get_run", { workflow: "priced", run_id: runs[0]!["runId"], token: runs[0]!["token"] });
    assert.deepEqual(got.out["run"]["output"], ran.out["run"]["output"]);
    // The same over HTTP, with relative urls.
    const http = (await (await strut.app.request("/public/credit", { headers: { authorization: `L402 ${credential}` } })).json()) as { runs: Array<Record<string, any>> };
    assert.equal(http.runs[0]!["token"], ran.out["token"]);
    assert.match(http.runs[0]!["url"], /^\/public\/workflows\/priced\/runs\//);
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
    // The call is on the credential's list: what it was charged and how it ended.
    const listed = ((await tool("get_credit", { payment: credential })).out["runs"] as Array<Record<string, any>>).find((r) => r["kind"] === "step");
    assert.equal(listed?.["name"], "test/echo");
    assert.equal(listed?.["charged_usd"], 0.02);
    assert.equal(listed?.["status"], "success");
    assert.equal(listed?.["token"], undefined, "a call has no run to read");
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

describe("the agent tools hold no call past a client's patience, and cut nothing paid for", () => {
  /** Doors whose run is in flight for `reads` reads, then ends as `ended`. */
  const fakeDoors = (o: { reads?: number; ended?: Record<string, unknown>; callMs?: number; output?: unknown; launchMs?: number } = {}): PublicDoors => {
    let n = 0;
    const ended = o.ended ?? { runId: "r1", status: "success", output: { ok: true }, charged: 0 };
    const view = () => (++n > (o.reads ?? 0) ? ended : { runId: "r1", status: "running" });
    return {
      launch: async () => {
        if (o.launchMs) await new Promise((r) => setTimeout(r, o.launchMs));
        return { status: 202, body: { runId: "r1", token: "tok" } };
      },
      call: async () => {
        await new Promise((r) => setTimeout(r, o.callMs ?? 120));
        return { status: 200, body: { output: o.output ?? { done: true } } };
      },
      run: async ({ token }) => (token === "tok" ? { status: 200, body: view() } : { status: 404, body: { error: "no run" } }),
      credit: async () => ({ status: 404, body: { error: "no credit" } }),
      claim: async () => ({ status: 404, body: { error: "no credit" } }),
      runnable: async () => [],
      listing: async () => ({ workflows: [], steps: [], concepts: [], types: [], apps: [], runnable: [] }),
      overBudget: () => false,
    };
  };
  const drain = async (gen: unknown): Promise<unknown[]> => {
    const out: unknown[] = [];
    for await (const y of gen as AsyncIterable<unknown>) out.push(y);
    return out;
  };
  const run = async (tools: ReturnType<typeof buildPublicAgentTools>, name: string, args: Record<string, unknown>) =>
    drain(await tools[name]!.execute!(args as never, { toolCallId: "1", messages: [] }));

  it("run_workflow: the first yield carries the run's handle, progress while it goes, then the result; past `wait`, a handle with `next`", async () => {
    const tools = buildPublicAgentTools({ doors: fakeDoors({ reads: 3 }), who: "a", publicUrl: "https://s.example/", progressEveryMs: 1 });
    const ys = (await run(tools, "run_workflow", { workflow: "w", input: {}, wait: 5 })) as Array<Record<string, any>>;
    assert.deepEqual(ys[0], { status: "running", workflow: "w", run_id: "r1", token: "tok", url: "https://s.example/public/workflows/w/runs/r1?t=tok" }, "a client that loses the answer still has the handle");
    assert.ok(ys.slice(1, -1).every((y) => y["status"] === "running" && y["run_id"] === "r1" && y["token"] === "tok"));
    const last = ys.at(-1)!;
    assert.equal(last["run"]["status"], "success");
    assert.equal(last["run"]["url"], "https://s.example/public/workflows/w/runs/r1?t=tok");

    const held = buildPublicAgentTools({ doors: fakeDoors({ reads: 1000 }), who: "a", publicUrl: "https://s.example", progressEveryMs: 1 });
    const handle = (await run(held, "run_workflow", { workflow: "w", input: {}, wait: 0 })).at(-1) as Record<string, any>;
    assert.equal(handle["run_id"], "r1");
    assert.match(handle["next"], /get_run/);
  });

  it("a run that ended with its charge pending reads as ended, never as still running", async () => {
    const tools = buildPublicAgentTools({ doors: fakeDoors({ ended: { runId: "r1", status: "success", output: { ok: 1 }, charge_pending: true } }), who: "a", publicUrl: "https://s.example", progressEveryMs: 1 });
    const t0 = Date.now();
    const last = (await run(tools, "get_run", { workflow: "w", run_id: "r1", token: "tok", wait: 30 })).at(-1) as Record<string, any>;
    assert.ok(Date.now() - t0 < 2000, "answered at once, not after `wait`");
    assert.equal(last["run"]["status"], "success");
    assert.match(last["next"], /charge is not recorded yet/);
    assert.doesNotMatch(last["next"], /Still running/);
  });

  it("the call's deadline: a launch or a call still going answers what it has before the client's 60 s, and says to read get_credit", async () => {
    const slowCall = buildPublicAgentTools({ doors: fakeDoors({ callMs: 300 }), who: "a", publicUrl: "https://s.example", progressEveryMs: 20, deadlineMs: 100 });
    const call = (await run(slowCall, "call_tool", { type: "t", config: {}, payment: "mac:aa" })).at(-1) as Record<string, any>;
    assert.equal(call["status"], "still_running");
    assert.match(call["next"], /get_credit/);
    const slowLaunch = buildPublicAgentTools({ doors: fakeDoors({ launchMs: 300 }), who: "a", publicUrl: "https://s.example", progressEveryMs: 20, deadlineMs: 100 });
    const launch = (await run(slowLaunch, "run_workflow", { workflow: "w", input: {}, payment: "mac:aa" })).at(-1) as Record<string, any>;
    assert.equal(launch["status"], "starting");
    assert.match(launch["next"], /get_credit/);
    // A run that outlasts the deadline answers its handle.
    const longRun = buildPublicAgentTools({ doors: fakeDoors({ reads: Number.MAX_SAFE_INTEGER }), who: "a", publicUrl: "https://s.example", progressEveryMs: 20, deadlineMs: 100 });
    const t0 = Date.now();
    const handle = (await run(longRun, "run_workflow", { workflow: "w", input: {}, wait: 45 })).at(-1) as Record<string, any>;
    assert.ok(Date.now() - t0 < 1000, "held no longer than the deadline");
    assert.match(handle["next"], /get_run/);
  });

  it("nothing paid for is cut: a call's output comes back whole; a run's large output is left out with its url", async () => {
    const big = { text: "x".repeat(200_000) };
    const tools = buildPublicAgentTools({ doors: fakeDoors({ output: big, callMs: 1 }), who: "a", publicUrl: "https://s.example", progressEveryMs: 20 });
    const call = (await run(tools, "call_tool", { type: "t", config: {} })).at(-1) as Record<string, any>;
    assert.equal(call["output"]["text"].length, 200_000);
    const huge = buildPublicAgentTools({ doors: fakeDoors({ ended: { runId: "r1", status: "success", output: big, charged: 0.1 } }), who: "a", publicUrl: "https://s.example", progressEveryMs: 1 });
    const last = (await run(huge, "get_run", { workflow: "w", run_id: "r1", token: "tok" })).at(-1) as Record<string, any>;
    assert.equal(last["run"]["output"], undefined);
    assert.equal(last["run"]["output_omitted"]["read_at"], "https://s.example/public/workflows/w/runs/r1?t=tok");
    assert.ok(last["run"]["output_omitted"]["chars"] > 200_000);
  });

  it("the default key is the parsed input with its keys sorted", () => {
    assert.equal(defaultLaunchKey("w", { b: 1, a: { d: 2, c: [1, { f: 1, e: 2 }] } }), defaultLaunchKey("w", { a: { c: [1, { e: 2, f: 1 }], d: 2 }, b: 1 }));
    assert.notEqual(defaultLaunchKey("w", { a: 1 }), defaultLaunchKey("w", { a: 2 }));
    assert.notEqual(defaultLaunchKey("w", { a: 1 }), defaultLaunchKey("v", { a: 1 }));
  });

  it("llms.txt leaves the MCP door out when it is off", () => {
    const listing = { runnable: [], workflows: [{ name: "w" }], apps: [], concepts: [] };
    assert.match(publicLlmsTxt(listing, { publicUrl: "https://s.example" }), /\/public\/mcp/);
    assert.doesNotMatch(publicLlmsTxt(listing, { publicUrl: "https://s.example", mcp: false }), /\/public\/mcp|claude mcp add/);
  });

  it("priceWords: free, fixed, metered, both — and the reserve and recent charges", () => {
    const r = { kind: "workflow" as const, capUsd: null, reserve: 0, recent: { days: 30, runs: 0, average: 0 } };
    assert.equal(priceWords({ ...r, base: 0, markup: 0 }), "free");
    assert.equal(priceWords({ ...r, base: 0.5, markup: 0, reserve: 0.5 }), "$0.50 a run; needs $0.50 of credit to start");
    assert.equal(priceWords({ ...r, base: 0, markup: 1.5, capUsd: 2, reserve: 3, recent: { days: 30, runs: 4, average: 0.75 } }), "1.5× what a run costs, at most $2.00 of cost; needs $3.00 of credit to start; 4 in the last 30 days, $0.75 charged on average");
    assert.equal(priceWords({ ...r, kind: "step", base: 0.005, markup: 0, reserve: 0.005 }), "$0.005 a call; needs $0.005 of credit to start");
  });
});
