/**
 * Priced public runs (plans/paid-runs.md work item 5; §3 the door, §4 the
 * token, §5 the ledger's half, §7 the run's cap): the L402 challenge with
 * its locked quote, the check and a token's first use, the reserve at the
 * launch and the charge at the end, carry-over, the credit routes, `claim`
 * — against the fake wallet and a workflow whose cost the test sets.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createStrut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { defineStep, withUsage, type StepContext } from "./core.js";
import { createRegistry } from "./steps/registry.js";
import { FakeWallet } from "./payments/fake-wallet.js";
import { lightningCapability } from "./payments/lightning.js";
import { MemoryLedgerStore } from "./payments/ledger-memory.js";
import { EXPIRED_SUBJECT, usdToMicros } from "./payments/ledger.js";
import { PaymentsSettings } from "./payments/settings.js";
import { RateUnavailableError, type ExchangeRate, type Rate } from "./payments/rate.js";
import { MemorySecretStore } from "./secret-store.js";
import { publicRunsPath } from "./public-runs.js";
import { createCredit, PRICED_INVOICE_SECS } from "./public-credit.js";
import { addCaveat, macaroonFromBase64, macaroonToBase64, mintToken, readCaveats, decodeIdentifier } from "./l402.js";

const KEY = "public-priced-key";
const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const json = { "content-type": "application/json" };
const RATE = 100_000; // dollars per bitcoin: $1 is 1000 sats

/** Spends what its config says, after waiting what it says (a checkpoint
 *  every 10 ms, so a cancel lands). */
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
const boom = defineStep({
  type: "test/boom",
  input: z.object({}).passthrough(),
  output: z.any(),
  async run() {
    throw new Error("boom");
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
    return { opened: s.id };
  },
});

const INPUT = "input:\n  cost: { type: number, default: 0 }\n  ms: { type: number, default: 0 }\n";
const spendYaml = (name: string) => `name: ${name}\n${INPUT}steps:\n  - id: s\n    type: test/spend\n    config:\n      cost: "{{ input.cost }}"\n      ms: "{{ input.ms }}"\n`;
const WORKFLOWS: Record<string, string> = {
  fixed: spendYaml("fixed"),
  metered: spendYaml("metered"),
  both: spendYaml("both"),
  other: spendYaml("other"),
  failing: `name: failing\n${INPUT}steps:\n  - id: s\n    type: test/spend\n    config:\n      cost: "{{ input.cost }}"\n  - id: b\n    type: test/boom\n    config: {}\n`,
  cancelling: `name: cancelling\n${INPUT}steps:\n  - id: s\n    type: test/spend\n    config:\n      cost: "{{ input.cost }}"\n  - id: w\n    type: test/spend\n    config:\n      ms: "{{ input.ms }}"\n`,
  sessions: `name: sessions\ninput:\n  session: { type: string }\nsteps:\n  - id: s\n    type: test/session\n    config:\n      id: "{{ input.session }}"\n`,
  two: `name: two\n${INPUT}steps:\n  - id: a\n    type: test/spend\n    config:\n      cost: 1.5\n  - id: b\n    type: test/spend\n    config:\n      cost: 0.5\n`,
};

interface Challenge402 {
  error: string;
  usd: number;
  sats: number;
  rate: ExchangeRate;
  invoice: string;
  macaroon: string;
  description: string;
  expires: string;
  remaining_usd: number;
  reason?: string;
  carries?: boolean;
}

const fixedRate = async (): Promise<ExchangeRate> => ({ usdPerBtc: RATE, at: new Date().toISOString(), source: "test" });

describe("priced public runs", () => {
  let dir: string;
  let savedKey: string | undefined;
  const open: Array<{ close(): Promise<void> }> = [];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-public-priced-"));
    savedKey = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = KEY;
  });
  afterEach(async () => {
    for (const s of open.splice(0)) await s.close();
    if (savedKey === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = savedKey;
    await rm(dir, { recursive: true, force: true });
  });

  const boot = async (o: { runnable: unknown[]; maxInFlight?: number; wallet?: FakeWallet }) => {
    const wallet = o.wallet ?? new FakeWallet();
    const strut = await createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")),
      store: new MemoryRunStore(),
      serveUi: false,
      scheduler: false,
      registry: await createRegistry([spend, boom, session]),
      services: { lightning: lightningCapability(wallet) },
      payments: { rate: fixedRate },
      publicRuns: { ...(o.maxInFlight ? { maxInFlight: o.maxInFlight } : {}) },
    });
    open.push(strut);
    for (const [name, yaml] of Object.entries(WORKFLOWS)) {
      await strut.workspace.createWorkflow(name, yaml);
      await strut.workspace.setWorkflowOwner(name, "owner-1");
    }
    const put = await strut.app.request("/public-view", { method: "PUT", headers: auth, body: JSON.stringify({ runnable: o.runnable }) });
    assert.equal(put.status, 200, await put.clone().text());
    const launch = (name: string, body: unknown = {}, credential?: string, scheme = "L402") =>
      strut.app.request(`/public/workflows/${encodeURIComponent(name)}/run`, {
        method: "POST",
        headers: { ...json, ...(credential ? { authorization: `${scheme} ${credential}` } : {}) },
        body: JSON.stringify(body),
      });
    const launched = async (name: string, body: unknown, credential: string) => {
      const res = await launch(name, body, credential);
      assert.equal(res.status, 202, await res.clone().text());
      return (await res.json()) as { runId: string; token: string; existing?: boolean; credit?: Record<string, unknown> };
    };
    const challenged = async (res: Response) => {
      assert.equal(res.status, 402, await res.clone().text());
      return (await res.json()) as Challenge402;
    };
    /** Pay a challenge: the credential `<macaroon>:<preimage>`. */
    const pay = (c: Challenge402, o: { msat?: number } = {}) => `${c.macaroon}:${wallet.settle(c.invoice, o)}`;
    /** Buy `usd` of credit through `POST /public/credit` and pay it. */
    const buy = async (usd: number, from?: string) => {
      const res = await strut.app.request("/public/credit", { method: "POST", headers: { ...json, ...(from ? { authorization: `L402 ${from}` } : {}) }, body: JSON.stringify({ usd }) });
      return pay(await challenged(res));
    };
    const credit = async (credential: string) => {
      const res = await strut.app.request("/public/credit", { headers: { authorization: `L402 ${credential}` } });
      assert.equal(res.status, 200, await res.clone().text());
      return (await res.json()) as Record<string, any>;
    };
    const ended = async (name: string, runId: string, token: string) => {
      const res = await strut.app.request(`/public/workflows/${encodeURIComponent(name)}/runs/${runId}?t=${encodeURIComponent(token)}&wait=10`);
      assert.equal(res.status, 200, await res.clone().text());
      return (await res.json()) as Record<string, any>;
    };
    const run = async (name: string, input: Record<string, unknown>, credential: string) => {
      const r = await launched(name, { input }, credential);
      return ended(name, r.runId, r.token);
    };
    return { strut, wallet, launch, launched, challenged, pay, buy, credit, ended, run };
  };

  it("no token is a 402 with an L402 challenge whose usd, sats and rate agree; paid, the retry runs and its end charges the base", async () => {
    const { strut, wallet, launch, launched, challenged, pay, credit, ended } = await boot({ runnable: [{ kind: "workflow", name: "fixed", base: 0.5 }] });
    const res = await launch("fixed", { input: { cost: 2 } });
    const header = res.headers.get("www-authenticate") ?? "";
    const c = await challenged(res);
    const m = /^L402 macaroon="([^"]+)", invoice="([^"]+)"$/.exec(header);
    assert.ok(m, header);
    assert.equal(m[1], c.macaroon);
    assert.equal(m[2], c.invoice);
    assert.equal(c.error, "payment_required");
    assert.equal(c.usd, 0.5);
    assert.equal(c.sats, 500, "$0.50 at $100,000 a bitcoin");
    assert.equal(c.rate.usdPerBtc, RATE);
    assert.equal(c.remaining_usd, 0);
    assert.equal(c.description, "fixed: credit for one run");
    assert.equal(c.carries, undefined);
    const lasts = Date.parse(c.expires) - Date.now();
    assert.ok(lasts > 590_000 && lasts <= 600_000, `a priced invoice lasts ten minutes: ${lasts}`);
    const made = wallet.calls.find((x) => x.method === "makeInvoice")!.arg as { msat: number; expirySecs: number };
    assert.deepEqual({ msat: made.msat, expirySecs: made.expirySecs }, { msat: 500_000, expirySecs: PRICED_INVOICE_SECS });
    // The quote is locked into the macaroon, and nothing is stored for a challenge.
    const caveats = macaroonFromBase64(c.macaroon).caveats.map((x) => x.id.toString());
    assert.deepEqual(caveats.slice(0, 3), ["services=strut:0", "strut_sats=500", "strut_credit=500000"]);
    assert.equal(caveats[4], "strut_carry=none");
    assert.deepEqual(await (await strut.ledger()).scan(), []);

    const cred = pay(c);
    const r = await launched("fixed", { input: { cost: 2 } }, cred);
    assert.deepEqual(r.credit, { held_usd: 0.5, remaining_usd: 0, remaining_sats: 0, expires: r.credit!["expires"] });
    const view = await ended("fixed", r.runId, r.token);
    assert.equal(view.status, "success");
    assert.equal(view.charged, 0.5, "the base, whatever the run cost");
    assert.equal(view.totals.cost, 2);
    assert.equal(view.credit, undefined, "the token's id is never shown on a run");
    const tokenId = decodeIdentifier(macaroonFromBase64(c.macaroon).id).tokenId;
    const start = (await strut.store.getRunEvents("fixed", r.runId)).find((e) => e.type === "run.start")!;
    assert.equal(start.credit, tokenId, "run.start names the token that paid");
    const bal = await credit(cred);
    assert.deepEqual(
      { paid: bal.paid_usd, spent: bal.spent_usd, held: bal.held_usd, remaining: bal.remaining_usd, bought: bal.bought_sats, rate: bal.rate, expired: bal.expired, replaced: bal.replaced },
      { paid: 0.5, spent: 0.5, held: 0, remaining: 0, bought: 500, rate: RATE, expired: false, replaced: false },
    );
    assert.deepEqual(bal.entries.map((e: { kind: string }) => e.kind), ["charge", "hold", "payment"]);
    assert.ok(Date.parse(bal.expires) - Date.now() > 364 * 86_400_000, "credit lasts a year");
    // Spent: the next launch is a 402 for the whole reserve again, carrying the (empty) token.
    const again = await challenged(await launch("fixed", { input: {} }, cred));
    assert.equal(again.usd, 0.5);
    assert.equal(again.reason, "short");
    assert.equal(again.carries, true);
  });

  it("the pricing rule: base alone, markup alone, both; a failed run its cost and no more than the reserve; a cancelled one by the rule", async () => {
    const { strut, buy, credit, run, launched, ended } = await boot({
      runnable: [
        { kind: "workflow", name: "fixed", base: 0.5 },
        { kind: "workflow", name: "metered", markup: 1.5, capUsd: 4 },
        { kind: "workflow", name: "both", base: 0.1, markup: 1.2, capUsd: 5 },
        { kind: "workflow", name: "failing", base: 1, markup: 2, capUsd: 3 },
        { kind: "workflow", name: "cancelling", base: 0.5, markup: 1, capUsd: 5 },
      ],
    });
    const cred = await buy(50);
    assert.equal((await run("fixed", { cost: 2 }, cred)).charged, 0.5, "base alone");
    assert.equal((await run("metered", { cost: 2 }, cred)).charged, 3, "markup alone");
    assert.equal((await run("both", { cost: 2 }, cred)).charged, 2.5, "both: 0.10 + 1.2 × 2");
    const failed = await run("failing", { cost: 2 }, cred);
    assert.equal(failed.status, "error");
    assert.equal(failed.charged, 2, "a failed run: its cost, no markup, no base");
    assert.equal((await run("failing", { cost: 10 }, cred)).charged, 7, "and never more than its reserve (1 + 2 × 3)");
    const r = await launched("cancelling", { input: { cost: 1, ms: 5000 } }, cred);
    while (!(await strut.store.getRunEvents("cancelling", r.runId)).some((e) => e.type === "step.end")) await new Promise((x) => setTimeout(x, 10));
    const cancel = await strut.app.request(`/public/workflows/cancelling/runs/${r.runId}/cancel`, { method: "POST", headers: { authorization: `Bearer ${r.token}` } });
    assert.equal(cancel.status, 202);
    const cancelled = await ended("cancelling", r.runId, r.token);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.charged, 1.5, "a cancelled run by the rule: 0.50 + 1 × 1");
    const bal = await credit(cred);
    assert.equal(bal.spent_usd, 0.5 + 3 + 2.5 + 2 + 7 + 1.5);
    assert.equal(bal.held_usd, 0);
    assert.equal(bal.remaining_usd, 50 - 16.5);
    const ledger = await strut.ledger();
    assert.deepEqual(await ledger.today("workflow:failing"), { key: "workflow:failing", calls: 2, failed: 2, earned: usdToMicros(9), cost: usdToMicros(12) });
  });

  it("a token one cent short is a 402 for the shortfall; the top-up inherits; what a charge did not use is free again; the old token is refused", async () => {
    const { launch, launched, challenged, pay, buy, credit, ended } = await boot({ runnable: [{ kind: "workflow", name: "metered", markup: 1, capUsd: 1 }] });
    const a = await buy(0.99);
    const short = await challenged(await launch("metered", { input: { cost: 0.25 } }, a));
    assert.deepEqual({ usd: short.usd, sats: short.sats, remaining: short.remaining_usd, reason: short.reason, carries: short.carries }, { usd: 0.01, sats: 10, remaining: 0.99, reason: "short", carries: true });
    const b = pay(short);
    const r = await launched("metered", { input: { cost: 0.25 } }, b);
    assert.equal(r.credit!["remaining_usd"], 0, "0.99 carried + 0.01 paid, all set aside");
    assert.equal((await ended("metered", r.runId, r.token)).charged, 0.25);
    assert.equal((await credit(b)).remaining_usd, 0.75, "what the charge did not use is free again");
    // A presented again: its credit moved on.
    const old = await challenged(await launch("metered", { input: {} }, a));
    assert.deepEqual({ usd: old.usd, reason: old.reason, carries: old.carries, remaining: old.remaining_usd }, { usd: 1, reason: "replaced", carries: undefined, remaining: 0 });
    const av = await credit(a);
    assert.equal(av.replaced, true);
    assert.equal(av.remaining_usd, 0);
    const bv = await credit(b);
    assert.equal(bv.paid_usd, 1);
    assert.ok(bv.entries.some((e: { kind: string; usd: number }) => e.kind === "carry" && e.usd === 0.99));
  });

  it("twenty launches at once on a token that covers three reserves: three run, seventeen are 402, and the token is never overdrawn", async () => {
    const { strut, launch, buy, credit, ended } = await boot({ runnable: [{ kind: "workflow", name: "fixed", base: 1 }], maxInFlight: 50 });
    const cred = await buy(3);
    const answers = await Promise.all(Array.from({ length: 20 }, () => launch("fixed", { input: { ms: 200 } }, cred)));
    const ok = answers.filter((r) => r.status === 202);
    assert.equal(ok.length, 3, answers.map((r) => r.status).join(","));
    assert.equal(answers.filter((r) => r.status === 402).length, 17);
    const held = await credit(cred);
    assert.equal(held.held_usd, 3);
    assert.equal(held.remaining_usd, 0);
    for (const r of (await Promise.all(ok.map((x) => x.json()))) as Array<{ runId: string; token: string }>) await ended("fixed", r.runId, r.token);
    const bal = await credit(cred);
    assert.deepEqual({ spent: bal.spent_usd, held: bal.held_usd, remaining: bal.remaining_usd }, { spent: 3, held: 0, remaining: 0 });
    assert.equal((await (await strut.ledger()).today("workflow:fixed")).calls, 3);
  });

  it("carry-over with a run still in flight on the first token: the second inherits its free credit, and what the first's run frees later reaches the second", async () => {
    const { strut, launch, launched, challenged, pay, buy, credit, ended } = await boot({ runnable: [{ kind: "workflow", name: "metered", markup: 1, capUsd: 2 }] });
    const a = await buy(3);
    const r1 = await launched("metered", { input: { cost: 0.5, ms: 400 } }, a);
    const top = await challenged(await launch("metered", { input: {} }, a));
    assert.deepEqual({ usd: top.usd, remaining: top.remaining_usd, carries: top.carries }, { usd: 1, remaining: 1, carries: true });
    const b = pay(top);
    const r2 = await launched("metered", { input: {} }, b);
    assert.equal(r2.credit!["remaining_usd"], 0, "1 paid + 1 inherited, 2 set aside");
    assert.equal((await ended("metered", r1.runId, r1.token)).charged, 0.5);
    assert.equal((await ended("metered", r2.runId, r2.token)).charged, 0);
    const bv = await credit(b);
    assert.deepEqual({ paid: bv.paid_usd, spent: bv.spent_usd, remaining: bv.remaining_usd }, { paid: 3.5, spent: 0, remaining: 3.5 });
    assert.equal(bv.entries.filter((e: { kind: string }) => e.kind === "carry").length, 2, "inherited at its first use, and again when the first token's run ended");
    assert.equal((await challenged(await launch("metered", { input: {} }, a))).reason, "replaced");
    assert.equal((await (await strut.ledger()).outstanding()).usd, usdToMicros(3.5), "nothing lost, nothing made");
  });

  it("a narrowed token is checked against its caveats and never carried from", async () => {
    const { launch, launched, challenged, pay, buy, credit, ended } = await boot({
      runnable: [
        { kind: "workflow", name: "fixed", base: 1 },
        { kind: "workflow", name: "other", base: 1 },
      ],
    });
    const a = await buy(1.5);
    const [mac, preimage] = a.split(":") as [string, string];
    const narrow = (...caveats: string[]) => `${macaroonToBase64(caveats.reduce((m, c) => addCaveat(m, c), macaroonFromBase64(mac)))}:${preimage}`;
    const onlyFixed = narrow("strut_capabilities=workflow:fixed", "strut_max_charge=5000000");
    const notThis = await launch("other", { input: {} }, onlyFixed);
    assert.equal(notThis.status, 403);
    assert.equal(((await notThis.json()) as { code: string }).code, "token_not_for_this");
    const capped = await launch("fixed", { input: {} }, narrow("strut_max_charge=500000"));
    assert.equal(capped.status, 403);
    assert.equal(((await capped.json()) as { code: string }).code, "token_over_max_charge");
    const r = await launched("fixed", { input: {} }, onlyFixed);
    await ended("fixed", r.runId, r.token);
    // 0.50 left: the narrowed copy's top-up is for the whole reserve, carrying nothing.
    const top = await challenged(await launch("fixed", { input: {} }, onlyFixed));
    assert.deepEqual({ usd: top.usd, remaining: top.remaining_usd, carries: top.carries, reason: top.reason }, { usd: 1, remaining: 0.5, carries: undefined, reason: "short" });
    assert.equal(readCaveats(macaroonFromBase64(top.macaroon).caveats).quote.carry, undefined);
    const b = pay(top);
    await ended("fixed", ...(Object.values(await launched("fixed", { input: {} }, b)).slice(0, 2) as [string, string]));
    const av = await credit(a);
    assert.deepEqual({ replaced: av.replaced, remaining: av.remaining_usd }, { replaced: false, remaining: 0.5 }, "the parent keeps its balance");
    // The un-narrowed token presented short is carried from.
    const plain = await challenged(await launch("fixed", { input: {} }, a));
    assert.deepEqual({ usd: plain.usd, carries: plain.carries }, { usd: 0.5, carries: true });
  });

  it("a payment that settled short is credited in proportion", async () => {
    const { strut, challenged, pay, credit } = await boot({ runnable: [{ kind: "workflow", name: "fixed", base: 1 }] });
    const c = await challenged(await strut.app.request("/public/credit", { method: "POST", headers: json, body: JSON.stringify({ usd: 2 }) }));
    assert.equal(c.sats, 2000);
    const cred = pay(c, { msat: 1_000_000 });
    const bal = await credit(cred);
    assert.deepEqual({ paid: bal.paid_usd, bought: bal.bought_sats }, { paid: 1, bought: 1000 });
    // Bought in sats: the credit is what they buy at the rate now.
    const s = await challenged(await strut.app.request("/public/credit", { method: "POST", headers: json, body: JSON.stringify({ sats: 2500 }) }));
    assert.deepEqual({ usd: s.usd, sats: s.sats }, { usd: 2.5, sats: 2500 });
    for (const body of [{}, { usd: 0 }, { usd: 5000 }, { usd: 1, sats: 1 }, { sats: 1.5 }, { dollars: 1 }]) {
      assert.equal((await strut.app.request("/public/credit", { method: "POST", headers: json, body: JSON.stringify(body) })).status, 400, JSON.stringify(body));
    }
  });

  it("a token past its year is refused, and the sweep earns what was left", async () => {
    const { strut, wallet, launch, run, challenged, buy, credit } = await boot({ runnable: [{ kind: "workflow", name: "fixed", base: 1 }] });
    const cred = await buy(3);
    assert.equal((await run("fixed", {}, cred)).charged, 1);
    const ledger = await strut.ledger();
    const swept = await ledger.sweep({ now: Date.now() + 400 * 86_400_000 });
    assert.deepEqual(swept, { closed: 1, expired: usdToMicros(2) });
    const refused = await challenged(await launch("fixed", { input: {} }, cred));
    assert.deepEqual({ usd: refused.usd, reason: refused.reason, carries: refused.carries }, { usd: 1, reason: "expired", carries: undefined });
    const bal = await credit(cred);
    assert.deepEqual({ expired: bal.expired, remaining: bal.remaining_usd }, { expired: true, remaining: 0 });
    assert.equal((await ledger.earnings({ by: "item" })).find((r) => r.key === EXPIRED_SUBJECT)?.earned, usdToMicros(2));
    // A macaroon whose own end passed is refused before the wallet is asked.
    const root = (await strut.payments.settings.l402Root())!;
    const inv = await lightningCapability(wallet).makeInvoice({ msat: 1_000_000 });
    const preimage = wallet.settle(inv.invoice);
    const { macaroon } = mintToken(root, { paymentHash: inv.payment_hash, quote: { sats: 1000, credit: 1_000_000, validUntil: Math.floor(Date.now() / 1000) - 1 } });
    const lookups = wallet.calls.filter((x) => x.method === "lookup").length;
    const late = await challenged(await launch("fixed", { input: {} }, `${macaroonToBase64(macaroon)}:${preimage}`));
    assert.equal(late.reason, "expired");
    assert.equal(wallet.calls.filter((x) => x.method === "lookup").length, lookups);
  });

  it("a forged, tampered or unknown-caveat token is refused, and so is a wrong preimage; LSAT is the scheme's old name", async () => {
    const { strut, wallet, launch, launched, buy, ended } = await boot({ runnable: [{ kind: "workflow", name: "fixed", base: 1 }] });
    const cred = await buy(5);
    const [mac, preimage] = cred.split(":") as [string, string];
    const m = macaroonFromBase64(mac);
    const forgedMac = mintToken(randomBytes(32), { paymentHash: decodeIdentifier(m.id).paymentHash, quote: { sats: 99_000, credit: 99_000_000, validUntil: 2_000_000_000 } }).macaroon;
    const tampered = { ...m, caveats: m.caveats.map((c, i) => (i === 2 ? { id: Buffer.from("strut_credit=99000000") } : c)) };
    const cases: Array<[string, string]> = [
      ["forged", `${macaroonToBase64(forgedMac)}:${preimage}`],
      ["tampered", `${macaroonToBase64(tampered)}:${preimage}`],
      ["unknown caveat", `${macaroonToBase64(addCaveat(m, "strut_budget=1"))}:${preimage}`],
      ["wrong preimage", `${mac}:${randomBytes(32).toString("hex")}`],
      ["no preimage", mac],
      ["not base64", `!!!:${preimage}`],
    ];
    for (const [name, credential] of cases) {
      const res = await launch("fixed", { input: {} }, credential);
      assert.equal(res.status, 401, name);
      assert.equal(((await res.json()) as { code: string }).code, "invalid_token", name);
      assert.equal(res.headers.get("www-authenticate"), 'L402 error="invalid_token"', name);
    }
    assert.equal((await strut.app.request("/public/credit", { headers: { authorization: `L402 ${macaroonToBase64(forgedMac)}:${preimage}` } })).status, 401);
    assert.equal(wallet.calls.filter((x) => x.method === "lookup").length, 0, "no refused token reaches the wallet");
    const r = await launched("fixed", { input: {} }, cred);
    await ended("fixed", r.runId, r.token);
    const lsat = await launch("fixed", { input: {} }, cred, "LSAT");
    assert.equal(lsat.status, 202);
    const l = (await lsat.json()) as { runId: string; token: string };
    await ended("fixed", l.runId, l.token);
  });

  it("claim: pending until the wallet settles, then the preimage, which works as a credential; an invoice that expired is expired", async () => {
    const { strut, wallet, launch, launched, challenged, ended } = await boot({ runnable: [{ kind: "workflow", name: "fixed", base: 1 }] });
    const claim = (body: unknown, headers: Record<string, string> = {}) =>
      strut.app.request("/public/credit/claim", { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(body) });
    const c = await challenged(await launch("fixed", { input: {} }));
    assert.deepEqual(await (await claim({ macaroon: c.macaroon })).json(), { state: "pending" });
    assert.deepEqual(await (await claim({}, { authorization: `L402 ${c.macaroon}` })).json(), { state: "pending" });
    const preimage = wallet.settle(c.invoice);
    const settled = (await (await claim({ macaroon: c.macaroon })).json()) as Record<string, unknown>;
    assert.deepEqual(settled, { state: "settled", preimage, credential: `${c.macaroon}:${preimage}`, msat: 1_000_000 });
    // The claim recorded the token's first use: the launch asks the wallet nothing.
    const lookups = wallet.calls.filter((x) => x.method === "lookup").length;
    const r = await launched("fixed", { input: {} }, settled["credential"] as string);
    await ended("fixed", r.runId, r.token);
    assert.equal(wallet.calls.filter((x) => x.method === "lookup").length, lookups);
    const late = await challenged(await launch("fixed", { input: {} }));
    wallet.expire(late.invoice);
    assert.deepEqual(await (await claim({ macaroon: late.macaroon })).json(), { state: "expired" });
    const forged = mintToken(randomBytes(32), { paymentHash: randomBytes(32).toString("hex"), quote: { sats: 1, credit: 1, validUntil: 2_000_000_000 } }).macaroon;
    assert.equal((await claim({ macaroon: macaroonToBase64(forged) })).status, 401);
    assert.equal((await claim({})).status, 400);
  });

  it("a wallet that cannot be reached is 503, never 402; a token already used still runs", async () => {
    const { strut, wallet, launch, launched, buy, credit, ended } = await boot({ runnable: [{ kind: "workflow", name: "fixed", base: 1 }] });
    const used = await buy(2);
    await credit(used); // its first use
    const unused = await buy(2);
    wallet.down();
    const none = await launch("fixed", { input: {} });
    assert.equal(none.status, 503);
    assert.equal(((await none.json()) as { code: string }).code, "wallet_unavailable");
    assert.ok(Number(none.headers.get("retry-after")) > 0);
    const first = await launch("fixed", { input: {} }, unused);
    assert.equal(first.status, 503, "a first use needs the wallet");
    assert.equal((await strut.app.request("/public/credit", { method: "POST", headers: json, body: JSON.stringify({ usd: 1 }) })).status, 503);
    const r = await launched("fixed", { input: {} }, used);
    assert.equal((await ended("fixed", r.runId, r.token)).charged, 1);
    wallet.down(false);
    const back = await launch("fixed", { input: {} }, unused);
    assert.equal(back.status, 202, "and once it is back, the token's first use");
    const b = (await back.json()) as { runId: string; token: string };
    await ended("fixed", b.runId, b.token);
  });

  it("the same token and key return one run and set aside one reserve, in flight and after it ended", async () => {
    const { launched, buy, credit, ended } = await boot({ runnable: [{ kind: "workflow", name: "fixed", base: 1 }] });
    const cred = await buy(3);
    const first = await launched("fixed", { input: { ms: 300 }, key: "k1" }, cred);
    const again = await launched("fixed", { input: { ms: 300 }, key: "k1" }, cred);
    assert.equal(again.runId, first.runId);
    assert.equal(again.existing, true);
    assert.equal((await credit(cred)).held_usd, 1);
    assert.equal((await ended("fixed", first.runId, first.token)).charged, 1);
    const later = await launched("fixed", { input: {}, key: "k1" }, cred);
    assert.deepEqual({ runId: later.runId, existing: later.existing }, { runId: first.runId, existing: true });
    const bal = await credit(cred);
    assert.deepEqual({ spent: bal.spent_usd, held: bal.held_usd }, { spent: 1, held: 0 });
    // Another key is another run.
    const other = await launched("fixed", { input: {}, key: "k2" }, cred);
    assert.notEqual(other.runId, first.runId);
    await ended("fixed", other.runId, other.token);
  });

  it("a paid run's sessions open under public/<token id>/", async () => {
    const { buy, run } = await boot({ runnable: [{ kind: "workflow", name: "sessions", base: 0.5, results: "run" }] });
    const cred = await buy(1);
    const tokenId = decodeIdentifier(macaroonFromBase64(cred.split(":")[0]!).id).tokenId;
    const view = await run("sessions", { session: "tom/abc" }, cred);
    assert.equal(view.output.opened, `public/${tokenId}/tom/abc`);
  });

  it("selling credit needs a priced item; a server that never priced anything answers none of the credit routes", async () => {
    const free = await boot({ runnable: [{ kind: "workflow", name: "fixed", dailyCapUsd: 5 }] });
    assert.equal((await free.strut.app.request("/public/credit", { method: "POST", headers: json, body: JSON.stringify({ usd: 1 }) })).status, 404);
    assert.equal((await free.strut.app.request("/public/credit", { headers: { authorization: "L402 x:y" } })).status, 404);
    assert.equal((await free.strut.app.request("/public/credit/claim", { method: "POST", headers: json, body: "{}" })).status, 404);
    assert.equal(await free.strut.payments.settings.l402Root(), null, "no root minted for a free item");
    // The first priced item saved mints it.
    const put = await free.strut.app.request("/public-view", { method: "PUT", headers: auth, body: JSON.stringify({ runnable: [{ kind: "workflow", name: "fixed", base: 1 }] }) });
    assert.equal(put.status, 200);
    const root = await free.strut.payments.settings.l402Root();
    assert.equal(root?.length, 32);
    await free.strut.app.request("/public-view", { method: "PUT", headers: auth, body: JSON.stringify({ runnable: [{ kind: "workflow", name: "other", base: 2 }] }) });
    assert.deepEqual(await free.strut.payments.settings.l402Root(), root, "never replaced");
  });
});

describe("credit, the service", () => {
  const readings: ExchangeRate[] = [];
  let rateDown = false;
  const rate: Rate = {
    read: async () => {
      if (rateDown) throw new RateUnavailableError("the source is down and the last reading is over 10 minutes old");
      return readings.at(-1)!;
    },
    last: () => null,
  };
  const setup = () => {
    readings.length = 0;
    readings.push({ usdPerBtc: RATE, at: new Date().toISOString(), source: "test" });
    rateDown = false;
    const wallet = new FakeWallet();
    const ledger = new MemoryLedgerStore();
    const settings = new PaymentsSettings(new MemorySecretStore());
    const credit = createCredit({ ledger: async () => ledger, settings, rate, lightning: () => lightningCapability(wallet), invoicesPerMinute: 3 });
    return { wallet, ledger, settings, credit };
  };

  it("the credit written is the macaroon's strut_credit whatever the rate is by then; the wallet is asked once per token", async () => {
    const { wallet, ledger, credit } = setup();
    const ch = await credit.challenge({ usd: usdToMicros(7.5), description: "x", address: "a" });
    assert.ok(ch.ok);
    assert.deepEqual({ usd: ch.body.usd, sats: ch.body.sats }, { usd: 7.5, sats: 7500 });
    readings.push({ usdPerBtc: 10, at: new Date().toISOString(), source: "test" });
    const preimage = wallet.settle(ch.body.invoice);
    const p = { macaroon: ch.body.macaroon, preimage };
    const all = await Promise.all(Array.from({ length: 5 }, () => credit.check(p)));
    assert.ok(all.every((r) => r.ok));
    assert.equal(all.filter((r) => r.ok && r.created).length, 1);
    assert.equal(wallet.calls.filter((x) => x.method === "lookup").length, 1, "asked once, five requests at once");
    await credit.check(p);
    assert.equal(wallet.calls.filter((x) => x.method === "lookup").length, 1, "and never again");
    const t = (await ledger.token(decodeIdentifier(macaroonFromBase64(ch.body.macaroon).id).tokenId))!;
    assert.equal(t.paid, usdToMicros(7.5));
    assert.equal(t.rate, RATE, "the token keeps the rate it was bought at");
  });

  it("a rate that cannot be read is 503 for a challenge, and a token already bought is untouched", async () => {
    const { wallet, credit } = setup();
    const ch = await credit.challenge({ usd: usdToMicros(1), description: "x", address: "a" });
    assert.ok(ch.ok);
    const p = { macaroon: ch.body.macaroon, preimage: wallet.settle(ch.body.invoice) };
    rateDown = true;
    const refused = await credit.challenge({ usd: usdToMicros(1), description: "x", address: "a" });
    assert.ok(!refused.ok);
    assert.deepEqual({ status: refused.status, code: refused.code }, { status: 503, code: "rate_unavailable" });
    const used = await credit.check(p);
    assert.ok(used.ok && used.balance.free === usdToMicros(1));
  });

  it("a payment the wallet has not settled is 503 payment_pending; an invoice that expired unpaid is no token", async () => {
    const { wallet, credit, settings } = setup();
    const root = await settings.ensureL402Root();
    const inv = await lightningCapability(wallet).makeInvoice({ msat: 1000 });
    const preimage = wallet.invoices().find((i) => i.payment_hash === inv.payment_hash)!.preimage;
    const { macaroon } = mintToken(root, { paymentHash: inv.payment_hash, quote: { sats: 1, credit: 1000, validUntil: 2_000_000_000 } });
    const p = { macaroon: macaroonToBase64(macaroon), preimage };
    const pending = await credit.check(p);
    assert.ok(!pending.ok && pending.status === 503 && pending.code === "payment_pending");
    wallet.expire(inv.payment_hash);
    const gone = await credit.check(p);
    assert.ok(!gone.ok && gone.status === 401 && gone.code === "invalid_token");
  });

  it("invoices have their own per-address allowance", async () => {
    const { credit } = setup();
    for (let i = 0; i < 3; i++) assert.ok((await credit.challenge({ usd: 1000, description: "x", address: "a" })).ok);
    const over = await credit.challenge({ usd: 1000, description: "x", address: "a" });
    assert.ok(!over.ok && over.status === 429 && over.code === "too_many_invoices");
    assert.ok((await credit.challenge({ usd: 1000, description: "x", address: "b" })).ok, "another address has its own");
  });
});

describe("priced public runs across a restart", () => {
  const PRICED = { kind: "workflow", name: "two", base: 0.5, markup: 1, capUsd: 4 };
  const registryP = createRegistry([spend, boom, session]);
  const until = async (fn: () => Promise<boolean>, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!(await fn())) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  const firstBoot = async (ws: string, wallet: FakeWallet) => {
    const strut = await createStrut({
      workspace: new WorkspaceManager(ws),
      serveUi: false,
      scheduler: false,
      registry: await registryP,
      autoResume: false,
      services: { lightning: lightningCapability(wallet) },
      payments: { rate: fixedRate },
    });
    await strut.workspace.createWorkflow("two", WORKFLOWS["two"]!);
    await strut.workspace.setWorkflowOwner("two", "owner-1");
    assert.equal((await strut.app.request("/public-view", { method: "PUT", body: JSON.stringify({ runnable: [PRICED] }), headers: json })).status, 200);
    const res = await strut.app.request("/public/credit", { method: "POST", headers: json, body: JSON.stringify({ usd: 10 }) });
    const c = (await res.json()) as Challenge402;
    const cred = `${c.macaroon}:${wallet.settle(c.invoice)}`;
    assert.equal((await strut.app.request("/public/credit", { headers: { authorization: `L402 ${cred}` } })).status, 200, "its first use");
    return { strut, cred, tokenId: decodeIdentifier(macaroonFromBase64(c.macaroon).id).tokenId };
  };
  const nextBoot = async (ws: string, wallet: FakeWallet) =>
    createStrut({
      workspace: new WorkspaceManager(ws),
      serveUi: false,
      scheduler: false,
      registry: await registryP,
      autoResume: { delayMs: 0 },
      services: { lightning: lightningCapability(wallet) },
      payments: { rate: fixedRate },
    });

  it("a paid run cut off by a restart is resumed and charged once against its token, at its launch's price", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-public-priced-resume-"));
    const saved = process.env["STRUT_API_KEY"];
    delete process.env["STRUT_API_KEY"];
    try {
      const ws = join(dir, "ws");
      const wallet = new FakeWallet();
      const { strut: first, tokenId } = await firstBoot(ws, wallet);
      const runId = "1800000000001";
      const reserve = usdToMicros(4.5);
      // What a dead process left: on file with its token and price, the
      // reserve held, `run.start` naming the token, step a's end, no end.
      await writeFile(publicRunsPath(ws), JSON.stringify([{ workflow: "two", runId, subject: "workflow:two", cap: usdToMicros(4), at: Date.now(), token: tokenId, price: { base: 500_000, markup: 1 }, reserve }]));
      const held = await (await first.ledger()).hold({ token: tokenId, reserve, subject: "workflow:two", runId });
      assert.ok(held.ok);
      const t = new Date().toISOString();
      await first.store.append("two", runId, { ts: t, runId, path: "two", type: "run.start", origin: "public", input: { cost: 0, ms: 0 }, maxCostUsd: 4, credit: tokenId });
      await first.store.append("two", runId, { ts: t, runId, path: "two/a", type: "step.start", stepType: "test/spend" });
      await first.store.append("two", runId, { ts: t, runId, path: "two/a", type: "step.end", stepType: "test/spend", output: { spent: 1.5 }, cost: 1.5, modelCalls: 1, usage: {} });
      // The price changes before the restart: the run is charged at its launch's.
      assert.equal((await first.app.request("/public-view", { method: "PUT", body: JSON.stringify({ runnable: [{ ...PRICED, base: 3 }] }), headers: json })).status, 200);
      await first.close();

      const second = await nextBoot(ws, wallet);
      try {
        await until(async () => !!(await second.store.getRunSummary("two", runId)) && JSON.parse(await readFile(publicRunsPath(ws), "utf-8")).length === 0);
        const ledger = await second.ledger();
        assert.equal((await ledger.chargeOf(runId, "workflow:two"))!.usd, usdToMicros(2.5), "0.50 + 1 × (1.5 + 0.5)");
        const tok = (await ledger.token(tokenId))!;
        assert.deepEqual({ spent: tok.spent, held: tok.held }, { spent: usdToMicros(2.5), held: 0 });
      } finally {
        await second.close();
      }
      const third = await nextBoot(ws, wallet);
      try {
        await new Promise((r) => setTimeout(r, 200));
        assert.equal((await (await third.ledger()).token(tokenId))!.spent, usdToMicros(2.5), "charged once");
      } finally {
        await third.close();
      }
    } finally {
      if (saved === undefined) delete process.env["STRUT_API_KEY"];
      else process.env["STRUT_API_KEY"] = saved;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a hold whose run ended and whose entry was lost is charged once at boot, from the run's summary; the boot sweep closes a token past its end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-public-priced-holds-"));
    const saved = process.env["STRUT_API_KEY"];
    delete process.env["STRUT_API_KEY"];
    try {
      const ws = join(dir, "ws");
      const wallet = new FakeWallet();
      const { strut: first, tokenId } = await firstBoot(ws, wallet);
      const ledger = await first.ledger();
      // A finished run, no entry on file, its reserve still held.
      const runId = "1800000000002";
      const t = new Date().toISOString();
      await first.store.append("two", runId, { ts: t, runId, path: "two", type: "run.start", origin: "public", input: {}, credit: tokenId });
      await first.store.append("two", runId, { ts: t, runId, path: "two/a", type: "step.end", stepType: "test/spend", output: {}, cost: 2, modelCalls: 1, usage: {} });
      await first.store.append("two", runId, { ts: t, runId, path: "two", type: "run.end", output: {} });
      await first.store.finalize("two", runId, { runId, workflow: "two", startedAt: t, finishedAt: t, durationMs: 0, status: "success", input: {}, origin: "public", totals: { modelCalls: 1, usage: {}, cost: 2 } } as never);
      assert.ok((await ledger.hold({ token: tokenId, reserve: usdToMicros(4.5), subject: "workflow:two", runId })).ok);
      // A token whose end comes in a second, used once.
      const root = (await first.payments.settings.l402Root())!;
      const inv = await lightningCapability(wallet).makeInvoice({ msat: 1_000_000 });
      const preimage = wallet.settle(inv.invoice);
      const short = mintToken(root, { paymentHash: inv.payment_hash, quote: { sats: 1000, credit: 1_000_000, validUntil: Math.floor(Date.now() / 1000) + 1 } });
      assert.equal((await first.app.request("/public/credit", { headers: { authorization: `L402 ${macaroonToBase64(short.macaroon)}:${preimage}` } })).status, 200);
      await first.close();
      await new Promise((r) => setTimeout(r, 1100));

      const second = await nextBoot(ws, wallet);
      try {
        const l = await second.ledger();
        await until(async () => (await l.openHolds()).length === 0 && (await l.token(short.tokenId))?.closed !== undefined);
        assert.equal((await l.chargeOf(runId, "workflow:two"))!.usd, usdToMicros(2.5), "at the item's price: 0.50 + 1 × 2");
        assert.equal((await l.token(short.tokenId))!.closed !== undefined, true, "swept at boot");
      } finally {
        await second.close();
      }
      const third = await nextBoot(ws, wallet);
      try {
        await new Promise((r) => setTimeout(r, 200));
        const l = await third.ledger();
        assert.equal((await l.token(tokenId))!.spent, usdToMicros(2.5), "charged once");
        assert.equal((await l.today("workflow:two")).calls, 1);
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

