import { teardownDom, useActEnvironment } from "./test-dom.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { bootstrap, type Transport } from "./bootstrap.js";
import type { StrutClient } from "./client.js";
import { StrutProvider } from "./provider.js";
import { useTransaction, useWallet, type UseTransaction, type UseWallet } from "./wallet-hooks.js";
import { WALLET_CAPABILITY, WalletError, type Payment, type WalletCapability, type WalletNotification } from "./wallet/protocol.js";
import type { WalletClient } from "./wallet/client.js";
import type { WebLNProvider } from "./wallet/webln.js";

after(teardownDom);
useActEnvironment();

const PK = "02" + "a".repeat(64);
const HASH = "72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793";
const PREIMAGE = "01".repeat(32);
const CAPABILITY: WalletCapability = {
  version: 1,
  methods: ["connect", "get_info", "pay_keysend", "lookup_payment", "get_budget"],
  notifications: ["payment_sent", "payment_failed"],
  wallet: "sphinx",
  connected: false,
};
const pending: Payment = { transaction_id: "tx-2", state: "pending", payment_hash: HASH, amount: 20_000, created_at: 1793800000 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, ms = 3000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await act(async () => { await sleep(10); });
  }
}

type Msg = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

/** A host on the other end of the bridge that offers (or not) a wallet and
 *  answers `strut/wallet/*` from a script. */
class WalletHostTransport implements Transport {
  onmessage?: (message: Msg) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  walletCalls: Array<{ method: string; params?: unknown }> = [];
  constructor(readonly offer: WalletCapability | null, readonly answers: Record<string, unknown> = {}) {}
  async start() {}
  async close() { this.onclose?.(); }
  async send(message: Msg) {
    if (message.id === undefined || !message.method) return;
    const reply = (body: { result?: unknown; error?: unknown }) => queueMicrotask(() => this.onmessage?.({ jsonrpc: "2.0", id: message.id, ...body } as Msg));
    if (message.method === "ui/initialize") {
      reply({ result: {
        protocolVersion: (message.params as { protocolVersion: string }).protocolVersion,
        hostInfo: { name: "fake-host", version: "1" },
        hostCapabilities: { openLinks: {}, ...(this.offer ? { experimental: { [WALLET_CAPABILITY]: this.offer } } : {}) },
        hostContext: {},
      } });
    } else if (message.method.startsWith("strut/wallet/")) {
      const method = message.method.slice("strut/wallet/".length);
      this.walletCalls.push({ method, params: message.params });
      reply(method in this.answers ? { result: this.answers[method] } : { error: { code: -32000, message: "no", data: { code: "NOT_IMPLEMENTED" } } });
    } else {
      reply({ result: {} });
    }
  }
}

const noClient: StrutClient = { run: async () => undefined as never };

describe("the bootstrap and the host's wallet", () => {
  it("installs window.webln and hands the wallet to the hooks when the host offers one", async () => {
    delete (window as { webln?: unknown }).webln;
    const host = new WalletHostTransport(CAPABILITY, {
      get_info: { alias: "Peel", network: "bitcoin", methods: ["connect", "get_info", "pay_keysend"], notifications: [] },
    });
    let wallet: UseWallet | undefined;
    function Probe() {
      wallet = useWallet();
      return null;
    }
    const root = document.createElement("div");
    document.body.appendChild(root);
    const mounted = await bootstrap(Probe, { transport: host, document, root });
    assert.deepEqual(mounted.wallet.capability(), CAPABILITY);
    const webln = (window as { webln?: WebLNProvider }).webln;
    assert.ok(webln, "window.webln is installed");
    assert.deepEqual((await webln!.getInfo()).methods, ["enable", "getInfo", "keysend"]);
    await until(() => wallet?.connected === true, "useWallet read get_info");
    assert.equal(wallet!.available, true);
    assert.equal(wallet!.wallet, "sphinx");
    assert.equal(wallet!.info?.alias, "Peel");
    await mounted.unmount();
    root.remove();
  });

  it("leaves window.webln out, and the wallet unavailable, when the host offers none", async () => {
    delete (window as { webln?: unknown }).webln;
    let wallet: UseWallet | undefined;
    function Probe() {
      wallet = useWallet();
      return null;
    }
    const root = document.createElement("div");
    document.body.appendChild(root);
    const mounted = await bootstrap(Probe, { transport: new WalletHostTransport(null), document, root });
    assert.equal((window as { webln?: unknown }).webln, undefined);
    await until(() => wallet !== undefined, "rendered");
    assert.equal(wallet!.available, false);
    await assert.rejects(wallet!.payKeysend({ pubkey: PK, amount: 1000 }), (e: unknown) => e instanceof WalletError && e.code === "NOT_IMPLEMENTED");
    await mounted.unmount();
    root.remove();
  });
});

/** A wallet client scripted by method, recording calls, with notifications pushed by hand. */
function scripted(answer: (method: string, n: number) => unknown) {
  const listeners = new Set<(n: WalletNotification) => void>();
  const calls: string[] = [];
  const client: WalletClient = {
    capability: () => CAPABILITY,
    async call(method) {
      calls.push(method);
      const r = answer(method, calls.filter((c) => c === method).length);
      if (r instanceof Error) throw r;
      return r as never;
    },
    on(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return { client, calls, push: (n: WalletNotification) => { for (const l of listeners) l(n); } };
}

async function renderHook<T>(use: () => T, wallet: WalletClient) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let current: T | undefined;
  function Probe() {
    current = use();
    return null;
  }
  await act(async () => { root.render(createElement(StrutProvider, { client: noClient, wallet }, createElement(Probe))); });
  return { result: () => current as T, unmount: () => act(async () => { root.unmount(); container.remove(); }) };
}

describe("useWallet", () => {
  it("connects first when a call meets no connection, then goes on", async () => {
    const info = (granted: boolean) => ({ network: "bitcoin", methods: granted ? ["connect", "get_info", "pay_keysend"] : ["connect", "get_info"], notifications: [] });
    let isConnected = false;
    const w = scripted((method, n) => {
      if (method === "get_info") return info(isConnected);
      if (method === "connect") {
        isConnected = true;
        return { connection: { methods: ["pay_keysend"], notification_types: [] } };
      }
      if (method === "pay_keysend") return n === 1 ? new WalletError("UNAUTHORIZED", "connect first") : pending;
      return new WalletError("NOT_IMPLEMENTED", method);
    });
    const h = await renderHook(() => useWallet(), w.client);
    await until(() => h.result().info !== undefined, "get_info");
    assert.equal(h.result().connected, false);
    let payment: Payment | undefined;
    await act(async () => { payment = await h.result().payKeysend({ pubkey: PK, amount: 20_000 }); });
    assert.deepEqual(payment, pending);
    // get_info reads in between (connect refreshes it); the calls that matter:
    assert.deepEqual(w.calls.filter((c) => c !== "get_info"), ["pay_keysend", "connect", "pay_keysend"]);
    await until(() => h.result().connected === true, "connected after connect");
    await h.unmount();
  });

  it("passes a refusal through: no second connect for anything but UNAUTHORIZED", async () => {
    const w = scripted((method) => (method === "get_info" ? { network: "bitcoin", methods: ["connect", "get_info", "pay_keysend"], notifications: [] } : new WalletError("QUOTA_EXCEEDED", "over budget")));
    const h = await renderHook(() => useWallet(), w.client);
    await assert.rejects(h.result().payKeysend({ pubkey: PK, amount: 1 }), (e: unknown) => e instanceof WalletError && e.code === "QUOTA_EXCEEDED");
    assert.ok(!w.calls.includes("connect"));
    await h.unmount();
  });
});

describe("useTransaction", () => {
  it("follows a pending payment to settled on its notification, and ignores others'", async () => {
    const w = scripted(() => new WalletError("RESTRICTED", "no lookups"));
    const h = await renderHook(() => useTransaction(pending), w.client);
    assert.equal(h.result().state, "pending");
    const sent = (id: string): WalletNotification => ({
      notification_type: "payment_sent",
      notification: { type: "outgoing", state: "settled", transaction_id: id, payment_hash: HASH, preimage: PREIMAGE, amount: 20_000, fees_paid: 1000, created_at: 1793800000, settled_at: 1793803000 },
    });
    await act(async () => { w.push(sent("tx-other")); });
    assert.equal(h.result().state, "pending");
    await act(async () => { w.push(sent("tx-2")); });
    assert.deepEqual(h.result() satisfies UseTransaction, { state: "settled", preimage: PREIMAGE, feesPaid: 1000, settledAt: 1793803000 });
    await h.unmount();
  });

  it("follows a pending payment to failed", async () => {
    const w = scripted(() => new WalletError("RESTRICTED", "no lookups"));
    const h = await renderHook(() => useTransaction(pending), w.client);
    await act(async () => {
      w.push({ notification_type: "payment_failed", notification: { type: "outgoing", state: "failed", transaction_id: "tx-2", payment_hash: HASH, amount: 20_000, created_at: 1793800000, failure_reason: "the payee never came online" } });
    });
    assert.deepEqual(h.result(), { state: "failed", failureReason: "the payee never came online" });
    await h.unmount();
  });
});
