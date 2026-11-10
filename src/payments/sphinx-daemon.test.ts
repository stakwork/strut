/**
 * The Sphinx daemon provider against a stand-in daemon: an HTTP server that
 * answers the routes specs/LIGHTNING.md writes down, so the daemon side can
 * be built to match what this test drives.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { SphinxDaemonProvider, daemonUrl } from "./sphinx-daemon.js";
import { LightningError, lightningCapability } from "./lightning.js";
import { receiveProvider } from "./wallet.js";

const RECEIVE = "receive-token-1";
const PAY = "pay-token-1";

interface StoredInvoice {
  hash: string;
  preimage: string;
  sats: number;
  description?: string;
  expiresAt: number;
  settled?: { msat: number; at: number };
}

/** A daemon with the API strut reads: invoices, lookups, payments, balance. */
class StandIn {
  server!: Server;
  url = "";
  invoices = new Map<string, StoredInvoice>();
  requests: Array<{ method: string; path: string; auth: string | undefined; body: unknown }> = [];
  /** A route answers this instead, once. */
  next: { status: number; body: unknown } | null = null;
  /** Answer as today's daemon: POST /invoice → { invoice, sats }, nothing else. */
  old = false;

  async start() {
    this.server = createServer(async (req, res) => {
      const body = await readBody(req);
      const url = new URL(req.url ?? "/", "http://x");
      this.requests.push({ method: req.method ?? "", path: url.pathname + url.search, auth: req.headers.authorization, body });
      const send = (status: number, b: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      if (this.next) {
        const n = this.next;
        this.next = null;
        return send(n.status, n.body);
      }
      if (req.headers.authorization !== `Bearer ${RECEIVE}`) return send(401, { error: "unauthorized", code: "unauthorized" });
      const key = `${req.method} ${url.pathname}`;
      if (key === "POST /invoice") {
        const b = body as { sats?: number; description?: string; expiry?: number };
        const preimage = randomBytes(32).toString("hex");
        const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
        const expiresAt = Math.floor(Date.now() / 1000) + (b.expiry ?? 3600);
        this.invoices.set(hash, { hash, preimage, sats: b.sats!, ...(b.description ? { description: b.description } : {}), expiresAt });
        if (this.old) return send(200, { invoice: `lnbc${b.sats}n1fake`, sats: b.sats });
        return send(200, { invoice: `lnbc${b.sats}n1fake${hash.slice(0, 8)}`, sats: b.sats, payment_hash: hash, expires_at: expiresAt });
      }
      if (this.old) return send(404, { error: `no route ${key}`, code: "not_found" });
      if (req.method === "GET" && url.pathname.startsWith("/invoice/")) {
        const inv = this.invoices.get(url.pathname.slice("/invoice/".length));
        if (!inv) return send(404, { error: "no such invoice", code: "not_found" });
        if (inv.settled) return send(200, { payment_hash: inv.hash, state: "settled", msat: inv.settled.msat, settled_at: inv.settled.at, preimage: inv.preimage, expires_at: inv.expiresAt });
        return send(200, { payment_hash: inv.hash, state: inv.expiresAt * 1000 <= Date.now() ? "expired" : "pending", expires_at: inv.expiresAt });
      }
      if (key === "GET /payments") {
        const since = Number(url.searchParams.get("since") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 1000);
        const payments = [...this.invoices.values()]
          .filter((i) => i.settled && i.settled.at >= since)
          .map((i) => ({ payment_hash: i.hash, msat: i.settled!.msat, settled_at: i.settled!.at }))
          // newest first, to show the provider orders them itself
          .sort((a, b) => b.settled_at - a.settled_at)
          .slice(0, limit);
        return send(200, { payments });
      }
      if (key === "GET /balance") {
        let msat = 0;
        for (const i of this.invoices.values()) msat += i.settled?.msat ?? 0;
        return send(200, { msat });
      }
      return send(404, { error: `no route ${key}`, code: "not_found" });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  settle(hash: string, msat?: number, at = Math.floor(Date.now() / 1000)) {
    const inv = this.invoices.get(hash)!;
    inv.settled = { msat: msat ?? inv.sats * 1000, at };
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolve(text ? JSON.parse(text) : undefined);
    });
  });
}

const code = (c: LightningError["code"]) => (err: unknown) => err instanceof LightningError && err.code === c;

describe("SphinxDaemonProvider", () => {
  const daemon = new StandIn();
  let provider: SphinxDaemonProvider;
  before(() => daemon.start());
  after(() => daemon.stop());
  beforeEach(() => {
    daemon.invoices.clear();
    daemon.requests = [];
    daemon.old = false;
    provider = new SphinxDaemonProvider({ url: `${daemon.url}/`, token: RECEIVE });
  });

  it("makes an invoice in whole sats with its description and expiry, with the receive token", async () => {
    const inv = await provider.makeInvoice({ msat: 10_250_000, description: "acme/voxel: credit for one run", expirySecs: 600 });
    assert.match(inv.payment_hash, /^[0-9a-f]{64}$/);
    assert.ok(inv.invoice.startsWith("lnbc10250n1fake"));
    const expires = Date.parse(inv.expires) - Date.now();
    assert.ok(expires > 590_000 && expires <= 600_000, `expires in ${expires} ms`);
    const req = daemon.requests[0]!;
    assert.deepEqual([req.method, req.path, req.auth], ["POST", "/invoice", `Bearer ${RECEIVE}`]);
    assert.deepEqual(req.body, { sats: 10250, description: "acme/voxel: credit for one run", expiry: 600 });
  });

  it("refuses an amount that is not whole sats before asking", async () => {
    await assert.rejects(provider.makeInvoice({ msat: 1500 }), code("bad_request"));
    assert.equal(daemon.requests.length, 0);
  });

  it("looks an invoice up: pending, settled in full or short with its preimage, expired, unknown", async () => {
    const a = await provider.makeInvoice({ msat: 5000_000 });
    assert.deepEqual(await provider.lookup(a.payment_hash), { state: "pending" });
    daemon.settle(a.payment_hash, 4000_000, 1_793_000_000);
    const settled = await provider.lookup(a.payment_hash.toUpperCase());
    assert.equal(settled.state, "settled");
    assert.equal(settled.msat, 4000_000, "a short payment is what settled, not what was asked");
    assert.equal(settled.settled_at, new Date(1_793_000_000 * 1000).toISOString());
    assert.equal(createHash("sha256").update(Buffer.from(settled.preimage!, "hex")).digest("hex"), a.payment_hash);
    assert.equal(daemon.requests.at(-1)!.path, `/invoice/${a.payment_hash}`);

    const b = await provider.makeInvoice({ msat: 1000, expirySecs: 1 });
    daemon.invoices.get(b.payment_hash)!.expiresAt = Math.floor(Date.now() / 1000) - 1;
    assert.deepEqual(await provider.lookup(b.payment_hash), { state: "expired" });

    await assert.rejects(provider.lookup("ab".repeat(32)), code("invoice_unknown"));
    await assert.rejects(provider.lookup("not-a-hash"), code("bad_request"));
  });

  it("does not believe a preimage that is not the invoice's", async () => {
    const a = await provider.makeInvoice({ msat: 1000 });
    daemon.next = { status: 200, body: { payment_hash: a.payment_hash, state: "settled", msat: 1000, settled_at: 1_793_000_000, preimage: "00".repeat(32) } };
    await assert.rejects(provider.lookup(a.payment_hash), code("wallet_bad_answer"));
    daemon.next = { status: 200, body: { payment_hash: "cd".repeat(32), state: "pending" } };
    await assert.rejects(provider.lookup(a.payment_hash), code("wallet_bad_answer"), "an answer for another invoice");
  });

  it("lists what came in since a time, oldest first, and reads the balance", async () => {
    const hashes = [];
    for (const sats of [1, 2, 3]) hashes.push((await provider.makeInvoice({ msat: sats * 1000 })).payment_hash);
    daemon.settle(hashes[0]!, undefined, 1_793_000_000);
    daemon.settle(hashes[1]!, undefined, 1_793_000_100);
    daemon.settle(hashes[2]!, undefined, 1_793_000_200);
    const all = await provider.received({});
    assert.deepEqual(all.map((p) => p.msat), [1000, 2000, 3000]);
    const since = await provider.received({ since: new Date(1_793_000_100_500).toISOString(), limit: 5 });
    assert.deepEqual(since.map((p) => p.payment_hash), [hashes[1], hashes[2]], "since is whole seconds, inclusive");
    assert.equal(daemon.requests.at(-1)!.path, "/payments?since=1793000100&limit=5");
    assert.deepEqual(await provider.balance(), { msat: 6000 });
  });

  it("names each failure: a refused token, the daemon down or failing, a daemon from before this API", async () => {
    const wrong = new SphinxDaemonProvider({ url: daemon.url, token: "nope" });
    await assert.rejects(wrong.balance(), code("wallet_unauthorized"));
    daemon.next = { status: 500, body: { error: "the core is busy", code: "failed" } };
    await assert.rejects(provider.balance(), (e: unknown) => code("wallet_unavailable")(e) && /the core is busy/.test((e as Error).message));
    daemon.next = { status: 400, body: { error: "sats must be a whole number above 0", code: "failed" } };
    await assert.rejects(provider.makeInvoice({ msat: 1000 }), code("wallet_refused"));

    const down = new SphinxDaemonProvider({ url: "http://127.0.0.1:1", token: RECEIVE, timeoutMs: 2000 });
    await assert.rejects(down.balance(), code("wallet_unavailable"));

    daemon.old = true;
    await assert.rejects(provider.makeInvoice({ msat: 1000 }), (e: unknown) => code("wallet_bad_answer")(e) && /LIGHTNING\.md/.test((e as Error).message));
    await assert.rejects(provider.balance(), (e: unknown) => code("wallet_refused")(e) && /predates/.test((e as Error).message));
    await assert.rejects(provider.lookup("ab".repeat(32)), code("wallet_refused"), "an old daemon's missing route is not an unknown invoice");
  });

  it("takes only an http(s) URL with no credential, query or fragment in it", () => {
    assert.equal(daemonUrl("http://treasury:3000/"), "http://treasury:3000");
    assert.equal(daemonUrl(" https://a.example/api/ "), "https://a.example/api");
    for (const bad of ["ftp://a", "http://u:p@a", "http://a/?k=1", "nope"]) assert.throws(() => daemonUrl(bad), bad);
    assert.throws(() => new SphinxDaemonProvider({ url: daemon.url, token: " " }));
  });

  it("built from settings with a pay token, it never sends the pay token; the capability is four functions and nothing else", async () => {
    const cap = lightningCapability(receiveProvider({ provider: "sphinx", url: daemon.url, token: RECEIVE, payToken: PAY }));
    const inv = await cap.makeInvoice({ msat: 2000 });
    daemon.settle(inv.payment_hash);
    await cap.lookup(inv.payment_hash);
    await cap.received({});
    await cap.balance();
    assert.ok(daemon.requests.length >= 4);
    for (const r of daemon.requests) assert.equal(r.auth, `Bearer ${RECEIVE}`);
    assert.ok(!JSON.stringify(daemon.requests).includes(PAY));

    assert.deepEqual(Object.keys(cap).sort(), ["balance", "lookup", "makeInvoice", "received"]);
    assert.ok(Object.isFrozen(cap));
    assert.equal(Object.getPrototypeOf(cap), Object.prototype, "no provider behind it to reach");
    // The provider keeps its token private for real.
    const p = new SphinxDaemonProvider({ url: daemon.url, token: RECEIVE });
    assert.ok(!JSON.stringify(p).includes(RECEIVE));
    assert.ok(!Object.values(p).some((v) => v === RECEIVE));
    // The capability checks what it is handed before the provider sees it.
    await assert.rejects(cap.makeInvoice({ msat: -1 }), code("bad_request"));
    await assert.rejects(cap.makeInvoice({ msat: 1000, expirySecs: 2 * 24 * 3600 }), code("bad_request"));
    await assert.rejects(cap.received({ since: "yesterday" }), code("bad_request"));
  });
});
