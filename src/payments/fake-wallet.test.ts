import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { FakeWallet } from "./fake-wallet.js";
import { LightningError, lightningCapability } from "./lightning.js";

describe("FakeWallet", () => {
  it("makes invoices it settles on command, in full or short, with a real preimage", async () => {
    let now = 1_793_000_000_000;
    const fake = new FakeWallet({ now: () => now });
    const w = lightningCapability(fake);
    const a = await w.makeInvoice({ msat: 10_000, description: "one run", expirySecs: 600 });
    assert.equal(a.expires, new Date(now + 600_000).toISOString());
    assert.deepEqual(await w.lookup(a.payment_hash), { state: "pending" });

    now += 1000;
    const preimage = fake.settle(a.invoice);
    assert.equal(createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex"), a.payment_hash);
    assert.deepEqual(await w.lookup(a.payment_hash), { state: "settled", msat: 10_000, settled_at: new Date(now).toISOString(), preimage });
    assert.throws(() => fake.settle(a.payment_hash), /already settled/);

    const b = await w.makeInvoice({ msat: 10_000 });
    fake.settle(b.payment_hash, { msat: 6_000 });
    assert.equal((await w.lookup(b.payment_hash)).msat, 6_000, "a short payment settles for less");
    assert.throws(() => fake.settle((fake.invoices()[0]!).payment_hash, { msat: 1 }), /already settled/);

    assert.deepEqual(await w.balance(), { msat: 16_000 });
    fake.credit(500);
    assert.deepEqual(await w.balance(), { msat: 16_500 });
  });

  it("expires an invoice by its clock or on command, and an expired one cannot be paid", async () => {
    let now = 0;
    const fake = new FakeWallet({ now: () => now });
    const a = await fake.makeInvoice({ msat: 1000, expirySecs: 60 });
    now = 60_000;
    assert.deepEqual(await fake.lookup(a.payment_hash), { state: "expired" });
    assert.throws(() => fake.settle(a.payment_hash), /expired/);
    const b = await fake.makeInvoice({ msat: 1000 });
    fake.expire(b.invoice);
    assert.deepEqual(await fake.lookup(b.payment_hash), { state: "expired" });
  });

  it("lists what settled, oldest first, since a time, up to a limit", async () => {
    let now = 1_000_000;
    const fake = new FakeWallet({ now: () => now });
    const made = [];
    for (let i = 0; i < 4; i++) made.push(await fake.makeInvoice({ msat: (i + 1) * 1000 }));
    for (const i of [2, 0, 3]) {
      now += 1000;
      fake.settle(made[i]!.payment_hash);
    }
    const all = await fake.received({});
    assert.deepEqual(all.map((p) => p.msat), [3000, 1000, 4000], "settle order, unpaid left out");
    assert.deepEqual((await fake.received({ since: new Date(1_002_000).toISOString(), limit: 1 })).map((p) => p.msat), [1000]);
    assert.equal(fake.invoices().length, 4);
  });

  it("goes down on command: every call is wallet_unavailable until it is back", async () => {
    const fake = new FakeWallet();
    fake.down("the treasury is restarting");
    await assert.rejects(fake.balance(), (e: unknown) => e instanceof LightningError && e.code === "wallet_unavailable" && /restarting/.test(e.message));
    fake.down(false);
    assert.deepEqual(await fake.balance(), { msat: 0 });
    await assert.rejects(fake.lookup("ab".repeat(32)), (e: unknown) => e instanceof LightningError && e.code === "invoice_unknown");
    assert.deepEqual(fake.calls.map((c) => c.method), ["balance", "balance", "lookup"]);
  });
});
