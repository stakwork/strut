import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { addCaveat, macaroonToBase64, mintToken, type Macaroon } from "../../src/l402.js";
import { encodeBolt11 } from "../../src/payments/bolt11.js";
import { checkChallenge, readMacaroon } from "./challenge";
import type { PaymentRequired } from "./visitor-pay";

// A host holds a priced launch's challenge to what a strut server writes
// before it shows or pays it (./challenge): checked against strut's own
// minter and BOLT11 encoder, so the page reads what the server writes.

const ROOT = randomBytes(32);
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

function challenge(o: { sats?: number; usd?: number; invoiceSats?: number; macaroonSats?: number; macaroonHash?: string; noAmount?: boolean; expirySecs?: number; carry?: string } = {}) {
  const preimage = randomBytes(32);
  const paymentHash = createHash("sha256").update(preimage).digest("hex");
  const sats = o.sats ?? 7500;
  const usd = o.usd ?? 7.5;
  const invoice = encodeBolt11({
    ...(o.noAmount ? {} : { msat: (o.invoiceSats ?? sats) * 1000 }),
    paymentHash,
    description: "acme/voxel/character: credit for one run",
    timestamp: Math.floor(NOW / 1000) - 5,
    expirySecs: o.expirySecs ?? 600,
  });
  const { macaroon, tokenId } = mintToken(ROOT, {
    paymentHash: o.macaroonHash ?? paymentHash,
    quote: { sats: o.macaroonSats ?? sats, credit: Math.round(usd * 1_000_000), validUntil: Math.floor(NOW / 1000) + 3600, ...(o.carry ? { carry: o.carry } : {}) },
  });
  const p: PaymentRequired = { macaroon: macaroonToBase64(macaroon), invoice, usd, sats, description: "acme/voxel/character: credit for one run", expires: new Date(NOW + 600_000).toISOString() };
  return { p, paymentHash, tokenId, macaroon, preimage: preimage.toString("hex") };
}

describe("reading an L402 macaroon in the page", () => {
  it("reads strut's minted token: the payment hash, the token id, the five caveats", () => {
    const c = challenge({ carry: "ab".repeat(32) });
    const m = readMacaroon(c.p.macaroon);
    assert.equal(m.paymentHash, c.paymentHash);
    assert.equal(m.tokenId, c.tokenId);
    assert.deepEqual(m.caveats, ["services=strut:0", "strut_sats=7500", "strut_credit=7500000", `strut_valid_until=${Math.floor(NOW / 1000) + 3600}`, `strut_carry=${"ab".repeat(32)}`]);
    // URL-safe and unpadded base64 read the same.
    const urlSafe = c.p.macaroon.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    assert.deepEqual(readMacaroon(urlSafe), m);
    // A holder's narrowing is read too.
    assert.ok(readMacaroon(macaroonToBase64(addCaveat(c.macaroon, "strut_max_charge=100"))).caveats.includes("strut_max_charge=100"));
  });

  it("reads the macaroons Go's gopkg.in/macaroon.v2 wrote (src/fixtures/l402-macaroons.json)", () => {
    const f = JSON.parse(readFileSync(new URL("../../src/fixtures/l402-macaroons.json", import.meta.url), "utf-8")) as {
      paymentHashHex: string;
      macaroons: Array<{ name: string; base64: string; caveats: string[] | null; thirdParty?: unknown }>;
    };
    assert.ok(f.macaroons.length >= 5);
    for (const v of f.macaroons) {
      if (v.thirdParty) {
        // A third-party caveat is never a strut challenge's.
        assert.throws(() => readMacaroon(v.base64), /third-party/, v.name);
        continue;
      }
      const m = readMacaroon(v.base64);
      assert.equal(m.paymentHash, f.paymentHashHex, v.name);
      assert.deepEqual(m.caveats, v.caveats ?? [], v.name);
    }
  });

  it("refuses what is not one", () => {
    for (const bad of ["", "not base64 !", btoa("hello"), btoa(String.fromCharCode(2, 0))]) assert.throws(() => readMacaroon(bad));
    const c = challenge();
    // Cut short, and a byte after the signature.
    const bytes = Uint8Array.from(atob(c.p.macaroon), (ch) => ch.charCodeAt(0));
    assert.throws(() => readMacaroon(btoa(String.fromCharCode(...bytes.subarray(0, bytes.length - 3)))));
    assert.throws(() => readMacaroon(btoa(String.fromCharCode(...bytes, 0))));
    // An identifier that is not L402's.
    const m = { ...c.macaroon, id: Buffer.from("short") } as Macaroon;
    assert.throws(() => readMacaroon(macaroonToBase64(m)), /L402/);
  });
});

describe("checking a challenge before it is shown or paid", () => {
  it("takes what a strut server writes", () => {
    const c = challenge();
    const r = checkChallenge(c.p, NOW);
    assert.ok(r.ok, r.ok ? "" : r.error);
    if (r.ok) {
      assert.equal(r.checked.paymentHash, c.paymentHash);
      assert.equal(r.checked.msat, 7_500_000);
      assert.equal(r.checked.expiresAt, Math.floor(NOW / 1000) - 5 + 600);
    }
  });

  it("refuses junk, saying why, with nothing paid", () => {
    const cases: Array<[string, PaymentRequired, RegExp]> = [
      ["an invoice the macaroon does not name", challenge({ macaroonHash: "11".repeat(32) }).p, /different payments/],
      ["an invoice asking more than the price shown", challenge({ invoiceSats: 9000 }).p, /asks 9000 sats, not the 7500/],
      ["a macaroon minted for another amount", challenge({ macaroonSats: 10 }).p, /another amount/],
      ["credit other than the dollars shown", { ...challenge().p, usd: 75 }, /another amount of credit/],
      ["an invoice with no amount", challenge({ noAmount: true }).p, /no amount/],
      ["an invoice that has ended", challenge({ expirySecs: 2 }).p, /already ended/],
      ["no invoice at all", { ...challenge().p, invoice: "lnbc1" }, /invoice is not one/],
      ["no macaroon at all", { ...challenge().p, macaroon: "AgJ=" }, /macaroon|cut short/],
      ["no price in sats", { ...challenge().p, sats: 0 }, /no price in sats/],
    ];
    for (const [name, p, why] of cases) {
      const r = checkChallenge(p, NOW);
      assert.equal(r.ok, false, name);
      if (!r.ok) {
        assert.match(r.error, why, name);
        assert.match(r.error, /^the server's payment request does not check out: .*, so nothing was paid$/, name);
      }
    }
  });
});
