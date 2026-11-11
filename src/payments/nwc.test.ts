/**
 * The NWC provider against a stand-in relay on this machine and a wallet
 * service behind it (NIP-47), the wallet's books a FakeWallet. No test
 * reaches a public relay.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { ERROR_CODES, WALLET_METHODS } from "../../kit/src/wallet/protocol.js";
import { decodeBolt11, encodeBolt11 } from "./bolt11.js";
import { FakeWallet } from "./fake-wallet.js";
import { NwcPayer } from "./payer.js";
import { LightningError } from "./lightning.js";
import {
  NWC_ERROR_MAP,
  NWC_INFO_KIND,
  NWC_RECEIVE_METHODS,
  NWC_REQUEST_KIND,
  NWC_RESPONSE_KIND,
  NwcProvider,
  eventId,
  nip04Decrypt,
  nip04Encrypt,
  nip44ConversationKey,
  nip44Decrypt,
  nip44Encrypt,
  publicKeyOf,
  signEvent,
  verifyEvent,
  type NostrEvent,
} from "./nwc.js";

const code = (c: LightningError["code"]) => (err: unknown) => err instanceof LightningError && err.code === c;

describe("NIP-44 v2, NIP-04 and NIP-01 events", () => {
  it("matches NIP-44's first test vector", () => {
    const sec1 = "0".repeat(63) + "1";
    const pub2 = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"; // secret 2's x-only key
    const ck = nip44ConversationKey(sec1, pub2);
    assert.equal(ck.toString("hex"), "c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d");
    const nonce = Buffer.from("0".repeat(63) + "1", "hex");
    const payload = nip44Encrypt(ck, "a", nonce);
    assert.equal(payload, "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb");
    assert.equal(nip44Decrypt(ck, payload), "a");
  });

  it("round-trips both ways, pads, and refuses a tampered payload", async () => {
    const [a, b] = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
    const [pa, pb] = await Promise.all([publicKeyOf(a), publicKeyOf(b)]);
    const text = JSON.stringify({ method: "get_balance", params: {}, note: "é".repeat(300) });
    assert.equal(nip44Decrypt(nip44ConversationKey(b, pa), nip44Encrypt(nip44ConversationKey(a, pb), text)), text);
    assert.equal(nip04Decrypt(b, pa, nip04Encrypt(a, pb, text)), text);
    const raw = Buffer.from(nip44Encrypt(nip44ConversationKey(a, pb), "hello"), "base64");
    raw[40]! ^= 1;
    assert.throws(() => nip44Decrypt(nip44ConversationKey(b, pa), raw.toString("base64")), /MAC/);
    assert.equal(Buffer.from(nip44Encrypt(nip44ConversationKey(a, pb), "x"), "base64").length, 1 + 32 + 34 + 32, "one byte pads to 32");
  });

  it("signs an event its id and pubkey vouch for, and a changed one fails", async () => {
    const secret = randomBytes(32).toString("hex");
    const e = await signEvent({ kind: 1, created_at: 1_793_000_000, tags: [["p", "a".repeat(64)]], content: "hi" }, secret);
    assert.equal(e.pubkey, await publicKeyOf(secret));
    assert.equal(e.id, eventId(e));
    assert.ok(await verifyEvent(e));
    assert.equal(await verifyEvent({ ...e, content: "hi!" }), false);
    assert.equal(await verifyEvent({ ...e, sig: "00".repeat(64) }), false);
  });

  it("names its methods and error codes as the app wallet contract does", () => {
    for (const m of NWC_RECEIVE_METHODS) assert.ok((WALLET_METHODS as readonly string[]).includes(m), m);
    assert.ok(!NWC_RECEIVE_METHODS.some((m) => m.startsWith("pay_")), "nothing that pays");
    assert.deepEqual(Object.keys(NWC_ERROR_MAP).sort(), ERROR_CODES.filter((c) => c !== "USER_REJECTED").sort(), "every NWC error code is mapped; USER_REJECTED is strut's own");
  });
});

// ── a relay and a wallet service ─────────────────────────────────────────

interface Filter {
  kinds?: number[];
  authors?: string[];
  "#e"?: string[];
  limit?: number;
}
const matches = (f: Filter, e: NostrEvent) =>
  (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)) && (!f["#e"] || e.tags.some((t) => t[0] === "e" && f["#e"]!.includes(t[1]!)));

class Relay {
  wss!: WebSocketServer;
  url = "";
  stored: NostrEvent[] = [];
  subs = new Map<WebSocket, Map<string, Filter>>();
  /** Called for each published event; a wallet service listens here. */
  onEvent: (e: NostrEvent) => void = () => {};
  /** Before the real answer, send this on the subscription (a forger). */
  forge: ((sub: string, e: NostrEvent) => NostrEvent | null) | null = null;

  async start() {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => this.wss.once("listening", () => r()));
    this.url = `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
    this.wss.on("connection", (ws) => {
      this.subs.set(ws, new Map());
      ws.on("close", () => this.subs.delete(ws));
      ws.on("message", (data) => {
        const msg = JSON.parse(String(data)) as unknown[];
        if (msg[0] === "REQ") {
          const [, sub, filter] = msg as [string, string, Filter];
          this.subs.get(ws)!.set(sub, filter);
          const hits = this.stored.filter((e) => matches(filter, e)).slice(-(filter.limit ?? 1000));
          for (const e of hits) ws.send(JSON.stringify(["EVENT", sub, e]));
          ws.send(JSON.stringify(["EOSE", sub]));
        } else if (msg[0] === "CLOSE") {
          this.subs.get(ws)?.delete(msg[1] as string);
        } else if (msg[0] === "EVENT") {
          const e = msg[1] as NostrEvent;
          ws.send(JSON.stringify(["OK", e.id, true, ""]));
          this.publish(e);
        }
      });
    });
  }

  publish(e: NostrEvent) {
    if (e.kind === NWC_INFO_KIND) this.stored.push(e);
    for (const [ws, subs] of this.subs) {
      for (const [sub, f] of subs) {
        if (!matches(f, e)) continue;
        const forged = this.forge?.(sub, e);
        if (forged) ws.send(JSON.stringify(["EVENT", sub, forged]));
        ws.send(JSON.stringify(["EVENT", sub, e]));
      }
    }
    this.onEvent(e);
  }

  stop() {
    for (const ws of this.subs.keys()) ws.terminate();
    return new Promise<void>((r) => this.wss.close(() => r()));
  }
}

/** A wallet service: reads requests p-tagged to it, answers from a FakeWallet. */
class WalletService {
  secret = randomBytes(32).toString("hex");
  pubkey = "";
  fake = new FakeWallet();
  requests: Array<{ method: string; params: Record<string, unknown>; encryption: string; author: string }> = [];
  silent = false;
  /** The pay side: how the next pay_invoice ends, and what it paid. */
  payOutcomes: Array<"settled" | "failed" | "no_answer" | "no_preimage" | "INSUFFICIENT_BALANCE"> = [];
  preimages = new Map<string, string>();
  outgoing = new Map<string, { state: "pending" | "settled" | "failed"; fees_paid: number }>();

  constructor(private relay: Relay) {}

  async start(opts: { nip44: boolean; methods: string[] }) {
    this.pubkey = await publicKeyOf(this.secret);
    this.relay.publish(
      await signEvent({ kind: NWC_INFO_KIND, created_at: 1_793_000_000, tags: opts.nip44 ? [["encryption", "nip44_v2 nip04"]] : [], content: opts.methods.join(" ") }, this.secret),
    );
    this.relay.onEvent = (e) => void this.handle(e);
  }

  async handle(e: NostrEvent) {
    if (e.kind !== NWC_REQUEST_KIND || !e.tags.some((t) => t[0] === "p" && t[1] === this.pubkey)) return;
    const nip44 = e.tags.some((t) => t[0] === "encryption" && t[1] === "nip44_v2");
    const text = nip44 ? nip44Decrypt(nip44ConversationKey(this.secret, e.pubkey), e.content) : nip04Decrypt(this.secret, e.pubkey, e.content);
    const { method, params } = JSON.parse(text) as { method: string; params: Record<string, unknown> };
    this.requests.push({ method, params, encryption: nip44 ? "nip44_v2" : "nip04", author: e.pubkey });
    if (this.silent) return;
    let body: unknown;
    if (method === "pay_invoice") {
      const hash = decodeBolt11(params["invoice"] as string).paymentHash;
      const outcome = this.payOutcomes.shift() ?? "settled";
      if (outcome === "no_answer") {
        this.outgoing.set(hash, { state: "pending", fees_paid: 0 });
        return;
      }
      if (outcome === "INSUFFICIENT_BALANCE") body = { result_type: method, error: { code: "INSUFFICIENT_BALANCE", message: "not enough sats" } };
      else if (outcome === "no_preimage") body = { result_type: method, result: { fees_paid: 2000 } };
      else if (outcome === "failed") {
        this.outgoing.set(hash, { state: "failed", fees_paid: 0 });
        body = { result_type: method, error: { code: "PAYMENT_FAILED", message: "no route" } };
      } else {
        this.outgoing.set(hash, { state: "settled", fees_paid: 2000 });
        body = { result_type: method, result: { preimage: this.preimages.get(hash), fees_paid: 2000 } };
      }
    } else if (method === "lookup_invoice" && this.outgoing.has(params["payment_hash"] as string)) {
      const hash = params["payment_hash"] as string;
      const o = this.outgoing.get(hash)!;
      body = { result_type: method, result: { type: "outgoing", state: o.state, payment_hash: hash, amount: 1, fees_paid: o.fees_paid, created_at: 1, ...(o.state === "settled" ? { preimage: this.preimages.get(hash), settled_at: 2 } : {}) } };
    } else {
      try {
        body = { result_type: method, result: await this.answer(method, params) };
      } catch (err) {
        body = { result_type: method, error: { code: err instanceof LightningError && err.code === "invoice_unknown" ? "NOT_FOUND" : "INTERNAL", message: (err as Error).message } };
      }
    }
    const plain = JSON.stringify(body);
    const content = nip44 ? nip44Encrypt(nip44ConversationKey(this.secret, e.pubkey), plain) : nip04Encrypt(this.secret, e.pubkey, plain);
    this.relay.publish(await signEvent({ kind: NWC_RESPONSE_KIND, created_at: Math.floor(Date.now() / 1000), tags: [["p", e.pubkey], ["e", e.id]], content }, this.secret));
  }

  async answer(method: string, params: Record<string, unknown>): Promise<unknown> {
    const s = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    if (method === "make_invoice") {
      const inv = await this.fake.makeInvoice({ msat: params["amount"] as number, ...(params["expiry"] ? { expirySecs: params["expiry"] as number } : {}) });
      return { type: "incoming", state: "pending", invoice: inv.invoice, payment_hash: inv.payment_hash, amount: params["amount"], created_at: Math.floor(Date.now() / 1000), expires_at: s(inv.expires) };
    }
    if (method === "lookup_invoice") {
      const l = await this.fake.lookup(params["payment_hash"] as string);
      const inv = this.fake.invoices().find((i) => i.payment_hash === params["payment_hash"])!;
      return { type: "incoming", state: l.state, payment_hash: inv.payment_hash, amount: l.msat ?? inv.msat, created_at: 1, ...(l.settled_at ? { settled_at: s(l.settled_at) } : {}), ...(l.preimage ? { preimage: l.preimage } : {}) };
    }
    if (method === "list_transactions") {
      const since = params["from"] ? new Date((params["from"] as number) * 1000).toISOString() : undefined;
      const rows = await this.fake.received({ ...(since ? { since } : {}) });
      // An old wallet: no `state`, settled by `settled_at`; newest first.
      return { transactions: rows.reverse().map((r) => ({ type: "incoming", payment_hash: r.payment_hash, amount: r.msat, created_at: 1, settled_at: s(r.at) })).concat([{ type: "outgoing", payment_hash: "e".repeat(64), amount: 5, created_at: 1, settled_at: 2 } as never]) };
    }
    if (method === "get_balance") return { balance: (await this.fake.balance()).msat };
    throw new Error(`no ${method}`);
  }
}

const RECEIVE = ["make_invoice", "lookup_invoice", "list_transactions", "get_balance"];

for (const nip44 of [true, false]) {
  describe(`NwcProvider, a wallet that speaks ${nip44 ? "NIP-44" : "only NIP-04"}`, () => {
    const relay = new Relay();
    let wallet: WalletService;
    let client: string;
    let url: string;
    before(async () => {
      await relay.start();
    });
    after(() => relay.stop());
    beforeEach(async () => {
      relay.stored = [];
      relay.forge = null;
      wallet = new WalletService(relay);
      await wallet.start({ nip44, methods: RECEIVE });
      client = randomBytes(32).toString("hex");
      url = `nostr+walletconnect://${wallet.pubkey}?relay=${encodeURIComponent(relay.url)}&secret=${client}`;
    });

    it("makes, looks up, lists and balances, each request signed by the connection's key and encrypted as the wallet says", async () => {
      const p = new NwcProvider({ url, timeoutMs: 5000 });
      const inv = await p.makeInvoice({ msat: 21_000, description: "one run", expirySecs: 600 });
      assert.match(inv.payment_hash, /^[0-9a-f]{64}$/);
      assert.ok(Math.abs(Date.parse(inv.expires) - (Date.now() + 600_000)) < 2000);
      assert.deepEqual(await p.lookup(inv.payment_hash), { state: "pending" });
      wallet.fake.settle(inv.payment_hash, { msat: 15_000 });
      const settled = await p.lookup(inv.payment_hash);
      assert.equal(settled.state, "settled");
      assert.equal(settled.msat, 15_000);
      assert.equal(createHash("sha256").update(Buffer.from(settled.preimage!, "hex")).digest("hex"), inv.payment_hash);
      const rec = await p.received({ limit: 10 });
      assert.deepEqual(rec.map((r) => [r.payment_hash, r.msat]), [[inv.payment_hash, 15_000]], "the outgoing one is not received");
      assert.deepEqual(await p.balance(), { msat: 15_000 });

      assert.deepEqual(wallet.requests.map((r) => r.method), ["make_invoice", "lookup_invoice", "lookup_invoice", "list_transactions", "get_balance"]);
      assert.deepEqual(wallet.requests[0]!.params, { amount: 21_000, description: "one run", expiry: 600 });
      assert.deepEqual(wallet.requests[3]!.params, { type: "incoming", unpaid: false, limit: 10 });
      const me = await publicKeyOf(client);
      for (const r of wallet.requests) {
        assert.equal(r.encryption, nip44 ? "nip44_v2" : "nip04");
        assert.equal(r.author, me);
      }
    });

    it("an unknown invoice is invoice_unknown; a method the connection does not allow is refused before a request", async () => {
      const p = new NwcProvider({ url, timeoutMs: 5000 });
      await assert.rejects(p.lookup("ab".repeat(32)), code("invoice_unknown"));
      relay.stored = [];
      const narrow = new WalletService(relay);
      await narrow.start({ nip44, methods: ["make_invoice", "pay_invoice"] });
      const q = new NwcProvider({ url: `nostr+walletconnect://${narrow.pubkey}?relay=${encodeURIComponent(relay.url)}&secret=${client}`, timeoutMs: 5000 });
      await assert.rejects(q.balance(), (e: unknown) => code("wallet_unauthorized")(e) && /does not allow get_balance/.test((e as Error).message));
      assert.equal(narrow.requests.length, 0);
    });

    it("ignores an answer the wallet did not sign, and takes the real one after it", async () => {
      relay.forge = (_sub, e) => (e.kind === NWC_RESPONSE_KIND ? { ...e, content: e.content.split("").reverse().join("") } : null);
      const p = new NwcProvider({ url, timeoutMs: 5000 });
      assert.deepEqual(await p.balance(), { msat: 0 });
    });

    it("a wallet that never answers, or a relay that is not there, is wallet_unavailable", async () => {
      wallet.silent = true;
      const p = new NwcProvider({ url, timeoutMs: 1500 });
      await assert.rejects(p.balance(), code("wallet_unavailable"));
      const gone = new NwcProvider({ url: url.replace(encodeURIComponent(relay.url), encodeURIComponent("ws://127.0.0.1:1")), timeoutMs: 1500 });
      await assert.rejects(gone.balance(), (e: unknown) => code("wallet_unavailable")(e) && /no NWC relay answered/.test((e as Error).message) && !(e as Error).message.includes(client));
    });
  });
}

describe("NwcPayer: pay_invoice over the pay connection", () => {
  const relay = new Relay();
  let wallet: WalletService;
  let payUrl: string;
  let receiveUrl: string;
  before(() => relay.start());
  after(() => relay.stop());
  beforeEach(async () => {
    relay.stored = [];
    relay.forge = null;
    wallet = new WalletService(relay);
    await wallet.start({ nip44: true, methods: [...RECEIVE, "pay_invoice"] });
    const at = (secret: string) => `nostr+walletconnect://${wallet.pubkey}?relay=${encodeURIComponent(relay.url)}&secret=${secret}`;
    payUrl = at(randomBytes(32).toString("hex"));
    receiveUrl = at(randomBytes(32).toString("hex"));
  });
  const invoice = (msat = 21_000) => {
    const preimage = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
    wallet.preimages.set(hash, preimage);
    return { hash, preimage, invoice: encodeBolt11({ msat, paymentHash: hash, expirySecs: 600 }) };
  };

  it("settled: the preimage proves it and the fee is what the wallet says; nothing caps it", async () => {
    const p = new NwcPayer({ payUrl, url: receiveUrl, timeoutMs: 5000 });
    assert.equal(p.capsFee, false);
    const inv = invoice();
    assert.deepEqual(await p.pay({ invoice: inv.invoice, maxFeeMsat: 5000 }), { paymentHash: inv.hash, state: "settled", feeMsat: 2000, preimage: inv.preimage });
    const req = wallet.requests.find((r) => r.method === "pay_invoice")!;
    assert.deepEqual(req.params, { invoice: inv.invoice }, "NIP-47's pay_invoice takes no fee cap");
    assert.equal(req.author, await publicKeyOf(new URL(payUrl.replace("nostr+walletconnect", "http")).searchParams.get("secret")!), "signed by the pay connection");
  });

  it("PAYMENT_FAILED is failed with the wallet's words; INSUFFICIENT_BALANCE is a refusal before sending", async () => {
    const p = new NwcPayer({ payUrl, timeoutMs: 5000 });
    wallet.payOutcomes.push("failed", "INSUFFICIENT_BALANCE");
    const failed = invoice();
    const out = await p.pay({ invoice: failed.invoice, maxFeeMsat: 5000 });
    assert.equal(out.state, "failed");
    assert.match(out.error!, /PAYMENT_FAILED: no route/);
    await assert.rejects(p.pay({ invoice: invoice().invoice, maxFeeMsat: 5000 }), (e: unknown) => code("wallet_refused")(e) && (e as LightningError).walletCode === "INSUFFICIENT_BALANCE");
  });

  it("published with no answer is pending; status reads it with lookup_invoice, then settled", async () => {
    const p = new NwcPayer({ payUrl, url: receiveUrl, timeoutMs: 1500 });
    wallet.payOutcomes.push("no_answer");
    const inv = invoice();
    assert.deepEqual(await p.pay({ invoice: inv.invoice, maxFeeMsat: 5000 }), { paymentHash: inv.hash, state: "pending", feeMsat: 0 });
    assert.equal((await p.status({ invoice: inv.invoice, paymentHash: inv.hash, maxFeeMsat: 5000 })).state, "pending");
    wallet.outgoing.set(inv.hash, { state: "settled", fees_paid: 1500 });
    assert.deepEqual(await p.status({ invoice: inv.invoice, paymentHash: inv.hash, maxFeeMsat: 5000 }), { paymentHash: inv.hash, state: "settled", feeMsat: 1500, preimage: inv.preimage });
    assert.equal(wallet.requests.filter((r) => r.method === "pay_invoice").length, 1, "status never pays");
    // No record of it is not "nothing was paid": pending, saying so.
    const unknown = invoice();
    const none = await p.status({ invoice: unknown.invoice, paymentHash: unknown.hash, maxFeeMsat: 5000 });
    assert.deepEqual([none.state, none.error], ["pending", "the wallet has no record of this payment"]);
  });

  it("a pay_invoice that answered is never failed: with no preimage that proves it, pending — and named by its wallet's pubkey", async () => {
    const p = new NwcPayer({ payUrl, timeoutMs: 5000 });
    assert.equal(p.id, `nwc:${wallet.pubkey}`);
    wallet.payOutcomes.push("no_preimage");
    const inv = invoice();
    const out = await p.pay({ invoice: inv.invoice, maxFeeMsat: 5000 });
    assert.equal(out.state, "pending");
    assert.match(out.error!, /no preimage/);
  });

  it("a relay that is not there is wallet_unavailable before anything went out", async () => {
    const gone = new NwcPayer({ payUrl: payUrl.replace(encodeURIComponent(relay.url), encodeURIComponent("ws://127.0.0.1:1")), timeoutMs: 1500 });
    await assert.rejects(gone.pay({ invoice: invoice().invoice, maxFeeMsat: 5000 }), code("wallet_unavailable"));
  });
});
