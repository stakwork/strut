/**
 * The payer for the Sphinx daemon against a stand-in daemon whose POST /pay
 * behaves as stakwork/sphinx#428 built it: the pay token only, the LSP's fee
 * floor refused below it, a wait then `pending`, idempotent per payment hash
 * (only a failed one is paid again), `failed` with the LSP's words, and its
 * refusals before sending. The NWC payer is in nwc.test.ts, beside its
 * stand-in relay.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { decodeBolt11, encodeBolt11 } from "./bolt11.js";
import { LightningError } from "./lightning.js";
import { SphinxDaemonPayer, defaultMaxFeeMsat, lspFeeFloorMsat, payerFor } from "./payer.js";

const PAY = "pay-token-1";
const RECEIVE = "receive-token-1";

interface Pay {
  hash: string;
  msat: number;
  state: "pending" | "settled" | "failed";
  fee_msat: number;
  preimage?: string;
  error?: string;
  attempts: number;
}

/** POST /pay as the daemon answers it. Each attempt's outcome is queued. */
class StandIn {
  server!: Server;
  url = "";
  pays = new Map<string, Pay>();
  /** Outcomes for the next attempts that go out: settled, failed, or held pending. */
  outcomes: Array<"settled" | "failed" | "pending"> = [];
  requests: Array<{ auth: string | undefined; body: Record<string, unknown> }> = [];
  ownHashes = new Set<string>();
  /** What GET /balance answers; undefined: no such route. */
  balanceMsat: number | undefined = undefined;

  async start() {
    this.server = createServer(async (req, res) => {
      const body = (await readBody(req)) as Record<string, unknown>;
      const send = (status: number, b: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      if (req.method === "GET" && req.url === "/balance") {
        if (this.balanceMsat === undefined) return send(404, { error: "no route GET /balance", code: "not_found" });
        return send(200, { msat: this.balanceMsat });
      }
      this.requests.push({ auth: req.headers.authorization, body });
      if (req.method !== "POST" || req.url !== "/pay") return send(404, { error: `no route ${req.method} ${req.url}`, code: "not_found" });
      if (req.headers.authorization === `Bearer ${RECEIVE}`) return send(403, { error: "the receive token may not pay", code: "forbidden" });
      if (req.headers.authorization !== `Bearer ${PAY}`) return send(401, { error: "unauthorized", code: "unauthorized" });
      let inv;
      try {
        inv = decodeBolt11(String(body["invoice"]));
      } catch {
        return send(400, { error: "invoice is not a BOLT11 invoice", code: "bad_request" });
      }
      if (!inv.msat) return send(400, { error: "the invoice names no amount: the daemon pays only an invoice with one", code: "bad_request" });
      const had = this.pays.get(inv.paymentHash);
      if (had && had.state !== "failed") return send(200, this.answer(had));
      if (this.ownHashes.has(inv.paymentHash)) return send(400, { error: "the invoice is the account's own", code: "own_invoice" });
      if (inv.expiresAt * 1000 <= Date.now()) return send(400, { error: `the invoice expired at ${inv.expiresAt}`, code: "expired" });
      const max = body["max_fee_msat"];
      if (typeof max === "number" && max < lspFeeFloorMsat(inv.msat)) {
        return send(400, { error: `max_fee_msat ${max} is below the LSP's own fee limit for ${inv.msat} msat, ${lspFeeFloorMsat(inv.msat)}`, code: "max_fee_too_low" });
      }
      const p: Pay = had ?? { hash: inv.paymentHash, msat: inv.msat, state: "pending", fee_msat: 0, attempts: 0 };
      p.attempts++;
      p.state = "pending";
      delete p.error;
      this.pays.set(p.hash, p);
      const outcome = this.outcomes.shift() ?? "settled";
      if (outcome === "settled") this.settle(p.hash);
      if (outcome === "failed") {
        p.state = "failed";
        p.error = "not enough balance";
      }
      send(200, this.answer(p));
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  settle(hash: string, preimage?: string) {
    const p = this.pays.get(hash)!;
    p.state = "settled";
    p.fee_msat = 1200;
    if (preimage) p.preimage = preimage;
  }

  answer(p: Pay) {
    return { payment_hash: p.hash, state: p.state, fee_msat: p.state === "settled" ? p.fee_msat : 0, ...(p.preimage ? { preimage: p.preimage } : {}), ...(p.error && p.state === "failed" ? { error: p.error } : {}) };
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
      resolve(text ? JSON.parse(text) : {});
    });
  });
}

const code = (c: LightningError["code"], walletCode?: string) => (err: unknown) => err instanceof LightningError && err.code === c && (walletCode === undefined || err.walletCode === walletCode);

/** An invoice for `msat` with a preimage the test knows. */
function invoice(msat: number, opts: { expirySecs?: number; timestamp?: number } = {}) {
  const preimage = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  return { hash, preimage, invoice: encodeBolt11({ msat, paymentHash: hash, expirySecs: opts.expirySecs ?? 600, ...(opts.timestamp ? { timestamp: opts.timestamp } : {}) }) };
}

describe("the fee floor", () => {
  it("is the LSP's: 0.5% of the amount, or 5 sats when that is more", () => {
    assert.equal(lspFeeFloorMsat(1_000_000), 5000, "1 000 sats");
    assert.equal(lspFeeFloorMsat(10_000_000), 50_000, "10 000 sats");
    assert.equal(lspFeeFloorMsat(1_000_001), 5000);
    assert.equal(lspFeeFloorMsat(10_000_333), 50_001, "floored, as the daemon floors");
    assert.equal(defaultMaxFeeMsat(10_000_000), 50_000, "the default cap is the floor");
  });
});

describe("SphinxDaemonPayer", () => {
  const daemon = new StandIn();
  let payer: SphinxDaemonPayer;
  before(() => daemon.start());
  after(() => daemon.stop());
  beforeEach(() => {
    daemon.pays.clear();
    daemon.outcomes = [];
    daemon.requests = [];
    daemon.balanceMsat = undefined;
    payer = new SphinxDaemonPayer({ url: daemon.url, payToken: PAY });
  });

  it("names its wallet by the daemon's URL, never a credential", () => {
    assert.equal(payer.id, `sphinx:${daemon.url}`);
    assert.ok(!payer.id.includes(PAY));
  });

  it("the fee booked is the one taken: the mixer skips it when the balance less the amount does not cover it", async () => {
    // 2 000 sats held, 1 999 asked: 1 sat left, the 1.2-sat routing fee is not taken.
    daemon.balanceMsat = 2_000_000;
    const tight = invoice(1_999_000);
    const out = await payer.pay({ invoice: tight.invoice, maxFeeMsat: 10_000 });
    assert.deepEqual([out.state, out.feeMsat, out.routingFeeMsat, out.balanceBeforeMsat], ["settled", 0, 1200, 2_000_000]);
    // Room for it: booked as reported.
    const roomy = invoice(1_000_000);
    const ok = await payer.pay({ invoice: roomy.invoice, maxFeeMsat: 10_000 });
    assert.deepEqual([ok.feeMsat, ok.routingFeeMsat], [1200, undefined]);
    // A pending one read later is judged on the balance before it went, never a fresh read.
    daemon.outcomes.push("pending");
    const later = invoice(1_999_000);
    const first = await payer.pay({ invoice: later.invoice, maxFeeMsat: 10_000 });
    daemon.balanceMsat = 50_000_000;
    daemon.settle(later.hash);
    const read = await payer.status({ invoice: later.invoice, paymentHash: later.hash, maxFeeMsat: 10_000, balanceBeforeMsat: first.balanceBeforeMsat! });
    assert.deepEqual([read.feeMsat, read.routingFeeMsat], [0, 1200]);
    // No balance to read: the reported fee is booked.
    daemon.balanceMsat = undefined;
    const blind = invoice(1_999_000);
    assert.equal((await payer.pay({ invoice: blind.invoice, maxFeeMsat: 10_000 })).feeMsat, 1200);
  });

  it("pays with the pay token and the cap, and reads settled with its fee and a proven preimage", async () => {
    const inv = invoice(10_000_000);
    daemon.outcomes.push("pending");
    const first = await payer.pay({ invoice: inv.invoice, maxFeeMsat: 50_000 });
    assert.deepEqual(first, { paymentHash: inv.hash, state: "pending", feeMsat: 0 });
    assert.deepEqual(daemon.requests[0], { auth: `Bearer ${PAY}`, body: { invoice: inv.invoice, max_fee_msat: 50_000 } });
    daemon.settle(inv.hash, inv.preimage);
    const read = await payer.status({ invoice: inv.invoice, paymentHash: inv.hash, maxFeeMsat: 50_000 });
    assert.deepEqual(read, { paymentHash: inv.hash, state: "settled", feeMsat: 1200, preimage: inv.preimage });
    assert.equal(daemon.pays.get(inv.hash)!.attempts, 1, "reading a pending payment pays nothing again");
    // Settled answers as settled however often it is asked.
    assert.equal((await payer.pay({ invoice: inv.invoice, maxFeeMsat: 50_000 })).state, "settled");
    assert.equal(daemon.pays.get(inv.hash)!.attempts, 1);
  });

  it("failed carries the LSP's words; paying a failed one again tries again", async () => {
    const inv = invoice(2_000_000);
    daemon.outcomes.push("failed");
    assert.deepEqual(await payer.pay({ invoice: inv.invoice, maxFeeMsat: 10_000 }), { paymentHash: inv.hash, state: "failed", feeMsat: 0, error: "not enough balance" });
    const again = await payer.status({ invoice: inv.invoice, paymentHash: inv.hash, maxFeeMsat: 10_000 });
    assert.equal(again.state, "settled");
    assert.equal(daemon.pays.get(inv.hash)!.attempts, 2);
  });

  it("a preimage that does not hash to the payment is not kept", async () => {
    const inv = invoice(2_000_000);
    daemon.outcomes.push("pending");
    await payer.pay({ invoice: inv.invoice, maxFeeMsat: 10_000 });
    daemon.settle(inv.hash, "ab".repeat(32));
    const read = await payer.status({ invoice: inv.invoice, paymentHash: inv.hash, maxFeeMsat: 10_000 });
    assert.equal(read.state, "settled");
    assert.equal(read.preimage, undefined);
  });

  it("refusals before sending throw with the daemon's code: fee floor, own invoice, expired, not an invoice", async () => {
    const inv = invoice(10_000_000);
    await assert.rejects(payer.pay({ invoice: inv.invoice, maxFeeMsat: 5000 }), code("wallet_refused", "max_fee_too_low"));
    const own = invoice(10_000);
    daemon.ownHashes.add(own.hash);
    await assert.rejects(payer.pay({ invoice: own.invoice, maxFeeMsat: 5000 }), code("wallet_refused", "own_invoice"));
    const old = invoice(10_000, { timestamp: 1_700_000_000, expirySecs: 60 });
    await assert.rejects(payer.pay({ invoice: old.invoice, maxFeeMsat: 5000 }), code("wallet_refused", "expired"));
    await assert.rejects(payer.pay({ invoice: "lnbc1nope", maxFeeMsat: 5000 }), code("wallet_refused", "bad_request"));
    assert.equal(daemon.pays.size, 0, "nothing went out");
    await assert.rejects(payer.pay({ invoice: inv.invoice, maxFeeMsat: -1 }), code("bad_request"));
  });

  it("the receive token cannot pay; a daemon that is not there is wallet_unavailable", async () => {
    const withReceive = new SphinxDaemonPayer({ url: daemon.url, payToken: RECEIVE });
    await assert.rejects(withReceive.pay({ invoice: invoice(10_000).invoice, maxFeeMsat: 5000 }), code("wallet_unauthorized", "forbidden"));
    const gone = new SphinxDaemonPayer({ url: "http://127.0.0.1:1", payToken: PAY, timeoutMs: 1000 });
    await assert.rejects(gone.pay({ invoice: invoice(10_000).invoice, maxFeeMsat: 5000 }), (e: unknown) => code("wallet_unavailable")(e) && !(e as Error).message.includes(PAY));
  });

  it("payerFor: only a wallet with a pay credential makes one", () => {
    assert.equal(payerFor({ provider: "sphinx", url: daemon.url, token: RECEIVE }), null);
    assert.equal(payerFor({ provider: "sphinx", url: daemon.url, token: RECEIVE, payToken: PAY })?.provider, "sphinx");
    const nwc = `nostr+walletconnect://${"a".repeat(64)}?relay=wss%3A%2F%2Frelay.example&secret=${"b".repeat(64)}`;
    assert.equal(payerFor({ provider: "nwc", url: nwc }), null);
    assert.equal(payerFor({ provider: "nwc", url: nwc, payUrl: nwc.replace("b".repeat(64), "c".repeat(64)) })?.provider, "nwc");
  });
});
