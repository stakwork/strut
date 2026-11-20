/**
 * Add sats (plans/paid-runs.md §8, §9; src/payments/deposits.ts): an invoice
 * into the server's own wallet, kept until it settles or expires, recorded
 * once in the ledger's `deposits` with what settled, and counted by the
 * books check — never as credit or earnings. On a real server: full scope
 * only, and the books balanced afterwards.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createStrut } from "../createStrut.js";
import { WorkspaceManager } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import { signInTicket } from "../auth.js";
import { FakeWallet } from "./fake-wallet.js";
import { lightningCapability, type LightningCapability } from "./lightning.js";
import { MemoryLedgerStore } from "./ledger-memory.js";
import { WALLET_ENV } from "./settings.js";
import type { EarningsView } from "./earnings.js";
import {
  createDeposits,
  DepositError,
  DEPOSIT_DESCRIPTION,
  DEPOSIT_EXPIRY_SECS,
  DEPOSIT_FORGET_AFTER_MS,
  DEPOSIT_MAX_SATS,
  depositAmountProblem,
} from "./deposits.js";

const KEY = "deposits-key";
const PEER = "deposits-peer-key";
const json = { "content-type": "application/json" };
const keyed = { authorization: `Bearer ${KEY}`, ...json };
const CLEARED = [...WALLET_ENV, "STRUT_RATE_URL", "STRUT_API_KEY", "STRUT_PEER_KEY", "STRUT_SECRET_KEY"];
const RATE = { usdPerBtc: 100_000, at: new Date().toISOString(), source: "test" };

let dir: string;
beforeEach(async () => {
  dir = join(tmpdir(), `strut-deposits-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("deposits: the service", () => {
  const setup = (o: { file?: string; now?: () => number; wallet?: FakeWallet | null } = {}) => {
    const wallet = o.wallet === undefined ? new FakeWallet({ ...(o.now ? { now: o.now } : {}) }) : o.wallet;
    const lightning: LightningCapability | null = wallet ? lightningCapability(wallet) : null;
    const ledger = new MemoryLedgerStore();
    const deposits = createDeposits({ lightning: () => lightning, ledger: async () => ledger, ...(o.file ? { file: o.file } : {}), ...(o.now ? { now: o.now } : {}) });
    return { wallet, ledger, deposits };
  };

  it("an amount is a whole number of sats from 1 to 0.1 bitcoin", () => {
    for (const bad of [0, -5, 1.5, Number.NaN, "100", undefined, DEPOSIT_MAX_SATS + 1]) assert.ok(depositAmountProblem(bad), String(bad));
    assert.equal(depositAmountProblem(1), undefined);
    assert.equal(depositAmountProblem(DEPOSIT_MAX_SATS), undefined);
  });

  it("asks the receive side for an invoice, keeps it until it settles, then records what settled, once", async () => {
    const { wallet, ledger, deposits } = setup();
    const asked = await deposits.ask({ sats: 21_000, actor: "evan" });
    assert.equal(asked.state, "pending");
    assert.equal(asked.msat, 21_000_000);
    assert.ok(asked.invoice);
    const made = wallet!.calls.find((c) => c.method === "makeInvoice")!.arg as { msat: number; description: string; expirySecs: number };
    assert.deepEqual(made, { msat: 21_000_000, description: DEPOSIT_DESCRIPTION, expirySecs: DEPOSIT_EXPIRY_SECS });
    assert.deepEqual((await deposits.pending()).map((p) => p.paymentHash), [asked.paymentHash]);
    assert.equal((await deposits.read(asked.paymentHash)).state, "pending");

    wallet!.settle(asked.paymentHash, { msat: 20_000_000 });
    const settled = await deposits.read(asked.paymentHash);
    assert.equal(settled.state, "settled");
    assert.equal(settled.invoice, undefined, "no invoice once paid");
    assert.equal(settled.deposit!.msat, 20_000_000, "what SETTLED, not what was asked");
    assert.equal(settled.deposit!.actor, "evan");
    assert.deepEqual(await deposits.pending(), []);
    assert.deepEqual(await ledger.depositOf(asked.paymentHash), settled.deposit);

    // Read again: from the books, without asking the wallet.
    const lookups = wallet!.calls.filter((c) => c.method === "lookup").length;
    const again = await deposits.read(asked.paymentHash);
    assert.equal(again.state, "settled");
    assert.deepEqual(again.deposit, settled.deposit);
    assert.equal(wallet!.calls.filter((c) => c.method === "lookup").length, lookups);
    assert.equal((await ledger.deposited())[0]!.count, 1);
    assert.deepEqual(await ledger.received(), [], "never credit");
  });

  it("refuses a bad amount and a server with no wallet, before asking anything", async () => {
    const { wallet, deposits } = setup();
    await assert.rejects(deposits.ask({ sats: 0 }), (e: unknown) => e instanceof DepositError && e.status === 400 && e.code === "bad_amount");
    assert.equal(wallet!.calls.length, 0);
    const none = setup({ wallet: null });
    await assert.rejects(none.deposits.ask({ sats: 100 }), (e: unknown) => e instanceof DepositError && e.status === 409 && e.code === "no_wallet");
  });

  it("a wallet that cannot be reached: 503 for the invoice; a read stays pending, and is forgotten a day past expiry", async () => {
    let t = Date.parse("2026-11-11T12:00:00Z");
    const now = () => t;
    const { wallet, deposits } = setup({ now });
    wallet!.down();
    await assert.rejects(deposits.ask({ sats: 100 }), (e: unknown) => e instanceof DepositError && e.status === 503 && e.code === "wallet_unavailable");
    wallet!.down(false);
    const asked = await deposits.ask({ sats: 100 });
    wallet!.down();
    const r = await deposits.read(asked.paymentHash);
    assert.equal(r.state, "pending");
    assert.match(r.error!, /wallet_unavailable/);
    assert.match((await deposits.pending())[0]!.lastError!, /wallet_unavailable/);
    t += DEPOSIT_EXPIRY_SECS * 1000 + DEPOSIT_FORGET_AFTER_MS + 1;
    assert.equal((await deposits.read(asked.paymentHash)).state, "expired");
    assert.deepEqual(await deposits.pending(), []);
  });

  it("an invoice that expired unpaid is forgotten; one the wallet no longer knows is forgotten too", async () => {
    const { wallet, deposits } = setup();
    const a = await deposits.ask({ sats: 100 });
    wallet!.expire(a.paymentHash);
    assert.equal((await deposits.read(a.paymentHash)).state, "expired");
    await assert.rejects(deposits.read(a.paymentHash), (e: unknown) => e instanceof DepositError && e.status === 404);

    // Another wallet set since the invoice was made: it does not know it.
    const file = join(dir, "payments", "deposits.json");
    const before = setup({ file });
    const b = await before.deposits.ask({ sats: 100 });
    const after = setup({ file, wallet: new FakeWallet() });
    await assert.rejects(after.deposits.read(b.paymentHash), (e: unknown) => e instanceof DepositError && e.status === 404 && /another wallet/.test(e.message));
    assert.deepEqual(await after.deposits.pending(), [], "forgotten");
  });

  it("check(): a deposit paid after the page closed is recorded at the next check, and kept on file across a restart", async () => {
    const file = join(dir, "payments", "deposits.json");
    const wallet = new FakeWallet();
    const first = setup({ file, wallet });
    const asked = await first.deposits.ask({ sats: 500, actor: "evan" });
    const onFile = JSON.parse(await readFile(file, "utf8")) as Array<{ paymentHash: string }>;
    assert.deepEqual(onFile.map((p) => p.paymentHash), [asked.paymentHash]);

    const second = setup({ file, wallet });
    wallet.settle(asked.paymentHash);
    assert.deepEqual(await second.deposits.check(), [{ paymentHash: asked.paymentHash, state: "settled" }]);
    assert.equal((await second.ledger.depositOf(asked.paymentHash))!.msat, 500_000);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), []);
  });

  it("one read per payment hash at a time: a second caller joins the first", async () => {
    const { wallet, deposits } = setup();
    const asked = await deposits.ask({ sats: 100 });
    wallet!.settle(asked.paymentHash);
    const before = wallet!.calls.filter((c) => c.method === "lookup").length;
    const [x, y] = await Promise.all([deposits.read(asked.paymentHash), deposits.read(asked.paymentHash)]);
    assert.deepEqual(x, y);
    assert.equal(wallet!.calls.filter((c) => c.method === "lookup").length, before + 1);
  });
});

describe("deposits: on a server", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of CLEARED) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of CLEARED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const boot = (wallet: FakeWallet) =>
    createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")),
      store: new MemoryRunStore(),
      webDist: join(dir, "dist"),
      scheduler: false,
      payments: { rate: async () => RATE },
      services: { lightning: lightningCapability(wallet) } as never,
    });

  it("full scope only: the key and an admin's session; a member, a person token and a peer are refused", async () => {
    process.env["STRUT_API_KEY"] = KEY;
    process.env["STRUT_PEER_KEY"] = PEER;
    const wallet = new FakeWallet();
    const strut = await boot(wallet);
    try {
      const session = async (role: "admin" | "member") => {
        const { ticket } = signInTicket(`${role}-1`, role)!;
        const traded = await strut.app.request("/auth/session", { method: "POST", headers: { ...json, "x-strut-ui": "1" }, body: JSON.stringify({ ticket }) });
        return { cookie: traded.headers.get("set-cookie")!.split(";")[0]!, "x-strut-ui": "1", ...json };
      };
      const minted = await strut.app.request("/peers/tokens", { method: "POST", headers: keyed, body: JSON.stringify({ actor: "tom-1" }) });
      const person = { authorization: `Bearer ${((await minted.json()) as { token: string }).token}`, ...json };
      const post = (headers: Record<string, string>) => strut.app.request("/earnings/deposit", { method: "POST", headers, body: JSON.stringify({ sats: 1000 }) });

      assert.equal((await post(json)).status, 401);
      assert.equal((await post({ authorization: `Bearer ${PEER}`, ...json })).status, 403);
      assert.equal((await post(person)).status, 403);
      assert.equal((await post(await session("member"))).status, 403);
      assert.equal(wallet.calls.filter((c) => c.method === "makeInvoice").length, 0, "no invoice on a refusal");
      const admin = await post(await session("admin"));
      assert.equal(admin.status, 200, await admin.clone().text());
      const a = (await admin.json()) as { state: string; paymentHash: string; invoice: string };
      assert.equal(a.state, "pending");
      const read = (headers: Record<string, string>) => strut.app.request(`/earnings/deposits/${a.paymentHash}/read`, { method: "POST", headers });
      assert.equal((await read({ authorization: `Bearer ${PEER}`, ...json })).status, 403);
      assert.equal((await read(keyed)).status, 200);
    } finally {
      await strut.close();
    }
  });

  it("the body is { sats } alone; a hash is 64 hex characters", async () => {
    const strut = await boot(new FakeWallet());
    try {
      for (const body of [{}, { sats: 0 }, { sats: 10, memo: "x" }, [], { sats: "10" }]) {
        const res = await strut.app.request("/earnings/deposit", { method: "POST", headers: json, body: JSON.stringify(body) });
        assert.equal(res.status, 400, JSON.stringify(body));
      }
      assert.equal((await strut.app.request("/earnings/deposits/nothex/read", { method: "POST", headers: json })).status, 400);
      const unknown = await strut.app.request(`/earnings/deposits/${"ab".repeat(32)}/read`, { method: "POST", headers: json });
      assert.equal(unknown.status, 404);
      assert.equal(((await unknown.json()) as { code: string }).code, "not_found");
    } finally {
      await strut.close();
    }
  });

  it("a settled deposit balances the books: the wallet holds what the books say, and nothing is credit or earnings", async () => {
    const wallet = new FakeWallet();
    const strut = await boot(wallet);
    try {
      const asked = (await (await strut.app.request("/earnings/deposit", { method: "POST", headers: json, body: JSON.stringify({ sats: 2100 }) })).json()) as { paymentHash: string };
      wallet.settle(asked.paymentHash);
      // No read of the deposit: opening Earnings settles what was paid.
      const view = (await (await strut.app.request("/earnings?wallet=1")).json()) as EarningsView;
      assert.equal(view.wallet!.balance!.msat, 2_100_000);
      assert.equal(view.wallet!.expectedMsat, 2_100_000);
      assert.equal(view.wallet!.differenceMsat, 0);
      assert.equal(view.deposited.count, 1);
      assert.equal(view.deposited.msat, 2_100_000);
      assert.deepEqual(view.received, { count: 0, msat: 0, usd: 0, days: [] });
      assert.deepEqual(view.totals, { calls: 0, failed: 0, earned: 0, cost: 0, margin: 0 });
      assert.deepEqual(view.outstanding, { tokens: 0, usd: 0, held: 0 });
      const read = (await (await strut.app.request(`/earnings/deposits/${asked.paymentHash}/read`, { method: "POST", headers: json })).json()) as { state: string; deposit: { at: string; msat: number } };
      assert.equal(read.state, "settled");
      assert.equal(read.deposit.msat, 2_100_000);
      assert.ok(!Number.isNaN(Date.parse(read.deposit.at)), "at is ISO 8601 on the wire");
    } finally {
      await strut.close();
    }
  });
});
