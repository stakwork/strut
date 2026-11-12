/**
 * A strut that BUYS (plans/paid-runs.md §10 "Another strut", work item 9):
 * a SELLER strut with a priced workflow and a free one behind its public
 * door, and a BUYER strut whose `remote/*` steps reach it in process through
 * the guarded http, whose payer pays the seller's wallet. What is held is
 * spent with no ask; it is bought only on an admin's accepted proposal,
 * paid once, booked as a purchase, and stored only when its preimage proves
 * it — at once, or by the claim keeper once a pending payment settles.
 */
import { describe, it, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { createStrut, type Strut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { defineStep, withUsage, type RunEvent, type StepContext } from "./core.js";
import { createRegistry } from "./steps/registry.js";
import { FakeWallet } from "./payments/fake-wallet.js";
import { lightningCapability, LightningError } from "./payments/lightning.js";
import { decodeBolt11, encodeBolt11 } from "./payments/bolt11.js";
import { lspFeeFloorMsat, type PayRequest, type PayResult, type Payer } from "./payments/payer.js";
import type { ExchangeRate } from "./payments/rate.js";
import { MemorySecretStore } from "./secret-store.js";
import { guardedHttp } from "./guarded-http.js";
import { httpCapability, type HttpCapability } from "./capabilities.js";
import { buildRegistryTools } from "./steps/core/agent.js";
import { ENTITLEMENTS_FILE, createRemote, sellerOf, type RemoteListing } from "./remote.js";
import { mintToken, macaroonToBase64 } from "./l402.js";
import type { Proposal } from "./proposals.js";
type WithdrawAnswerLike = { state: "pending" | "settled" | "failed"; paymentHash: string; msat: number; feeMsat: number; maxFeeMsat: number };
import { hiddenFromSteps } from "./env.js";
import { personToken } from "./auth.js";
import { grantRefusal } from "./apps/tools.js";
import type { AppManifest } from "./apps/manifest.js";

const KEY = "remote-api-key";
const PEER = "remote-peer-key";
const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const RATE = 100_000; // dollars per bitcoin: $1 is 1000 sats
const fixedRate = async (): Promise<ExchangeRate> => ({ usdPerBtc: RATE, at: new Date().toISOString(), source: "test" });
const SELLER = "https://seller.example";
const PUBLIC_IP = async () => ["93.184.216.34"];

/** Spends what its config says (the seller's cost), after `ms`. */
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
    return withUsage({ spent: cfg.cost ?? 0, cve: "CVE-2026-0001" }, cfg.cost ? { modelCalls: 1, usage: {}, cost: cfg.cost } : undefined);
  },
});
/** A tool the seller sells: looks a package up, spending what it is told. */
const lookup = defineStep({
  type: "cve/lookup",
  description: "Look a package up in the CVE feed",
  effect: "read",
  input: z.object({ package: z.string(), cost: z.number().optional(), fail: z.boolean().optional() }),
  output: z.any(),
  async run(cfg) {
    if (cfg.fail) throw new Error(`no such package ${cfg.package}`);
    return withUsage({ package: cfg.package, cves: ["CVE-2026-0002"] }, cfg.cost ? { modelCalls: 1, usage: {}, cost: cfg.cost } : undefined);
  },
});
const FLOW = (name: string) =>
  `name: ${name}\ninput:\n  cost: { type: number, default: 0 }\n  ms: { type: number, default: 0 }\nsteps:\n  - id: s\n    type: test/spend\n    config:\n      cost: "{{ input.cost }}"\n      ms: "{{ input.ms }}"\n`;

/** The buyer's wallet: pays the SELLER's fake wallet. Each outcome queued
 *  is the next pay's: `settled` (with the preimage), `quiet` (settled, no
 *  preimage — the claim must fetch it), `pending` (the test settles it),
 *  or a refusal before anything went. A payment already made is read as it
 *  stands, never paid again; only a failed one is. */
class LinkedPayer implements Payer {
  readonly provider = "sphinx" as const;
  readonly capsFee = true;
  readonly id = "sphinx:linked";
  readonly outcomes: Array<"settled" | "quiet" | "pending" | LightningError> = [];
  readonly #payments = new Map<string, { state: "settled" | "pending" | "failed"; preimage?: string; quiet?: boolean }>();
  /** The payment hashes actually SENT, in order. */
  readonly sent: string[] = [];
  constructor(readonly seller: FakeWallet) {}
  minFeeMsat(msat: number) {
    return lspFeeFloorMsat(msat);
  }
  async pay(req: PayRequest): Promise<PayResult> {
    const inv = decodeBolt11(req.invoice);
    const had = this.#payments.get(inv.paymentHash);
    if (had && had.state !== "failed") return this.#answer(inv.paymentHash);
    const outcome = this.outcomes.shift() ?? "settled";
    if (outcome instanceof LightningError) throw outcome;
    this.sent.push(inv.paymentHash);
    const p: { state: "settled" | "pending" | "failed"; preimage?: string; quiet?: boolean } = { state: "pending" };
    this.#payments.set(inv.paymentHash, p);
    if (outcome !== "pending") {
      p.preimage = this.seller.settle(inv.paymentHash);
      p.state = "settled";
      p.quiet = outcome === "quiet";
    }
    return this.#answer(inv.paymentHash);
  }
  async status(req: PayRequest & { paymentHash: string }): Promise<PayResult> {
    const p = this.#payments.get(req.paymentHash);
    if (!p || p.state === "failed") return this.pay(req);
    return this.#answer(req.paymentHash);
  }
  /** A pending payment arrives at the seller. */
  settle(paymentHash: string) {
    const p = this.#payments.get(paymentHash)!;
    p.preimage = this.seller.settle(paymentHash);
    p.state = "settled";
    p.quiet = true;
  }
  #answer(hash: string): PayResult {
    const p = this.#payments.get(hash)!;
    return { paymentHash: hash, state: p.state, feeMsat: p.state === "settled" ? 5 : 0, ...(p.state === "settled" && !p.quiet ? { preimage: p.preimage } : {}) };
  }
}

const quiet = {
  serveUi: false,
  scheduler: false,
  enableChat: false,
  systemWorkflows: false,
  browserWorkflows: false,
  privacyWorkflows: false, mediaWorkflows: false,
  job: false,
  orchestrator: false,
  builder: false,
  views: false,
  jamie: false,
  knowledge: false,
  concepts: false,
  stt: false,
  subscriptionPoll: false,
} as const;

const saved: Record<string, string | undefined> = {};
before(() => {
  for (const k of ["STRUT_API_KEY", "STRUT_PEER_KEY", "STRUT_SECRET_KEY", "STRUT_PACKAGE_INDEXES"]) saved[k] = process.env[k];
  process.env["STRUT_API_KEY"] = KEY;
  process.env["STRUT_PEER_KEY"] = PEER;
  process.env["STRUT_SECRET_KEY"] = "remote-secret";
  process.env["STRUT_PACKAGE_INDEXES"] = "[]";
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

type Tool = { execute: (input: unknown, o?: { strutToolPath?: string }) => Promise<unknown> };

describe("a strut that buys — remote/* against another strut's public door", () => {
  let dir: string;
  let seller: Strut;
  let buyer: Strut;
  let sellerWallet: FakeWallet;
  let payer: LinkedPayer;
  let launches: number;
  let toSeller: HttpCapability;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-remote-"));
    sellerWallet = new FakeWallet({ bolt11: true });
    seller = await createStrut({
      workspace: new WorkspaceManager(join(dir, "seller")),
      store: new MemoryRunStore(),
      ...quiet,
      registry: await createRegistry([spend, lookup]),
      services: { lightning: lightningCapability(sellerWallet) },
      payments: { rate: fixedRate },
    });
    for (const name of ["cve/scan", "cve/free"]) {
      await seller.workspace.createWorkflow(name, FLOW(name));
      await seller.workspace.setWorkflowOwner(name, "owner-1");
    }
    const put = await seller.app.request("/public-view", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        runnable: [
          { kind: "workflow", name: "cve/scan", base: 0.5, markup: 2, capUsd: 1 },
          { kind: "workflow", name: "cve/free", dailyCapUsd: 5 },
          { kind: "step", name: "cve/lookup", base: 0.1, markup: 1, capUsd: 0.5 },
        ],
      }),
    });
    assert.equal(put.status, 200, await put.clone().text());
    launches = 0;
    // The buyer reaches the seller in process, through the GUARDED http
    // (the name resolves to a public address, so the guard lets it by).
    toSeller = guardedHttp({
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const req = new Request(url, init);
        if (req.method === "POST" && /\/public\/workflows\/[^/]+\/run$/.test(new URL(req.url).pathname)) launches++;
        return seller.app.fetch(req);
      }) as typeof fetch,
      lookup: PUBLIC_IP,
    });
    payer = new LinkedPayer(sellerWallet);
    buyer = await createStrut({ workspace: new WorkspaceManager(join(dir, "buyer")), store: new MemoryRunStore(), ...quiet, remote: { http: toSeller }, payments: { rate: fixedRate, payer } });
  });
  afterEach(async () => {
    await buyer.close();
    await seller.close();
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = (events: RunEvent[] = [], extra: Partial<StepContext> = {}): StepContext => ({
    runId: `r${randomBytes(4).toString("hex")}`,
    path: "cve-watch/scan",
    scope: {},
    input: undefined,
    emit: async (e) => void events.push(e),
    services: buyer.services,
    registry: buyer.getRegistry(),
    actor: "ann",
    principal: "ann",
    ...extra,
  });
  const step = (type: string) => buyer.getRegistry()[type]!;
  const gatedBuy = (c: StepContext) =>
    buildRegistryTools(["remote/buy-credit"], buyer.getRegistry(), c, (d: unknown) => d, { approve: new Set(["remote/buy-credit"]), session: "s1" })["remote_buy_credit"] as Tool;
  const record = async (id: string): Promise<Proposal> => (await (buyer.services as { proposals: { get(id: string): Promise<Proposal | null> } }).proposals.get(id))!;
  const decide = async (id: string, action: "accept" | "reject") => {
    const res = await buyer.app.request(`/proposals/${id}/decide`, { method: "POST", headers: auth, body: JSON.stringify({ action }) });
    return { status: res.status, body: (await res.json()) as Proposal & { error?: string } };
  };
  /** An agent asks to buy `usd` at the seller; returns the proposal id. */
  const ask = async (usd: number, n = 1) => {
    const out = (await gatedBuy(ctx()).execute({ url: SELLER, usd, rationale: "For the hourly CVE scan." }, { strutToolPath: `orchestrator/turn/00${n}-remote_buy_credit` })) as { proposal: string; status: string };
    assert.equal(out.status, "pending");
    return out.proposal;
  };
  const held = async () => ((await (await buyer.app.request("/remote/credit?balance=1", { headers: auth })).json()) as { sellers: Array<Record<string, any>> }).sellers;

  it("reads what a seller sells and what is held there; the URL is https, a trailing /public is the same seller", async () => {
    const listing = (await step("remote/list").run({ url: `${SELLER}/public/` }, ctx())) as RemoteListing;
    assert.equal(listing.seller, SELLER);
    const scan = listing.runnable.find((i) => i.name === "cve/scan")!;
    assert.deepEqual([scan.kind, scan.base, scan.markup, scan.capUsd, scan.reserve], ["workflow", 0.5, 2, 1, 2.5]);
    assert.ok(listing.runnable.some((i) => i.name === "cve/free" && i.base === 0 && i.markup === 0));
    assert.ok(listing.runnable.some((i) => i.kind === "step" && i.name === "cve/lookup" && i.reserve === 0.6));
    assert.deepEqual(listing.credit, { seller: SELLER, held: false });
    assert.equal(sellerOf("https://Seller.Example:443/lab/public"), "https://seller.example/lab");
    // The admin's drop of a stuck purchase: the key's, never a peer's.
    const drop = (authorization: string) => buyer.app.request(`/remote/purchases?seller=${encodeURIComponent(SELLER)}`, { method: "DELETE", headers: { authorization } });
    assert.deepEqual(await (await drop(`Bearer ${KEY}`)).json(), { seller: SELLER });
    assert.equal((await drop(`Bearer ${PEER}`)).status, 403);
    await assert.rejects(step("remote/list").run({ url: "http://seller.example" }, ctx()), /bad_url: http:\/\/seller\.example is not https/);
    // The guard: never a private, loopback or metadata address.
    const guarded = guardedHttp();
    await assert.rejects(guarded("https://127.0.0.1/public"), /local|private|loopback|not allowed|refus/i);
    await assert.rejects(guarded("https://169.254.169.254/latest/meta-data"), /local|private|link|not allowed|refus/i);
  });

  it("a free workflow runs with no credit; a priced one fails saying what the seller asks, and nothing is paid", async () => {
    const free = (await step("remote/run-workflow").run({ url: SELLER, workflow: "cve/free", input: { cost: 0.01 } }, ctx())) as Record<string, any>;
    assert.equal(free.status, "success");
    assert.equal(free.output.cve, "CVE-2026-0001");
    assert.equal(free.charged_usd, 0);
    await assert.rejects(
      step("remote/run-workflow").run({ url: SELLER, workflow: "cve/scan", input: { cost: 0.2 } }, ctx()),
      (err: Error) => {
        assert.match(err.message, /^payment_required: https:\/\/seller\.example asks \$2\.50 \(2500 sats\) for a run of cve\/scan: this strut server holds no credit there\. This step never pays: an admin buys credit there with remote\/buy-credit \{ url: "https:\/\/seller\.example", usd: 2\.5 \}/);
        return true;
      },
    );
    assert.deepEqual(payer.sent, [], "nothing paid");
    assert.equal(sellerWallet.invoices().filter((i) => i.settled).length, 0);
  });

  it("buying is an admin's accepted proposal: refused as a tool call or a forged record; accepted, it pays once, books a purchase, keeps the token where no step reads it, and runs spend it", async () => {
    await assert.rejects(step("remote/buy-credit").run({ url: SELLER, usd: 5 }, ctx()), /runs only as a proposal a person accepted/);
    const door = (buyer.services as { remote: { buyCredit(u: string, usd: number, o: { proposal: string }): Promise<unknown> } }).remote;
    await assert.rejects(door.buyCredit(SELLER, 5, { proposal: "nope" }), /buy_needs_person/);

    const id = await ask(5);
    const rec = await record(id);
    assert.equal(rec.approver, "admin");
    assert.equal(rec.title, "Buy $5.00 of credit at seller.example");
    // The card (decision 25): who, what it sells and at what price, what is held, whether the wallet pays.
    assert.match(rec.summary!, /https:\/\/seller\.example sells 3 things to run \(2 priced\): cve\/scan \(workflow\): \$0\.50 a run \+ 2× its cost, \$2\.50 to start/);
    assert.match(rec.summary!, /This strut server holds no credit there\./);
    assert.match(rec.summary!, /Paid from this strut server's wallet/);
    await assert.rejects(door.buyCredit(SELLER, 5, { proposal: id }), /buy_needs_person: .*is pending/, "pending is not accepted");
    assert.deepEqual(payer.sent, []);

    const { status, body } = await decide(id, "accept");
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.status, "applied", JSON.stringify(body.result));
    const out = body.result!.output as Record<string, any>;
    assert.equal(out.state, "stored");
    assert.deepEqual([out.seller, out.usd, out.sats], [SELLER, 5, 5000]);
    assert.equal(out.credit.remaining_usd, 5);
    assert.equal(payer.sent.length, 1, "paid once");
    // Booked as a purchase, not a withdrawal.
    const entries = (await (await buyer.app.request("/earnings/entries?kind=withdrawal", { headers: auth })).json()) as { entries: Array<Record<string, any>> };
    assert.deepEqual(entries.entries.map((e) => [e.subject, e.msat, e.ref]), [["purchase", 5_000_000, payer.sent[0]]]);
    // Held: what, not the token.
    const h = await held();
    assert.equal(h.length, 1);
    assert.equal(h[0]!.seller, SELLER);
    assert.equal(h[0]!.credit.usd, 5);
    assert.equal(h[0]!.credit.macaroon, undefined);
    assert.equal(h[0]!.credit.preimage, undefined);
    assert.equal(h[0]!.balance.remaining_usd, 5);
    // In its own encrypted file, under names no step reads.
    const text = await readFile(join(buyer.dataDir, ENTITLEMENTS_FILE), "utf8");
    const names = Object.keys((JSON.parse(text) as { secrets: Record<string, unknown> }).secrets);
    assert.equal(names.length, 1);
    assert.ok(names.every((n) => hiddenFromSteps(n)), "no step reads an entitlement's name");
    assert.ok(!text.includes(payer.sent[0]!) && !text.includes("AgEFc3RydXQ"), "encrypted at rest: no payment hash, no macaroon");
    const secrets = (buyer.services as { secrets: { get(n: string): Promise<string | undefined> } }).secrets;
    assert.equal(await secrets.get(`ENTITLEMENT_${createHash("sha256").update(SELLER).digest("hex")}`), undefined);
    // The same record opens the door no more.
    await assert.rejects(door.buyCredit(SELLER, 5, { proposal: id }), /buy_needs_person: .*is applied/);

    // Spent with no ask: a priced run, its charge, the balance after.
    const ran = (await step("remote/run-workflow").run({ url: SELLER, workflow: "cve/scan", input: { cost: 0.25 } }, ctx())) as Record<string, any>;
    assert.equal(ran.status, "success");
    assert.equal(ran.output.cve, "CVE-2026-0001");
    assert.equal(ran.charged_usd, 1, "0.5 + 2 × 0.25");
    assert.equal(ran.credit.held_usd, 2.5);
    const after = (await step("remote/list").run({ url: SELLER }, ctx())) as RemoteListing;
    assert.equal(after.credit.remaining_usd, 4);
    // A tool the seller sells, called with the same credit (its real door, POST /public/steps/:type/run).
    const called = (await step("remote/call").run({ url: SELLER, type: "cve/lookup", config: { package: "lodash", cost: 0.2 } }, ctx())) as Record<string, any>;
    assert.deepEqual(called.output, { package: "lodash", cves: ["CVE-2026-0002"] });
    assert.equal(called.credit.charged_usd, 0.3, "0.1 + 1 × 0.2");
    assert.equal(((await step("remote/list").run({ url: SELLER }, ctx())) as RemoteListing).credit.remaining_usd, 3.7);
    assert.equal(payer.sent.length, 1, "spending pays nothing");
    // The run's token is let go once the step ends.
    assert.equal((await held())[0]!.runs, 0);
  });

  it("a payment that answers pending is claimed until it settles, then held; a top-up inherits what is left", async () => {
    const first = await ask(5);
    assert.equal((await decide(first, "accept")).body.status, "applied");
    await step("remote/run-workflow").run({ url: SELLER, workflow: "cve/scan", input: { cost: 0.25 } }, ctx()); // $1 charged: $4 left
    const oldToken = (await held())[0]!.credit.tokenId as string;

    payer.outcomes.push("pending");
    const second = await ask(3, 2);
    const { body } = await decide(second, "accept");
    assert.equal(body.status, "applied", JSON.stringify(body.result));
    const out = body.result!.output as Record<string, any>;
    assert.equal(out.state, "paying");
    assert.match(out.note, /claims the credit from https:\/\/seller\.example every minute/);
    let h = (await held())[0]!;
    assert.equal(h.purchase.usd, 3);
    assert.equal(h.credit.tokenId, oldToken, "the old token is spent meanwhile");
    // Another purchase waits for this one: never two inheriting one credit.
    const third = await ask(2, 3);
    const refused = await decide(third, "accept");
    assert.equal(refused.body.status, "failed");
    assert.match(refused.body.result!.error!, /purchase_in_flight: a purchase of \$3\.00 from https:\/\/seller\.example .* is still being paid/);

    // Not settled yet: the keeper claims and keeps it.
    assert.deepEqual((await buyer.remote.check()).map((c) => c.state), ["pending"]);
    payer.settle(payer.sent[1]!);
    assert.deepEqual((await buyer.remote.check()).map((c) => c.state), ["stored"]);
    h = (await held())[0]!;
    assert.equal(h.purchase, undefined);
    assert.notEqual(h.credit.tokenId, oldToken);
    assert.equal(h.credit.carried, oldToken);
    assert.equal(h.balance.remaining_usd, 7, "$4 inherited + $3");
    assert.equal(payer.sent.length, 2, "each purchase paid once");
    // The refused proposal, accepted again now, goes.
    const again = await decide(third, "accept");
    assert.equal(again.body.status, "applied", JSON.stringify(again.body.result));
    assert.equal((await held())[0]!.balance.remaining_usd, 9);
  });

  it("a purchase still being paid when the process stops is claimed by the next one, from disk", async () => {
    payer.outcomes.push("pending");
    const id = await ask(5);
    assert.equal(((await decide(id, "accept")).body.result!.output as Record<string, any>).state, "paying");
    await buyer.close();
    payer.settle(payer.sent[0]!); // it arrives while nothing runs
    buyer = await createStrut({ workspace: new WorkspaceManager(join(dir, "buyer")), store: new MemoryRunStore(), ...quiet, remote: { http: toSeller }, payments: { rate: fixedRate, payer } });
    // The boot's own claim may have run first; either way it ends held.
    await buyer.remote.check();
    for (let i = 0; i < 200 && (await held())[0]?.purchase; i++) await new Promise((r) => setTimeout(r, 50));
    const h = (await held())[0]!;
    assert.equal(h.purchase, undefined);
    assert.equal(h.credit.usd, 5);
    assert.equal(payer.sent.length, 1, "paid once");
  });

  it("a purchase whose payment may have gone is retried with the SAME invoice, never a second", async () => {
    payer.outcomes.push(new LightningError("wallet_unavailable", "the daemon did not answer"));
    const id = await ask(4);
    const failed = await decide(id, "accept");
    assert.equal(failed.body.status, "failed");
    assert.match(failed.body.result!.error!, /payment_failed: .*wallet_unavailable/);
    assert.equal(sellerWallet.invoices().length, 1);
    assert.equal((await held())[0]!.purchase.usd, 4, "kept: it may have gone");
    // Accepted again: the same invoice, read where it stands (here: never sent, so sent now).
    const again = await decide(id, "accept");
    assert.equal(again.body.status, "applied", JSON.stringify(again.body.result));
    assert.equal((again.body.result!.output as Record<string, any>).state, "stored");
    assert.equal(sellerWallet.invoices().length, 1, "no second invoice");
    assert.deepEqual(payer.sent, [sellerWallet.invoices()[0]!.payment_hash]);
    // A refusal before anything went ends the purchase: the next accept asks anew.
    payer.outcomes.push(new LightningError("wallet_refused", "below the LSP's own fee limit", "max_fee_too_low"));
    const id2 = await ask(2, 2);
    assert.equal((await decide(id2, "accept")).body.status, "failed");
    assert.equal((await held())[0]!.purchase, undefined);
  });

  it("what the seller charged is the buyer's run's cost; a peer's run (no person) and a stranger's public run never spend; a person's credential does", async () => {
    assert.equal((await decide(await ask(10), "accept")).body.status, "applied");
    const WATCH = `name: cve-watch\npeer: true\ninput:\n  pkg: { type: string, default: lodash }\nsteps:\n  - id: scan\n    type: remote/run-workflow\n    config:\n      url: ${SELLER}\n      workflow: cve/scan\n      input:\n        cost: 0.25\n  - id: look\n    type: remote/call\n    config:\n      url: ${SELLER}\n      type: cve/lookup\n      config:\n        package: "{{ input.pkg }}"\n        cost: 0.2\n`;
    await buyer.workspace.createWorkflow("cve-watch", WATCH);
    await buyer.workspace.setWorkflowOwner("cve-watch", "ann");
    const run = await buyer.run("cve-watch", {});
    assert.equal(run.status, "success", JSON.stringify(run.error));
    const summary = (await buyer.store.getRunSummary("cve-watch", run.runId))!;
    assert.equal(Math.round(summary.totals!.cost * 100) / 100, 1.3, "$1 for the run + $0.30 for the call, the seller's charges");
    const before = launches;
    const left = ((await step("remote/list").run({ url: SELLER }, ctx())) as RemoteListing).credit.remaining_usd;
    /** A launch over HTTP, read until it ends. */
    const launchAs = async (authorization: string) => {
      const res = await buyer.app.request("/workflows/cve-watch/run", { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ input: {} }) });
      assert.equal(res.status, 202, await res.clone().text());
      const { runId } = (await res.json()) as { runId: string };
      for (let i = 0; i < 200; i++) {
        const s2 = await buyer.store.getRunSummary("cve-watch", runId);
        if (s2) return s2;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("the run never ended");
    };
    // Another strut on the peer key: refused before anything reaches the seller.
    const peerRun = await launchAs(`Bearer ${PEER}`);
    assert.equal(peerRun.status, "error");
    assert.match(JSON.stringify(peerRun.error), /spend_refused: a stranger's public run, a run another strut launched without a person's credential/);
    assert.equal(launches, before, "nothing launched at the seller");
    // A stranger's public run of it: refused the same way.
    const put = await buyer.app.request("/public-view", { method: "PUT", headers: auth, body: JSON.stringify({ runnable: [{ kind: "workflow", name: "cve-watch", dailyCapUsd: 5 }] }) });
    assert.equal(put.status, 200, await put.clone().text());
    const pub = await buyer.app.request("/public/workflows/cve-watch/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    assert.equal(pub.status, 202, await pub.clone().text());
    const { runId: pubId, token } = (await pub.json()) as { runId: string; token: string };
    const seen = (await (await buyer.app.request(`/public/workflows/cve-watch/runs/${pubId}?t=${encodeURIComponent(token)}&wait=10`)).json()) as { status: string };
    assert.equal(seen.status, "error");
    assert.match(JSON.stringify((await buyer.store.getRunSummary("cve-watch", pubId))!.error), /spend_refused/);
    assert.equal(launches, before);
    assert.equal(((await step("remote/list").run({ url: SELLER }, ctx())) as RemoteListing).credit.remaining_usd, left, "no credit spent");
    // A PERSON's credential is this strut's own person: it spends.
    const personRun = await launchAs(`Bearer ${personToken("ann")!.token}`);
    assert.equal(personRun.status, "success", JSON.stringify(personRun.error));
    assert.equal(launches, before + 1);
  });

  it("a tool that fails at the seller is charged there, and says so — never 'try again'", async () => {
    assert.equal((await decide(await ask(5), "accept")).body.status, "applied");
    await assert.rejects(step("remote/call").run({ url: SELLER, type: "cve/lookup", config: { package: "nope", fail: true } }, ctx()), (err: Error) => {
      assert.match(err.message, /^failed_charged: https:\/\/seller\.example ran a call of cve\/lookup and it failed \(step_failed: no such package nope\); it was charged its cost/);
      assert.doesNotMatch(err.message, /try again/);
      return true;
    });
  });

  it("STRUT_REMOTE_LOCAL: a seller on this machine over http is reached for real; a link-local address never is", async () => {
    const port = await seller.listen(0, "127.0.0.1");
    const local = await createStrut({ workspace: new WorkspaceManager(join(dir, "local")), store: new MemoryRunStore(), ...quiet, remote: { local: true } });
    try {
      const reg = local.getRegistry();
      const listing = (await reg["remote/list"]!.run({ url: `http://127.0.0.1:${port}` }, { ...ctx(), services: local.services, registry: reg })) as RemoteListing;
      assert.equal(listing.seller, `http://127.0.0.1:${port}`);
      assert.ok(listing.runnable.some((i) => i.name === "cve/scan"));
      await assert.rejects(reg["remote/list"]!.run({ url: "http://169.254.169.254" }, { ...ctx(), services: local.services, registry: reg }), /link-local/);
    } finally {
      await local.close();
    }
  });

  it("a resumed run reads the remote run it launched instead of launching another; a retry sends the same key", async () => {
    const id = await ask(5);
    assert.equal((await decide(id, "accept")).body.status, "applied");
    const events: RunEvent[] = [];
    const c = ctx(events);
    await step("remote/run-workflow").run({ url: SELLER, workflow: "cve/scan", input: { cost: 0.1 } }, c);
    assert.equal(launches, 1);
    const journal = events.find((e) => e.path === "cve-watch/scan#launch")!;
    assert.equal((journal.output as { runId: string }).runId.length > 0, true);
    assert.equal(JSON.stringify(journal).includes("token"), false, "no run token in the log");
    // A key the seller saw for a run in flight returns that run.
    const slow = ctx([]);
    const remote = (buyer.services as { remote: import("./remote.js").RemoteCapability }).remote;
    const h1 = await remote.launch(SELLER, "cve/scan", { input: { ms: 3000 }, key: "k-1" });
    const h2 = await remote.launch(SELLER, "cve/scan", { input: { ms: 3000 }, key: "k-1" });
    assert.equal(h2.runId, h1.runId);
    assert.equal(h2.existing, true);
    // Resumed with a journaled launch: it waits on that run, launching nothing.
    const resumed = (await step("remote/run-workflow").run({ url: SELLER, workflow: "cve/scan", input: { ms: 3000 }, key: "k-1" }, { ...slow, journal: { [`${slow.path}#launch`]: { seller: SELLER, workflow: "cve/scan", runId: h1.runId } } })) as Record<string, any>;
    assert.equal(resumed.runId, h1.runId, "waited on the journaled run");
    assert.equal(resumed.status, "success");
    assert.equal(launches, 3, "no launch on resume");
  });
});

describe("remote: a seller's challenge is checked before anything is paid", () => {
  const root = randomBytes(32);
  /** A fake seller's http: `/public/credit` answers `challenge()`, the claim `claim()`. */
  const fakeSeller = (o: { challenge: () => Record<string, unknown>; claim?: () => Record<string, unknown> }): HttpCapability =>
    httpCapability((async (url: string) => {
      const path = new URL(url).pathname;
      const json = (status: number, body: unknown) => ({ status, ok: status < 300, headers: new Headers({ "content-type": "application/json" }), text: async () => JSON.stringify(body) });
      if (path === "/public/credit") return json(402, o.challenge());
      if (path === "/public/credit/claim") return json(200, o.claim?.() ?? { state: "pending" });
      return json(404, { error: "no" });
    }) as never);
  const challenge = (o: { sats?: number; credit?: number; otherHash?: boolean; at?: number } = {}) => {
    const preimage = randomBytes(32);
    const paymentHash = createHash("sha256").update(preimage).digest("hex");
    const sats = o.sats ?? 5000;
    const { macaroon } = mintToken(root, { paymentHash: o.otherHash ? createHash("sha256").update("x").digest("hex") : paymentHash, quote: { sats, credit: o.credit ?? 5_000_000, validUntil: Math.floor(Date.now() / 1000) + 3600 } });
    return {
      preimage: preimage.toString("hex"),
      paymentHash,
      body: { error: "payment_required", usd: 5, sats, invoice: encodeBolt11({ msat: sats * 1000, paymentHash, expirySecs: 600, timestamp: Math.floor((o.at ?? Date.now()) / 1000) }), macaroon: macaroonToBase64(macaroon) },
    };
  };
  const service = (http: HttpCapability, paid: string[]) =>
    createRemote({
      store: new MemorySecretStore(),
      http,
      withdraw: async (w) => {
        paid.push(w.invoice);
        return { state: "settled", paymentHash: decodeBolt11(w.invoice).paymentHash, msat: w.msat, feeMsat: 0, maxFeeMsat: 5000 };
      },
      canPay: async () => true,
      proposal: async (id) => ({ id, step: "remote/buy-credit", status: "accepted", input: { url: SELLER, usd: 5 } }) as unknown as Proposal,
      rate: fixedRate,
    });

  it("refuses a quote over this server's rate, an invoice and macaroon that name two payments, a token that buys less than accepted", async () => {
    for (const [c, re] of [
      [challenge({ sats: 6000 }), /quote_too_high: https:\/\/seller\.example asks 6000 sats for \$5\.00; at this server's rate .* 5000 sats/],
      [challenge({ otherHash: true }), /bad_challenge: .*names another payment than its invoice/],
      [challenge({ credit: 4_000_000 }), /bad_challenge: .*would buy \$4\.00, not the \$5\.00 accepted/],
    ] as const) {
      const paid: string[] = [];
      await assert.rejects(service(fakeSeller({ challenge: () => c.body }), paid).capability.buyCredit(SELLER, 5, { proposal: "p1" }), re);
      assert.deepEqual(paid, [], "nothing paid");
    }
  });

  it("never stores a token its preimage does not prove; a proving claim stores it", async () => {
    const c = challenge();
    const paid: string[] = [];
    let claimed: Record<string, unknown> = { state: "settled", preimage: randomBytes(32).toString("hex") };
    const r = service(fakeSeller({ challenge: () => c.body, claim: () => claimed }), paid);
    const out = await r.capability.buyCredit(SELLER, 5, { proposal: "p1" });
    assert.equal(out.state, "paying", "settled with no preimage of its own, and the seller's does not prove it");
    assert.equal(paid.length, 1);
    assert.deepEqual((await r.check()).map((x) => [x.state, /does not hash/.test(x.error ?? "")]), [["unread", true]]);
    assert.equal((await r.held())[0]!.credit, undefined);
    claimed = { state: "settled", preimage: c.preimage };
    assert.deepEqual((await r.check()).map((x) => x.state), ["stored"]);
    assert.equal((await r.held())[0]!.credit!.paymentHash, c.paymentHash);
    assert.equal(paid.length, 1, "the keeper never pays");
  });

  it("a purchase sent and not confirmed is never dropped while the seller is silent, even past its invoice; only the seller's 'expired' ends it", async () => {
    let clock = Date.now();
    let c = challenge();
    let claimAnswer: (() => { status: number; body: unknown }) = () => ({ status: 200, body: { state: "pending" } });
    const http = httpCapability((async (url: string) => {
      const path = new URL(url).pathname;
      const json = (status: number, body: unknown) => ({ status, ok: status < 300, headers: new Headers({ "content-type": "application/json" }), text: async () => JSON.stringify(body) });
      if (path === "/public/credit") return json(402, c.body);
      if (path === "/public/credit/claim") {
        const a = claimAnswer();
        return json(a.status, a.body);
      }
      return json(404, {});
    }) as never);
    const paid: string[] = [];
    const r = createRemote({
      store: new MemorySecretStore(),
      http,
      withdraw: async (w) => {
        paid.push(w.invoice);
        return { state: "pending", paymentHash: decodeBolt11(w.invoice).paymentHash, msat: w.msat, feeMsat: 0, maxFeeMsat: 5000 };
      },
      canPay: async () => true,
      proposal: async (id) => ({ id, step: "remote/buy-credit", status: "accepted", input: { url: SELLER, usd: 5 } }) as unknown as Proposal,
      rate: fixedRate,
      now: () => clock,
    });
    assert.equal((await r.capability.buyCredit(SELLER, 5, { proposal: "p1" })).state, "paying");
    clock += 11 * 60_000; // past the invoice's ten minutes
    claimAnswer = () => ({ status: 500, body: { error: "down" } });
    await assert.rejects(r.capability.buyCredit(SELLER, 5, { proposal: "p1" }), /remote_unavailable: the invoice of this purchase .* has expired, and the seller has not said whether it was paid: the purchase is kept/);
    assert.equal((await r.held())[0]!.purchase!.paymentHash, decodeBolt11(paid[0]!).paymentHash, "kept");
    assert.equal(paid.length, 1);
    // The seller says it ended unpaid: the next accept buys anew.
    claimAnswer = () => ({ status: 200, body: { state: "expired" } });
    c = challenge({ at: clock });
    assert.equal((await r.capability.buyCredit(SELLER, 5, { proposal: "p1" })).state, "paying");
    assert.equal(paid.length, 2);
    assert.notEqual(paid[1], paid[0]);
  });

  /** A scripted seller: each request answered by `route`, or thrown. */
  const scripted = (route: (method: string, path: string, req: { authorization?: string; body?: string }) => { status: number; body?: unknown; headers?: Record<string, string> } | "throw") =>
    httpCapability((async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const u = new URL(url);
      const a = route(init?.method ?? "GET", u.pathname + u.search, { ...(init?.headers?.["authorization"] ? { authorization: init.headers["authorization"] } : {}), ...(init?.body ? { body: init.body } : {}) });
      if (a === "throw") throw new Error("socket hang up");
      return { status: a.status, ok: a.status < 300, headers: new Headers({ "content-type": "application/json", ...(a.headers ?? {}) }), text: async () => JSON.stringify(a.body ?? {}) };
    }) as never);
  const bare = (http: HttpCapability, extra: Partial<Parameters<typeof createRemote>[0]> = {}) =>
    createRemote({ store: new MemorySecretStore(), http, withdraw: async () => ({ state: "pending", paymentHash: "", msat: 0, feeMsat: 0, maxFeeMsat: 0 }), canPay: async () => true, proposal: async () => null, retryBaseMs: 1, ...extra });

  it("a launch turned away for a moment is tried again under the same key; a lost 202 comes back as the same run; a day's cap is not waited for", async () => {
    const keys: string[] = [];
    let n = 0;
    const r = bare(
      scripted((method, path, req) => {
        if (method !== "POST") return { status: 404 };
        keys.push((JSON.parse(req.body!) as { key: string }).key);
        n++;
        if (n === 1) return { status: 429, body: { error: "too many public runs in flight" }, headers: { "retry-after": "0" } };
        if (n === 2) return { status: 503, body: { error: "draining" }, headers: { "retry-after": "0" } };
        if (n === 3) return "throw"; // the seller launched, the 202 was lost
        return { status: 202, body: { runId: "r1", token: "t1", existing: true } };
      }),
    );
    const h = await r.capability.launch(SELLER, "cve/scan", { key: "k-9" });
    assert.deepEqual([h.runId, h.existing, n], ["r1", true, 4]);
    assert.deepEqual([...new Set(keys)], ["k-9"], "one key every try");
    let tries = 0;
    const capped = bare(scripted(() => (tries++, { status: 429, body: { error: "the day's cap is spent" }, headers: { "retry-after": "3600" } })));
    await assert.rejects(capped.capability.launch(SELLER, "cve/scan", { key: "k" }), /remote_unavailable: .*the day's cap is spent \(try again in 3600 s\)/);
    assert.equal(tries, 1, "an hour is not waited for");
  });

  it("a remote run is waited on through a seller that does not answer; only the seller not knowing it ends the wait", async () => {
    let reads = 0;
    const r = bare(
      scripted((method, path) => {
        if (method === "POST") return { status: 202, body: { runId: "r1", token: "t1" } };
        reads++;
        if (reads <= 9) return reads % 3 === 0 ? "throw" : { status: reads % 2 ? 502 : 429 };
        return { status: 200, body: { status: "success", output: { ok: 1 }, charged: 0.5 } };
      }),
    );
    const h = await r.capability.launch(SELLER, "cve/scan", { key: "k" });
    const v = await r.capability.wait(h);
    assert.deepEqual([v.status, v.charged, reads], ["success", 0.5, 10], "nine failed reads in a row, then the end");
    const gone = bare(scripted((method) => (method === "POST" ? { status: 202, body: { runId: "r2", token: "t2" } } : { status: 404, body: { error: "no such run" } })));
    await assert.rejects(gone.capability.wait(await gone.capability.launch(SELLER, "cve/scan", { key: "k" })), /run_unknown: .* \(404: no such run\)/);
  });

  it("a token replaced between the read and the request: the launch goes once more with the one now held", async () => {
    const store = new MemorySecretStore();
    const key = `ENTITLEMENT_${createHash("sha256").update(SELLER).digest("hex")}`;
    const held = (id: string) => ({ macaroon: `mac-${id}`, preimage: "00".repeat(32), tokenId: id.repeat(64).slice(0, 64), paymentHash: "ab".repeat(32), boughtAt: "", usd: 1, sats: 1000, expires: "" });
    await store.set(key, JSON.stringify({ seller: SELLER, credit: held("a") }));
    const seen: string[] = [];
    const r = bare(
      scripted((method, _path, req) => {
        seen.push(req.authorization ?? "");
        if (seen.length === 1) {
          // The keeper stores the purchase that settled: B, which carried A.
          void store.set(key, JSON.stringify({ seller: SELLER, credit: held("b") }));
          return { status: 402, body: { error: "payment_required", usd: 1, sats: 1000, reason: "replaced" } };
        }
        return { status: 202, body: { runId: "r1", token: "t1" } };
      }),
      { store },
    );
    await r.capability.launch(SELLER, "cve/scan", { key: "k" });
    assert.deepEqual(seen.map((a) => a.split(":")[0]), ["L402 mac-a", "L402 mac-b"]);
  });

  it("a call whose answer was lost may have run: never sent again, and said so", async () => {
    let calls = 0;
    const r = bare(scripted(() => (calls++, "throw")));
    await assert.rejects(r.capability.call(SELLER, "cve/lookup", {}), /may_have_run: .*it may have run and been charged — read the credit left with remote\/list/);
    assert.equal(calls, 1);
  });

  it("a purchase the seller never answers for ends when the payer says it never left, an admin may drop one, and a sent one is never dropped on a withdraw error", async () => {
    let clock = Date.now();
    const c = challenge({ at: clock });
    let claimStatus = 401;
    let withdrawAnswer: () => Promise<WithdrawAnswerLike> = async () => ({ state: "pending", paymentHash: c.paymentHash, msat: 5_000_000, feeMsat: 0, maxFeeMsat: 0 });
    let sendState: "pending" | "settled" | "gone" = "pending";
    const r = createRemote({
      store: new MemorySecretStore(),
      http: scripted((method, path) => (path === "/public/credit" ? { status: 402, body: c.body } : path === "/public/credit/claim" ? { status: claimStatus, body: { error: "invalid_token" } } : { status: 404 })),
      withdraw: () => withdrawAnswer() as never,
      canPay: async () => true,
      proposal: async (id) => ({ id, step: "remote/buy-credit", status: "accepted", input: { url: SELLER, usd: 5 } }) as unknown as Proposal,
      rate: fixedRate,
      now: () => clock,
      sendState: async () => sendState,
    });
    assert.equal((await r.capability.buyCredit(SELLER, 5, { proposal: "p1" })).state, "paying");
    // Accepted again; the payer's re-read refuses it — it went, so it stays.
    withdrawAnswer = async () => {
      throw Object.assign(new Error("wallet_refused: expired"), { code: "wallet_refused" });
    };
    await assert.rejects(r.capability.buyCredit(SELLER, 5, { proposal: "p1" }), /payment_failed/);
    assert.ok((await r.held())[0]!.purchase, "kept: it was sent before");
    // The seller refuses every claim (it rotated its root). Within the margin past the invoice: kept.
    clock += 11 * 60_000;
    assert.deepEqual((await r.check()).map((x) => x.state), ["unread"]);
    await assert.rejects(r.capability.buyCredit(SELLER, 5, { proposal: "p2" }), /purchase_in_flight: .*DELETE \/remote\/purchases\?seller=/);
    // Past it, and the payer says it settled: kept (the seller has the sats; an admin decides).
    clock += 60 * 60_000;
    sendState = "settled";
    assert.deepEqual((await r.check()).map((x) => x.state), ["unread"]);
    // The payer says it never left: ended, and the next purchase goes.
    sendState = "gone";
    assert.deepEqual((await r.check()).map((x) => x.state), ["ended"]);
    assert.equal((await r.held()).length, 0);
    // An admin's drop, for one the seller will never answer for.
    clock = Date.now();
    withdrawAnswer = async () => ({ state: "pending", paymentHash: c.paymentHash, msat: 5_000_000, feeMsat: 0, maxFeeMsat: 0 });
    assert.equal((await r.capability.buyCredit(SELLER, 5, { proposal: "p1" })).state, "paying");
    const dropped = await r.dropPurchase(SELLER);
    assert.equal(dropped.dropped!.paymentHash, c.paymentHash);
    assert.equal((dropped.dropped as Record<string, unknown>)["macaroon"], undefined);
    assert.equal((await r.held()).length, 0);
  });

  it("remote/call presents the credit held and keeps a type's slashes in the path; a 402 says the price and pays nothing", async () => {
    const c = challenge();
    const seen: Array<{ path: string; authorization?: string; body?: string }> = [];
    let price = false;
    const http = httpCapability((async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      const path = new URL(url).pathname;
      seen.push({ path, ...(init?.headers?.["authorization"] ? { authorization: init.headers["authorization"] } : {}), ...(init?.body ? { body: init.body } : {}) });
      const json = (status: number, body: unknown) => ({ status, ok: status < 300, headers: new Headers({ "content-type": "application/json" }), text: async () => JSON.stringify(body) });
      if (path === "/public/credit") return json(402, c.body);
      if (path === "/public/credit/claim") return json(200, { state: "settled", preimage: c.preimage });
      if (path === "/public/steps/cve/lookup/run") return price ? json(402, { error: "payment_required", usd: 0.3, sats: 300, reason: "short", remaining_usd: 0.1 }) : json(200, { output: { id: "CVE-1" }, credit: { charged_usd: 0.2, remaining_usd: 4.8 } });
      return json(404, { error: "no" });
    }) as never);
    const paid: string[] = [];
    const r = service(http, paid);
    await r.capability.buyCredit(SELLER, 5, { proposal: "p1" });
    const out = await r.capability.call(SELLER, "cve/lookup", { id: "lodash" });
    assert.deepEqual(out, { seller: SELLER, type: "cve/lookup", output: { id: "CVE-1" }, credit: { charged_usd: 0.2, remaining_usd: 4.8 } });
    const call = seen.find((x) => x.path === "/public/steps/cve/lookup/run")!;
    assert.match(call.authorization!, new RegExp(`^L402 ${c.body.macaroon.replace(/[+/=]/g, "\\$&")}:${c.preimage}$`));
    assert.deepEqual(JSON.parse(call.body!), { config: { id: "lodash" } });
    price = true;
    await assert.rejects(r.capability.call(SELLER, "cve/lookup", {}), /payment_required: https:\/\/seller\.example asks \$0\.30 \(300 sats\) for a call of cve\/lookup: the credit this strut server holds there is short \(\$0\.10 left\)/);
    assert.equal(paid.length, 1, "a step never pays");
  });

  it("the guard drops credentials on a redirect to another origin, and a page never calls remote/* spending steps directly", async () => {
    const got: Array<{ url: string; authorization: string | null }> = [];
    const http = guardedHttp({
      lookup: PUBLIC_IP,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const req = new Request(url, init);
        got.push({ url: req.url, authorization: req.headers.get("authorization") });
        return req.url.startsWith(SELLER) ? new Response(null, { status: 302, headers: { location: "https://elsewhere.example/x" } }) : new Response("{}", { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    await http(`${SELLER}/public/credit`, { headers: { authorization: "L402 m:p" } });
    assert.deepEqual(got.map((g) => g.authorization), ["L402 m:p", null]);
    const manifest = { title: "x", grants: { workflows: [], steps: ["remote/run-workflow", "remote/call", "remote/list"] } } as unknown as AppManifest;
    for (const t of ["remote/run-workflow", "remote/call", "remote/buy-credit"]) assert.match(grantRefusal(t, {}, manifest, {}) ?? "", /paid or shell-shaped step: a page never calls it/);
    assert.equal(grantRefusal("remote/list", {}, manifest, {}), null, "a read");
  });
});
