import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  chargeFor,
  CREDIT_LIFETIME_MS,
  dayOf,
  EXPIRED_SUBJECT,
  FREE,
  isFree,
  LedgerError,
  ledgerPath,
  openLedger,
  priceOf,
  reserveFor,
  usdToMicros,
  type EarningsRow,
  type LedgerEntry,
  type LedgerStore,
  type Price,
} from "./ledger.js";
import { MemoryLedgerStore } from "./ledger-memory.js";
import { packagePrefixOf } from "../package-lookup.js";

/**
 * The ledger's spec (plans/paid-runs.md §5), as tests: one suite, run over
 * the SQLite file and the memory twin. An implementation that needs a
 * different assertion here changed the contract.
 */

const $ = usdToMicros;
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-11-10T12:00:00Z");
const YEAR = CREDIT_LIFETIME_MS;

describe("the pricing rule", () => {
  const cases: Array<[string, Price, number, number]> = [
    ["free", FREE, 0.8, 0],
    ["fixed", priceOf({ base: 0.5 }), 0.8, 0.5],
    ["fixed, whatever it cost", priceOf({ base: 0.5 }), 40, 0.5],
    ["metered", priceOf({ markup: 1.5 }), 0.8, 1.2],
    ["both", priceOf({ base: 0.1, markup: 1.2 }), 0.8, 1.06],
    ["a markup of 1 is the cost", priceOf({ markup: 1 }), 0.123456, 0.123456],
  ];
  for (const [name, price, cost, charge] of cases) {
    it(`${name}: charge = base + markup × cost`, () => {
      assert.equal(chargeFor(price, $(cost), "success"), $(charge));
      assert.equal(chargeFor(price, $(cost), "cancelled"), $(charge), "a cancelled run is charged by the rule");
    });
  }

  it("a failed run is charged its cost, no markup, no base, never more than the reserve", () => {
    const price = priceOf({ base: 0.1, markup: 2 });
    assert.equal(chargeFor(price, $(0.3), "error", $(5)), $(0.3));
    assert.equal(chargeFor(price, $(9), "error", $(5)), $(5));
    assert.equal(chargeFor(FREE, $(0.3), "error", $(5)), $(0.3), "even on a free price: the seller breaks even");
  });

  it("the reserve is base + markup × the cap, and a run within its cap is never charged past it", () => {
    const price = priceOf({ base: 0.1, markup: 1.5 });
    assert.equal(reserveFor(price, $(5)), $(7.6));
    assert.equal(reserveFor(priceOf({ markup: 1.5 }), $(100)), $(150), "the server's default cap at 1.5 needs $150");
    for (const markup of [1.1, 1.3, 1.7, 2.9, 0.333]) {
      const p = priceOf({ base: 0.07, markup });
      const cap = 1_234_567;
      for (const cost of [0, 1, 999_999, cap - 1, cap]) assert.ok(chargeFor(p, cost, "success") <= reserveFor(p, cap), `${markup} × ${cost}`);
    }
  });

  it("prices are dollars; refused when negative", () => {
    assert.deepEqual(priceOf({}), FREE);
    assert.ok(isFree(priceOf({ base: 0, markup: 0 })));
    assert.throws(() => priceOf({ base: -1 }), RangeError);
    assert.throws(() => priceOf({ markup: -0.5 }), RangeError);
    assert.throws(() => usdToMicros(Number.NaN), RangeError);
  });
});

// ── The store ─────────────────────────────────────────────────────────────

interface Impl {
  name: string;
  make(dir: string): Promise<LedgerStore>;
  /** Close and open again on the same data: what a restart does. */
  reopen?(store: LedgerStore, dir: string): Promise<LedgerStore>;
}

const impls: Impl[] = [
  {
    name: "SqliteLedgerStore",
    make: (dir) => openLedger({ dataDir: dir }),
    reopen: async (store, dir) => {
      await store.close();
      return openLedger({ dataDir: dir });
    },
  },
  { name: "MemoryLedgerStore", make: async () => new MemoryLedgerStore() },
];

const RATE = 73_176;
const W = "workflow:acme/voxel/character";

let tokenSeq = 0;
/** A token bought for `usd` dollars at `at`: an invoice for the sats those
 *  dollars are at RATE, settled in full unless `settled` says otherwise. */
async function buy(
  store: LedgerStore,
  usd: number,
  o: { at?: number; carryFrom?: string; settled?: number; id?: string; expires?: number } = {},
) {
  const at = o.at ?? T0;
  const id = o.id ?? `tok${++tokenSeq}`;
  const askedMsat = Math.round((usd / RATE) * 1e8) * 1000;
  return store.firstUse({
    id,
    paymentHash: `hash-${id}`,
    askedMsat,
    settledMsat: Math.round(askedMsat * (o.settled ?? 1)),
    credit: $(usd),
    rate: RATE,
    expires: o.expires ?? at + YEAR,
    carryFrom: o.carryFrom,
    at,
  });
}

const price = priceOf({ base: 0.5, markup: 1.5 });

for (const impl of impls) {
  describe(`LedgerStore conformance: ${impl.name}`, () => {
    let dir: string;
    let store: LedgerStore;
    beforeEach(async () => {
      dir = join(tmpdir(), `strut-ledger-${randomUUID()}`);
      await mkdir(dir, { recursive: true });
      store = await impl.make(dir);
    });
    afterEach(async () => {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    });

    // ── first use ─────────────────────────────────────────────────────

    it("first use writes the token and its payment; a second first use writes nothing", async () => {
      const first = await buy(store, 10, { id: "a" });
      assert.equal(first.created, true);
      assert.equal(first.credited, $(10));
      assert.deepEqual(
        { paid: first.token.paid, spent: first.token.spent, held: first.token.held, free: first.token.free, rate: first.token.rate },
        { paid: $(10), spent: 0, held: 0, free: $(10), rate: RATE },
      );
      assert.equal(first.token.expires, T0 + YEAR);
      const again = await buy(store, 10, { id: "a" });
      assert.equal(again.created, false);
      assert.equal(again.credited, 0);
      assert.equal((await store.token("a"))!.paid, $(10), "never credited twice");
      const entries = await store.entries("a");
      assert.equal(entries.length, 1);
      assert.equal(entries[0].kind, "payment");
      assert.equal(entries[0].usd, $(10));
      assert.equal(entries[0].msat, first.token.msat);
      assert.equal(entries[0].ref, "hash-a");
    });

    it("a payment hash buys one token", async () => {
      await buy(store, 10, { id: "a" });
      await assert.rejects(
        store.firstUse({ id: "b", paymentHash: "hash-a", askedMsat: 1000, settledMsat: 1000, credit: 1, rate: RATE, expires: T0 + YEAR, at: T0 }),
        (e: unknown) => e instanceof LedgerError && e.code === "payment_reused",
      );
      assert.equal(await store.token("b"), undefined);
    });

    it("a short payment is credited in proportion to what settled; an overpayment buys no more than the quote", async () => {
      const short = await buy(store, 10, { settled: 0.75 });
      assert.equal(short.credited, $(7.5));
      assert.equal(short.token.free, $(7.5));
      const over = await buy(store, 10, { settled: 1.5 });
      assert.equal(over.credited, $(10));
      await assert.rejects(buy(store, 10, { settled: 0 }), RangeError);
    });

    // ── holds ──────────────────────────────────────────────────────────

    it("a hold sets the reserve aside; one short of it is refused with what is free", async () => {
      await buy(store, 10, { id: "a" });
      const h = await store.hold({ token: "a", reserve: $(7.5), subject: W, runId: "r1", at: T0 });
      assert.ok(h.ok && !h.existing && h.runId === "r1" && h.reserve === $(7.5));
      const t = (await store.token("a"))!;
      assert.equal(t.held, $(7.5));
      assert.equal(t.free, $(2.5));
      const short = await store.hold({ token: "a", reserve: $(2.5) + 1, subject: W, runId: "r2", at: T0 });
      assert.deepEqual(short, { ok: false, reason: "short", free: $(2.5) });
      assert.deepEqual(await store.hold({ token: "nope", reserve: 1, subject: W, runId: "r3", at: T0 }), { ok: false, reason: "unknown", free: 0 });
      const [last] = await store.entries("a");
      assert.equal(last.kind, "hold");
      assert.equal(last.usd, $(7.5));
      assert.equal(last.runId, "r1");
      assert.equal(last.subject, W);
    });

    it("twenty holds at once on a token that covers three: three succeed, never overdrawn", async () => {
      await buy(store, 10, { id: "a" });
      const reserve = $(3);
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => store.hold({ token: "a", reserve, subject: W, runId: `r${i}`, at: T0 })),
      );
      assert.equal(results.filter((r) => r.ok).length, 3);
      assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "short"));
      const t = (await store.token("a"))!;
      assert.equal(t.held, 3 * reserve);
      assert.equal(t.free, $(1));
      assert.equal((await store.openHolds()).length, 3);
    });

    it("a key dedupes a run in flight only: once its run is charged, the same key holds again", async () => {
      await buy(store, 10, { id: "a" });
      const first = await store.hold({ token: "a", reserve: $(2), subject: W, runId: "r1", key: "k", at: T0 });
      assert.ok(first.ok && !first.existing);
      await store.charge({ token: "a", runId: "r1", subject: W, cost: $(1), outcome: "success", price, at: T0 });
      assert.equal(await store.findHold("a", W, "k"), undefined, "the charged hold is no longer open");
      const again = await store.hold({ token: "a", reserve: $(2), subject: W, runId: "r2", key: "k", at: T0 });
      assert.ok(again.ok);
      assert.equal(again.existing, false, "a new run, not the one that ended");
      assert.equal(again.runId, "r2");
      assert.equal((await store.findHold("a", W, "k"))!.runId, "r2");
      const dup = await store.hold({ token: "a", reserve: $(2), subject: W, runId: "r3", key: "k", at: T0 });
      assert.ok(dup.ok && dup.existing && dup.runId === "r2", "while r2 is in flight the key returns it");
      assert.equal((await store.token("a"))!.held, $(2));
    });

    it("a key is one item's: the same key for another subject holds anew", async () => {
      await buy(store, 10, { id: "a" });
      const one = await store.hold({ token: "a", reserve: $(2), subject: W, runId: "r1", key: "k", at: T0 });
      const other = await store.hold({ token: "a", reserve: $(2), subject: "workflow:other", runId: "r2", key: "k", at: T0 });
      assert.ok(one.ok && other.ok && !other.existing && other.runId === "r2");
      assert.equal((await store.token("a"))!.held, $(4));
    });

    it("a run is never charged more than its reserve, whatever it cost; the rest of the token's credit stays the buyer's", async () => {
      await buy(store, 10, { id: "a" });
      await store.hold({ token: "a", reserve: $(2), subject: W, runId: "r1", at: T0 });
      const c = await store.charge({ token: "a", runId: "r1", subject: W, cost: $(5), outcome: "success", price, at: T0 });
      assert.equal(c.charged, $(2), "the reserve, not base + markup × $5");
      assert.ok(c.due > $(2), "the rule's amount is still reported");
      assert.equal((await store.token("a"))!.free, $(8));
    });

    it("the same key returns the first hold and its run, and sets nothing more aside", async () => {
      await buy(store, 10, { id: "a" });
      const first = await store.hold({ token: "a", reserve: $(2), subject: W, runId: "r1", key: "k", at: T0 });
      const again = await store.hold({ token: "a", reserve: $(2), subject: W, runId: "r2", key: "k", at: T0 });
      assert.ok(first.ok && again.ok);
      assert.equal(again.existing, true);
      assert.equal(again.runId, "r1");
      assert.equal(again.seq, first.seq);
      assert.equal((await store.token("a"))!.held, $(2));
      assert.equal((await store.findHold("a", W, "k"))!.runId, "r1");
      assert.equal(await store.findHold("a", W, "other"), undefined);
      const sameRun = await store.hold({ token: "a", reserve: $(2), subject: W, runId: "r1", at: T0 });
      assert.ok(sameRun.ok && sameRun.existing, "one hold per run");
      assert.equal((await store.token("a"))!.held, $(2));
    });

    // ── charges ────────────────────────────────────────────────────────

    it("a run's end frees the hold and charges base + markup × cost", async () => {
      await buy(store, 20, { id: "a" });
      const reserve = reserveFor(price, $(5));
      await store.hold({ token: "a", reserve, subject: W, runId: "r1", at: T0 });
      const c = await store.charge({ token: "a", runId: "r1", subject: W, cost: $(2), outcome: "success", price, at: T0 + 1000 });
      assert.deepEqual(c, { seq: c.seq, charged: $(3.5), due: $(3.5), reserve, existing: false });
      const t = (await store.token("a"))!;
      assert.deepEqual({ held: t.held, spent: t.spent, free: t.free }, { held: 0, spent: $(3.5), free: $(16.5) });
      const [entry] = await store.entries("a");
      assert.deepEqual(
        { kind: entry.kind, usd: entry.usd, cost: entry.cost, outcome: entry.outcome, runId: entry.runId, subject: entry.subject },
        { kind: "charge", usd: $(3.5), cost: $(2), outcome: "success", runId: "r1", subject: W },
      );
      assert.deepEqual(await store.today(W, { now: T0 }), { key: W, calls: 1, failed: 0, earned: $(3.5), cost: $(2) });
      const again = await store.charge({ token: "a", runId: "r1", subject: W, cost: $(2), outcome: "success", price, at: T0 + 2000 });
      assert.equal(again.existing, true);
      assert.equal(again.charged, $(3.5));
      assert.equal((await store.token("a"))!.spent, $(3.5), "charged once");
      assert.equal((await store.today(W, { now: T0 })).calls, 1);
      assert.deepEqual(await store.openHolds(), []);
      // The run's charge reads back by its run, for the launcher's view.
      const read = (await store.chargeOf("r1", W))!;
      assert.deepEqual({ kind: read.kind, usd: read.usd, token: read.token, seq: read.seq }, { kind: "charge", usd: $(3.5), token: "a", seq: c.seq });
      assert.equal(await store.chargeOf("r1", "workflow:other"), undefined);
      assert.equal(await store.chargeOf("r9", W), undefined);
      await store.charge({ runId: "free1", subject: W, cost: $(1), outcome: "success", price: FREE, at: T0 });
      assert.equal((await store.chargeOf("free1", W))!.usd, 0, "a free run's charge of nothing");
    });

    it("a failed run is charged its cost and no more than the reserve; a cancelled one by the rule", async () => {
      await buy(store, 50, { id: "a" });
      const reserve = reserveFor(price, $(5));
      for (const runId of ["f1", "f2", "c1"]) await store.hold({ token: "a", reserve, subject: W, runId, at: T0 });
      const f1 = await store.charge({ token: "a", runId: "f1", subject: W, cost: $(1), outcome: "error", price, at: T0 });
      assert.equal(f1.charged, $(1));
      const f2 = await store.charge({ token: "a", runId: "f2", subject: W, cost: $(40), outcome: "error", price, at: T0 });
      assert.equal(f2.charged, reserve);
      const c1 = await store.charge({ token: "a", runId: "c1", subject: W, cost: $(1), outcome: "cancelled", price, at: T0 });
      assert.equal(c1.charged, $(2));
      assert.deepEqual(await store.today(W, { now: T0 }), { key: W, calls: 3, failed: 2, earned: $(1) + reserve + $(2), cost: $(42) });
    });

    it("a charge never takes more than the token holds; the rest is the seller's", async () => {
      const reserve = reserveFor(price, $(5));
      await buy(store, 8, { id: "a" });
      await store.hold({ token: "a", reserve, subject: W, runId: "r1", at: T0 });
      const c = await store.charge({ token: "a", runId: "r1", subject: W, cost: $(30), outcome: "success", price, at: T0 });
      assert.equal(c.due, $(45.5));
      assert.equal(c.charged, $(8));
      const t = (await store.token("a"))!;
      assert.deepEqual({ held: t.held, spent: t.spent, free: t.free }, { held: 0, spent: $(8), free: 0 });
      const day = await store.today(W, { now: T0 });
      assert.equal(day.earned, $(8));
      assert.equal(day.cost, $(30), "the margin shows the loss");
    });

    it("a charge needs its hold, on the subject it was held for", async () => {
      await buy(store, 10, { id: "a" });
      await store.hold({ token: "a", reserve: $(1), subject: W, runId: "r1", at: T0 });
      await assert.rejects(store.charge({ token: "a", runId: "r9", subject: W, cost: 0, outcome: "success", price }), (e: unknown) => e instanceof LedgerError && e.code === "no_hold");
      await assert.rejects(store.charge({ token: "zz", runId: "r1", subject: W, cost: 0, outcome: "success", price }), (e: unknown) => e instanceof LedgerError && e.code === "unknown_token");
      await assert.rejects(store.charge({ token: "a", runId: "r1", subject: "step:x/y/z", cost: 0, outcome: "success", price }), (e: unknown) => e instanceof LedgerError && e.code === "subject_mismatch");
      assert.equal((await store.token("a"))!.held, $(1), "a refused charge changes nothing");
    });

    it("a free run is a charge of nothing with no token, counted in daily with its cost", async () => {
      const c = await store.charge({ runId: "r1", subject: W, cost: $(0.4), outcome: "success", price: FREE, at: T0 });
      assert.deepEqual(c, { seq: c.seq, charged: 0, due: 0, reserve: 0, existing: false });
      await store.charge({ runId: "r2", subject: W, cost: $(0.1), outcome: "error", price: FREE, at: T0 });
      const again = await store.charge({ runId: "r1", subject: W, cost: $(0.4), outcome: "success", price: FREE, at: T0 });
      assert.equal(again.existing, true);
      assert.deepEqual(await store.today(W, { now: T0 }), { key: W, calls: 2, failed: 1, earned: 0, cost: $(0.5) });
    });

    // ── carry ──────────────────────────────────────────────────────────

    it("a token bought presenting another inherits its free credit, and the first is refused", async () => {
      await buy(store, 10, { id: "a" });
      await store.hold({ token: "a", reserve: $(2), subject: W, runId: "r1", at: T0 });
      await store.charge({ token: "a", runId: "r1", subject: W, cost: 0, outcome: "success", price, at: T0 });
      const b = await buy(store, 5, { id: "b", carryFrom: "a", at: T0 + DAY });
      assert.equal(b.carried, $(9.5));
      assert.equal(b.token.paid, $(14.5));
      assert.equal(b.token.free, $(14.5));
      assert.equal(b.token.expires, T0 + DAY + YEAR, "the new token's year");
      const a = (await store.token("a"))!;
      assert.equal(a.successor, "b");
      assert.equal(a.free, 0);
      const [aCarry] = await store.entries("a");
      const [bCarry] = await store.entries("b");
      assert.deepEqual({ kind: aCarry.kind, usd: aCarry.usd, ref: aCarry.ref }, { kind: "carry", usd: -$(9.5), ref: "b" });
      assert.deepEqual({ kind: bCarry.kind, usd: bCarry.usd, ref: bCarry.ref }, { kind: "carry", usd: $(9.5), ref: "a" });
      assert.deepEqual(await store.hold({ token: "a", reserve: 1, subject: W, runId: "r2", at: T0 + DAY }), { ok: false, reason: "carried", free: 0, successor: "b" });
      const c = await buy(store, 1, { id: "c", carryFrom: "a", at: T0 + DAY });
      assert.equal(c.carried, 0, "a token is carried from once");
      assert.equal((await store.token("a"))!.successor, "b");
      assert.deepEqual(await store.outstanding(), { tokens: 2, usd: $(15.5), held: 0 });
    });

    it("credit freed late, by a run of the first token that was still in flight, reaches the live successor", async () => {
      const reserve = reserveFor(price, $(5));
      await buy(store, 10, { id: "a" });
      await store.hold({ token: "a", reserve, subject: W, runId: "r1", at: T0 });
      const b = await buy(store, 5, { id: "b", carryFrom: "a", at: T0 + 10 });
      assert.equal(b.carried, $(10) - reserve, "what is held stays for its run");
      const c = await buy(store, 5, { id: "c", carryFrom: "b", at: T0 + 20 });
      assert.equal(c.carried, $(5) + $(10) - reserve);
      const charge = await store.charge({ token: "a", runId: "r1", subject: W, cost: $(1), outcome: "success", price, at: T0 + 30 });
      assert.equal(charge.charged, $(2));
      assert.deepEqual(charge.carried, { to: "c", usd: reserve - $(2) });
      const a = (await store.token("a"))!;
      assert.deepEqual({ held: a.held, free: a.free, spent: a.spent }, { held: 0, free: 0, spent: $(10) });
      assert.equal((await store.token("c"))!.free, $(20) - $(2), "all bought, less the one charge");
    });

    it("nothing is carried from an unknown or expired token", async () => {
      const b = await buy(store, 5, { id: "b", carryFrom: "nope" });
      assert.equal(b.carried, 0);
      await buy(store, 5, { id: "old", at: T0 - 2 * YEAR });
      const c = await buy(store, 5, { id: "c", carryFrom: "old" });
      assert.equal(c.carried, 0);
      assert.equal((await store.token("old"))!.successor, undefined);
    });

    // ── expiry ─────────────────────────────────────────────────────────

    it("the sweep closes a token past its year; what was left is earned under `expired`", async () => {
      await buy(store, 10, { id: "a" });
      await buy(store, 10, { id: "b", at: T0 + DAY });
      assert.deepEqual(await store.hold({ token: "a", reserve: 1, subject: W, runId: "r0", at: T0 + YEAR }), { ok: false, reason: "expired", free: $(10) });
      const swept = await store.sweep({ now: T0 + YEAR + 1 });
      assert.deepEqual(swept, { closed: 1, expired: $(10) });
      const a = (await store.token("a"))!;
      assert.equal(a.closed, T0 + YEAR + 1);
      assert.equal(a.free, 0);
      const [expiry] = await store.entries("a");
      assert.deepEqual({ kind: expiry.kind, usd: expiry.usd, subject: expiry.subject }, { kind: "expiry", usd: $(10), subject: EXPIRED_SUBJECT });
      assert.deepEqual(await store.today(EXPIRED_SUBJECT, { now: T0 + YEAR + 1 }), { key: EXPIRED_SUBJECT, calls: 0, failed: 0, earned: $(10), cost: 0 });
      assert.equal((await store.hold({ token: "a", reserve: 1, subject: W, runId: "r1", at: T0 + YEAR + 2 })).ok, false);
      assert.deepEqual(await store.sweep({ now: T0 + YEAR + 3 }), { closed: 0, expired: 0 }, "once");
      assert.deepEqual(await store.outstanding(), { tokens: 1, usd: $(10), held: 0 });
    });

    it("a run in flight when its token expired: what its charge frees expires too", async () => {
      await buy(store, 10, { id: "a" });
      await store.hold({ token: "a", reserve: $(4), subject: W, runId: "r1", at: T0 + YEAR - 5 });
      assert.deepEqual(await store.sweep({ now: T0 + YEAR }), { closed: 1, expired: $(6) });
      const c = await store.charge({ token: "a", runId: "r1", subject: W, cost: $(1), outcome: "success", price, at: T0 + YEAR + 9 });
      assert.equal(c.charged, $(2));
      assert.equal(c.expired, $(2));
      const a = (await store.token("a"))!;
      assert.deepEqual({ held: a.held, free: a.free, spent: a.spent }, { held: 0, free: 0, spent: $(10) });
    });

    // ── withdrawals and reads ──────────────────────────────────────────

    it("a withdrawal is an entry; withdrawn and received read by day", async () => {
      await buy(store, 10, { id: "a", at: T0 });
      await buy(store, 5, { id: "b", at: T0 + DAY });
      await buy(store, 1, { id: "c", at: T0 + DAY + 60_000, settled: 0.5 });
      const w = await store.withdrawal({ msat: 5_000_000, feeMsat: 12_000, paymentHash: "out-1", actor: "evan", at: T0 + DAY });
      assert.deepEqual(
        { kind: w.kind, msat: w.msat, feeMsat: w.feeMsat, ref: w.ref, actor: w.actor, token: w.token },
        { kind: "withdrawal", msat: 5_000_000, feeMsat: 12_000, ref: "out-1", actor: "evan", token: undefined },
      );
      await store.withdrawal({ msat: 1_000_000, paymentHash: "out-2", at: T0 + DAY + 5 });
      assert.deepEqual(await store.withdrawn(), [{ day: dayOf(T0 + DAY), count: 2, msat: 6_000_000, feeMsat: 12_000 }]);
      const received = await store.received();
      assert.deepEqual(received.map((r) => [r.day, r.count, r.usd]), [[dayOf(T0), 1, $(10)], [dayOf(T0 + DAY), 2, $(5) + $(0.5)]]);
      const a = (await store.token("a"))!;
      assert.equal(received[0].msat, a.msat);
      assert.deepEqual(await store.received({ from: dayOf(T0 + DAY) }), received.slice(1));
      assert.deepEqual(await store.received({ to: dayOf(T0) }), received.slice(0, 1));
    });

    it("one withdrawal per payment hash: the same hash again writes nothing and answers the first", async () => {
      const first = await store.withdrawal({ msat: 5_000_000, feeMsat: 12_000, paymentHash: "out-1", actor: "evan", at: T0 });
      const again = await store.withdrawal({ msat: 5_000_000, feeMsat: 99_000, paymentHash: "out-1", actor: "someone", at: T0 + DAY });
      assert.deepEqual(again, first);
      assert.deepEqual(await store.withdrawalOf("out-1"), first);
      assert.equal(await store.withdrawalOf("out-2"), undefined);
      assert.deepEqual(await store.withdrawn(), [{ day: dayOf(T0), count: 1, msat: 5_000_000, feeMsat: 12_000 }]);
    });

    it("list: entries newest first, of one kind or one run, paged", async () => {
      await buy(store, 100, { id: "a", at: T0 });
      for (let i = 0; i < 4; i++) await store.hold({ token: "a", reserve: $(1), subject: W, runId: `r${i}`, at: T0 + i });
      await store.charge({ token: "a", runId: "r1", subject: W, cost: $(0.5), outcome: "success", price: { base: 0, markup: 1 }, at: T0 + 10 });
      await store.withdrawal({ msat: 1000, paymentHash: "out-1", at: T0 + 20 });
      const all = await store.list();
      assert.deepEqual(all.map((e) => e.kind), ["withdrawal", "charge", "hold", "hold", "hold", "hold", "payment"]);
      assert.deepEqual((await store.list({ kind: "hold", limit: 2 })).map((e) => e.runId), ["r3", "r2"]);
      assert.deepEqual((await store.list({ kind: "hold", before: all[3]!.seq })).map((e) => e.runId), ["r1", "r0"]);
      assert.deepEqual((await store.list({ runId: "r1" })).map((e) => e.kind), ["charge", "hold"]);
      assert.deepEqual((await store.list({ kind: "payment" })).map((e) => e.token), ["a"]);
    });

    it("a token's entries, newest 50 first, paged", async () => {
      await buy(store, 100, { id: "a" });
      for (let i = 0; i < 60; i++) await store.hold({ token: "a", reserve: 1, subject: W, runId: `r${i}`, at: T0 + i });
      const page = await store.entries("a");
      assert.equal(page.length, 50);
      assert.equal(page[0].runId, "r59");
      assert.ok(page.every((e, i) => i === 0 || e.seq < page[i - 1].seq));
      const next = await store.entries("a", { before: page[49].seq });
      assert.equal(next.length, 11);
      assert.equal(next[10].kind, "payment");
      assert.equal((await store.entries("a", { limit: 3 })).length, 3);
      assert.deepEqual(await store.entries("nope"), []);
    });

    it("earnings by item, day, package and in total equal the sums of the entries", async () => {
      const subjects = ["workflow:acme/voxel/character", "step:acme/voxel/rig", "workflow:acme/cve/feed", "workflow:solo", "step:acme/voxel_x/y"];
      await buy(store, 1000, { id: "a" });
      let n = 0;
      for (let d = 0; d < 4; d++) {
        for (const subject of subjects) {
          for (const outcome of ["success", "error", "cancelled"] as const) {
            const at = T0 + d * DAY + n;
            const runId = `r${n++}`;
            const cost = (n * 37_123) % 900_000;
            if (n % 4 === 0) {
              await store.charge({ runId, subject, cost, outcome, price: FREE, at });
              continue;
            }
            await store.hold({ token: "a", reserve: reserveFor(price, $(1)), subject, runId, at });
            await store.charge({ token: "a", runId, subject, cost, outcome, price, at });
          }
        }
      }
      await buy(store, 3, { id: "old", at: T0 - YEAR });
      await store.sweep({ now: T0 + DAY });

      const all: LedgerEntry[] = [];
      for (let page = await store.scan({ limit: 7 }); page.length; page = await store.scan({ after: page[page.length - 1].seq, limit: 7 })) all.push(...page);
      assert.deepEqual(all.map((e) => e.seq), all.map((_, i) => i + 1), "scan reads every entry once, in order");

      const sum = (key: (e: LedgerEntry) => string | undefined, keep: (e: LedgerEntry) => boolean = () => true): EarningsRow[] => {
        const rows = new Map<string, EarningsRow>();
        for (const e of all) {
          if ((e.kind !== "charge" && e.kind !== "expiry") || !keep(e)) continue;
          const k = key(e);
          if (!k) continue;
          const r = rows.get(k) ?? { key: k, calls: 0, failed: 0, earned: 0, cost: 0 };
          if (e.kind === "charge") {
            r.calls++;
            if (e.outcome === "error") r.failed++;
            r.cost += e.cost ?? 0;
          }
          r.earned += e.usd ?? 0;
          rows.set(k, r);
        }
        return [...rows.values()].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
      };
      const pkg = (e: LedgerEntry) => (e.subject!.includes(":") ? packagePrefixOf(e.subject!.slice(e.subject!.indexOf(":") + 1)) : undefined);

      assert.deepEqual(await store.earnings({ by: "item" }), sum((e) => e.subject));
      assert.deepEqual(await store.earnings({ by: "day" }), sum((e) => dayOf(e.at)));
      assert.deepEqual(await store.earnings({ by: "package" }), sum(pkg));
      assert.deepEqual(await store.earnings({ by: "total" }), sum(() => "total"));
      const voxel = (e: LedgerEntry) => pkg(e) === "acme/voxel";
      assert.deepEqual(await store.earnings({ by: "item", prefix: "acme/voxel" }), sum((e) => e.subject, voxel));
      assert.deepEqual(await store.earnings({ by: "total", prefix: "acme/voxel" }), sum(() => "total", voxel));
      const d1 = dayOf(T0 + DAY);
      const d2 = dayOf(T0 + 2 * DAY);
      const inRange = (e: LedgerEntry) => dayOf(e.at) >= d1 && dayOf(e.at) <= d2;
      assert.deepEqual(await store.earnings({ by: "item", from: d1, to: d2 }), sum((e) => e.subject, inRange));
      assert.deepEqual(await store.earnings({ by: "total", from: "2030-01-01" }), [{ key: "total", calls: 0, failed: 0, earned: 0, cost: 0 }]);

      const t = (await store.token("a"))!;
      const charged = all.filter((e) => e.kind === "charge" && e.token === "a").reduce((s, e) => s + (e.usd ?? 0), 0);
      assert.equal(t.spent, charged, "a token's spent is the sum of its charges");
    });

    it("recent: a subject's last 30 days of runs and its average charge", async () => {
      await buy(store, 100, { id: "a", at: T0 - 60 * DAY });
      const run = async (runId: string, at: number, cost: number) => {
        await store.hold({ token: "a", reserve: $(5), subject: W, runId, at });
        await store.charge({ token: "a", runId, subject: W, cost: $(cost), outcome: "success", price, at });
      };
      await run("old", T0 - 40 * DAY, 2);
      await run("r1", T0 - 29 * DAY, 1);
      await run("r2", T0 - DAY, 2);
      await run("r3", T0, 3);
      assert.deepEqual(await store.recent(W, { now: T0 }), { days: 30, runs: 3, failed: 0, earned: $(2) + $(3.5) + $(5), average: $(3.5) });
      assert.deepEqual(await store.recent("workflow:none", { now: T0 }), { days: 30, runs: 0, failed: 0, earned: 0, average: 0 });
      assert.equal((await store.today(W, { now: T0 })).cost, $(3), "the daily cap reads today's cost");
      assert.deepEqual(await store.today("workflow:none", { now: T0 }), { key: "workflow:none", calls: 0, failed: 0, earned: 0, cost: 0 });
    });

    it("open holds: every hold no charge has freed", async () => {
      await buy(store, 10, { id: "a" });
      await buy(store, 10, { id: "b" });
      await store.hold({ token: "a", reserve: $(1), subject: W, runId: "r1", key: "k1", at: T0 });
      await store.hold({ token: "a", reserve: $(1), subject: W, runId: "r2", at: T0 });
      await store.hold({ token: "b", reserve: $(1), subject: W, runId: "r3", at: T0 });
      await store.charge({ token: "a", runId: "r2", subject: W, cost: 0, outcome: "success", price, at: T0 });
      const open = await store.openHolds();
      assert.deepEqual(open.map((h) => [h.token, h.runId, h.reserve, h.key]), [["a", "r1", $(1), "k1"], ["b", "r3", $(1), undefined]]);
    });

    if (impl.reopen) {
      it("a restart loses no credit and no hold", async () => {
        await buy(store, 10, { id: "a" });
        await store.hold({ token: "a", reserve: $(4), subject: W, runId: "r1", key: "k", at: T0 });
        await store.hold({ token: "a", reserve: $(1), subject: W, runId: "r2", at: T0 });
        await store.charge({ token: "a", runId: "r2", subject: W, cost: 0, outcome: "success", price, at: T0 });
        const before = await store.token("a");
        store = await impl.reopen!(store, dir);
        assert.deepEqual(await store.token("a"), before);
        assert.deepEqual((await store.openHolds()).map((h) => h.runId), ["r1"]);
        assert.equal((await store.hold({ token: "a", reserve: $(4), subject: W, runId: "rx", key: "k", at: T0 })).ok, true);
        assert.equal((await store.findHold("a", W, "k"))!.runId, "r1");
        const c = await store.charge({ token: "a", runId: "r1", subject: W, cost: $(1), outcome: "success", price, at: T0 });
        assert.equal(c.charged, $(2));
        assert.equal((await buy(store, 10, { id: "a" })).created, false);
        assert.equal((await store.today(W, { now: T0 })).calls, 2);
      });
    }
  });
}

describe("the ledger file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(tmpdir(), `strut-ledger-file-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("lives at <dataDir>/payments/ledger.db in an owner-only folder; close() folds the WAL", async () => {
    const store = await openLedger({ dataDir: dir });
    await buy(store, 10, { id: "a" });
    const file = ledgerPath(dir);
    assert.equal(file, join(dir, "payments", "ledger.db"));
    assert.equal(statSync(join(dir, "payments")).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(existsSync(`${file}-wal`), "WAL while open");
    await store.close();
    assert.ok(!existsSync(`${file}-wal`) || statSync(`${file}-wal`).size === 0, "one file once closed");
    const db = new DatabaseSync(file);
    try {
      assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
      assert.throws(() => db.exec("update entries set usd = 0"), /append-only/);
    } finally {
      db.close();
    }
  });

  it("two connections to one file still never overdraw a token", async () => {
    const one = await openLedger({ dataDir: dir });
    const two = await openLedger({ dataDir: dir });
    try {
      await buy(one, 10, { id: "a" });
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => (i % 2 ? one : two).hold({ token: "a", reserve: $(3), subject: W, runId: `r${i}`, at: T0 })),
      );
      assert.equal(results.filter((r) => r.ok).length, 3);
      assert.equal((await two.token("a"))!.held, $(9));
    } finally {
      await one.close();
      await two.close();
    }
  });
});
