import { teardownDom } from "../test-dom.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { App } from "@modelcontextprotocol/ext-apps";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import {
  WALLET_CAPABILITY, WalletError, walletCapabilityOf,
  type NativeWalletApp, type NativeWalletMessage, type Payment, type WalletCapability, type WalletNotification,
} from "./protocol.js";
import { PASS_THROUGH_SCHEMA, nativeWalletNotifications, nativeWalletOf, probeNativeWallet, relayNativeWallet, type RelayBridge } from "./relay.js";
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
