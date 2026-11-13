import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  creditPurchaseProblems, probeNativeWallet, relayNativeWallet, signInRequestProblems,
  type CreditPurchase, type NativeWalletApp, type NativeWalletMessage, type RelayBridge, type SignInRequest, type WalletCapability,
} from "@strut/kit/wallet";
import { macaroonToBase64, mintToken } from "../../src/l402.js";
import { encodeBolt11 } from "../../src/payments/bolt11.js";
import { checkChallenge, type CheckedChallenge } from "./challenge";
import {
  WALLET_WAIT_MAX_MS, createHostWalletProbe, creditPurchaseOf, fallbackNote, nativeWalletApp, sellerOf, signInAsk, signInNote, walletAsk, walletWaitMs,
  type HostWallet, type WalletAnswer, type WalletAsk,
} from "./native-pay";
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
const CAN = { result: { version: 1, ops: ["buy_credit", "buy_credit_status", "buy_credit_cancel"], wallet: "Peel" } };
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

/** The native host as this page found it (`createHostWalletProbe`). */
const found = (native: Native, ops: HostWallet["cap"]["ops"] = ["buy_credit", "buy_credit_status", "buy_credit_cancel"]): HostWallet => ({ native, cap: { version: 1, ops, wallet: "Peel" } });
const askOf = (c: ReturnType<typeof challenge>, wallet: HostWallet | undefined) =>
  walletAsk({ wallet, p: c.p, checked: c.checked, seller: SELLER, app: APP, workflow: "acme/voxel/character", now: () => NOW });
const never = () => new AbortController().signal;

describe("finding the native host's wallet, once per page", () => {
  it("asks once — again only for another handler — and only a host that buys credit counts", async () => {
    let asked = 0;
    const probe = createHostWalletProbe(async () => (asked++, { version: 1, ops: ["buy_credit"], wallet: "Peel" }));
    const handler = { postMessage: async () => ({}) };
    const win = { webkit: { messageHandlers: { strutWallet: handler } } };
    const a = await probe(win);
    assert.deepEqual(a?.cap, { version: 1, ops: ["buy_credit"], wallet: "Peel" });
    await probe(win);
    assert.equal(asked, 1, "cached for the page");
    await probe({ webkit: { messageHandlers: { strutWallet: { postMessage: async () => ({}) } } } });
    assert.equal(asked, 2, "another handler is asked again");
    assert.equal(await probe({}), undefined, "no native host");
    const cannot = createHostWalletProbe(async () => ({ version: 1, ops: ["buy_credit_status"] }));
    assert.equal(await cannot(win), undefined, "one that neither buys credit nor signs in");
    const signs = createHostWalletProbe(async () => ({ version: 1, ops: ["sign_in"], wallet: "Peel" }));
    assert.deepEqual((await signs(win))?.cap.ops, ["sign_in"], "one that only signs a visitor in counts");
    const silent = createHostWalletProbe(async () => undefined);
    assert.equal(await silent(win), undefined, "an older one");
  });
});

describe("paying through the native wallet", () => {
  it("no bridge, or one that does not buy credit: nothing to ask, the QR code from the start", () => {
    const c = challenge();
    assert.equal(askOf(c, undefined), undefined);
    assert.equal(askOf(c, found(peel(() => ({})), ["buy_credit_status"])), undefined);
    assert.equal(walletAsk({ wallet: found(peel(() => ({}))), p: c.p, checked: c.checked, seller: SELLER, app: undefined, workflow: "w" }), undefined);
  });

  it("one tap: the preimage proves the payment, and the credential is the macaroon and it", async () => {
    const c = challenge();
    const native = peel((p) => settledPayment(p.payment_hash, c.preimage));
    const ask = askOf(c, found(native))!;
    assert.equal(ask.name, "Peel");
    assert.deepEqual(await ask.pay(never()), { outcome: "paid", credential: `${c.p.macaroon}:${c.preimage}` });
    assert.deepEqual(native.ops(), ["buy_credit"], "the capability was asked before: nothing more");
    assert.equal(askOf(c, { native, cap: { version: 1, ops: ["buy_credit"] } })!.name, "your wallet");
  });

  it("nothing sent — a decline, a refusal, a failure: the QR code, saying why, and Pay with the wallet again", async () => {
    const c = challenge();
    const answer = async (reply: unknown) => (await askOf(c, found(peel(() => reply)))!.pay(never())) as Extract<WalletAnswer, { outcome: "fallback" }>;
    const declined = await answer({ error: { code: -32000, message: "Declined", data: { code: "USER_REJECTED" } } });
    assert.deepEqual(declined, { outcome: "fallback", reason: "Declined", code: "USER_REJECTED", declined: true });
    assert.equal(fallbackNote(declined, "Peel"), "You declined in Peel. Pay this invoice from another wallet, or ask Peel again.");
    const restricted = await answer({ error: { code: -32000, message: "no tap", data: { code: "RESTRICTED" } } });
    assert.match(fallbackNote(restricted, "Peel"), /Press Pay with Peel to confirm there/);
    const failed = await answer({ result: { transaction_id: "t", state: "failed", payment_hash: c.paymentHash, amount: 1, created_at: 1, failure_reason: "no route" } });
    assert.equal(failed.code, "PAYMENT_FAILED");
    assert.match(fallbackNote(failed, "Peel"), /^Peel could not pay it \(no route\): nothing was paid/);
  });

  it("once the person tapped — pending, or settled with a preimage that proves nothing — never the QR again", async () => {
    const c = challenge();
    assert.deepEqual(await askOf(c, found(peel((p) => ({ result: { transaction_id: "t", state: "pending", payment_hash: p.payment_hash, amount: 7_500_000, created_at: 1 } }))))!.pay(never()), { outcome: "pending" });
    assert.deepEqual(await askOf(c, found(peel((p) => settledPayment(p.payment_hash, "07".repeat(32)))))!.pay(never()), { outcome: "pending" });
  });

  it("where a pending payment stands: proven, failed (the QR comes back), still going", async () => {
    const c = challenge();
    let state: unknown = { result: { transaction_id: "t", state: "pending", payment_hash: c.paymentHash, amount: 7_500_000, created_at: 1 } };
    const native = new Native((m) => (m.op === "buy_credit_status" ? state : m.op === "buy_credit" ? state : CAN));
    const ask = askOf(c, found(native))!;
    assert.deepEqual(await ask.status!(), { outcome: "pending" });
    state = { result: { transaction_id: "t", state: "failed", payment_hash: c.paymentHash, amount: 7_500_000, created_at: 1, failure_reason: "no route" } };
    assert.equal((await ask.status!()).outcome, "fallback");
    state = settledPayment(c.paymentHash, c.preimage);
    assert.deepEqual(await ask.status!(), { outcome: "paid", credential: `${c.p.macaroon}:${c.preimage}` });
    assert.equal(askOf(c, found(native, ["buy_credit"]))!.status, undefined, "a host that does not answer it: the claim alone");
  });

  it("no answer before the invoice ends, or the person chose the invoice: the native host takes its sheet down, and a payment it sent after all still counts", async () => {
    const c = challenge();
    const native = peel(() => new Promise(() => {}));
    const short = walletAsk({ wallet: found(native), p: c.p, checked: c.checked, seller: SELLER, app: APP, workflow: "w", now: () => c.checked.expiresAt * 1000 - 20 })!;
    assert.equal((await short.pay(never())).outcome, "fallback");
    assert.deepEqual(native.ops(), ["buy_credit", "buy_credit_cancel"]);
    let answer!: (v: unknown) => void;
    const slow = peel(() => new Promise((r) => (answer = r)));
    const stop = new AbortController();
    const late: WalletAnswer[] = [];
    const waiting = askOf(c, found(slow))!.pay(stop.signal, (a) => late.push(a));
    stop.abort();
    assert.equal((await waiting).outcome, "fallback");
    answer({ result: { transaction_id: "t", state: "pending", payment_hash: c.paymentHash, amount: 7_500_000, created_at: 1 } });
    for (let i = 0; i < 20 && !late.length; i++) await new Promise((r) => setTimeout(r, 1));
    assert.deepEqual(late, [{ outcome: "pending" }], "the sheet hides the invoice it had shown");
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
   *  comes first of its answer and the claim; `shown` counts the QR codes. */
  const sheet = (ask: WalletAsk | undefined, settled: Promise<ClaimEnd>, seen: { qr: number }): Promise<PayOutcome> =>
    new Promise((resolve) => {
      void settled.then((e) => resolve(e.state === "settled" ? e.credential : "again"));
      if (!ask) {
        seen.qr++;
        return;
      }
      void ask.pay(new AbortController().signal).then((a) => {
        if (a.outcome === "paid") resolve(a.credential);
        else if (a.outcome === "fallback") seen.qr++;
      });
    });

  for (const [name, reply, qr] of [
    ["paid with one tap: sent again at once with the credential, no QR", "paid", 0],
    ["declined: the QR code, paid from a phone, claimed", "declined", 1],
    ["a preimage that proves nothing: no QR (the person tapped), the payment claimed", "bad", 0],
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
      const seen = { qr: 0 };
      const result = await callPaying(launch, {
        call: s.call(purse),
        purse,
        pay: async (q) => {
          const check = checkChallenge(q, NOW);
          if (!check.ok) return { error: check.error };
          const settled = keeper.watch({ macaroon: q.macaroon, expires: new Date(check.checked.expiresAt * 1000).toISOString() });
          const ask = walletAsk({ wallet: found(native), p: q, checked: check.checked, seller: SELLER, app: APP, workflow: "acme/voxel/character", now: () => NOW });
          // Declined: the person pays the QR code from a phone instead.
          if (reply === "declined") setTimeout(() => (s.state.paid = true), 5);
          return sheet(ask, settled, seen);
        },
      });
      assert.deepEqual(result.structuredContent, { runId: "r1" });
      assert.equal(purse.credential, s.credential);
      assert.deepEqual(s.state.sent, [undefined, s.credential], "asked once, then sent again with the credential");
      assert.equal(seen.qr, qr);
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
        void askOf(c, found(native));
        return null;
      },
    });
    assert.equal(result.isError, true);
    assert.match(result.content![0]!.text!, /does not check out: the invoice asks 7500 sats, not the 1/);
    assert.equal(shown, false);
    assert.deepEqual(native.sent, []);
  });
});

// ── Signing a visitor in through the native wallet (`sign_in`) ─────────────

/** The wallet contract's vectors: real challenges, and Sphinx's own signer's
 *  signature over one. */
const vectors = JSON.parse(readFileSync(new URL("../../kit/src/wallet/vectors.json", import.meta.url), "utf-8")) as {
  sign_in_requests: Array<{ name: string; now: number; request: SignInRequest }>;
  sign_in_signatures: Array<{ message: string; key: string; sig: string; actor: string | null }>;
};
const SIGN_NOW = vectors.sign_in_requests[0]!.now;
const SHOP = "https://shop.example.com";
const SHOP_CHALLENGE = vectors.sign_in_requests[0]!.request.challenge;
const EVIL_CHALLENGE = vectors.sign_in_requests.find((v) => v.name.startsWith("a challenge for ANOTHER host"))!.request.challenge;
const SIGNED = vectors.sign_in_signatures[0]!;
const GAME = { name: "moon-game", version: "v3", title: "Moon Game" };
const signer = (reply: (m: SignInRequest) => unknown) => new Native((m) => (m.op === "sign_in" ? reply(m) : { result: {} }));
const signerOf = (native: Native, ops: HostWallet["cap"]["ops"] = ["sign_in"]) => signInAsk({ wallet: found(native, ops), seller: SHOP, app: GAME, now: () => SIGN_NOW });
const err = (code: string, message: string) => ({ error: { code: -32000, message, data: { code } } });

describe("signing a visitor in through the native wallet", () => {
  it("no native host, one that does not sign in, or no app: sphinx is not offered", () => {
    assert.equal(signInAsk({ wallet: undefined, seller: SHOP, app: GAME }), undefined);
    assert.equal(signInAsk({ wallet: found(signer(() => ({}))), seller: SHOP, app: GAME }), undefined, "buys credit, does not sign in");
    assert.equal(signInAsk({ wallet: found(signer(() => ({})), ["sign_in"]), seller: SHOP, app: undefined }), undefined);
    assert.equal(signerOf(signer(() => ({})))?.name, "Peel");
  });

  it("one sign_in of the seller's challenge, as the contract has it: the key and signature to post", async () => {
    const native = signer(() => ({ result: { key: SIGNED.key, sig: SIGNED.sig } }));
    const r = await signerOf(native)!.sign(SHOP_CHALLENGE);
    assert.deepEqual(r, { outcome: "signed", key: SIGNED.key, sig: SIGNED.sig });
    assert.deepEqual(native.sent, [{ v: 1, op: "sign_in", seller: SHOP, app: GAME, challenge: SHOP_CHALLENGE }]);
    assert.deepEqual(signInRequestProblems(native.sent[0], SIGN_NOW), [], "what the native host gets passes its own check");
  });

  it("the account's address rides along only when its pubkey is the key that signed", async () => {
    const address = `${SIGNED.key}_03${"ab".repeat(32)}_1099511627776`;
    const kept = await signerOf(signer(() => ({ result: { key: SIGNED.key, sig: SIGNED.sig, address } })))!.sign(SHOP_CHALLENGE);
    assert.deepEqual(kept, { outcome: "signed", key: SIGNED.key, sig: SIGNED.sig, address });
    const other = `02${"cd".repeat(32)}_03${"ab".repeat(32)}_1099511627776`;
    const dropped = await signerOf(signer(() => ({ result: { key: SIGNED.key, sig: SIGNED.sig, address: other } })))!.sign(SHOP_CHALLENGE);
    assert.deepEqual(dropped, { outcome: "signed", key: SIGNED.key, sig: SIGNED.sig });
  });

  it("a seller's challenge for another host is never put to the wallet", async () => {
    const native = signer(() => ({ result: { key: SIGNED.key, sig: SIGNED.sig } }));
    const r = await signerOf(native)!.sign(EVIL_CHALLENGE);
    assert.equal(r.outcome, "refused");
    assert.match(r.outcome === "refused" ? r.message : "", /does not check out: the challenge is for evil\.example\.net/);
    assert.equal(native.sent.length, 0, "the wallet was not asked");
    assert.equal((await signerOf(native)!.sign("Sign in to shop.example.com")).outcome, "refused", "nor is any other message");
    assert.equal(native.sent.length, 0);
  });

  it("a decline, a wanted tap, junk, and no answer before the challenge ends", async () => {
    const declined = await signerOf(signer(() => err("USER_REJECTED", "You declined")))!.sign(SHOP_CHALLENGE);
    assert.deepEqual(declined, { outcome: "refused", code: "USER_REJECTED", message: "You declined", declined: true });
    assert.equal(signInNote(declined as Extract<typeof declined, { outcome: "refused" }>, "Peel"), "You declined in Peel.");
    const tap = await signerOf(signer(() => err("RESTRICTED", "Tap to sign in")))!.sign(SHOP_CHALLENGE);
    assert.equal(tap.outcome === "refused" && tap.code, "RESTRICTED");
    assert.match(signInNote(tap as Extract<typeof tap, { outcome: "refused" }>, "Peel"), /Press Sign in with Peel/);
    const junk = await signerOf(signer(() => ({ result: { key: SIGNED.key } })))!.sign(SHOP_CHALLENGE);
    assert.equal(junk.outcome === "refused" && junk.code, "INTERNAL");
    // The challenge ends 60 s after SIGN_NOW: a wallet that never answers is
    // waited on no longer than that.
    const late = signInAsk({ wallet: found(new Native(() => new Promise(() => {})), ["sign_in"]), seller: SHOP, app: GAME, now: () => 1793800060000 - 30 })!;
    const t = Date.now();
    const silent = await late.sign(SHOP_CHALLENGE);
    assert.equal(silent.outcome === "refused" && silent.code, "RESTRICTED");
    assert.ok(Date.now() - t < 2_000);
  });
});

// An app's OWN wallet connection (specs/WALLET.md §1.1): offered to a
// member's page and a visitor's alike (plans/app-payments.md §11 R8), its
// identity naming the seller — the strut server whose app it is — which the
// native host keys the connection by. Through the kit's relay, with a
// native host that answers like Peel's handler.
describe("an app's own wallet, its identity naming the seller", () => {
  const REQ = { request_methods: ["pay_keysend", "get_budget"], max_amount: 5_000_000, renewal_period: "weekly" };
  const CAP: WalletCapability = { version: 1, methods: ["connect", "get_info", "pay_keysend", "get_budget"], notifications: ["payment_sent"], wallet: "sphinx", connected: false };
  const PK = "02" + "a".repeat(64);
  const HERE = "http://127.0.0.1:3000/?app=tip-jar&public=1";

  function nativeHost() {
    const sent: NativeWalletMessage[] = [];
    return {
      sent,
      async postMessage(m: NativeWalletMessage) {
        sent.push(structuredClone(m));
        if (m.op === "capability") return { result: CAP };
        return { result: { transaction_id: "tx-1", state: "pending", payment_hash: "ab".repeat(32), amount: 21_000, created_at: 1793800000 } };
      },
    };
  }
  /** The bridge as the relay uses it: the handlers it sets, called by hand. */
  function bridge() {
    const handlers = new Map<string, (params: unknown) => unknown>();
    const b: RelayBridge = {
      setRequestHandler: (method, _schemas, handler) => void handlers.set(method, handler),
      notification: async () => {},
    };
    return { b, handlers };
  }

  it("the seller is this server's base, under its mount, or the other server's (`from`)", () => {
    assert.equal(sellerOf(undefined, "", HERE), "http://127.0.0.1:3000");
    assert.equal(sellerOf(undefined, "/lab", "https://swarm.test/lab/?app=tip-jar&public=1"), "https://swarm.test/lab");
    assert.equal(sellerOf("https://shop.example.com", "", `http://127.0.0.1:3000/?app=tip-jar&public=1&from=${encodeURIComponent("https://shop.example.com")}`), "https://shop.example.com");
  });

  it("a visitor's page whose version requests a wallet is offered it through the relay, the seller in every message", async () => {
    const seller = sellerOf(undefined, "", HERE);
    const app = nativeWalletApp({ app: { name: "tip-jar", version: "v1" }, title: "Tip jar", request: REQ, seller });
    assert.deepEqual(app, { name: "tip-jar", version: "v1", seller: "http://127.0.0.1:3000", title: "Tip jar", request: REQ });
    const native = nativeHost();
    const capability = await probeNativeWallet(native, app!);
    assert.deepEqual(capability, CAP, "the wallet capability, for ui/initialize");
    const { b, handlers } = bridge();
    relayNativeWallet({ bridge: b, native, app: app!, capability: capability! });
    await handlers.get("strut/wallet/pay_keysend")!({ pubkey: PK, amount: 21_000 });
    assert.deepEqual(native.sent.map((m) => [m.op, (m as { app?: NativeWalletApp }).app?.seller]), [["capability", seller], ["call", seller]]);
  });

  it("a version that asks for no wallet, or for one that is not a request, is offered none: the native host never hears of it", async () => {
    const native = nativeHost();
    for (const request of [undefined, null, { request_methods: ["drain_everything"] }, { request_methods: ["pay_keysend"], renewal_period: "weekly" }, "pay_keysend"]) {
      const app = nativeWalletApp({ app: { name: "tip-jar", version: "v1" }, title: "Tip jar", request, seller: sellerOf(undefined, "", HERE) });
      assert.equal(app, undefined, JSON.stringify(request));
    }
    // And a seller that is no seller's base: no identity, so no wallet.
    assert.equal(nativeWalletApp({ app: { name: "tip-jar", version: "v1" }, title: "Tip jar", request: REQ, seller: "http://192.168.1.2:3000" }), undefined);
    assert.deepEqual(native.sent, []);
  });

  it("another server's public app names that server as its seller", async () => {
    const app = nativeWalletApp({ app: { name: "tip-jar", version: "v1" }, title: "Tip jar", request: REQ, seller: sellerOf("https://shop.example.com", "", HERE) });
    assert.equal(app?.seller, "https://shop.example.com");
    const native = nativeHost();
    assert.deepEqual(await probeNativeWallet(native, app!), CAP);
    assert.deepEqual(native.sent, [{ v: 1, op: "capability", app: { name: "tip-jar", version: "v1", seller: "https://shop.example.com", title: "Tip jar", request: REQ } }]);
  });

  it("a member's page: the identity it always had, the seller beside it", () => {
    const app = nativeWalletApp({ app: { name: "tip-jar", version: "v3", peer: "acme" }, title: "Tip jar", request: REQ, seller: sellerOf(undefined, "", "http://127.0.0.1:3000/?app=@acme/tip-jar") });
    const { seller, ...rest } = app!;
    assert.equal(seller, "http://127.0.0.1:3000");
    assert.deepEqual(rest, { name: "tip-jar", version: "v3", peer: "acme", title: "Tip jar", request: REQ });
  });
});
