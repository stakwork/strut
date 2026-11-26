import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withdrawFeeMsat, withdrawState } from "./withdraw.js";
import { defaultMaxFeeMsat } from "../../../src/payments/fee.js";

const open = { on: true, minMsat: 1_000_000, dayLeftMsat: 1_000_000_000, maxMsat: 0 };
const off = (why: string) => ({ on: false, why, minMsat: 1_000_000, dayLeftMsat: 0, maxMsat: 0 });

describe("withdraw", () => {
  it("a Withdraw only when one can go through, for the most it may ask", () => {
    assert.deepEqual(withdrawState(9_000_000, { ...open, maxMsat: 8_990_000 }), { kind: "ready", maxMsat: 8_990_000 });
  });

  it("nothing to withdraw, or a server that says nothing of payouts: nothing at all", () => {
    assert.deepEqual(withdrawState(0, open), { kind: "none" });
    assert.deepEqual(withdrawState(0, off("no_address")), { kind: "none" }, "no reason without something to withdraw");
    assert.deepEqual(withdrawState(5_000_000, undefined), { kind: "none" });
  });

  it("a withdrawal on its way: that, whatever else", () => {
    assert.deepEqual(withdrawState(0, { ...open, out: { msat: 2_000_000 } }), { kind: "out", msat: 2_000_000 });
    assert.deepEqual(withdrawState(5_000_000, { ...off("off"), out: { msat: 2_000_000 } }), { kind: "out", msat: 2_000_000 });
  });

  it("something to withdraw that can't go: why, from the server's reason", () => {
    const why = (p: object, free = 5_000_000) => {
      const s = withdrawState(free, p);
      return s.kind === "blocked" ? s.why : s.kind;
    };
    assert.equal(why(off("no_address")), "no_address");
    assert.equal(why(off("off")), "off");
    assert.equal(why(off("no_wallet")), "cannot_pay");
    assert.equal(why(off("no_keysend")), "cannot_pay");
    assert.equal(why(off("not_here")), "not_here");
    // Open, yet nothing may be asked: today's cap, the minimum with the fee on top, else the server's own cap.
    assert.equal(why({ ...open, dayLeftMsat: 0 }), "day_limit");
    assert.equal(why(open, 150_000), "below_min", "stadeum1, 11-18: 150 sats against a 1,000 sat minimum");
    assert.equal(why(open, 1_004_000), "below_min", "the 5 sat fee on top of the minimum");
    assert.equal(why(open), "paused");
    assert.deepEqual(withdrawState(150_000, open), { kind: "blocked", why: "below_min", minMsat: 1_000_000, feeMsat: 5000 });
  });

  it("the fee is the server's own figure", () => {
    for (const msat of [0, 1_000_000, 999_999_999, 5_000_000_000]) assert.equal(withdrawFeeMsat(msat), defaultMaxFeeMsat(msat), `${msat}`);
  });
});
