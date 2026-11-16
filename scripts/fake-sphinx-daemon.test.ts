/**
 * The stand-in treasury daemon (scripts/fake-sphinx-daemon.ts) through
 * strut's own clients: `SphinxDaemonProvider` for payments in, and
 * `SphinxDaemonPayer` for payouts out and worker invites, so a local strut
 * and an end-to-end test can lean on it.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { decodeBolt11, encodeBolt11 } from "../src/payments/bolt11.js";
import { lspFeeFloorMsat } from "../src/payments/fee.js";
import { LightningError } from "../src/payments/lightning.js";
import { SphinxDaemonPayer } from "../src/payments/payer.js";
import { SphinxDaemonProvider } from "../src/payments/sphinx-daemon.js";
import { INVITE_PRICE_SATS, startFakeSphinxDaemon, type FakeSphinxDaemon } from "./fake-sphinx-daemon.js";

const TOKEN = "receive-1";
const PAY = "pay-1";
const sha256 = (h: string) => createHash("sha256").update(Buffer.from(h, "hex")).digest("hex");
const code = (c: LightningError["code"], walletCode?: string) => (err: unknown) => err instanceof LightningError && err.code === c && (walletCode === undefined || err.walletCode === walletCode);
const id = (n: number) => n.toString(16).padStart(64, "0");
const address = `02${"a".repeat(64)}_03${"b".repeat(64)}_1099511627776`;

describe("the stand-in Sphinx daemon", () => {
  let daemon: FakeSphinxDaemon;
  let wallet: SphinxDaemonProvider;
  let payer: SphinxDaemonPayer;
  const post = (path: string, body: unknown = {}) => fetch(`${daemon.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const balance = async () => (await wallet.balance()).msat;

  before(async () => {
    daemon = await startFakeSphinxDaemon({ port: 0, token: TOKEN, payToken: PAY, settleAfterMs: 0, startSats: 10_000 });
    wallet = new SphinxDaemonProvider({ url: daemon.url, token: TOKEN });
    payer = new SphinxDaemonPayer({ url: daemon.url, payToken: PAY });
  });
  after(() => daemon.close());

  it("refuses a pay token equal to the receive token, as strut's boot does", async () => {
    await assert.rejects(startFakeSphinxDaemon({ port: 0, token: "same", payToken: "same" }), /must differ/);
  });

  it("IN: an invoice is pending, then settled with a preimage that hashes to it, listed and in the balance", async () => {
    const before = await balance();
    assert.equal(before, 10_000_000);
    const inv = await wallet.makeInvoice({ msat: 21_000, description: "a run", expirySecs: 600 });
    const read = decodeBolt11(inv.invoice);
    assert.deepEqual([read.msat, read.paymentHash, read.description], [21_000, inv.payment_hash, "a run"]);
    assert.deepEqual(await wallet.lookup(inv.payment_hash), { state: "pending" });
    assert.equal((await post(`/settle/${inv.payment_hash}`)).status, 200);
    const settled = await wallet.lookup(inv.payment_hash);
    assert.equal(settled.state, "settled");
    assert.equal(settled.msat, 21_000);
    assert.equal(sha256(settled.preimage!), inv.payment_hash, "the provider checks it too");
    assert.ok((await wallet.received({})).some((p) => p.payment_hash === inv.payment_hash && p.msat === 21_000));
    assert.equal(await balance(), before + 21_000);
  });

  it("IN: an invoice settles on its own after settleAfterMs", async () => {
    const quick = await startFakeSphinxDaemon({ port: 0, token: TOKEN, payToken: PAY, settleAfterMs: 20 });
    try {
      const w = new SphinxDaemonProvider({ url: quick.url, token: TOKEN });
      const inv = await w.makeInvoice({ msat: 5_000 });
      await new Promise((r) => setTimeout(r, 40));
      assert.equal((await w.lookup(inv.payment_hash)).state, "settled");
    } finally {
      await quick.close();
    }
  });

  it("OUT: a keysend settles once per id, with a proven preimage, and debits the amount and the LSP's fee", async () => {
    const before = await balance();
    const msat = 2_000_000;
    const fee = lspFeeFloorMsat(msat);
    const out = await payer.keysend({ id: id(1), address, msat, maxFeeMsat: fee });
    assert.equal(out.state, "settled");
    assert.equal(out.feeMsat, fee);
    assert.equal(sha256(out.preimage!), out.paymentHash, "the payer keeps a preimage only when it proves the payment");
    assert.equal(await balance(), before - msat - fee);
    assert.deepEqual(await payer.keysendStatus({ id: id(1) }), out);
    assert.deepEqual(await payer.keysend({ id: id(1), address, msat, maxFeeMsat: fee }), out, "the same id only answers");
    assert.equal(await balance(), before - msat - fee, "and never sends again");
  });

  it("OUT: the switch makes the next keysend stay pending until settled by hand, or fail", async () => {
    const msat = 1_000_000;
    const fee = lspFeeFloorMsat(msat);
    const before = await balance();
    assert.equal((await post("/next-payout", { state: "pending" })).status, 200);
    assert.deepEqual(await payer.keysend({ id: id(2), address, msat, maxFeeMsat: fee }), { id: id(2), state: "pending", feeMsat: 0, paymentHash: (await payer.keysendStatus({ id: id(2) })).paymentHash });
    assert.equal(await balance(), before - msat, "a pending one holds its amount");
    await post(`/settle/${id(2)}`);
    const read = await payer.keysendStatus({ id: id(2) });
    assert.deepEqual([read.state, read.feeMsat], ["settled", fee]);
    assert.equal(await balance(), before - msat - fee);

    await post("/next-payout", { state: "failed" });
    assert.deepEqual(await payer.keysend({ id: id(3), address, msat, maxFeeMsat: fee }), { id: id(3), state: "failed", feeMsat: 0, paymentHash: (await payer.keysendStatus({ id: id(3) })).paymentHash, error: "no route found" });
    assert.equal(await balance(), before - msat - fee, "a failed one takes nothing");
    assert.equal((await payer.keysend({ id: id(4), address, msat, maxFeeMsat: fee })).state, "settled", "the switch is for one payout");
  });

  it("OUT: one the balance cannot cover fails; refusals before sending throw with the daemon's code", async () => {
    const all = await balance();
    const big = await payer.keysend({ id: id(5), address, msat: all, maxFeeMsat: lspFeeFloorMsat(all) });
    assert.deepEqual([big.state, big.error], ["failed", "not enough balance"]);
    assert.deepEqual(await payer.keysendStatus({ id: id(6) }), { id: id(6), state: "failed", feeMsat: 0, error: "the daemon never took this payment" });
    await assert.rejects(payer.keysend({ id: id(7), address, msat: 10_000_000, maxFeeMsat: 5_000 }), code("wallet_refused", "max_fee_too_low"));
    await assert.rejects(payer.keysend({ id: id(8), address: "not-an-address", msat: 1_000_000, maxFeeMsat: 5_000 }), code("wallet_refused", "bad_request"));
    const withReceive = new SphinxDaemonPayer({ url: daemon.url, payToken: TOKEN });
    await assert.rejects(withReceive.keysend({ id: id(9), address, msat: 1_000_000, maxFeeMsat: 5_000 }), code("wallet_unauthorized", "forbidden"));
    assert.equal(await balance(), all);
  });

  it("OUT: POST /pay pays another wallet's invoice once per hash, and refuses the account's own", async () => {
    const before = await balance();
    const msat = 3_000_000;
    const fee = lspFeeFloorMsat(msat);
    const hash = sha256(randomBytes(32).toString("hex"));
    const invoice = encodeBolt11({ msat, paymentHash: hash, expirySecs: 600 });
    const paid = await payer.pay({ invoice, maxFeeMsat: fee });
    assert.deepEqual([paid.paymentHash, paid.state, paid.feeMsat], [hash, "settled", fee]);
    assert.equal(await balance(), before - msat - fee);
    assert.equal((await payer.status({ invoice, paymentHash: hash, maxFeeMsat: fee })).state, "settled");
    assert.equal(await balance(), before - msat - fee, "paid once");
    const own = await wallet.makeInvoice({ msat: 10_000 });
    await assert.rejects(payer.pay({ invoice: own.invoice, maxFeeMsat: 5_000 }), code("wallet_refused", "own_invoice"));
  });

  it("INVITES (plans/human-steps.md §5.7): made, listed and cancelled with the pay token; its sats and price held, given back on a cancel", async () => {
    const before = await balance();
    const made = await payer.invite({ sats: 100 });
    assert.equal(made.status, "ready");
    assert.equal(made.sats, 100);
    assert.match(made.link ?? "", /^sphinx\.chat:\/\/\?action=i&d=[A-Za-z0-9_-]+=*$/);
    assert.equal(made.link!.split("d=")[1]!.length % 4, 0, "padded, as the core's URL_SAFE engine writes it");
    // The core's invite: the code's 32 bytes, then the mixer's host.
    const d = Buffer.from(made.link!.split("d=")[1]!, "base64url");
    assert.equal(d.subarray(0, 32).toString("hex"), made.code);
    assert.equal(await balance(), before - (100 + INVITE_PRICE_SATS) * 1000);
    assert.ok(made.createdAt && Math.abs(Date.parse(made.createdAt) - Date.now()) < 5_000);
    assert.deepEqual((await payer.invites()).map((i) => [i.code, i.status]), [[made.code, "ready"]]);
    assert.deepEqual(await payer.cancelInvite({ code: made.code }), { code: made.code, status: "cancelled" });
    assert.equal(await balance(), before);
    // Sending until the mixer has it; a used one cannot be cancelled.
    await post("/next-payout", { state: "pending" });
    const slow = await payer.invite({ sats: 50 });
    assert.equal(slow.status, "sending");
    await post(`/settle/${slow.code}`);
    assert.equal((await payer.invites()).find((i) => i.code === slow.code)?.status, "ready");
    await post(`/use-invite/${slow.code}`);
    await assert.rejects(payer.cancelInvite({ code: slow.code }), code("wallet_refused", "not_cancellable"));
    await assert.rejects(payer.cancelInvite({ code: "f".repeat(64) }), code("wallet_refused", "not_found"));
    const withReceive = new SphinxDaemonPayer({ url: daemon.url, payToken: TOKEN });
    await assert.rejects(withReceive.invite({ sats: 100 }), code("wallet_unauthorized", "forbidden"));
  });

  it("GET /prices answers mempool's shape for STRUT_RATE_URL", async () => {
    const prices = (await (await fetch(`${daemon.url}/prices`)).json()) as { time: number; USD: number };
    assert.equal(prices.USD, 100_000);
    assert.ok(Math.abs(prices.time - Date.now() / 1000) < 5);
  });
});
