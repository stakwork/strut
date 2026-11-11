/**
 * src/l402.ts against a reference library: the fixtures in
 * src/fixtures/l402-macaroons.json were made by Go's gopkg.in/macaroon.v2
 * (the libmacaroons v2 binary format aperture and lnd use), with
 * scripts/l402-fixtures/.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import {
  addCaveat,
  decodeIdentifier,
  decodeMacaroon,
  encodeIdentifier,
  encodeMacaroon,
  L402Error,
  macaroonFromBase64,
  macaroonToBase64,
  mintMacaroon,
  mintToken,
  parseAuthorization,
  readCaveats,
  tokenRefusal,
  tokenRootKey,
  verifySignature,
  verifyToken,
  type Macaroon,
} from "./l402.js";

interface Fixture {
  name: string;
  location: string;
  caveats: string[] | null;
  thirdParty?: { location: string; id: string; vidHex: string };
  base64: string;
  hex: string;
  signature: string;
}
const F = JSON.parse(readFileSync(new URL("./fixtures/l402-macaroons.json", import.meta.url), "utf-8")) as {
  l402RootHex: string;
  tokenIdHex: string;
  preimageHex: string;
  paymentHashHex: string;
  identifierHex: string;
  rootKeyHex: string;
  macaroons: Fixture[];
};
const root = Buffer.from(F.l402RootHex, "hex");
const fixture = (name: string) => F.macaroons.find((m) => m.name === name)!;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof L402Error, String(err));
    return err.code;
  }
  assert.fail("did not throw");
};

describe("libmacaroons v2, against Go's macaroon.v2", () => {
  it("the token's root key and the identifier are the reference's", () => {
    assert.equal(tokenRootKey(root, F.tokenIdHex).toString("hex"), F.rootKeyHex);
    const id = encodeIdentifier({ paymentHash: F.paymentHashHex, tokenId: F.tokenIdHex });
    assert.equal(id.toString("hex"), F.identifierHex);
    assert.equal(id.length, 66);
    assert.deepEqual(decodeIdentifier(id), { paymentHash: F.paymentHashHex, tokenId: F.tokenIdHex });
    assert.equal(createHash("sha256").update(Buffer.from(F.preimageHex, "hex")).digest("hex"), F.paymentHashHex);
  });

  it("every first-party fixture: minted here to the same bytes, signature and base64; decoded back whole", () => {
    const rootKey = Buffer.from(F.rootKeyHex, "hex");
    for (const f of F.macaroons.filter((m) => !m.thirdParty)) {
      const m = mintMacaroon(rootKey, Buffer.from(F.identifierHex, "hex"), f.location, f.caveats ?? []);
      assert.equal(m.signature.toString("hex"), f.signature, f.name);
      assert.equal(encodeMacaroon(m).toString("hex"), f.hex, f.name);
      assert.equal(macaroonToBase64(m), f.base64, f.name);
      const back = decodeMacaroon(Buffer.from(f.hex, "hex"));
      assert.equal(back.location, f.location, f.name);
      assert.equal(back.id.toString("hex"), F.identifierHex, f.name);
      assert.deepEqual(back.caveats.map((c) => c.id.toString("utf8")), f.caveats ?? [], f.name);
      assert.equal(back.signature.toString("hex"), f.signature, f.name);
      assert.ok(verifySignature(back, rootKey), f.name);
    }
  });

  it("a holder's appended caveats chain from the macaroon alone, as the reference's did", () => {
    const minted = macaroonFromBase64(fixture("minted").base64);
    const narrowed = fixture("narrowed");
    let m: Macaroon = minted;
    for (const c of narrowed.caveats!.slice(minted.caveats.length)) m = addCaveat(m, c);
    assert.equal(macaroonToBase64(m), narrowed.base64);
  });

  it("a third-party caveat: decoded with its location and verification id, and its signature chains as libmacaroons'", () => {
    const f = fixture("third-party");
    const m = macaroonFromBase64(f.base64);
    const tp = m.caveats.at(-1)!;
    assert.equal(tp.location, f.thirdParty!.location);
    assert.equal(tp.id.toString("utf8"), f.thirdParty!.id);
    assert.equal(tp.vid!.toString("hex"), f.thirdParty!.vidHex);
    assert.ok(verifySignature(m, Buffer.from(F.rootKeyHex, "hex")));
    assert.equal(encodeMacaroon(m).toString("hex"), f.hex, "re-encodes to the same bytes");
    // And refused as a token: strut cannot discharge it.
    assert.equal(code(() => verifyToken({ macaroon: f.base64, preimage: F.preimageHex }, root)), "bad_caveat");
  });

  it("URL-safe and unpadded base64 read the same", () => {
    const b = fixture("minted").base64;
    const url = b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    assert.equal(macaroonToBase64(macaroonFromBase64(url)), b);
  });

  it("refuses what is not a v2 binary macaroon", () => {
    const good = Buffer.from(fixture("minted").hex, "hex");
    const cases: Array<[string, Buffer | string]> = [
      ["v1 / not v2", Buffer.concat([Buffer.from([1]), good.subarray(1)])],
      ["JSON", Buffer.from('{"v":2,"i":"x"}')],
      ["cut short", good.subarray(0, good.length - 5)],
      ["trailing bytes", Buffer.concat([good, Buffer.from([0])])],
      ["empty", Buffer.alloc(0)],
      ["no identifier", Buffer.from([2, 0, 0, 6, 32, ...randomBytes(32)])],
      ["a field out of order", Buffer.from([2, 2, 1, 0x41, 1, 1, 0x61, 0, 0, 6, 32, ...randomBytes(32)])],
      ["a short signature", Buffer.from([2, 2, 1, 0x41, 0, 0, 6, 16, ...randomBytes(16)])],
      ["too big", Buffer.concat([Buffer.from([2]), randomBytes(9000)])],
    ];
    for (const [name, b] of cases) assert.equal(code(() => decodeMacaroon(b as Buffer)), "bad_macaroon", name);
    assert.equal(code(() => macaroonFromBase64("not base64 !")), "bad_macaroon");
    assert.equal(code(() => decodeIdentifier(Buffer.alloc(65))), "bad_identifier");
    assert.equal(code(() => decodeIdentifier(Buffer.concat([Buffer.from([0, 1]), randomBytes(64)]))), "bad_identifier", "version 1");
  });
});

describe("a credit token", () => {
  const presented = (name: string) => ({ macaroon: fixture(name).base64, preimage: F.preimageHex });

  it("verifies: the identifier, the signature, the preimage, strut's five caveats", () => {
    const t = verifyToken(presented("minted"), root);
    assert.equal(t.tokenId, F.tokenIdHex);
    assert.equal(t.paymentHash, F.paymentHashHex);
    assert.deepEqual(t.quote, { sats: 10250, credit: 7_500_000, validUntil: 1794340808 });
    assert.equal(t.narrowed, false);
    const c = verifyToken(presented("carry"), root);
    assert.equal(c.quote.carry, createHash("sha256").update("strut l402 fixture earlier token").digest("hex"));
    assert.equal(c.narrowed, false);
  });

  it("a holder's caveats narrow it, and each must hold", () => {
    const t = verifyToken(presented("narrowed"), root);
    assert.equal(t.narrowed, true);
    assert.deepEqual(t.holder, { capabilities: [["workflow:acme/voxel/character", "step:acme/lookup"]], maxCharge: [2_000_000], validUntil: [1794000000] });
    const at = 1790000000_000;
    assert.equal(tokenRefusal(t, { now: at, item: { kind: "workflow", name: "acme/voxel/character" }, reserve: 2_000_000 }), undefined);
    assert.equal(tokenRefusal(t, { now: at, item: { kind: "workflow", name: "acme/other" }, reserve: 1 }), "not_this_item");
    assert.equal(tokenRefusal(t, { now: at, item: { kind: "step", name: "acme/lookup" }, reserve: 2_000_001 }), "over_max_charge");
    // The holder's end comes before strut's: the copy is expired, the token not.
    assert.equal(tokenRefusal(t, { now: 1794100000_000 }), "expired");
    assert.equal(tokenRefusal(verifyToken(presented("minted"), root), { now: 1794100000_000 }), undefined);
    assert.equal(tokenRefusal(verifyToken(presented("minted"), root), { now: 1794340808_000 }), "expired");
    // A repeat can only narrow: a later end appended after an earlier one changes nothing.
    const wider = addCaveat(macaroonFromBase64(fixture("narrowed").base64), "strut_valid_until=1799999999");
    assert.equal(tokenRefusal(verifyToken({ macaroon: macaroonToBase64(wider), preimage: F.preimageHex }, root), { now: 1794100000_000 }), "expired");
    const two = addCaveat(macaroonFromBase64(fixture("narrowed").base64), "strut_capabilities=workflow:acme/other");
    assert.equal(tokenRefusal(verifyToken({ macaroon: macaroonToBase64(two), preimage: F.preimageHex }, root), { now: at, item: { kind: "workflow", name: "acme/voxel/character" } }), "not_this_item");
    // A narrower services line that still names strut is a holder's caveat.
    const svc = addCaveat(macaroonFromBase64(fixture("minted").base64), "services=strut:0");
    assert.equal(verifyToken({ macaroon: macaroonToBase64(svc), preimage: F.preimageHex }, root).narrowed, true);
  });

  it("refuses a forged, tampered or unknown-caveat token, and a wrong preimage", () => {
    const minted = macaroonFromBase64(fixture("minted").base64);
    const b64 = (m: Macaroon) => macaroonToBase64(m);
    // Signed under another server's root.
    assert.equal(code(() => verifyToken(presented("minted"), randomBytes(32))), "bad_signature");
    // A caveat changed in place, or one dropped: the chain breaks.
    const tampered: Macaroon = { ...minted, caveats: minted.caveats.map((c, i) => (i === 2 ? { id: Buffer.from("strut_credit=99000000") } : c)) };
    assert.equal(code(() => verifyToken({ macaroon: b64(tampered), preimage: F.preimageHex }, root)), "bad_signature");
    const dropped: Macaroon = { ...addCaveat(minted, "strut_max_charge=1"), caveats: minted.caveats };
    assert.equal(code(() => verifyToken({ macaroon: b64(dropped), preimage: F.preimageHex }, root)), "bad_signature");
    // Another token's id under the same signature.
    const swapped: Macaroon = { ...minted, id: encodeIdentifier({ paymentHash: F.paymentHashHex, tokenId: randomBytes(32).toString("hex") }) };
    assert.equal(code(() => verifyToken({ macaroon: b64(swapped), preimage: F.preimageHex }, root)), "bad_signature");
    // A caveat strut does not know, appended by a holder: the chain is good, the token refused.
    for (const c of ["strut_budget=5", "time-before=2030-01-01T00:00:00Z", "nonsense", "strut_carry=" + "ab".repeat(32), "strut_credit=1", "strut_sats=1", "services=other:0", "strut_capabilities=job:x", "strut_max_charge=-1"]) {
      assert.equal(code(() => verifyToken({ macaroon: b64(addCaveat(minted, c)), preimage: F.preimageHex }, root)), "bad_caveat", c);
    }
    // strut writes five caveats; four is not a token of strut's.
    assert.equal(code(() => verifyToken(presented("four-caveats"), root)), "bad_caveat");
    assert.equal(code(() => verifyToken(presented("no-caveats"), root)), "bad_caveat");
    // The preimage.
    assert.equal(code(() => verifyToken({ macaroon: fixture("minted").base64, preimage: randomBytes(32).toString("hex") }, root)), "bad_preimage");
    assert.equal(code(() => verifyToken({ macaroon: fixture("minted").base64, preimage: "xyz" }, root)), "bad_preimage");
    assert.equal(code(() => verifyToken({ macaroon: fixture("minted").base64 }, root)), "bad_preimage", "required unless asked otherwise");
    assert.equal(verifyToken({ macaroon: fixture("minted").base64 }, root, { requirePreimage: false }).preimage, undefined);
  });

  it("mintToken writes strut's caveats in order, with strut_carry=none when nothing carries", () => {
    const paymentHash = randomBytes(32).toString("hex");
    const { macaroon, tokenId } = mintToken(root, { paymentHash, quote: { sats: 1000, credit: 650_000, validUntil: 1800000000 } });
    assert.deepEqual(macaroon.caveats.map((c) => c.id.toString()), ["services=strut:0", "strut_sats=1000", "strut_credit=650000", "strut_valid_until=1800000000", "strut_carry=none"]);
    assert.equal(macaroon.location, "strut");
    assert.deepEqual(decodeIdentifier(macaroon.id), { paymentHash, tokenId });
    assert.ok(verifySignature(macaroon, tokenRootKey(root, tokenId)));
    const carry = randomBytes(32).toString("hex");
    const c = mintToken(root, { paymentHash, quote: { sats: 1, credit: 1, validUntil: 1, carry } });
    assert.equal(readCaveats(c.macaroon.caveats).quote.carry, carry);
  });

  it("the Authorization header: L402 and LSAT, with and without a preimage", () => {
    assert.deepEqual(parseAuthorization("L402 abc:def"), { macaroon: "abc", preimage: "def" });
    assert.deepEqual(parseAuthorization("LSAT abc:def"), { macaroon: "abc", preimage: "def" });
    assert.deepEqual(parseAuthorization("l402 abc="), { macaroon: "abc=" });
    assert.deepEqual(parseAuthorization("L402 abc:"), { macaroon: "abc" });
    assert.equal(parseAuthorization("Bearer abc"), undefined);
    assert.equal(parseAuthorization(undefined), undefined);
  });
});
