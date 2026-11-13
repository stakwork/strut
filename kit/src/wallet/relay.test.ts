import { teardownDom } from "../test-dom.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { App } from "@modelcontextprotocol/ext-apps";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import {
  WALLET_CAPABILITY, WalletError, walletCapabilityOf,
  type CreditPurchase, type NativeWalletApp, type NativeWalletMessage, type Payment, type WalletCapability, type WalletNotification,
} from "./protocol.js";
import {
  PASS_THROUGH_SCHEMA, buyCreditNatively, creditStatusNatively, nativeWalletNotifications, nativeWalletOf, probeHostWallet, probeNativeWallet,
  relayNativeWallet, type RelayBridge,
} from "./relay.js";
import { createBridgeWallet, type WalletBridgeApp, type WalletClient } from "./client.js";
import { createWebLN } from "./webln.js";

/**
 * The relay end to end (specs/WALLET.md §1.1): an app's wallet client on a
 * real ext-apps `App`, a real `AppBridge` as strut's UI runs it, the relay
 * between them, and a fake native host (Peel) behind the relay answering
 * the way its handler will.
 */

after(teardownDom);

const PK = "02" + "a".repeat(64);
const LSP = "03" + "b".repeat(64);
const HASH = "72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793";
const PREIMAGE = "01".repeat(32);

const APP: NativeWalletApp = {
  name: "tip-jar",
  version: "v3",
  peer: "acme",
  seller: "http://127.0.0.1:3000",
  title: "Tip jar",
  request: { request_methods: ["pay_keysend", "get_budget"], notification_types: ["payment_sent", "payment_failed"], max_amount: 5_000_000, renewal_period: "weekly" },
};

const CAPABILITY: WalletCapability = {
  version: 1,
  methods: ["connect", "get_info", "pay_invoice", "pay_keysend", "make_invoice", "lookup_payment", "lookup_invoice", "get_budget"],
  notifications: ["payment_received", "payment_sent", "payment_failed"],
  wallet: "sphinx",
  connected: false,
};

const pending: Payment = { transaction_id: "tx-2", state: "pending", payment_hash: HASH, amount: 20_000, created_at: 1793800000 };

/** Peel's handler, scripted: what it was sent, and what it answers. */
class FakeNative {
  sent: NativeWalletMessage[] = [];
  answer: (m: NativeWalletMessage) => unknown = () => ({ result: {} });
  async postMessage(m: NativeWalletMessage) {
    this.sent.push(structuredClone(m));
    return this.answer(m);
  }
  calls() {
    return this.sent.filter((m) => m.op === "call");
  }
}

async function connected(native: FakeNative, win: Record<string, unknown> = {}) {
  const [appSide, hostSide] = InMemoryTransport.createLinkedPair();
  const bridge = new AppBridge(null, { name: "strut-ui", version: "0" }, { openLinks: {}, experimental: { [WALLET_CAPABILITY]: CAPABILITY } }, {
    hostContext: { theme: "light" },
  });
  const relay = relayNativeWallet({ bridge: bridge as unknown as RelayBridge, native, app: APP, capability: CAPABILITY });
  const off = nativeWalletNotifications(win).register(APP, relay.notify);
  await bridge.connect(hostSide);
  const app = new App({ name: "tip-jar", version: "3" }, {}, { autoResize: false });
  const wallet = createBridgeWallet(app as unknown as WalletBridgeApp);
  await app.connect(appSide);
  return {
    app, bridge, wallet, win,
    async close() {
      off();
      await app.close();
      await bridge.close();
    },
  };
}

describe("the wallet relay", () => {
  it("advertises the native host's capability to the page at ui/initialize", async () => {
    const t = await connected(new FakeNative());
    assert.deepEqual(walletCapabilityOf(t.app.getHostCapabilities()), CAPABILITY);
    assert.deepEqual(t.wallet.capability(), CAPABILITY);
    await t.close();
  });

  it("forwards a call with the app it is for, its params normalized, and hands back the result", async () => {
    const native = new FakeNative();
    native.answer = () => ({ result: pending });
    const t = await connected(native);
    const payment = await t.wallet.call("pay_keysend", { pubkey: `${PK}_${LSP}_1099511627776`, amount: 20_000 });
    assert.deepEqual(payment, pending);
    assert.deepEqual(native.calls(), [
      { v: 1, op: "call", method: "pay_keysend", app: APP, params: { pubkey: PK, amount: 20_000, route_hints: [[{ pubkey: LSP, short_channel_id: "1099511627776" }]] } },
    ]);
    await t.close();
  });

  it("never hands a page the node key, whatever get_info answered", async () => {
    const native = new FakeNative();
    const info = { alias: "Peel", network: "bitcoin", methods: ["connect", "get_info", "pay_keysend"], notifications: ["payment_sent"] };
    native.answer = () => ({ result: { ...info, pubkey: PK } });
    const t = await connected(native);
    assert.deepEqual(await t.wallet.call("get_info", {}), info);
    await t.close();
  });

  it("hands the native host's refusal back with its wallet code", async () => {
    const native = new FakeNative();
    native.answer = () => ({ error: { code: -32000, message: "Over this app's budget", data: { code: "QUOTA_EXCEEDED" } } });
    const t = await connected(native);
    await assert.rejects(
      t.wallet.call("pay_keysend", { pubkey: PK, amount: 1000 }),
      (e: unknown) => e instanceof WalletError && e.code === "QUOTA_EXCEEDED" && /budget/.test(e.message),
    );
    native.answer = () => ({ error: { code: -32000, message: "No", data: { code: "USER_REJECTED" } } });
    await assert.rejects(t.wallet.call("connect"), (e: unknown) => e instanceof WalletError && e.code === "USER_REJECTED");
    await t.close();
  });

  it("refuses what checkParams refuses before the native host hears of it", async () => {
    const native = new FakeNative();
    const t = await connected(native);
    // Past the client's own check, straight at the bridge: the relay checks too.
    await assert.rejects(
      t.app.request({ method: "strut/wallet/pay_keysend", params: { pubkey: "nobody", amount: 1 } }, PASS_THROUGH_SCHEMA),
      (e: unknown) => (e as { data?: { code?: string } }).data?.code === "BAD_REQUEST",
    );
    await assert.rejects(t.wallet.call("pay_keysend", { pubkey: "nobody", amount: 1 }), (e: unknown) => e instanceof WalletError && e.code === "BAD_REQUEST");
    assert.equal(native.calls().length, 0);
    await t.close();
  });

  it("answers NOT_IMPLEMENTED for a method the native wallet does not offer, and INTERNAL when it does not answer", async () => {
    const native = new FakeNative();
    const t = await connected(native);
    await assert.rejects(t.wallet.call("get_balance"), (e: unknown) => e instanceof WalletError && e.code === "NOT_IMPLEMENTED");
    assert.equal(native.calls().length, 0);
    native.answer = () => {
      throw new Error("handler gone");
    };
    await assert.rejects(t.wallet.call("get_budget"), (e: unknown) => e instanceof WalletError && e.code === "INTERNAL" && /handler gone/.test(e.message));
    native.answer = () => ({ nonsense: true });
    await assert.rejects(t.wallet.call("get_budget"), (e: unknown) => e instanceof WalletError && e.code === "INTERNAL");
    await t.close();
  });

  it("routes the native host's notifications to the app they are for, and drops the rest", async () => {
    const win: Record<string, unknown> = {};
    const t = await connected(new FakeNative(), win);
    const got: WalletNotification[] = [];
    t.wallet.on((n) => got.push(n));
    const sent: WalletNotification = {
      notification_type: "payment_sent",
      notification: { type: "outgoing", state: "settled", transaction_id: "tx-2", payment_hash: HASH, preimage: PREIMAGE, amount: 20_000, fees_paid: 1000, created_at: 1793800000, settled_at: 1793803000 },
    };
    const notify = (win.strutWallet as { notify(m: unknown): void }).notify;
    notify({ v: 1, app: { name: "tip-jar", peer: "acme" }, notification: sent });
    notify(JSON.stringify({ v: 1, app: { name: "tip-jar", peer: "acme" }, notification: sent }));
    notify({ v: 1, app: { name: "tip-jar" }, notification: sent }); // this strut's own tip-jar: not hosted here
    notify({ v: 1, app: { name: "other", peer: "acme" }, notification: sent });
    notify({ v: 1, app: { name: "tip-jar", peer: "acme" }, notification: { notification_type: "payment_sent", notification: { type: "outgoing" } } });
    notify("not json");
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(got, [sent, sent]);
    await t.close();
  });
});

describe("finding the native host", () => {
  it("reads Peel's handler off the page, keeping its this", async () => {
    const handler = {
      seen: [] as unknown[],
      postMessage(m: unknown) {
        this.seen.push(m);
        return Promise.resolve({ result: CAPABILITY });
      },
    };
    const native = nativeWalletOf({ webkit: { messageHandlers: { strutWallet: handler } } });
    assert.ok(native);
    assert.deepEqual(await probeNativeWallet(native!, APP), CAPABILITY);
    assert.deepEqual(handler.seen, [{ v: 1, op: "capability", app: APP }]);
    assert.equal(nativeWalletOf({}), undefined);
    assert.equal(nativeWalletOf({ webkit: { messageHandlers: {} } }), undefined);
  });

  it("takes no wallet from a capability it cannot read, a refusal, or silence", async () => {
    const answering = (reply: unknown) => ({ postMessage: async () => reply });
    assert.equal(await probeNativeWallet(answering({ result: { ...CAPABILITY, version: 2 } }), APP), undefined);
    assert.equal(await probeNativeWallet(answering({ error: { code: -32000, message: "no", data: { code: "RESTRICTED" } } }), APP), undefined);
    assert.equal(await probeNativeWallet({ postMessage: () => new Promise(() => {}) }, APP, 20), undefined);
    assert.equal(await probeNativeWallet({ postMessage: async () => { throw new Error("x"); } }, APP), undefined);
  });

  it("never sends an identity that names no seller, or a request that is not one: no wallet", async () => {
    const native = new FakeNative();
    native.answer = () => ({ result: CAPABILITY });
    const { seller: _seller, ...noSeller } = APP;
    for (const app of [
      noSeller,
      { ...APP, seller: "http://192.168.1.2:3000" },
      { ...APP, seller: "https://shop.example?k=1" },
      { ...APP, request: { request_methods: ["drain_everything"] } },
    ]) {
      assert.equal(await probeNativeWallet(native, app as unknown as NativeWalletApp), undefined, JSON.stringify(app));
    }
    assert.deepEqual(native.sent, [], "the native host heard nothing");
    // Another server's public app: its seller is that server's base.
    const stranger: NativeWalletApp = { name: "tip-jar", version: "v1", seller: "https://shop.example.com", title: "Tip jar", request: APP.request };
    assert.deepEqual(await probeNativeWallet(native, stranger), CAPABILITY);
    assert.deepEqual(native.sent, [{ v: 1, op: "capability", app: stranger }]);
  });
});

/** A wallet client scripted by method, with notifications pushed by hand. */
function scripted(answers: Partial<Record<string, (params: unknown) => unknown>>): WalletClient & { push(n: WalletNotification): void; calls: Array<[string, unknown]> } {
  const listeners = new Set<(n: WalletNotification) => void>();
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    capability: () => CAPABILITY,
    async call(method, params) {
      calls.push([method, params]);
      const a = answers[method];
      if (!a) throw new WalletError("NOT_IMPLEMENTED", method);
      return (await a(params)) as never;
    },
    on(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    push(n) {
      for (const l of listeners) l(n);
    },
  };
}

describe("window.webln over the wallet", () => {
  it("sendPayment resolves with the preimage of a settled payment", async () => {
    const w = scripted({ pay_invoice: () => ({ ...pending, state: "settled", preimage: PREIMAGE, settled_at: 1793800001 }) });
    assert.deepEqual(await createWebLN(w).sendPayment("lnbc210n1pqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mua7l"), { preimage: PREIMAGE });
  });

  it("keysend waits for a pending payment to settle, sends customRecords as hex, sats as msat", async () => {
    const w = scripted({ pay_keysend: () => pending });
    const result = createWebLN(w, { settleWaitMs: 1000 }).keysend({ destination: PK, amount: 20, customRecords: { "7629169": "{\"action\":\"boost\"}" } });
    await new Promise((r) => setTimeout(r, 10));
    w.push({ notification_type: "payment_sent", notification: { type: "outgoing", state: "settled", transaction_id: "tx-2", payment_hash: HASH, preimage: PREIMAGE, amount: 20_000, created_at: 1793800000, settled_at: 1793800500 } });
    assert.deepEqual(await result, { preimage: PREIMAGE });
    assert.deepEqual(w.calls[0], ["pay_keysend", { pubkey: PK, amount: 20_000, tlv_records: [{ type: 7629169, value: "7b22616374696f6e223a22626f6f7374227d" }] }]);
  });

  it("never rejects a payment that may still settle: still pending after the wait, it says so", async () => {
    const w = scripted({ pay_keysend: () => pending });
    assert.deepEqual(await createWebLN(w, { settleWaitMs: 20 }).keysend({ destination: PK, amount: 20 }), { preimage: null, pending: true, transactionId: "tx-2" });
  });

  it("rejects a failed payment as a RoutingError and a decline as a RejectionError", async () => {
    const failing = scripted({ pay_keysend: () => pending });
    const result = createWebLN(failing, { settleWaitMs: 1000 }).keysend({ destination: PK, amount: 20 });
    await new Promise((r) => setTimeout(r, 10));
    failing.push({ notification_type: "payment_failed", notification: { type: "outgoing", state: "failed", transaction_id: "tx-2", payment_hash: HASH, amount: 20_000, created_at: 1793800000, failure_reason: "the payee never came online" } });
    await assert.rejects(result, (e: unknown) => (e as Error).name === "RoutingError" && /never came online/.test((e as Error).message));
    const declining = scripted({ connect: () => { throw new WalletError("USER_REJECTED", "no"); } });
    await assert.rejects(createWebLN(declining).enable(), (e: unknown) => (e as Error).name === "RejectionError");
  });

  it("maps getInfo, makeInvoice and getBalance onto the wallet's methods", async () => {
    const w = scripted({
      get_info: () => ({ alias: "Peel", network: "bitcoin", methods: ["connect", "get_info", "pay_keysend", "make_invoice"], notifications: [] }),
      make_invoice: () => ({ type: "incoming", invoice: "lnbc5u1pqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mua7l", payment_hash: HASH, amount: 500_000, created_at: 1793800000 }),
      get_balance: () => ({ balance: 21_999 }),
    });
    const webln = createWebLN(w);
    assert.deepEqual(await webln.getInfo(), { node: { alias: "Peel", pubkey: "" }, version: "strut-wallet-1", supports: ["lightning"], methods: ["enable", "getInfo", "keysend", "makeInvoice"] });
    assert.deepEqual(await webln.makeInvoice({ amount: 500, defaultMemo: "Q3 report" }), { paymentRequest: "lnbc5u1pqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mua7l" });
    assert.deepEqual(w.calls.at(-1), ["make_invoice", { amount: 500_000, description: "Q3 report" }]);
    assert.deepEqual(await webln.getBalance(), { balance: 21, currency: "sats" });
    await assert.rejects(webln.signMessage("hi"), (e: unknown) => (e as Error).name === "UnsupportedMethodError");
  });
});

describe("the host's own purchase through the native wallet (specs/WALLET.md §1.2)", () => {
  const purchase: CreditPurchase = {
    invoice: "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh",
    payment_hash: HASH,
    amount: 250_000_000,
    sats: 250_000,
    usd: 250,
    description: "acme/voxel/character: credit for one run",
    expires_at: 1893800000,
    seller: "https://acme.example",
    app: { name: "voxel", version: "v3", title: "Voxel" },
    workflow: "acme/voxel/character",
    credit: { carries: false },
  };
  const settled: Payment = { transaction_id: "tx-9", state: "settled", payment_hash: HASH, amount: 250_000_000, preimage: PREIMAGE, created_at: 1793800000, settled_at: 1793800001 };

  it("asks what the native host takes, and reads an older one's silence as nothing", async () => {
    const native = new FakeNative();
    native.answer = (m) => (m.op === "host_capability" ? { result: { version: 1, ops: ["buy_credit", "buy_credit_cancel", "buy_credit_refund"], wallet: "Peel" } } : { error: {} });
    assert.deepEqual(await probeHostWallet(native), { version: 1, ops: ["buy_credit", "buy_credit_cancel"], wallet: "Peel" }, "a newer op left out");
    assert.deepEqual(native.sent, [{ v: 1, op: "host_capability" }]);
    const old = new FakeNative();
    old.answer = () => ({ error: { code: -32601, message: "unknown op", data: { code: "NOT_IMPLEMENTED" } } });
    assert.equal(await probeHostWallet(old), undefined);
    const silent = { postMessage: () => new Promise<unknown>(() => {}) };
    assert.equal(await probeHostWallet(silent, 20), undefined);
    const broken = { postMessage: () => Promise.reject(new Error("no handler")) };
    assert.equal(await probeHostWallet(broken), undefined);
  });

  it("buys with one message and proves the preimage", async () => {
    const native = new FakeNative();
    native.answer = () => ({ result: settled });
    const r = await buyCreditNatively(native, purchase, { timeoutMs: 1000 });
    assert.deepEqual(r, { outcome: "paid", preimage: PREIMAGE });
    assert.deepEqual(native.sent, [{ v: 1, op: "buy_credit", purchase }]);
  });

  it("falls back on a decline and a rejected message; a payment that was SENT is never a fallback", async () => {
    const native = new FakeNative();
    native.answer = () => ({ error: { code: -32000, message: "Declined", data: { code: "USER_REJECTED" } } });
    assert.deepEqual(await buyCreditNatively(native, purchase, { timeoutMs: 1000, cancel: true }), { outcome: "fallback", code: "USER_REJECTED", message: "Declined" });
    // Settled with a preimage that proves nothing: sent, so the claim decides.
    native.answer = () => ({ result: { ...settled, preimage: "02".repeat(32) } });
    assert.deepEqual(await buyCreditNatively(native, purchase, { timeoutMs: 1000, cancel: true }), { outcome: "pending" });
    const broken = { postMessage: () => Promise.reject(new Error("gone")) };
    const r = await buyCreditNatively(broken, purchase, { timeoutMs: 1000 });
    assert.equal(r.outcome, "fallback");
    assert.equal(r.outcome === "fallback" && r.code, "INTERNAL");
    // The native host answered each time: no sheet to take down.
    assert.ok(native.sent.every((m) => m.op === "buy_credit"));
  });

  it("stops waiting at the timeout and asks the native host to take its sheet down", async () => {
    const native = new FakeNative();
    native.answer = (m) => (m.op === "buy_credit" ? new Promise(() => {}) : { result: {} });
    const r = await buyCreditNatively(native, purchase, { timeoutMs: 20, cancel: true });
    assert.equal(r.outcome, "fallback");
    assert.equal(r.outcome === "fallback" && r.code, "RESTRICTED");
    assert.deepEqual(native.sent.map((m) => m.op), ["buy_credit", "buy_credit_cancel"]);
    assert.deepEqual(native.sent[1], { v: 1, op: "buy_credit_cancel", payment_hash: HASH });
  });

  it("stops waiting when the page does, and never asks a native host that said it cannot cancel", async () => {
    const native = new FakeNative();
    native.answer = (m) => (m.op === "buy_credit" ? new Promise(() => {}) : { result: {} });
    const stop = new AbortController();
    const waiting = buyCreditNatively(native, purchase, { timeoutMs: 60_000, signal: stop.signal });
    stop.abort();
    const r = await waiting;
    assert.equal(r.outcome === "fallback" && r.code, "RESTRICTED");
    assert.deepEqual(native.sent.map((m) => m.op), ["buy_credit"]);
    // Already aborted, or an invoice already ended: never sent.
    const sent = native.sent.length;
    assert.equal((await buyCreditNatively(native, purchase, { timeoutMs: 1000, signal: stop.signal })).outcome, "fallback");
    assert.equal((await buyCreditNatively(native, purchase, { timeoutMs: 0 })).outcome, "fallback");
    assert.equal(native.sent.length, sent);
  });

  it("hands on an answer that comes after the page stopped waiting: a payment sent after all", async () => {
    const native = new FakeNative();
    let answer!: (v: unknown) => void;
    native.answer = (m) => (m.op === "buy_credit" ? new Promise((r) => (answer = r)) : { result: {} });
    const stop = new AbortController();
    const late: unknown[] = [];
    const waiting = buyCreditNatively(native, purchase, { timeoutMs: 60_000, signal: stop.signal, cancel: true, onLate: (o) => late.push(o) });
    stop.abort();
    assert.equal((await waiting).outcome, "fallback");
    answer({ result: { ...pending, payment_hash: HASH, amount: 250_000_000 } });
    for (let i = 0; i < 20 && !late.length; i++) await new Promise((r) => setTimeout(r, 1));
    assert.deepEqual(late, [{ outcome: "pending" }]);
  });

  it("asks where a pending purchase stands: proven, failed, and pending on silence or nonsense", async () => {
    const native = new FakeNative();
    native.answer = () => ({ result: settled });
    assert.deepEqual(await creditStatusNatively(native, HASH), { outcome: "paid", preimage: PREIMAGE });
    assert.deepEqual(native.sent, [{ v: 1, op: "buy_credit_status", payment_hash: HASH }]);
    native.answer = () => ({ result: { transaction_id: "t", state: "failed", payment_hash: HASH, amount: 1, created_at: 1, failure_reason: "no route" } });
    assert.deepEqual(await creditStatusNatively(native, HASH), { outcome: "fallback", code: "PAYMENT_FAILED", message: "no route" });
    native.answer = () => ({ error: { code: -32000, message: "?", data: { code: "NOT_FOUND" } } });
    assert.deepEqual(await creditStatusNatively(native, HASH), { outcome: "pending" }, "the person tapped: never the QR on a status it cannot read");
    native.answer = () => new Promise(() => {});
    assert.deepEqual(await creditStatusNatively(native, HASH, 10), { outcome: "pending" });
    assert.deepEqual(await creditStatusNatively({ postMessage: () => Promise.reject(new Error("gone")) }, HASH), { outcome: "pending" });
  });

  it("waits for a pending payment's claim", async () => {
    const native = new FakeNative();
    native.answer = () => ({ result: { transaction_id: "tx-9", state: "pending", payment_hash: HASH, amount: 250_000_000, created_at: 1793800000 } });
    assert.deepEqual(await buyCreditNatively(native, purchase, { timeoutMs: 1000 }), { outcome: "pending" });
  });
});
