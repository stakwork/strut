/**
 * The payer's THIRD door (plans/human-steps.md §8.2): a worker's withdrawal,
 * keysent to the Sphinx address their sign-in gave, with nobody's yes per
 * payment. With a fake wallet and a fake keysend payer, over both ledgers:
 * the switch is off until an admin turns it on; the address is the worker's
 * own; the solvency check; the reserve, the minimum and the caps; one payout
 * on its way; a payout settled, pending, failed, never taken, never sent,
 * stale; a retry reads rather than pays; the books stay balanced; and
 * ruling 7's refusal of every send that is not a worker's.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { encodeBolt11 } from "./bolt11.js";
import { FakePayer, FakeWallet } from "./fake-wallet.js";
import { lightningCapability } from "./lightning.js";
import { MemoryLedgerStore } from "./ledger-memory.js";
import { dayOf, openLedger, type LedgerStore } from "./ledger.js";
import type { Payer } from "./payer.js";
import { addressIsActors, createPayouts, ORPHAN_AFTER_MS, PayoutError, type PayoutErrorCode } from "./payouts.js";
import { createWithdrawals, KEYSEND_STALE_MS, WithdrawError } from "./withdrawals.js";
import { readEarnings } from "./earnings.js";

const T0 = Date.parse("2026-11-13T12:00:00Z");
const HOUR = 3_600_000;
/** A worker's root sign-in key, x-only, and the Sphinx address of that key. */
const X = "c".repeat(64);
const ACTOR = `secp:${X}`;
const ADDRESS = `02${X}_03${"d".repeat(64)}_1099511627776`;
const ON = { on: true, minSats: 1_000, workerDaySats: 200_000, serverDaySats: 2_000_000 };

const refusal = (c: PayoutErrorCode) => (e: unknown) => e instanceof PayoutError && e.code === c;

/** An invoice for `msat` an admin pastes. */
function invoice(msat: number) {
  const hash = createHash("sha256").update(randomBytes(32)).digest("hex");
  return { hash, invoice: encodeBolt11({ msat, paymentHash: hash, expirySecs: 3600 }) };
}

const impls: Array<{ name: string; make(dir: string): Promise<LedgerStore> }> = [
  { name: "memory", make: async () => new MemoryLedgerStore() },
  { name: "SQLite", make: (dir) => openLedger({ dataDir: dir }) },
];

for (const impl of impls) {
  describe(`payouts: a worker's withdrawal (plans/human-steps.md §8.2), ${impl.name} ledger`, () => {
    let dir: string;
    let ledger: LedgerStore;
    let now: number;
    let wallet: FakeWallet;
    let payer: FakePayer;
    /** The payer the server has now: the fake, none, or another. */
    let current: Payer | null;
    let payouts: ReturnType<typeof createPayouts>;
    let withdrawals: ReturnType<typeof createWithdrawals>;

    beforeEach(async () => {
      dir = join(tmpdir(), `strut-payouts-${randomUUID()}`);
      await mkdir(dir, { recursive: true });
      ledger = await impl.make(dir);
      now = T0;
      // The wallet holds 100 000 sats, all of it paid in by hand: the books know it.
      wallet = new FakeWallet({ startMsat: 100_000_000, now: () => now });
      await ledger.deposit({ msat: 100_000_000, paymentHash: "seed", at: T0 - HOUR });
      payer = new FakePayer();
      payer.wallet = wallet;
      current = payer;
      const lightning = lightningCapability(wallet);
      withdrawals = createWithdrawals({
        payer: async () => current,
        ledger: async () => ledger,
        now: () => now,
        answerWithinMs: 2_000,
        owedToWorkers: async () => (await ledger.owedToWorkers({ now })).owedMsat,
        balance: async () => {
          try {
            return (await lightning.balance()).msat;
          } catch {
            return undefined;
          }
        },
        sweep: () => payouts.sweep(),
      });
      payouts = createPayouts({ ledger: async () => ledger, ledgerIfAny: async () => ledger, withdrawals, payer: async () => current, lightning: () => lightning, now: () => now });
    });
    afterEach(async () => {
      await ledger.close();
      await rm(dir, { recursive: true, force: true });
    });

    /** `msat` earned by the worker an hour ago, released now. */
    const earned = async (msat: number, o: { worker?: string; lease?: string } = {}) => {
      const lease = o.lease ?? randomUUID();
      await ledger.pay({ lease, task: `t-${lease}`, worker: o.worker ?? ACTOR, type: "pet-match", msat, at: now - HOUR, releases: now });
    };
    const total = async (worker = ACTOR) => (await ledger.payeeBalance(worker, { now })).totalMsat;
    const books = () => readEarnings({ ledger: async () => ledger, pending: () => withdrawals.pending(), lightning: () => lightningCapability(wallet), now: () => now }, { wallet: true });

    it("is off until an admin turns it on: nothing is reserved or sent", async () => {
      await earned(10_000_000);
      await assert.rejects(payouts.pay(ACTOR, { address: ADDRESS, msat: 2_000_000 }), refusal("payouts_off"));
      assert.equal((await payouts.view(ACTOR, { address: ADDRESS, balance: await ledger.payeeBalance(ACTOR, { now }) })).why, "off");
      assert.deepEqual([payer.calls.length, (await ledger.payouts()).length], [0, 0]);
      assert.deepEqual(await payouts.settings(), { on: false, minSats: 1_000, workerDaySats: 200_000, serverDaySats: 2_000_000 });
    });

    it("settles at once: the worker's address receives the amount, the worker pays the fee up to its cap, the books stay balanced and the cover does not move", async () => {
      await payouts.saveSettings(ON, "admin-1");
      await earned(10_000_000);
      const before = await books();
      assert.equal(before.wallet!.coverMsat, 100_000_000 - 10_000_000);
      const out = await payouts.pay(ACTOR, { address: ADDRESS, msat: 2_000_000 });
      assert.deepEqual(out, { state: "settled", key: out.key, msat: 2_000_000, feeMsat: 2_000, maxFeeMsat: 10_000 });
      assert.match(out.key, /^[0-9a-f]{64}$/);
      assert.deepEqual(payer.keysends(), [{ id: out.key, address: ADDRESS, msat: 2_000_000, state: "settled", feeMsat: 2_000 }]);
      const p = (await ledger.payoutOf(out.key))!;
      assert.deepEqual([p.state, p.worker, p.address, p.feeMsat], ["paid", ACTOR, ADDRESS, 2_000]);
      assert.match(p.paymentHash!, /^[0-9a-f]{64}$/, "the wallet's payment hash kept beside the key");
      assert.equal(await total(), 10_000_000 - 2_002_000);
      const after = await books();
      assert.equal(after.wallet!.differenceMsat, 0, "the books say what the wallet holds");
      assert.equal(after.wallet!.coverMsat, before.wallet!.coverMsat, "a payout leaves the cover as it was");
      assert.deepEqual(after.workers!.paidOut, { count: 1, msat: 2_000_000, feeMsat: 2_000, days: [{ day: dayOf(now), count: 1, msat: 2_000_000, feeMsat: 2_000 }] });
      assert.deepEqual([after.withdrawn.count, after.workers!.outMsat], [0, 0], "Withdrawn stays the admin's own");
    });

    it("pending stays reserved and settles at the minute's check; a retry reads rather than pays", async () => {
      await payouts.saveSettings(ON);
      await earned(10_000_000);
      payer.outcomes.push("pending");
      const out = await payouts.pay(ACTOR, { address: ADDRESS, msat: 3_000_000 });
      assert.equal(out.state, "pending");
      assert.equal(await total(), 10_000_000 - 3_015_000, "out of the balance while on its way");
      const view = await payouts.view(ACTOR, { address: ADDRESS, balance: await ledger.payeeBalance(ACTOR, { now }) });
      assert.deepEqual(view.out, { key: out.key, msat: 3_000_000, maxFeeMsat: 15_000, at: now, stale: false });
      assert.equal(view.maxMsat, 0, "nothing more while one is out");
      const pendingBooks = await books();
      assert.deepEqual([pendingBooks.wallet!.pendingMsat, pendingBooks.workers!.outMsat], [3_000_000, 3_000_000]);
      assert.equal(pendingBooks.wallet!.expectedMsat, 100_000_000 - 3_000_000, "counted as gone while on its way, as every send is");
      // Asked again: the one on its way, never a second payment.
      const again = await payouts.pay(ACTOR, { address: ADDRESS, msat: 3_000_000 }).catch((e: unknown) => e);
      assert.ok(again instanceof PayoutError && again.code === "payout_out");
      assert.equal(again.detail.out?.key, out.key);
      assert.deepEqual(await withdrawals.check(), [{ paymentHash: out.key, state: "pending" }]);
      payer.settle(out.key);
      assert.deepEqual(await withdrawals.check(), [{ paymentHash: out.key, state: "settled" }]);
      assert.deepEqual(payer.calls.map((c) => c.method), ["keysend", "keysendStatus", "keysendStatus"], "read, never sent again");
      assert.equal((await ledger.payoutOf(out.key))!.state, "paid");
      assert.equal(await total(), 10_000_000 - 3_003_000, "charged the fee taken, not its cap");
      assert.equal((await books()).wallet!.differenceMsat, 0);
    });

    it("failed is given back; a daemon that never took it (404) fails it too", async () => {
      await payouts.saveSettings(ON);
      await earned(10_000_000);
      payer.outcomes.push("failed");
      const failed = await payouts.pay(ACTOR, { address: ADDRESS, msat: 2_000_000 });
      assert.deepEqual([failed.state, failed.feeMsat, failed.error], ["failed", 0, "no route found"]);
      assert.equal(await total(), 10_000_000, "the reserve is the worker's again");
      assert.deepEqual([(await ledger.payoutOf(failed.key))!.state, (await ledger.payoutOf(failed.key))!.why], ["failed", "no route found"]);
      // Pending, then the daemon has no record of it: it never took it.
      payer.outcomes.push("pending");
      const lost = await payouts.pay(ACTOR, { address: ADDRESS, msat: 2_000_000 });
      payer.forget(lost.key);
      assert.deepEqual(await withdrawals.check(), [{ paymentHash: lost.key, state: "failed", error: "the daemon never took this payment" }]);
      assert.equal(await total(), 10_000_000);
      assert.equal((await books()).wallet!.differenceMsat, 0, "nothing left the wallet");
    });

    it("a crash between the reserve and the send: the minute's check fails it a minute after the reserve", async () => {
      await payouts.saveSettings(ON);
      await earned(10_000_000);
      const key = "f".repeat(64);
      assert.ok((await ledger.reservePayout({ key, worker: ACTOR, address: ADDRESS, msat: 2_000_000, maxFeeMsat: 10_000, at: now })).ok);
      now += ORPHAN_AFTER_MS - 1;
      await withdrawals.check();
      assert.equal((await ledger.payoutOf(key))!.state, "out", "not yet: it may be on its way to the pending list");
      now += 2;
      await withdrawals.check();
      const p = (await ledger.payoutOf(key))!;
      assert.deepEqual([p.state, p.why], ["failed", "never sent: the server stopped between the reserve and the send"]);
      assert.equal(await total(), 10_000_000);
      assert.equal(payer.calls.length, 0);
    });

    it("stale a day after it was sent: no more reading, and a person records it as paid, with the fee they give, or drops it", async () => {
      await payouts.saveSettings(ON);
      await earned(20_000_000);
      payer.outcomes.push("pending");
      const one = await payouts.pay(ACTOR, { address: ADDRESS, msat: 2_000_000 });
      now += KEYSEND_STALE_MS + 1;
      const reads = payer.calls.length;
      assert.deepEqual(await withdrawals.check(), [{ paymentHash: one.key, state: "unread", error: "stale: still pending a day after it was sent; record it as paid or drop it" }]);
      assert.equal(payer.calls.length, reads, "nobody reads it unasked");
      assert.equal((await payouts.view(ACTOR, { address: ADDRESS, balance: await ledger.payeeBalance(ACTOR, { now }) })).out?.stale, true);
      assert.deepEqual((await payouts.list({ state: "stale" })).payouts.map((p) => [p.key, p.stale]), [[one.key, true]]);
      const paid = await payouts.resolve(one.key, { action: "paid", feeMsat: 3_000 }, "admin-1");
      assert.deepEqual([paid.action, paid.payout.state, paid.payout.feeMsat, paid.payout.by], ["paid", "paid", 3_000, "admin-1"]);
      assert.equal(await total(), 20_000_000 - 2_003_000);
      assert.equal((await ledger.withdrawalOf(one.key))!.subject, "worker");
      // Another, dropped: it never reached the worker, whose balance it is again.
      payer.outcomes.push("pending");
      const two = await payouts.pay(ACTOR, { address: ADDRESS, msat: 2_000_000 });
      now += KEYSEND_STALE_MS + 1;
      const dropped = await payouts.resolve(two.key, { action: "drop" }, "admin-2");
      assert.deepEqual([dropped.payout.state, dropped.payout.by], ["failed", "admin-2"]);
      assert.match(dropped.payout.why!, /dropped by admin-2/);
      assert.equal(await total(), 20_000_000 - 2_003_000);
      await assert.rejects(payouts.resolve("0".repeat(64), { action: "drop" }), refusal("unknown_payout"));
    });

    it("where it goes: only the session's address, whose pubkey is the actor's own key", async () => {
      await payouts.saveSettings(ON);
      await earned(10_000_000);
      const pay = (actor: string, address?: string) => payouts.pay(actor, { ...(address !== undefined ? { address } : {}), msat: 2_000_000 });
      await assert.rejects(pay(ACTOR), refusal("no_address"), "none: an older Peel, a plain browser");
      await assert.rejects(pay(ACTOR, `02${"e".repeat(64)}_03${"d".repeat(64)}_1`), refusal("no_address"), "another key's");
      await assert.rejects(pay(ACTOR, `${X}_03${"d".repeat(64)}_1`), refusal("no_address"), "not an address");
      await assert.rejects(pay("ada-1", ADDRESS), refusal("no_address"), "a member has no sign-in key");
      await assert.rejects(pay(`p256:${X}`, ADDRESS), refusal("no_address"));
      assert.equal(payer.calls.length, 0);
      // Either parity of the same key is the key's.
      assert.ok(addressIsActors(ACTOR, `03${X}_03${"d".repeat(64)}_1`));
      assert.equal((await pay(ACTOR, ` ${ADDRESS.toUpperCase()} `)).state, "settled");
      assert.equal(payer.keysends()[0]!.address, ADDRESS);
    });

    it("the order of the checks: the address, the switch, a wallet that can keysend, then the solvency", async () => {
      await earned(10_000_000);
      await assert.rejects(payouts.pay(ACTOR, { msat: 2_000_000 }), refusal("no_address"), "before the switch");
      await assert.rejects(payouts.pay(ACTOR, { address: ADDRESS, msat: 2_000_000 }), refusal("payouts_off"));
      await payouts.saveSettings(ON);
      current = null;
      await assert.rejects(payouts.pay(ACTOR, { address: ADDRESS, msat: 2_000_000 }), refusal("no_pay_credential"));
      assert.equal((await payouts.view(ACTOR, { address: ADDRESS, balance: await ledger.payeeBalance(ACTOR, { now }) })).why, "no_wallet");
      // An NWC wallet: no route hints, so no keysend.
      current = { provider: "nwc", id: "nwc:x", capsFee: false, minFeeMsat: () => 0, pay: () => Promise.reject(new Error("no")), status: () => Promise.reject(new Error("no")) };
      await assert.rejects(payouts.pay(ACTOR, { address: ADDRESS, msat: 2_000_000 }), refusal("no_keysend"));
      assert.equal((await payouts.view(ACTOR, { address: ADDRESS, balance: await ledger.payeeBalance(ACTOR, { now }) })).why, "no_keysend");
      assert.equal((await ledger.payouts()).length, 0, "nothing reserved");
      // A daemon without the route: found at the send, which fails and gives the reserve back.
      current = payer;
      payer.noKeysend = true;
      await assert.rejects(payouts.pay(ACTOR, { address: ADDRESS, msat: 2_000_000 }), refusal("no_keysend"));
      assert.equal(await total(), 10_000_000);
      assert.deepEqual((await ledger.payouts()).map((p) => p.state), ["failed"]);
      payer.noKeysend = false;
      // The wallet: unreadable, then short of what every worker is owed.
      wallet.down();
      await assert.rejects(payouts.pay(ACTOR, { address: ADDRESS, msat: 2_000_000 }), refusal("wallet_unavailable"));
      wallet.down(false);
      await earned(95_000_000, { worker: `secp:${"1".repeat(64)}` });
      await assert.rejects(payouts.pay(ACTOR, { address: ADDRESS, msat: 2_000_000 }), refusal("wallet_short"), "short: everybody waits alike");
      wallet.credit(10_000_000);
      assert.equal((await payouts.pay(ACTOR, { address: ADDRESS, msat: 2_000_000 })).state, "settled");
      const view = await payouts.view(ACTOR, { address: ADDRESS, balance: await ledger.payeeBalance(ACTOR, { now }) });
      assert.deepEqual([view.on, view.why], [true, undefined], "on says nothing of the wallet's balance: that is asked at a withdrawal");
    });

    it("the minimum, the balance and the day's caps, each with the most the worker may ask now", async () => {
      await payouts.saveSettings({ ...ON, workerDaySats: 50_000, serverDaySats: 60_000 });
      await earned(80_000_000);
      const ask = (msat: number) => payouts.pay(ACTOR, { address: ADDRESS, msat }).catch((e: unknown) => e as PayoutError);
      const r1 = await ask(999_999);
      assert.deepEqual([r1 instanceof PayoutError && r1.code, (r1 as PayoutError).detail.maxMsat], ["below_minimum", 50_000_000]);
      const r2 = await ask(50_000_001);
      assert.deepEqual([(r2 as PayoutError).code, (r2 as PayoutError).detail.maxMsat], ["over_worker_day", 50_000_000]);
      assert.match((r2 as PayoutError).message, /at most 50,000 sats now \(maxMsat 50000000\)/);
      const view = await payouts.view(ACTOR, { address: ADDRESS, balance: await ledger.payeeBalance(ACTOR, { now }) });
      assert.deepEqual({ ...view }, { on: true, minMsat: 1_000_000, dayLeftMsat: 50_000_000, maxMsat: 50_000_000 });
      assert.equal((await ask(view.maxMsat)).state, "settled", "the most it says may be asked, is paid");
      // Another worker meets the server's day.
      const OTHER = `secp:${"2".repeat(64)}`;
      const otherAddress = `03${"2".repeat(64)}_03${"d".repeat(64)}_5`;
      await earned(30_000_000, { worker: OTHER });
      wallet.credit(100_000_000);
      const r3 = await payouts.pay(OTHER, { address: otherAddress, msat: 10_000_001 }).catch((e: unknown) => e as PayoutError);
      assert.deepEqual([(r3 as PayoutError).code, (r3 as PayoutError).detail.maxMsat], ["over_server_day", 10_000_000]);
      // And their own balance, the fee cap beside it.
      await payouts.saveSettings({ ...ON });
      const r4 = await payouts.pay(OTHER, { address: otherAddress, msat: 30_000_000 }).catch((e: unknown) => e as PayoutError);
      assert.equal((r4 as PayoutError).code, "over_balance");
      const max = (r4 as PayoutError).detail.maxMsat!;
      assert.ok(max + Math.max(5_000, Math.floor(max * 0.005)) <= 30_000_000);
      assert.equal((await payouts.pay(OTHER, { address: otherAddress, msat: max })).state, "settled", "withdraw all");
      assert.equal(await total(OTHER), 30_000_000 - max - Math.ceil(max * 0.001));
    });

    it("ruling 7: an admin's Withdraw and a purchase are refused when they would leave the wallet short of what workers are owed; a retry of one out only reads", async () => {
      await earned(90_000_000);
      // 100 000 sats held, 90 000 owed: 10 000 sats are the seller's.
      const big = invoice(10_000_000);
      const refusedSend = (code: string) => (e: unknown) => e instanceof WithdrawError && e.code === code && e.status === 409;
      await assert.rejects(withdrawals.withdraw({ invoice: big.invoice, msat: 10_000_000 }), refusedSend("short_of_workers"), "the amount and its whole fee cap");
      await assert.rejects(withdrawals.withdraw({ invoice: big.invoice, msat: 10_000_000, purpose: "purchase" }), refusedSend("short_of_workers"), "a purchase too (ruled)");
      assert.equal(payer.calls.length, 0, "nothing went out");
      wallet.down();
      await assert.rejects(withdrawals.withdraw({ invoice: invoice(1_000_000).invoice, msat: 1_000_000 }), refusedSend("balance_unknown"));
      wallet.down(false);
      // What leaves enough goes; the worker is still covered.
      payer.outcomes.push("pending");
      const small = invoice(5_000_000);
      assert.equal((await withdrawals.withdraw({ invoice: small.invoice, msat: 5_000_000 })).state, "pending");
      // The wallet falls short now; a retry of the one out reads it and checks nothing.
      wallet.credit(-20_000_000);
      assert.equal((await withdrawals.withdraw({ invoice: small.invoice, msat: 5_000_000 })).state, "pending");
      assert.deepEqual(payer.calls.map((c) => c.method), ["pay", "status"]);
      // A worker's send is never an invoice.
      await assert.rejects(withdrawals.withdraw({ invoice: invoice(1_000_000).invoice, msat: 1_000_000, purpose: "worker" }), (e: unknown) => e instanceof WithdrawError && e.code === "worker_send");
    });

    it("with nothing owed to workers, an admin's Withdraw never asks the wallet's balance", async () => {
      const inv = invoice(2_000_000);
      assert.equal((await withdrawals.withdraw({ invoice: inv.invoice, msat: 2_000_000 })).state, "settled");
      assert.ok(!wallet.calls.some((c) => c.method === "balance"));
    });
  });
}
