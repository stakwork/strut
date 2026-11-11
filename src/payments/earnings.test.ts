/**
 * Earnings and Withdraw on a real server (plans/paid-runs.md §8): the reads
 * by item, day and package against a ledger with charges, payments and
 * withdrawals; Withdraw full scope only, paying exactly the amount
 * confirmed, recorded once, pending until it settles; and the payer out of
 * every step's reach.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createStrut } from "../createStrut.js";
import { WorkspaceManager } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import { signInTicket } from "../auth.js";
import type { StrutCapabilities } from "../capabilities.js";
import type { StepContext } from "../core.js";
import readStep from "../steps/lib/earnings/read.js";
import { encodeBolt11 } from "./bolt11.js";
import { FakePayer, FakeWallet } from "./fake-wallet.js";
import { LightningError, lightningCapability } from "./lightning.js";
import { MemoryLedgerStore } from "./ledger-memory.js";
import { dayOf, usdToMicros, type LedgerStore } from "./ledger.js";
import { WALLET_ENV } from "./settings.js";
import { createWithdrawals, WithdrawError } from "./withdrawals.js";
import type { EarningsView } from "./earnings.js";

const KEY = "earnings-key";
const PEER = "earnings-peer-key";
const json = { "content-type": "application/json" };
const keyed = { authorization: `Bearer ${KEY}`, ...json };
const CLEARED = [...WALLET_ENV, "STRUT_RATE_URL", "STRUT_API_KEY", "STRUT_PEER_KEY", "STRUT_SECRET_KEY"];
const $ = usdToMicros;
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-03T12:00:00Z");
const RATE = { usdPerBtc: 100_000, at: new Date().toISOString(), source: "test" };

/** An invoice for `msat`, unexpired. */
function invoice(msat: number, opts: { expirySecs?: number; timestamp?: number } = {}) {
  const hash = createHash("sha256").update(randomBytes(32)).digest("hex");
  return { hash, invoice: encodeBolt11({ msat, paymentHash: hash, expirySecs: opts.expirySecs ?? 3600, ...(opts.timestamp ? { timestamp: opts.timestamp } : {}) }) };
}

/** Books for three items in two packages over two days. */
async function seed(ledger: LedgerStore) {
  const buy = (id: string, usd: number, at: number, msat = usd * 1000 * 1000) =>
    ledger.firstUse({ id, paymentHash: `pay-${id}`, askedMsat: msat, settledMsat: msat, credit: $(usd), rate: 100_000, expires: at + 365 * DAY, at });
  await buy("a", 10, T0);
  await buy("b", 5, T0 + DAY);
  const price = { base: $(0.1), markup: 2 };
  const run = async (token: string, runId: string, subject: string, cost: number, outcome: "success" | "error", at: number) => {
    await ledger.hold({ token, reserve: $(1), subject, runId, at });
    await ledger.charge({ token, runId, subject, cost: $(cost), outcome, price, at: at + 1 });
  };
  await run("a", "r1", "workflow:acme/voxel/rig", 0.2, "success", T0); // earned 0.5
  await run("a", "r2", "workflow:acme/voxel/rig", 0.3, "error", T0 + 10); // earned 0.3 (failed: its cost)
  await run("a", "r3", "step:acme/voxel/slice", 0.1, "success", T0 + DAY); // earned 0.3
  await run("b", "r4", "workflow:cve-check", 0.05, "success", T0 + DAY); // earned 0.2
  await ledger.withdrawal({ msat: 3_000_000, feeMsat: 5000, paymentHash: "out-1", actor: "evan", at: T0 + DAY });
}

describe("earnings and withdraw on a server", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(async () => {
    dir = join(tmpdir(), `strut-earnings-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    for (const k of CLEARED) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(async () => {
    for (const k of CLEARED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  });

  const boot = (extra: Parameters<typeof createStrut>[0] = {}) =>
    createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")),
      store: new MemoryRunStore(),
      webDist: join(dir, "dist"),
      scheduler: false,
      payments: { rate: async () => RATE, ...(extra.payments ?? {}) },
      ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "payments")),
    });
  const get = async (strut: Awaited<ReturnType<typeof boot>>, path: string) => {
    const res = await strut.app.request(path, { headers: keyed });
    assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`);
    return (await res.json()) as EarningsView & Record<string, unknown>;
  };

  it("by item, day, package and total, from the rollups: earned, cost, margin, calls, failed; outstanding, received, withdrawn", async () => {
    process.env["STRUT_API_KEY"] = KEY;
    const wallet = new FakeWallet({ startMsat: 15_000_000 });
    const strut = await boot({ services: { lightning: lightningCapability(wallet) } as never });
    try {
      await seed(await strut.ledger());
      const byItem = await get(strut, "/earnings");
      assert.equal(byItem.by, "item");
      const row = (k: string) => byItem.rows.find((r) => r.key === k)!;
      assert.deepEqual(row("workflow:acme/voxel/rig"), { key: "workflow:acme/voxel/rig", calls: 2, failed: 1, earned: 0.8, cost: 0.5, margin: 0.3 });
      assert.deepEqual(row("step:acme/voxel/slice"), { key: "step:acme/voxel/slice", calls: 1, failed: 0, earned: 0.3, cost: 0.1, margin: 0.2 });
      assert.deepEqual(byItem.totals, { calls: 4, failed: 1, earned: 1.3, cost: 0.65, margin: 0.65 });
      assert.deepEqual(byItem.outstanding, { tokens: 2, usd: 15 - 1.3, held: 0 });
      assert.deepEqual({ count: byItem.received.count, msat: byItem.received.msat, usd: byItem.received.usd }, { count: 2, msat: 15_000_000, usd: 15 });
      assert.deepEqual({ count: byItem.withdrawn.count, msat: byItem.withdrawn.msat, feeMsat: byItem.withdrawn.feeMsat }, { count: 1, msat: 3_000_000, feeMsat: 5000 });
      assert.equal(byItem.wallet, undefined, "the wallet only when asked");

      const byDay = await get(strut, "/earnings?by=day");
      assert.deepEqual(byDay.rows.map((r) => [r.key, r.calls, r.earned]), [[dayOf(T0), 2, 0.8], [dayOf(T0 + DAY), 2, 0.5]]);
      const oneDay = await get(strut, `/earnings?by=day&from=${dayOf(T0 + DAY)}&to=${dayOf(T0 + DAY)}`);
      assert.deepEqual(oneDay.totals.earned, 0.5);
      assert.deepEqual(oneDay.received.days.map((d) => d.day), [dayOf(T0 + DAY)]);

      // A package's number: the subjects under its prefix, here.
      const byPackage = await get(strut, "/earnings?by=package");
      assert.deepEqual(byPackage.rows.map((r) => [r.key, r.calls, r.earned, r.margin]), [["acme/voxel", 3, 1.1, 0.5]]);
      const pkg = await get(strut, "/earnings?by=total&prefix=acme/voxel");
      assert.deepEqual(pkg.totals, { calls: 3, failed: 1, earned: 1.1, cost: 0.6, margin: 0.5 });
      assert.deepEqual(pkg.rows, [{ key: "total", calls: 3, failed: 1, earned: 1.1, cost: 0.6, margin: 0.5 }]);

      // The wallet beside the books: received − withdrawn − fees.
      const withWallet = await get(strut, "/earnings?by=total&wallet=1");
      assert.equal(withWallet.wallet!.expectedMsat, 15_000_000 - 3_000_000 - 5000);
      assert.deepEqual(withWallet.wallet!.balance, { msat: 15_000_000, sats: 15_000, usd: 15 });
      assert.equal(withWallet.wallet!.differenceMsat, 3_005_000, "the fake wallet never paid the withdrawal out");
      assert.equal(withWallet.wallet!.rate, 100_000);

      // Entries: one kind, one run.
      const outs = await get(strut, "/earnings/entries?kind=withdrawal");
      assert.deepEqual((outs["entries"] as Array<Record<string, unknown>>).map((e) => [e["ref"], e["msat"], e["actor"]]), [["out-1", 3_000_000, "evan"]]);
      const r2 = await get(strut, "/earnings/entries?runId=r2");
      assert.deepEqual((r2["entries"] as Array<Record<string, unknown>>).map((e) => [e["kind"], e["usd"], e["outcome"]]), [["charge", 0.3, "error"], ["hold", 1, undefined]]);
      const tok = await get(strut, "/earnings/entries?token=a&limit=2");
      assert.equal((tok["token"] as Record<string, unknown>)["paid"], 10);
      assert.equal((tok["entries"] as unknown[]).length, 2);

      for (const bad of ["/earnings?by=week", "/earnings?from=yesterday", "/earnings?prefix=x", "/earnings/entries?kind=nope", "/earnings/entries?limit=0"]) {
        assert.equal((await strut.app.request(bad, { headers: keyed })).status, 400, bad);
      }
    } finally {
      await strut.close();
    }
  });

  it("a strut that never sold reads zeros and makes no ledger file", async () => {
    const { FileRunStore } = await import("../store.js");
    const strut = await createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")),
      store: new FileRunStore(join(dir, "ws")),
      webDist: join(dir, "dist"),
      scheduler: false,
      autoResume: false,
    });
    try {
      const view = (await (await strut.app.request("/earnings?wallet=1")).json()) as EarningsView;
      assert.deepEqual(view.totals, { calls: 0, failed: 0, earned: 0, cost: 0, margin: 0 });
      assert.equal(view.wallet!.provider, null);
      assert.equal(view.wallet!.error, "no wallet is set");
      await assert.rejects(readFile(join(dir, "ws", "payments", "ledger.db")), "no file");
    } finally {
      await strut.close();
    }
  });

  it("withdraw: full scope only — the key and an admin's session; a member, a person token and a peer are refused", async () => {
    process.env["STRUT_API_KEY"] = KEY;
    process.env["STRUT_PEER_KEY"] = PEER;
    const payer = new FakePayer();
    const strut = await boot({ payments: { payer } });
    try {
      const body = () => {
        const inv = invoice(2_000_000);
        return JSON.stringify({ invoice: inv.invoice, msat: 2_000_000 });
      };
      const session = async (role: "admin" | "member") => {
        const { ticket } = signInTicket(`${role}-1`, role)!;
        const traded = await strut.app.request("/auth/session", { method: "POST", headers: { ...json, "x-strut-ui": "1" }, body: JSON.stringify({ ticket }) });
        return { cookie: traded.headers.get("set-cookie")!.split(";")[0]!, "x-strut-ui": "1", ...json };
      };
      const minted = await strut.app.request("/peers/tokens", { method: "POST", headers: keyed, body: JSON.stringify({ actor: "tom-1" }) });
      const person = { authorization: `Bearer ${((await minted.json()) as { token: string }).token}`, ...json };
      const post = (headers: Record<string, string>) => strut.app.request("/earnings/withdraw", { method: "POST", headers, body: body() });

      assert.equal((await post(json)).status, 401);
      assert.equal((await post({ authorization: `Bearer ${PEER}`, ...json })).status, 403);
      assert.equal((await post(person)).status, 403);
      assert.equal((await post(await session("member"))).status, 403);
      assert.equal(payer.calls.length, 0, "nothing paid on a refusal");
      const admin = await post(await session("admin"));
      assert.equal(admin.status, 200, await admin.clone().text());
      assert.equal(((await admin.json()) as { state: string }).state, "settled");
      assert.equal((await post(keyed)).status, 200);
      // The reads too: a peer reads every route but these.
      for (const path of ["/earnings", "/earnings/entries"]) {
        assert.equal((await strut.app.request(path, { headers: { authorization: `Bearer ${PEER}` } })).status, 403, path);
        assert.equal((await strut.app.request(path, { headers: person })).status, 403, path);
      }
      const books = await (await strut.ledger()).list({ kind: "withdrawal" });
      assert.deepEqual(books.map((e) => e.actor).sort(), ["admin-1", undefined].sort() as never, "who asked: the admin's session, and the key (no actor)");
    } finally {
      await strut.close();
    }
  });

  it("withdraw pays exactly what was confirmed, records it once, and answers a retry from the books", async () => {
    const payer = new FakePayer();
    const strut = await boot({ payments: { payer } });
    try {
      const inv = invoice(10_000_000);
      const post = (b: unknown) => strut.app.request("/earnings/withdraw", { method: "POST", headers: json, body: JSON.stringify(b) });

      const wrong = await post({ invoice: inv.invoice, msat: 9_000_000 });
      assert.equal(wrong.status, 400);
      assert.equal(((await wrong.json()) as { code: string }).code, "amount_mismatch");
      assert.equal((await post({ invoice: "lnbc1nope", msat: 1 })).status, 400);
      const noAmount = encodeBolt11({ paymentHash: "ab".repeat(32) });
      assert.equal(((await (await post({ invoice: noAmount, msat: 1000 })).json()) as { code: string }).code, "no_amount");
      const old = invoice(10_000, { timestamp: 1_700_000_000, expirySecs: 60 });
      assert.equal(((await (await post({ invoice: old.invoice, msat: 10_000 })).json()) as { code: string }).code, "expired");
      assert.equal((await post({ invoice: inv.invoice, msat: 10_000_000, extra: 1 })).status, 400);
      assert.equal(payer.calls.length, 0);

      const paid = (await (await post({ invoice: inv.invoice, msat: 10_000_000 })).json()) as Record<string, unknown>;
      assert.equal(paid["state"], "settled");
      assert.equal(paid["paymentHash"], inv.hash);
      assert.equal(paid["maxFeeMsat"], 50_000, "the default cap: the LSP's own limit for 10 000 sats");
      assert.equal(paid["feeMsat"], 10_000);
      assert.equal(payer.calls[0]!.maxFeeMsat, 50_000);
      assert.deepEqual((paid["entry"] as Record<string, unknown>)["usd"], 10, "the dollars at the moment, for the books");

      // A retry (a double click, a reload) pays nothing and says so.
      const again = (await (await post({ invoice: inv.invoice, msat: 10_000_000 })).json()) as Record<string, unknown>;
      assert.equal(again["existing"], true);
      assert.equal(payer.calls.length, 1);
      assert.equal((await (await strut.ledger()).list({ kind: "withdrawal" })).length, 1);

      // The wallet's refusal, as it came.
      payer.outcomes.push(new LightningError("wallet_refused", "the invoice is the account's own", "own_invoice"));
      const own = invoice(1_000_000);
      const refused = await post({ invoice: own.invoice, msat: 1_000_000 });
      assert.equal(refused.status, 400);
      assert.deepEqual(await refused.json(), { error: "wallet_refused: the invoice is the account's own", code: "wallet_refused", walletCode: "own_invoice" });
      // A fee cap below the floor: the daemon's refusal.
      const low = invoice(10_000_000);
      const tooLow = (await (await post({ invoice: low.invoice, msat: 10_000_000, maxFeeMsat: 1000 })).json()) as Record<string, unknown>;
      assert.equal(tooLow["walletCode"], "max_fee_too_low");

      // Failed: the wallet's words, nothing recorded, and it may be paid again.
      payer.outcomes.push("failed");
      const f = invoice(1_000_000);
      const failed = (await (await post({ invoice: f.invoice, msat: 1_000_000 })).json()) as Record<string, unknown>;
      assert.deepEqual([failed["state"], failed["error"]], ["failed", "no route found"]);
      assert.equal((await (await strut.ledger()).withdrawalOf(f.hash)), undefined);
      assert.equal(((await (await post({ invoice: f.invoice, msat: 1_000_000 })).json()) as Record<string, unknown>)["state"], "settled");
    } finally {
      await strut.close();
    }
  });

  it("pending: kept and read again until it settles, then recorded once; a retry pays nothing twice", async () => {
    const payer = new FakePayer();
    const strut = await boot({ payments: { payer } });
    try {
      const post = (b: unknown) => strut.app.request("/earnings/withdraw", { method: "POST", headers: json, body: JSON.stringify(b) });
      payer.outcomes.push("pending", "pending");
      const one = invoice(2_000_000);
      const two = invoice(3_000_000);
      assert.equal(((await (await post({ invoice: one.invoice, msat: 2_000_000 })).json()) as { state: string }).state, "pending");
      assert.equal(((await (await post({ invoice: two.invoice, msat: 3_000_000 })).json()) as { state: string }).state, "pending");
      const view = (await (await strut.app.request("/earnings")).json()) as EarningsView;
      assert.deepEqual(view.pending.map((p) => [p.paymentHash, p.answered]).sort(), [[one.hash, true], [two.hash, true]].sort());
      assert.equal((await (await strut.ledger()).list({ kind: "withdrawal" })).length, 0);

      // The person asks again: still out, nothing paid twice.
      assert.equal(((await (await post({ invoice: one.invoice, msat: 2_000_000 })).json()) as { state: string }).state, "pending");
      payer.settle(one.hash);
      const settled = (await (await post({ invoice: one.invoice, msat: 2_000_000 })).json()) as Record<string, unknown>;
      assert.equal(settled["state"], "settled");
      assert.equal(payer.calls.filter((c) => c.method === "pay").length, 2, "one pay per invoice");

      // The other is still out until it is read again (the minute's check,
      // "withdrawals on file" below).
      payer.settle(two.hash);
      const view2 = (await (await strut.app.request("/earnings")).json()) as EarningsView;
      assert.deepEqual(view2.pending.map((p) => p.paymentHash), [two.hash]);
    } finally {
      await strut.close();
    }
  });

  it("no pay credential: the route says so; the payer is on no bag and no step reaches it", async () => {
    const strut = await boot();
    try {
      await strut.payments.setWallet({ provider: "sphinx", url: "http://127.0.0.1:1", token: "receive-1" });
      const inv = invoice(1_000_000);
      const res = await strut.app.request("/earnings/withdraw", { method: "POST", headers: json, body: JSON.stringify({ invoice: inv.invoice, msat: 1_000_000 }) });
      assert.equal(res.status, 409);
      assert.equal(((await res.json()) as { code: string }).code, "no_pay_credential");
      assert.equal(await strut.payments.payer(), null);
      assert.equal(await strut.payments.canPay(), false);
      const wallet = ((await (await strut.app.request("/earnings?wallet=1")).json()) as EarningsView).wallet!;
      assert.equal(wallet.pay, false);

      await strut.payments.setWallet({ provider: "sphinx", url: "http://127.0.0.1:1", token: "receive-1", payToken: "pay-1" });
      assert.equal((await strut.payments.payer())?.provider, "sphinx");
      assert.equal(await strut.payments.canPay(), true);
      const bag = strut.services as StrutCapabilities & Record<string, unknown>;
      const reachable = JSON.stringify(Object.keys(bag)) + JSON.stringify(Object.keys(bag.lightning ?? {})) + JSON.stringify(Object.keys(bag.earnings ?? {}));
      assert.ok(!/payer|pay\b|withdraw/i.test(reachable), reachable);
      assert.deepEqual(Object.keys(bag.earnings!), ["read"]);
    } finally {
      await strut.close();
    }
  });

  it("earnings/read: a first-party page's admin reads; another app, or a member on strut's own page, is refused", async () => {
    const strut = await boot();
    try {
      await seed(await strut.ledger());
      const ctx = (app?: StepContext["app"]) => ({ services: strut.services, ...(app ? { app } : {}) }) as unknown as StepContext<StrutCapabilities>;
      const all = (await readStep.run({ by: "total" }, ctx())) as EarningsView;
      assert.equal(all.totals.earned, 1.3);
      const jamie = { name: "strut/jamie", version: "v1", firstParty: true as const, admin: true as const };
      const week = (await readStep.run({ days: 7, by: "item", wallet: true }, ctx(jamie))) as EarningsView;
      assert.ok(week.from);
      assert.ok(week.wallet);
      await assert.rejects(readStep.run({}, ctx({ name: "acme/dash", version: "v3" })), /admin's read/);
      await assert.rejects(readStep.run({}, ctx({ name: "strut/jamie", version: "v1", firstParty: true })), /admin's read/);
      await assert.rejects(readStep.run({ days: 7, from: "2026-11-01" }, ctx()), /not both/);
      assert.equal(readStep.effect, "read");
    } finally {
      await strut.close();
    }
  });
});

describe("withdrawals on file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(tmpdir(), `strut-withdrawals-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("a pending one outlives the process; the next one's check records it once; a daemon pay that never answered waits for its invoice to expire", async () => {
    const file = join(dir, "payments", "withdrawals.json");
    const ledger = new MemoryLedgerStore();
    const payer = new FakePayer();
    let now = Date.now();
    const make = () => createWithdrawals({ payer: async () => payer, ledger: async () => ledger, file, now: () => now });
    const first = make();
    payer.outcomes.push("pending");
    const out = invoice(4_000_000);
    assert.equal((await first.withdraw({ invoice: out.invoice, msat: 4_000_000, actor: "evan" })).state, "pending");
    const onFile = JSON.parse(await readFile(file, "utf8")) as Array<Record<string, unknown>>;
    assert.deepEqual(onFile.map((p) => [p["paymentHash"], p["answered"], p["actor"]]), [[out.hash, true, "evan"]]);

    // The process goes; a new one reads the file.
    const second = make();
    assert.deepEqual(await second.check(), [{ paymentHash: out.hash, state: "pending" }]);
    payer.settle(out.hash);
    assert.deepEqual(await second.check(), [{ paymentHash: out.hash, state: "settled" }]);
    assert.deepEqual(await second.check(), [], "nothing left out");
    assert.equal((await ledger.list({ kind: "withdrawal" })).length, 1);
    assert.equal((await ledger.withdrawalOf(out.hash))!.actor, "evan");

    // A pay call that never answered: the wallet may or may not have it.
    payer.outcomes.push(new LightningError("wallet_unavailable", "no answer in 75 s"));
    const lost = invoice(1_000_000, { expirySecs: 600 });
    await assert.rejects(second.withdraw({ invoice: lost.invoice, msat: 1_000_000 }), (e: unknown) => e instanceof WithdrawError && e.status === 503);
    assert.deepEqual((await second.pending()).map((p) => [p.paymentHash, p.answered]), [[lost.hash, false]]);
    const before = payer.calls.length;
    const read = await second.check();
    assert.equal(read[0]!.state, "unread", "never re-sent unattended");
    assert.equal(payer.calls.length, before);
    now += 601_000; // past its invoice
    const after = await second.check();
    assert.equal(after[0]!.paymentHash, lost.hash);
    assert.notEqual(after[0]!.state, "unread", "once expired it can only be read");
  });

  it("no pay credential: refused before anything is on file", async () => {
    const w = createWithdrawals({ payer: async () => null, ledger: async () => new MemoryLedgerStore() });
    await assert.rejects(w.withdraw({ invoice: invoice(1_000_000).invoice, msat: 1_000_000 }), (e: unknown) => e instanceof WithdrawError && e.code === "no_pay_credential" && e.status === 409);
    assert.deepEqual(await w.pending(), []);
  });
});
