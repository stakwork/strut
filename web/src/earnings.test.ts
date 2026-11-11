import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeBolt11 } from "../../src/payments/bolt11.js";
import { byEarned, fmtExpiresIn, fmtSats, fmtUsd, priceLine, rangeFrom, readWithdrawInvoice, subjectLabel, withdrawBlocked, withdrawRefusal } from "./earnings.js";

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
    const big = readWithdrawInvoice(inv, { balanceMsat: 10_000_000, nowMs: NOW });
    assert.ok(big.ok && big.overBalance, "the fee counts");
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
    assert.match(why(encodeBolt11({ msat: 1000, paymentHash: HASH, timestamp: nowS, network: "tb" })), /testnet/);
  });

  it("the server's refusals, said for a person", () => {
    assert.match(withdrawRefusal({ code: "wallet_refused", walletCode: "own_invoice", error: "wallet_refused: the invoice is the account's own" }), /this wallet's own/);
    assert.match(withdrawRefusal({ code: "wallet_refused", walletCode: "max_fee_too_low", error: "wallet_refused: max_fee_msat 1000 is below …" }), /routing fee limit/);
    assert.match(withdrawRefusal({ code: "wallet_unavailable", error: "wallet_unavailable: no answer in 75 s" }), /did not answer: no answer in 75 s/);
    assert.equal(withdrawRefusal({ code: "wallet_refused", error: "wallet_refused: the core would not pay it" }), "the core would not pay it");
  });
});
