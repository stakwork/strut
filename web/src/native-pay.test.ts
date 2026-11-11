import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { creditPurchaseProblems, type CreditPurchase, type NativeWalletMessage } from "@strut/kit/wallet";
import { macaroonToBase64, mintToken } from "../../src/l402.js";
import { encodeBolt11 } from "../../src/payments/bolt11.js";
import { checkChallenge, type CheckedChallenge } from "./challenge";
import { WALLET_WAIT_MAX_MS, creditPurchaseOf, fallbackNote, payWithNativeWallet, walletAsk, walletWaitMs } from "./native-pay";
import { callPaying, createClaimKeeper, newPurse, type CallParams, type CallResult, type ClaimEnd, type PaymentRequired, type PayOutcome } from "./visitor-pay";

// A visitor's credit paid with one tap in a native host (./native-pay,
// specs/WALLET.md §1.2): what the native host is asked, what its answers
// come to, and the QR code as what is left whenever it did not pay — no
// bridge, a decline, a preimage that proves nothing, no answer in time.

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const APP = { name: "acme/voxel/studio", version: "v3", title: "Voxel Studio" };
const SELLER = "https://acme.example";

function challenge(o: { carries?: boolean } = {}) {
  const preimage = randomBytes(32).toString("hex");
  const paymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  const invoice = encodeBolt11({ msat: 7_500_000, paymentHash, description: "credit", timestamp: Math.floor(NOW / 1000), expirySecs: 600 });
  const { macaroon } = mintToken(randomBytes(32), { paymentHash, quote: { sats: 7500, credit: 7_500_000, validUntil: Math.floor(NOW / 1000) + 3600 } });
  const p: PaymentRequired = {
    macaroon: macaroonToBase64(macaroon), invoice, usd: 7.5, sats: 7500,
    rate: { usdPerBtc: 100_000, at: new Date(NOW).toISOString(), source: "test" },
    description: "acme/voxel/character: credit for one run", expires: new Date(NOW + 600_000).toISOString(),
    ...(o.carries ? { carries: true, reason: "short", remaining_usd: 0.25 } : {}),
  };
  const r = checkChallenge(p, NOW);
  assert.ok(r.ok);
  return { p, preimage, paymentHash, checked: (r as { checked: CheckedChallenge }).checked };
}

/** Peel's handler, scripted. */
class Native {
  sent: NativeWalletMessage[] = [];
  constructor(public answer: (m: NativeWalletMessage) => unknown) {}
  async postMessage(m: NativeWalletMessage) {
    this.sent.push(structuredClone(m));
    return this.answer(m);
  }
  ops() {
    return this.sent.map((m) => m.op);
  }
}
const CAN = { result: { version: 1, ops: ["buy_credit", "buy_credit_cancel"] } };
const settledPayment = (hash: string, preimage: string) => ({
  result: { transaction_id: "tx-1", state: "settled", payment_hash: hash, amount: 7_500_000, preimage, created_at: 1, settled_at: 2 },
});
/** Peel that answers `buy_credit` with `reply`. */
const peel = (reply: (purchase: CreditPurchase) => unknown) =>
  new Native((m) => (m.op === "host_capability" ? CAN : m.op === "buy_credit" ? reply(m.purchase) : { result: {} }));

describe("what the native host is asked", () => {
  it("a purchase the contract accepts: the checked invoice, the server's quote, what it is for", () => {
    const c = challenge({ carries: true });
    const purchase = creditPurchaseOf(c.p, c.checked, { seller: SELLER, app: APP, workflow: "acme/voxel/character" });
    assert.deepEqual(creditPurchaseProblems(purchase), []);
    assert.deepEqual(purchase, {
      invoice: c.p.invoice, payment_hash: c.paymentHash, amount: 7_500_000, sats: 7500, usd: 7.5,
      rate: { usd_per_btc: 100_000, at: new Date(NOW).toISOString(), source: "test" },
      description: "acme/voxel/character: credit for one run", expires_at: Math.floor(NOW / 1000) + 600,
      seller: SELLER, app: APP, workflow: "acme/voxel/character",
      credit: { carries: true, reason: "short", remaining_usd: 0.25 },
    });
    // Never the macaroon, never a credential: the native host pays an invoice.
    assert.ok(!JSON.stringify(purchase).includes(c.p.macaroon));
  });

  it("waits until the invoice ends, at most ten minutes", () => {
    assert.equal(walletWaitMs(NOW / 1000 + 120, NOW), 120_000);
    assert.equal(walletWaitMs(NOW / 1000 + 3600, NOW), WALLET_WAIT_MAX_MS);
    assert.equal(walletWaitMs(NOW / 1000 - 1, NOW), 0);
  });
});

describe("paying through the native wallet", () => {
  it("no bridge (a plain browser): nothing to ask, the QR code from the start", () => {
    const c = challenge();
    assert.equal(walletAsk({ native: undefined, p: c.p, checked: c.checked, seller: SELLER, app: APP, workflow: "w" }), undefined);
    assert.equal(walletAsk({ native: peel(() => ({})), p: c.p, checked: c.checked, seller: SELLER, app: undefined, workflow: "w" }), undefined);
  });

  it("one tap: the preimage proves the payment, and the credential is the macaroon and it", async () => {
    const c = challenge();
    const native = peel((p) => settledPayment(p.payment_hash, c.preimage));
    const ask = walletAsk({ native, p: c.p, checked: c.checked, seller: SELLER, app: APP, workflow: "acme/voxel/character", now: () => NOW })!;
    assert.deepEqual(await ask(new AbortController().signal), { outcome: "paid", credential: `${c.p.macaroon}:${c.preimage}` });
    assert.deepEqual(native.ops(), ["host_capability", "buy_credit"]);
  });

  it("an older native host that does not buy credit: the QR code, nothing sent but the question", async () => {
    const c = challenge();
    const native = new Native((m) => (m.op === "host_capability" ? { error: { code: -32601, message: "unknown op", data: { code: "NOT_IMPLEMENTED" } } } : settledPayment(c.paymentHash, c.preimage)));
    const r = await payWithNativeWallet({ native, purchase: creditPurchaseOf(c.p, c.checked, { seller: SELLER, app: APP, workflow: "w" }), macaroon: c.p.macaroon, timeoutMs: 1000 });
    assert.equal(r.outcome, "fallback");
    assert.deepEqual(native.ops(), ["host_capability"]);
    // One that never says: the question times out.
    const silent = new Native(() => new Promise(() => {}));
    const s = await payWithNativeWallet({ native: silent, purchase: creditPurchaseOf(c.p, c.checked, { seller: SELLER, app: APP, workflow: "w" }), macaroon: c.p.macaroon, timeoutMs: 1000, probeMs: 10 });
    assert.equal(s.outcome, "fallback");
  });

  it("a decline, a failed payment, a preimage that proves nothing: the QR code, saying why", async () => {
    const c = challenge();
    const purchase = creditPurchaseOf(c.p, c.checked, { seller: SELLER, app: APP, workflow: "w" });
    const declined = await payWithNativeWallet({ native: peel(() => ({ error: { code: -32000, message: "Declined", data: { code: "USER_REJECTED" } } })), purchase, macaroon: c.p.macaroon, timeoutMs: 1000 });
    assert.deepEqual(declined, { outcome: "fallback", reason: "Declined", declined: true });
    assert.equal(fallbackNote(declined as Extract<typeof declined, { outcome: "fallback" }>), "You declined in your wallet. Pay this invoice from another wallet, or cancel.");
    const failed = await payWithNativeWallet({
      native: peel((p) => ({ result: { transaction_id: "t", state: "failed", payment_hash: p.payment_hash, amount: 1, created_at: 1, failure_reason: "no route" } })),
      purchase, macaroon: c.p.macaroon, timeoutMs: 1000,
    });
    assert.deepEqual(failed, { outcome: "fallback", reason: "no route", declined: false });
    assert.match(fallbackNote(failed as Extract<typeof failed, { outcome: "fallback" }>), /^Your wallet did not pay it \(no route\)/);
    const bad = await payWithNativeWallet({ native: peel((p) => settledPayment(p.payment_hash, "07".repeat(32))), purchase, macaroon: c.p.macaroon, timeoutMs: 1000 });
    assert.equal(bad.outcome, "fallback");
    assert.equal(bad.outcome === "fallback" && bad.declined, false);
  });

  it("no answer before the invoice ends: the QR code, and the native host is asked to take its sheet down", async () => {
    const c = challenge();
    const native = peel(() => new Promise(() => {}));
    const r = await payWithNativeWallet({ native, purchase: creditPurchaseOf(c.p, c.checked, { seller: SELLER, app: APP, workflow: "w" }), macaroon: c.p.macaroon, timeoutMs: 20 });
    assert.equal(r.outcome, "fallback");
    assert.deepEqual(native.ops(), ["host_capability", "buy_credit", "buy_credit_cancel"]);
  });

  it("a payment on its way: the sheet waits on its claim", async () => {
    const c = challenge();
    const native = peel((p) => ({ result: { transaction_id: "t", state: "pending", payment_hash: p.payment_hash, amount: 7_500_000, created_at: 1 } }));
    const r = await payWithNativeWallet({ native, purchase: creditPurchaseOf(c.p, c.checked, { seller: SELLER, app: APP, workflow: "w" }), macaroon: c.p.macaroon, timeoutMs: 1000 });
    assert.deepEqual(r, { outcome: "pending" });
  });
});

describe("a priced launch, paid in a native host (the relay's loop)", () => {
  const launch: CallParams = { name: "step_run", arguments: { type: "run/launch", config: { workflow: "acme/voxel/character", input: {} }, app: "app:x@v1.t" } };
  const ok = (o: unknown): CallResult => ({ structuredContent: o, content: [{ type: "text", text: JSON.stringify(o) }] });

  /** A server whose priced launch needs `credential`; the claim answers
   *  settled once `paid` is true. */
  function server(c: ReturnType<typeof challenge>) {
    const credential = `${c.p.macaroon}:${c.preimage}`;
    const state = { paid: false, sent: [] as Array<string | undefined> };
    return {
      state,
      credential,
      call: (purse: { credential?: string }) => async (): Promise<CallResult> => {
        state.sent.push(purse.credential);
        return purse.credential === credential ? ok({ runId: "r1" }) : ok({ payment_required: c.p });
      },
      claim: async () => (state.paid ? { state: "settled" as const, credential } : { state: "pending" as const }),
    };
  }
  /** The sheet, as PaymentSheet decides: the wallet first, then whichever
   *  comes first of its answer and the claim. */
  const sheet = (ask: ((s: AbortSignal) => Promise<import("./native-pay").WalletAnswer>) | undefined, settled: Promise<ClaimEnd>): Promise<PayOutcome> =>
    new Promise((resolve) => {
      void settled.then((e) => resolve(e.state === "settled" ? e.credential : "again"));
      void ask?.(new AbortController().signal).then((a) => {
        if (a.outcome === "paid") resolve(a.credential);
      });
    });

  for (const [name, reply] of [
    ["paid with one tap: sent again at once with the credential", "paid"],
    ["declined: the QR code, paid from a phone, claimed", "declined"],
    ["a preimage that proves nothing: the QR code; the payment that did go through is claimed", "bad"],
  ] as const) {
    it(name, async () => {
      const c = challenge();
      const s = server(c);
      const purse = newPurse("visit-aaaaaaaaaaaaaaaaaaaaaaaa");
      const keeper = createClaimKeeper({ purse, claim: s.claim, save: () => {}, intervalMs: 1, sleep: () => new Promise((r) => setTimeout(r, 2)), now: () => NOW });
      // Peel pays the invoice (it settles on the server's side too), or declines.
      const native = peel((p) => {
        if (reply === "declined") return { error: { code: -32000, message: "Declined", data: { code: "USER_REJECTED" } } };
        s.state.paid = true;
        return settledPayment(p.payment_hash, reply === "paid" ? c.preimage : "09".repeat(32));
      });
      const result = await callPaying(launch, {
        call: s.call(purse),
        purse,
        pay: async (q) => {
          const check = checkChallenge(q, NOW);
          if (!check.ok) return { error: check.error };
          const settled = keeper.watch({ macaroon: q.macaroon, ...(q.expires ? { expires: q.expires } : {}) });
          const ask = walletAsk({ native, p: q, checked: check.checked, seller: SELLER, app: APP, workflow: "acme/voxel/character", now: () => NOW });
          // Declined: the person pays the QR code from a phone instead.
          if (reply === "declined") setTimeout(() => (s.state.paid = true), 5);
          return sheet(ask, settled);
        },
      });
      assert.deepEqual(result.structuredContent, { runId: "r1" });
      assert.equal(purse.credential, s.credential);
      assert.deepEqual(s.state.sent, [undefined, s.credential], "asked once, then sent again with the credential");
    });
  }

  it("a challenge that does not check out: the page's call fails, nothing is shown or paid", async () => {
    const c = challenge();
    const junk: PaymentRequired = { ...c.p, sats: 1 };
    const native = peel(() => assert.fail("never asked"));
    let shown = false;
    const result = await callPaying(launch, {
      call: async () => ok({ payment_required: junk }),
      purse: newPurse("visit-aaaaaaaaaaaaaaaaaaaaaaaa"),
      pay: async (q) => {
        const check = checkChallenge(q, NOW);
        if (!check.ok) return { error: check.error };
        shown = true;
        void walletAsk({ native, p: q, checked: check.checked, seller: SELLER, app: APP, workflow: "w" });
        return null;
      },
    });
    assert.equal(result.isError, true);
    assert.match(result.content![0]!.text!, /does not check out: the invoice asks 7500 sats, not the 1/);
    assert.equal(shown, false);
    assert.deepEqual(native.sent, []);
  });
});
