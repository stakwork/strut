/**
 * A visitor's app page launches (plans/paid-runs.md work item 10, §10): a
 * public app's `run/launch` on a workflow it grants that a person made
 * runnable goes through the SAME launcher as `POST
 * /public/workflows/:name/run`. Free, it launches; priced with no credit,
 * the tool's RESULT is `{ payment_required }`; with the credit token on the
 * `/public/mcp` request's own `Authorization: L402`, it launches against
 * the token. The run token and the credit token never ride in a tool
 * result or argument; the visit the host names (`x-strut-visit`) reads its
 * own runs back, as far as the item's `results` lets its launcher.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createStrut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { defineStep, withUsage } from "./core.js";
import { publicAppOfIdentity } from "./auth.js";
import { kitForTests } from "./test-util/app-kit.js";
import { STEP_RUN_TOOL } from "./apps/tools.js";
import { createRegistry } from "./steps/registry.js";
import { FakeWallet } from "./payments/fake-wallet.js";
import { lightningCapability } from "./payments/lightning.js";
import { visitorOfVisit, VISIT_HEADER } from "./public-surface.js";
import type { ExchangeRate } from "./payments/rate.js";

const KEY = "public-visitor-launch-key";
const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const RATE = 100_000; // dollars per bitcoin: $1 is 1000 sats
const VISIT = "visit-one-aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_VISIT = "visit-two-bbbbbbbbbbbbbbbbbbbbbbbb";

/** Writes a file into the run's artifacts and declares it, spending what
 *  its config says. */
const make = defineStep({
  type: "test/make",
  input: z.object({ text: z.string(), cost: z.number().optional() }),
  output: z.any(),
  async run(cfg, ctx) {
    const artifacts = (ctx.services as { artifacts?: { write(runId: string, path: string, content: string): Promise<unknown> } }).artifacts;
    await artifacts?.write(ctx.runId, "out.txt", cfg.text);
    await artifacts?.write(ctx.runId, "notes.txt", "not declared");
    return withUsage({ text: cfg.text, artifacts: [{ id: "out", title: "Out", path: "out.txt" }] }, cfg.cost ? { modelCalls: 1, usage: {}, cost: cfg.cost } : undefined);
  },
});

const wf = (name: string) =>
  `name: ${name}\ninput:\n  text: { type: string }\n  cost: { type: number, default: 0 }\nsteps:\n  - id: m\n    type: test/make\n    config:\n      text: "{{ input.text }}"\n      cost: "{{ input.cost }}"\n`;

describe("a visitor's app page launches a runnable workflow (plans/paid-runs.md §10)", () => {
  let kit: Awaited<ReturnType<typeof kitForTests>>;
  let root: string;
  let saved: string | undefined;
  let strut: Awaited<ReturnType<typeof createStrut>>;
  let identity: string;
  /** The identity of `acme/shop/web`, an app in a package. */
  let pkgIdentity: string;
  const identityOf = async (name: string) => {
    const res = await strut.app.request(`/public/apps/${encodeURIComponent(name)}/document`);
    const html = await res.text();
    assert.equal(res.status, 200, `${name}: ${html.slice(0, 300)}`);
    return html.match(/<meta name="strut-app-token" content="([^"]+)">/)![1]!.replace(/&amp;/g, "&");
  };
  const metaOf = async (name: string) => {
    const html = await (await strut.app.request(`/public/apps/${encodeURIComponent(name)}/document`)).text();
    return JSON.parse(html.match(/<meta name="strut-public-runnable" content="([^"]+)">/)?.[1]?.replace(/&quot;/g, '"') ?? "null") as unknown;
  };
  const wallet = new FakeWallet();
  const store = new MemoryRunStore();

  const rpc = async (method: string, params: unknown, headers: Record<string, string> = {}) => {
    const res = await strut.app.request("/public/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    return { raw: text, body: line ? JSON.parse(line.slice(6)) : JSON.parse(text) };
  };
  /** A page's call through the visitor's door, as its host sends it. */
  const call = async (type: string, config: Record<string, unknown>, o: { visit?: string; credential?: string; app?: string } = {}) => {
    const headers: Record<string, string> = {
      ...(o.visit !== undefined ? { [VISIT_HEADER]: o.visit } : {}),
      ...(o.credential ? { authorization: `L402 ${o.credential}` } : {}),
    };
    const { raw, body } = await rpc("tools/call", { name: STEP_RUN_TOOL, arguments: { type, config, app: o.app ?? identity } }, headers);
    const out = JSON.parse(body.result.content[0].text) as Record<string, any>;
    return { raw, error: body.result.isError ? (out["error"] as string) : undefined, result: body.result.isError ? undefined : out };
  };
  const waitEnded = async (name: string, runId: string) => {
    for (let i = 0; i < 200; i++) {
      if (await store.getRunSummary(name, runId)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`${name}/${runId} did not end`);
  };

  before(async () => {
    saved = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = KEY;
    kit = await kitForTests();
    root = await mkdtemp(join(tmpdir(), "strut-public-visitor-launch-"));
    const workspace = new WorkspaceManager(join(root, "ws"));
    strut = await createStrut({
      workspace, store, kit, registry: await createRegistry([make]),
      scheduler: false, serveUi: false, views: false,
      job: false, orchestrator: false, builder: false, browserWorkflows: false, privacyWorkflows: false,
      services: { lightning: lightningCapability(wallet) },
      payments: { rate: async (): Promise<ExchangeRate> => ({ usdPerBtc: RATE, at: new Date().toISOString(), source: "test" }) },
    });
    for (const name of ["free-out", "free-run", "priced", "closed", "ungranted", "acme/shop/fortune"]) {
      await workspace.publishWorkflowByContent(name, wf(name));
      await workspace.setWorkflowOwner(name, "owner-1");
    }
    const dir = join(root, "apps", "shop");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "app.yaml"), "title: Shop\ngrants:\n  workflows: [free-out, free-run, priced, closed]\n");
    await writeFile(join(dir, "src", "App.tsx"), 'export default function App() { return <p className="p-2">shop</p>; }\n');
    const r = await strut.apps.publish(dir, "shop", { surface: "person" });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    // An app in a package names its package's workflow bare, as its page does.
    const pkgDir = join(root, "apps", "acme-web");
    await mkdir(join(pkgDir, "src"), { recursive: true });
    await writeFile(join(pkgDir, "app.yaml"), "title: Acme\ngrants:\n  workflows: [fortune]\n");
    await writeFile(join(pkgDir, "src", "App.tsx"), 'export default function App() { return <p className="p-2">acme</p>; }\n');
    const rp = await strut.apps.publish(pkgDir, "acme/shop/web", { surface: "person" });
    assert.ok(rp.ok, rp.ok ? "" : rp.errors.join("\n"));
    const put = await strut.app.request("/public-view", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        apps: [{ name: "shop" }, { name: "acme/shop/web" }],
        runnable: [
          { kind: "workflow", name: "acme/shop/fortune", dailyCapUsd: 5 },
          { kind: "workflow", name: "free-out", dailyCapUsd: 5 },
          { kind: "workflow", name: "free-run", dailyCapUsd: 5, results: "run" },
          { kind: "workflow", name: "priced", base: 0.5 },
          { kind: "workflow", name: "ungranted", base: 0.5 },
        ],
      }),
    });
    assert.equal(put.status, 200, await put.clone().text());
    identity = await identityOf("shop");
    assert.deepEqual(publicAppOfIdentity(identity), { name: "shop", version: "v1" });
    pkgIdentity = await identityOf("acme/shop/web");
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    if (saved === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = saved;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("the document names what its page may start — the runnable workflows it grants, nothing else — and what a visitor reads of each run", async () => {
    assert.deepEqual(await metaOf("shop"), [
      { name: "free-out", results: "output" },
      { name: "free-run", results: "run" },
      { name: "priced", results: "output" },
    ]);
  });

  it("an app in a package: its page's bare name is its package's workflow, for the meta, the launch and the reads", async () => {
    assert.deepEqual(await metaOf("acme/shop/web"), [{ name: "fortune", results: "output" }]);
    const launched = await call("run/launch", { workflow: "fortune", input: { text: "pkg" } }, { visit: VISIT, app: pkgIdentity });
    assert.equal(launched.error, undefined, launched.error);
    const runId = launched.result!["runId"] as string;
    await waitEnded("acme/shop/fortune", runId);
    const got = await call("run/get", { workflow: "fortune", runId }, { visit: VISIT, app: pkgIdentity });
    assert.equal(got.error, undefined, got.error);
    assert.equal(got.result!["status"], "success");
    assert.deepEqual(((await call("run/list", { workflow: "fortune" }, { visit: VISIT, app: pkgIdentity })).result as unknown as Array<{ runId: string }>).map((r) => r.runId), [runId]);
  });

  it("no visit, or not one: the launch is refused naming the header, before anything is admitted, held or charged", async () => {
    const invoices = wallet.calls.filter((c) => c.method === "makeInvoice").length;
    const before = (await store.listRuns("priced")).length + (await store.listRuns("free-out")).length;
    for (const visit of [undefined, "short", "not a visit secret at all, spaces and all"]) {
      for (const workflow of ["free-out", "priced"]) {
        const r = await call("run/launch", { workflow, input: { text: "x" } }, visit === undefined ? {} : { visit });
        assert.match(r.error!, /^visit_required: .*x-strut-visit/, `${workflow} with visit ${String(visit)}`);
      }
    }
    assert.equal((await store.listRuns("priced")).length + (await store.listRuns("free-out")).length, before, "nothing ran");
    assert.equal(wallet.calls.filter((c) => c.method === "makeInvoice").length, invoices, "no invoice was minted");
  });

  it("free: it launches through the public launcher, the result carries runId and no token, and the visit reads its own run back as `results` allows", async () => {
    const launched = await call("run/launch", { workflow: "free-out", input: { text: "hello" } }, { visit: VISIT });
    assert.equal(launched.error, undefined, launched.error);
    const runId = launched.result!["runId"] as string;
    assert.ok(runId);
    assert.deepEqual(Object.keys(launched.result!).sort(), ["runId"], "never the run token");
    // Read at once, before its `run.start` may have landed: the run, in flight or done — never "not found".
    const early = await call("run/get", { workflow: "free-out", runId }, { visit: VISIT });
    assert.equal(early.error, undefined, early.error);
    assert.equal(early.result!["runId"], runId);
    await waitEnded("free-out", runId);
    const start = (await store.getRunEvents("free-out", runId)).find((e) => e.type === "run.start")!;
    assert.equal(start.origin, "public");
    assert.equal(start.visitor, visitorOfVisit(VISIT));
    assert.ok(!JSON.stringify(await store.getRunEvents("free-out", runId)).includes(VISIT), "the visit's secret is in no log");

    // Its own run: the summary as its launcher reads it (`results: output`).
    const got = await call("run/get", { workflow: "free-out", runId }, { visit: VISIT });
    assert.equal(got.error, undefined, got.error);
    assert.equal(got.result!["status"], "success");
    assert.deepEqual(got.result!["output"], { text: "hello", artifacts: [{ id: "out", title: "Out", path: "out.txt" }] });
    assert.equal(got.result!["visitor"], undefined, "the visit's hash is never shown");
    assert.equal(got.result!["stepCounts"], undefined, "the output alone");
    const listed = await call("run/list", { workflow: "free-out" }, { visit: VISIT });
    assert.deepEqual((listed.result as unknown as Array<{ runId: string }>).map((r) => r.runId), [runId]);
    const file = await call("run/files", { workflow: "free-out", runId, path: "out.txt" }, { visit: VISIT });
    assert.equal(file.result!["text"], "hello");
    assert.match((await call("run/files", { workflow: "free-out", runId, path: "notes.txt" }, { visit: VISIT })).error!, /only the files its output declares/);
    assert.match((await call("run/events", { workflow: "free-out", runId }, { visit: VISIT })).error!, /output alone/);

    // Not another visit's, and not without one.
    assert.match((await call("run/get", { workflow: "free-out", runId }, { visit: OTHER_VISIT })).error!, /not found/);
    assert.match((await call("run/get", { workflow: "free-out", runId })).error!, /not found/);
    assert.deepEqual((await call("run/list", { workflow: "free-out" }, { visit: OTHER_VISIT })).result, []);
    assert.deepEqual((await call("run/list", { workflow: "free-out" })).result, []);
    assert.match((await call("run/files", { workflow: "free-out", runId, path: "out.txt" }, { visit: OTHER_VISIT })).error!, /not found|no file/i);
    // Stopping one stays closed.
    assert.match((await call("run/cancel", { workflow: "free-out", runId }, { visit: VISIT })).error!, /stopping a run is not available/);
  });

  it("an item that shows its launcher the whole run: the visit reads its events too, and only its own", async () => {
    // One at a time: a free item's runs in flight each set its cap aside of the day's.
    const mine = await call("run/launch", { workflow: "free-run", input: { text: "a" } }, { visit: VISIT });
    assert.equal(mine.error, undefined, mine.error);
    const runId = mine.result!["runId"] as string;
    await waitEnded("free-run", runId);
    const theirs = await call("run/launch", { workflow: "free-run", input: { text: "b" } }, { visit: OTHER_VISIT });
    assert.equal(theirs.error, undefined, theirs.error);
    await waitEnded("free-run", theirs.result!["runId"] as string);
    const events = await call("run/events", { workflow: "free-run", runId }, { visit: VISIT });
    assert.ok(Array.isArray(events.result) && (events.result as unknown[]).length > 0, events.error);
    assert.ok(!JSON.stringify(events.result).includes("visitor"), "no visit hash in a visitor's events");
    assert.deepEqual((await call("run/events", { workflow: "free-run", runId: theirs.result!["runId"] }, { visit: VISIT })).result, []);
    assert.deepEqual(((await call("run/list", { workflow: "free-run" }, { visit: VISIT })).result as unknown as Array<{ runId: string }>).map((r) => r.runId), [runId]);
    // The definition as `GET /public` lists it: its input, never its steps.
    const def = await call("run/workflow", { workflow: "free-run" }, { visit: VISIT });
    assert.deepEqual(Object.keys(def.result!).sort(), ["input", "name"]);
  });

  it("refused: a granted workflow nobody made runnable, a runnable one the app does not grant, params, a job", async () => {
    assert.match((await call("run/launch", { workflow: "closed", input: { text: "x" } }, { visit: VISIT })).error!, /not open to visitors to run/);
    assert.match((await call("run/launch", { workflow: "ungranted", input: { text: "x" } }, { visit: VISIT })).error!, /not granted to this app/);
    assert.match((await call("run/launch", { workflow: "free-out", input: { text: "x" }, params: { a: 1 } }, { visit: VISIT })).error!, /takes \{ input, key \} alone — drop params/);
    assert.match((await call("run/launch", { workflow: "free-out", input: { text: "x" }, job: "j1" }, { visit: VISIT })).error!, /drop job/);
    assert.match((await call("run/launch", { workflow: "free-out", input: {} }, { visit: VISIT })).error!, /input: text/);
    assert.match((await call("run/list", { workflow: "closed" }, { visit: VISIT })).error!, /not in the public view/);
  });

  it("priced: no credit is a payment_required RESULT; the host's L402 header launches it against the token, which no argument or result carries", async () => {
    const first = await call("run/launch", { workflow: "priced", input: { text: "pay" }, key: "k1" }, { visit: VISIT });
    assert.equal(first.error, undefined, first.error);
    const p = first.result!["payment_required"] as Record<string, any>;
    assert.ok(p, JSON.stringify(first.result));
    assert.deepEqual(Object.keys(first.result!), ["payment_required"]);
    assert.equal(p["usd"], 0.5);
    assert.equal(p["sats"], 500);
    assert.equal(p["rate"]["usdPerBtc"], RATE);
    assert.equal(p["description"], "priced: credit for one run");
    assert.ok(typeof p["macaroon"] === "string" && typeof p["invoice"] === "string" && typeof p["expires"] === "string");
    assert.equal(p["error"], undefined);
    assert.equal(await store.listRuns("priced").then((r) => r.length), 0, "nothing ran");

    // A phone pays the QR: the host learns the preimage from `claim`.
    const pending = (await (await strut.app.request("/public/credit/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ macaroon: p["macaroon"] }) })).json()) as Record<string, unknown>;
    assert.equal(pending["state"], "pending");
    const preimage = wallet.settle(p["invoice"]);
    const claimed = (await (await strut.app.request("/public/credit/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ macaroon: p["macaroon"] }) })).json()) as Record<string, unknown>;
    assert.equal(claimed["state"], "settled");
    const credential = claimed["credential"] as string;
    assert.equal(credential, `${p["macaroon"]}:${preimage}`);

    // The same call again, the credential on the request: it launches.
    const second = await call("run/launch", { workflow: "priced", input: { text: "pay" }, key: "k1" }, { visit: VISIT, credential });
    assert.equal(second.error, undefined, second.error);
    const runId = second.result!["runId"] as string;
    assert.ok(runId);
    assert.equal(second.result!["credit"]["held_usd"], 0.5, "the reserve is set aside");
    for (const secret of [preimage, p["macaroon"] as string]) assert.ok(!second.raw.includes(secret), "no credential in the result");
    assert.equal(second.result!["token"], undefined, "no run token in the result");
    await waitEnded("priced", runId);
    const start = (await store.getRunEvents("priced", runId)).find((e) => e.type === "run.start")!;
    assert.equal(start.visitor, visitorOfVisit(VISIT));
    assert.ok(start.credit, "launched against the token");
    assert.equal((await call("run/get", { workflow: "priced", runId }, { visit: VISIT })).result!["status"], "success");

    // Spent: the next launch asks again, and its macaroon carries the remainder.
    const third = await call("run/launch", { workflow: "priced", input: { text: "again" } }, { visit: VISIT, credential });
    const again = third.result!["payment_required"] as Record<string, any>;
    assert.equal(again["reason"], "short");
    assert.equal(again["remaining_usd"], 0);
    assert.equal(again["carries"], true, "the top-up inherits the token presented: the host replaces its credential with it");

    // A credential the server cannot vouch for is an error the host reads.
    const forged = await call("run/launch", { workflow: "priced", input: { text: "x" } }, { visit: VISIT, credential: `${p["macaroon"]}:${"0".repeat(64)}` });
    assert.match(forged.error!, /invalid_token/);
  });

  it("the same input launched twice with one credential is two runs: a key matches only a run still in flight", async () => {
    // Credit for two runs (the reserve is $0.50), bought up front.
    const bought = (await (await strut.app.request("/public/credit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ usd: 1 }) })).json()) as Record<string, any>;
    const credential = `${bought["macaroon"]}:${wallet.settle(bought["invoice"])}`;
    const one = await call("run/launch", { workflow: "priced", input: { text: "twice" }, key: "same" }, { visit: VISIT, credential });
    assert.equal(one.error, undefined, one.error);
    // Ended AND charged: until its charge a key still names the run in flight.
    await waitEnded("priced", one.result!["runId"] as string);
    for (let i = 0; i < 200 && !(await (await strut.ledger()).chargeOf(one.result!["runId"] as string, "workflow:priced")); i++) await new Promise((r) => setTimeout(r, 25));
    const two = await call("run/launch", { workflow: "priced", input: { text: "twice" }, key: "same" }, { visit: VISIT, credential });
    assert.equal(two.error, undefined, two.error);
    assert.notEqual(two.result!["runId"], one.result!["runId"], "a finished run is not returned again");
    assert.equal(two.result!["existing"], undefined);
    await waitEnded("priced", two.result!["runId"] as string);
  });

  it("the visitor's door answers a browser's preflight for the visit header", async () => {
    const res = await strut.app.request("/public/mcp", { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /x-strut-visit/);
  });
});
