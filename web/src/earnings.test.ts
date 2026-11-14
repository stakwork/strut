import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeBolt11 } from "../../src/payments/bolt11.js";
import {
  byEarned,
  coverLine,
  maxWithdrawMsat,
  fmtExpiresIn,
  fmtSats,
  fmtUsd,
  priceLine,
  rangeFrom,
  readWithdrawInvoice,
  shortOfWorkers,
  shortOfWorkersRefusal,
  sendPurposeNote,
  showsWorkers,
  subjectLabel,
  withdrawBlocked,
  withdrawRefusal,
  workersAcceptedLine,
  workersDayMsat,
  workersOutLine,
  workersOwedSub,
  workersPaidSub,
  type WorkersView,
} from "./earnings.js";

const HASH = "ab".repeat(32);
const NOW = Date.parse("2026-11-10T12:00:00Z");

describe("earnings: the words", () => {
  it("dollars and sats", () => {
    assert.equal(fmtUsd(0), "$0");
    assert.equal(fmtUsd(1.3), "$1.30");
    assert.equal(fmtUsd(1234.5), "$1,234.50");
    assert.equal(fmtUsd(0.0042), "$0.0042");
    assert.equal(fmtUsd(-0.5), "−$0.50");
    assert.equal(fmtSats(15_000_000), "15,000 sats");
    assert.equal(fmtSats(1000), "1 sat");
    assert.equal(fmtSats(1500), "1.5 sats");
    assert.equal(fmtSats(106_783_344), "106,783 sats", "whole sats from 100 up");
    assert.equal(fmtSats(72_000), "72 sats");
  });

  it("subjects, prices and ranges", () => {
    assert.deepEqual(subjectLabel("workflow:acme/voxel/rig"), { kind: "workflow", name: "acme/voxel/rig" });
    assert.deepEqual(subjectLabel("step:acme/voxel/slice"), { kind: "tool", name: "acme/voxel/slice" });
    assert.equal(subjectLabel("expired").kind, "expired");
    assert.equal(priceLine(undefined), "free");
    assert.equal(priceLine({ base: 0.1, markup: 2 }), "$0.10 + 2× cost");
    assert.equal(priceLine({ markup: 1.5 }), "1.5× cost");
    assert.equal(priceLine({ base: 0.25 }), "$0.25 a run");
    assert.equal(rangeFrom("7d", NOW), "2026-11-04");
    assert.equal(rangeFrom("all", NOW), undefined);
    assert.deepEqual(byEarned([{ key: "b", earned: 1 }, { key: "a", earned: 1 }, { key: "c", earned: 2 }]).map((r) => r.key), ["c", "a", "b"]);
    assert.equal(fmtExpiresIn(600), "in 10 min");
  });

  it("Withdraw is off, saying why, until the wallet can pay", () => {
    assert.match(withdrawBlocked({ provider: null, receive: false, pay: false })!, /No wallet/);
    assert.match(withdrawBlocked({ provider: "sphinx", receive: true, pay: false })!, /pay token/);
    assert.match(withdrawBlocked({ provider: "nwc", receive: true, pay: false })!, /NWC connection that may pay/);
    assert.equal(withdrawBlocked({ provider: "sphinx", receive: true, pay: true }), null);
  });
});

describe("what workers are owed (plans/human-steps.md §8.1)", () => {
  const none: WorkersView = { owedMsat: 0, heldMsat: 0, withdrawableMsat: 0, payees: 0, accepted: { answers: 0, msat: 0, days: [] }, takenBack: { answers: 0, msat: 0 } };
  const owed: WorkersView = {
    owedMsat: 19_000_000,
    heldMsat: 9_000_000,
    withdrawableMsat: 10_000_000,
    payees: 2,
    accepted: { answers: 4, msat: 39_000_000, days: [{ day: "2026-11-03", answers: 3, msat: 35_000_000, takenBackAnswers: 1, takenBackMsat: 20_000_000 }] },
    takenBack: { answers: 1, msat: 20_000_000 },
  };

  it("a strut that never paid a worker shows none of it", () => {
    assert.equal(showsWorkers(undefined), false, "a scoped view has none");
    assert.equal(showsWorkers(none), false);
    assert.equal(showsWorkers(owed), true);
    assert.equal(showsWorkers({ ...none, paidOut: { count: 1, msat: 5_000_000, feeMsat: 0, days: [] } }), true, "paid everything out: still shown");
    assert.equal(showsWorkers({ ...none, outMsat: 5_000_000 }), true, "a payout on its way");
    assert.equal(showsWorkers({ ...none, paidOut: { count: 0, msat: 0, feeMsat: 0, days: [] }, outMsat: 0 }), false);
    assert.equal(showsWorkers({ ...none, accepted: { answers: 1, msat: 1000, days: [] }, takenBack: { answers: 1, msat: 1000 } }), true, "every answer in range taken back: still shown");
  });

  it("owed, held and withdrawable in a line; the range's answers; a day's cell", () => {
    assert.equal(workersOwedSub(owed, 100_000), "≈ $19.00 · 9,000 sats held, 10,000 sats withdrawable · 2 workers");
    assert.equal(workersOwedSub({ ...owed, heldMsat: 0, withdrawableMsat: 19_000_000, payees: 1 }), "all withdrawable · 1 worker");
    assert.equal(workersOwedSub({ ...owed, heldMsat: 19_000_000, withdrawableMsat: 0 }, 100_000), "≈ $19.00 · all held · 2 workers");
    assert.equal(workersOwedSub(none), "0 workers", "everything taken back: nothing owed");
    assert.equal(workersAcceptedLine(owed), "4 answers accepted from workers, earning 39,000 sats; 1 of them taken back (20,000 sats).");
    assert.equal(workersAcceptedLine({ ...owed, takenBack: { answers: 0, msat: 0 } }), "4 answers accepted from workers, earning 39,000 sats.");
    assert.equal(workersDayMsat(owed.accepted.days[0]!), 15_000_000, "accepted that day, less what of it was taken back");
  });

  it("Paid to workers: what was paid and its fees, payouts on their way, and how a payout is marked in the pending list", () => {
    const paid: WorkersView = { ...owed, outMsat: 7_000_000, paidOut: { count: 3, msat: 30_000_000, feeMsat: 150_000, days: [] } };
    assert.equal(workersPaidSub(paid), "3 withdrawals · fees 150 sats");
    assert.equal(workersPaidSub({ ...owed, paidOut: { count: 1, msat: 1000, feeMsat: 0, days: [] } }), "1 withdrawal · fees 0 sats");
    assert.equal(workersPaidSub(owed), "0 withdrawals · fees 0 sats", "a strut from before payouts");
    assert.equal(workersOutLine(paid), "7,000 sats on its way to workers: reserved, not yet settled.");
    assert.equal(workersOutLine(owed), null);
    assert.equal(sendPurposeNote("worker"), " · a worker's payout");
    assert.equal(sendPurposeNote("purchase"), " · credit");
    assert.equal(sendPurposeNote("withdrawal"), "");
  });

  it("the wallet's cover: none without a balance or a debt; red when short", () => {
    assert.equal(coverLine(undefined), null);
    assert.equal(coverLine({ owedToWorkersMsat: 0, coverMsat: 50_000_000 }), null, "nothing owed: nothing to say");
    assert.equal(coverLine({ owedToWorkersMsat: 19_000_000 }), null, "the balance was not read");
    assert.deepEqual(coverLine({ owedToWorkersMsat: 19_000_000, coverMsat: 31_000_000 }), { short: false, text: "Covers the 19,000 sats workers are owed, with 31,000 sats to spare." });
    const short = coverLine({ owedToWorkersMsat: 59_000_000, coverMsat: -9_000_000 })!;
    assert.equal(short.short, true);
    assert.match(short.text, /^Short of what workers are owed by 9,000 sats/);
  });
});

describe("the Withdraw dialog's reading of an invoice", () => {
  const nowS = Math.floor(NOW / 1000);
  it("the amount it asks, its cap and its expiry, beside the balance", () => {
    const inv = encodeBolt11({ msat: 10_000_000, paymentHash: HASH, timestamp: nowS - 60, expirySecs: 600, description: "to cold storage" });
    const r = readWithdrawInvoice(inv, { balanceMsat: 20_000_000, usdPerBtc: 100_000, nowMs: NOW });
    assert.ok(r.ok);
    assert.equal(r.msat, 10_000_000);
    assert.equal(r.maxFeeMsat, 50_000, "the LSP's own limit: 0.5%");
    assert.equal(r.expiresIn, 540);
    assert.equal(r.usd, 10);
    assert.equal(r.overBalance, false);
    assert.equal(r.invoice.description, "to cold storage");
    // The Sphinx provider takes the amount first and the fee from what is
    // left: the whole balance can go. An NWC wallet keeps the fee back.
    const whole = readWithdrawInvoice(inv, { balanceMsat: 10_000_000, nowMs: NOW, provider: "sphinx" });
    assert.ok(whole.ok && !whole.overBalance);
    const nwc = readWithdrawInvoice(inv, { balanceMsat: 10_000_000, nowMs: NOW, provider: "nwc" });
    assert.ok(nwc.ok && nwc.overBalance, "the fee must fit beside it");
    const over = readWithdrawInvoice(inv, { balanceMsat: 9_999_000, nowMs: NOW, provider: "sphinx" });
    assert.ok(over.ok && over.overBalance);
  });

  it("says when paying would leave the wallet short of what workers are owed — the amount and its whole fee cap out — and the dialogs refuse it", () => {
    const inv = encodeBolt11({ msat: 10_000_000, paymentHash: HASH, timestamp: nowS - 60, expirySecs: 600 });
    // 50,000 sats held, 30,000 owed: 10,000 + a 50-sat cap out leaves 39,950.
    const fine = readWithdrawInvoice(inv, { balanceMsat: 50_000_000, owedToWorkersMsat: 30_000_000, nowMs: NOW, provider: "sphinx" });
    assert.ok(fine.ok && fine.shortOfWorkers === undefined);
    const short = readWithdrawInvoice(inv, { balanceMsat: 50_000_000, owedToWorkersMsat: 45_000_000, nowMs: NOW, provider: "sphinx" });
    assert.ok(short.ok);
    assert.deepEqual(short.shortOfWorkers, { afterMsat: 39_950_000, owedMsat: 45_000_000, shortMsat: 5_050_000 });
    assert.equal(short.overBalance, false, "within the balance: only the workers' cover refuses it");
    assert.equal(
      shortOfWorkersRefusal(short.shortOfWorkers!, short.msat),
      "Refused: paying this would leave the wallet 5,050 sats short of the 45,000 sats workers are owed for accepted answers. Withdraw at most 4,950 sats.",
    );
    // The most it names does leave what is owed: the fee cap falls with the amount.
    const most = short.msat - short.shortMsat;
    assert.equal(shortOfWorkers({ balanceMsat: 50_000_000, msat: most, maxFeeMsat: 24_750, owedMsat: 45_000_000 }), undefined);
    assert.equal(shortOfWorkersRefusal({ afterMsat: 0, owedMsat: 9_000, shortMsat: 9_000 }, 2_000), "Refused: paying this would leave the wallet 9 sats short of the 9 sats workers are owed for accepted answers. Withdraw at most 0 sats.");
    // Nothing owed, or no balance read: nothing to warn of.
    for (const o of [{ balanceMsat: 50_000_000 }, { owedToWorkersMsat: 45_000_000 }, { balanceMsat: 50_000_000, owedToWorkersMsat: 0 }]) {
      const r = readWithdrawInvoice(inv, { ...o, nowMs: NOW });
      assert.ok(r.ok && r.shortOfWorkers === undefined, JSON.stringify(o));
    }
    // A wallet already short: any withdrawal leaves it short; one past the balance leaves nothing.
    assert.deepEqual(shortOfWorkers({ balanceMsat: 5_000_000, msat: 10_000_000, maxFeeMsat: 50_000, owedMsat: 1_000 }), { afterMsat: 0, owedMsat: 1_000, shortMsat: 1_000 });
    assert.equal(shortOfWorkers({ balanceMsat: 5_000_000, msat: 1_000, maxFeeMsat: 5_000, owedMsat: 4_994_000 }), undefined, "exactly covered");
  });

  it("refuses what it cannot pay as confirmed, before anything is sent", () => {
    const why = (s: string) => {
      const r = readWithdrawInvoice(s, { nowMs: NOW });
      return r.ok ? "" : r.error;
    };
    assert.equal(why(""), "");
    assert.match(why("hello"), /Not an invoice/);
    assert.match(why(encodeBolt11({ paymentHash: HASH, timestamp: nowS })), /no amount/);
    assert.match(why(encodeBolt11({ msat: 1000, paymentHash: HASH, timestamp: nowS - 7200 })), /expired/);
    // The network is the wallet's to judge: a test stack pays a regtest invoice.
    const regtest = readWithdrawInvoice(encodeBolt11({ msat: 1000, paymentHash: HASH, timestamp: nowS, network: "bcrt" }), { nowMs: NOW });
    assert.ok(regtest.ok && regtest.network === "regtest");
  });

  it("the most that can be withdrawn: the whole balance with the Sphinx provider; less the fee cap with NWC", () => {
    assert.equal(maxWithdrawMsat("sphinx", 354_592_000), 354_592_000);
    const m = maxWithdrawMsat("nwc", 10_000_000);
    assert.ok(m + Math.max(5000, Math.floor(m * 0.005)) <= 10_000_000);
    assert.ok(m + 1 + Math.max(5000, Math.floor((m + 1) * 0.005)) > 10_000_000, "the largest that fits");
    assert.equal(maxWithdrawMsat("nwc", 3000), 0);
  });

  it("the server's refusals, said for a person", () => {
    assert.match(withdrawRefusal({ code: "wallet_refused", walletCode: "own_invoice", error: "wallet_refused: the invoice is the account's own" }), /this wallet's own/);
    assert.match(withdrawRefusal({ code: "wallet_refused", walletCode: "max_fee_too_low", error: "wallet_refused: max_fee_msat 1000 is below …" }), /routing fee limit/);
    assert.match(withdrawRefusal({ code: "wallet_unavailable", error: "wallet_unavailable: no answer in 75 s" }), /did not answer: no answer in 75 s/);
    assert.match(withdrawRefusal({ code: "short_of_workers", error: "short_of_workers: paying 10 msat would leave 5 msat, 9 msat short of the 14 msat workers are owed" }), /^Refused: paying 10 msat would leave .* short of the 14 msat workers are owed\. .*add sats or withdraw less/);
    assert.match(withdrawRefusal({ code: "balance_unknown", error: "balance_unknown: workers are owed 14 msat here and the wallet's balance cannot be read now" }), /^Refused: workers are owed 14 msat here/);
    assert.equal(withdrawRefusal({ code: "wallet_refused", error: "wallet_refused: the core would not pay it" }), "the core would not pay it");
  });
});
