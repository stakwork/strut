/**
 * The catalog card (plans/marketplace.md §13) — src/packages/card.ts: its
 * one byte form, its seal, and every check a reader runs. The TEST VECTOR
 * below is the contract for another implementation: the same key and
 * catalog must give the same bytes, fingerprint, seal and digest.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { canonicalJson, cardBytes, cardDigest, fingerprintOf, keyFromSeed, readCard, releaseFor, sealCard, z32Decode, z32Encode, type Catalog, type UnsignedCatalog } from "./card.js";

/** RFC 8032 §7.1, TEST 1: the secret key (a seed) and its public key. */
const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const VECTOR = {
  /** The public key in z-base-32. */
  key: "47pjoycnsrfmxikm95jh13y88e8qnhzu5kungjpxyepgt7a8krpy",
  /** The catalog before its seal. */
  unsigned: {
    v: 1,
    seq: 1792972800000000,
    packages: { "acme/linear": { description: 'Linear — issues, "sync"', releases: [{ version: "1.4.0", digest: DIGEST, license: "Apache-2.0" }] } },
    channels: { stable: { "acme/linear": DIGEST } },
  },
  fingerprint: "sha256:8802302f1e7f8524535fb37fa32dd96a6a42053f43505358182b5b6ffd58f8c5",
  sig: "6483ca732fd39c84db714552e27fb1e5d3b41f946554b591d3f4704238919e2fb53d9392523cd6cd8db2e430a2b7e4f1be42b0ab126fad68a767a075ca585001",
  /** The bytes as served: RFC 8785, `sig` included. */
  bytes:
    '{"channels":{"stable":{"acme/linear":"sha256:abababababababababababababababababababababababababababababababab"}},"key":"47pjoycnsrfmxikm95jh13y88e8qnhzu5kungjpxyepgt7a8krpy","packages":{"acme/linear":{"description":"Linear — issues, \\"sync\\"","releases":[{"digest":"sha256:abababababababababababababababababababababababababababababababab","license":"Apache-2.0","version":"1.4.0"}]}},"seq":1792972800000000,"sig":"6483ca732fd39c84db714552e27fb1e5d3b41f946554b591d3f4704238919e2fb53d9392523cd6cd8db2e430a2b7e4f1be42b0ab126fad68a767a075ca585001","v":1}',
  digest: "sha256:06ce30e80367f4a5ad385bbd39a2492df98cbbbec93390c747febcf988fd625e",
};

const signer = keyFromSeed(Buffer.from(SEED, "hex"));
const sealed = (over: Partial<UnsignedCatalog> = {}): Catalog => sealCard({ ...VECTOR.unsigned, key: signer.key, ...over } as UnsignedCatalog, signer.privateKey);

describe("the catalog card", () => {
  it("matches the test vector: the key, the fingerprint, the seal, the bytes and the digest", () => {
    assert.equal(signer.key, VECTOR.key);
    assert.equal(z32Decode(VECTOR.key).toString("hex"), PUBLIC, "the z-base-32 of RFC 8032's public key");
    const card = sealed();
    assert.equal(fingerprintOf(card), VECTOR.fingerprint);
    assert.equal(card.sig, VECTOR.sig);
    assert.equal(cardBytes(card).toString("utf8"), VECTOR.bytes);
    assert.equal(cardDigest(cardBytes(card)), VECTOR.digest);
    const read = readCard(VECTOR.bytes, { key: VECTOR.key });
    assert.equal(read.digest, VECTOR.digest);
    assert.deepEqual(read.card, card);
  });

  it("writes JSON in its RFC 8785 form", () => {
    // RFC 8785 §3.2.3: members sorted by their UTF-16 code units.
    const keys = ["\u20ac", "\r", "\ufb33", "1", "\ud83d\ude00", "\u0080", "\u00f6"];
    assert.equal(canonicalJson(Object.fromEntries(keys.map((k, i) => [k, i]))), '{"\\r":1,"1":3,"\u0080":5,"\u00f6":6,"\u20ac":0,"\ud83d\ude00":4,"\ufb33":2}');
    // ECMAScript's number forms, and the string escapes JCS keeps.
    assert.equal(canonicalJson([1e21, 0.000001, -0, 1.5, 100]), "[1e+21,0.000001,0,1.5,100]");
    assert.equal(canonicalJson("\u0001\b\t\n\f\r\"\\/é"), '"\\u0001\\b\\t\\n\\f\\r\\"\\\\/é"');
    assert.throws(() => canonicalJson(Number.NaN), /catalog_invalid/);
  });

  it("writes a key in z-base-32, as the spec's example does", () => {
    assert.equal(z32Encode(Buffer.from("f0bfc7", "hex")), "6n9hq");
    assert.throws(() => z32Decode("not-z32"), /catalog_key/);
    assert.throws(() => z32Decode(VECTOR.key.slice(0, -1)), /catalog_key: .* is not a 32-byte key/);
  });

  it("refuses a catalog in another byte form, under another key, or with a byte changed", () => {
    const card = sealed();
    const reordered = JSON.stringify({ v: card.v, ...card });
    assert.throws(() => readCard(reordered, { key: signer.key }), /^Error: catalog_noncanonical/);
    assert.throws(() => readCard(JSON.stringify(card, null, 2), { key: signer.key }), /^Error: catalog_noncanonical/);

    const other = generateKeyPairSync("ed25519");
    const otherKey = z32Encode(Buffer.from(other.publicKey.export({ format: "jwk" }).x!, "base64url"));
    assert.throws(() => readCard(VECTOR.bytes, { key: otherKey }), /^Error: catalog_key: the catalog is .*, and the reader expected/);
    // Sealed by another key that names ours: the key matches, the seal does not.
    const forged = sealCard({ ...VECTOR.unsigned, key: signer.key } as UnsignedCatalog, other.privateKey);
    assert.throws(() => readCard(cardBytes(forged), { key: signer.key }), /^Error: catalog_seal: the seal is not/);

    const tampered = VECTOR.bytes.replace('"1.4.0"', '"1.4.1"');
    assert.throws(() => readCard(tampered, { key: signer.key }), /^Error: catalog_seal/);
  });

  it("refuses another version, and ignores a member it does not know while the seal still covers it", () => {
    assert.throws(() => readCard(cardBytes(sealed({ v: 2 })), { key: signer.key }), /^Error: catalog_version: the catalog is v 2, and this reader reads v 1/);
    const extra = sealed({ homepage: "https://acme.example" } as Partial<UnsignedCatalog>);
    assert.equal(readCard(cardBytes(extra), { key: signer.key }).card.seq, VECTOR.unsigned.seq);
    const stripped = canonicalJson({ ...extra, homepage: undefined });
    assert.throws(() => readCard(stripped, { key: signer.key }), /^Error: catalog_seal/, "removing it breaks the seal");
  });

  it("refuses an older catalog, and another one at the same seq", () => {
    const first = readCard(cardBytes(sealed()), { key: signer.key });
    const newer = cardBytes(sealed({ seq: VECTOR.unsigned.seq + 1 }));
    const last = { seq: first.card.seq, digest: first.digest };
    assert.equal(readCard(newer, { key: signer.key, last }).card.seq, VECTOR.unsigned.seq + 1);
    assert.equal(readCard(cardBytes(sealed()), { key: signer.key, last }).digest, first.digest, "the same catalog again is accepted");
    const later = { seq: VECTOR.unsigned.seq + 1, digest: cardDigest(newer) };
    assert.throws(() => readCard(cardBytes(sealed()), { key: signer.key, last: later }), /^Error: catalog_rollback: the catalog is at seq 1792972800000000, older than/);
    const twin = cardBytes(sealed({ packages: { "acme/linear": { releases: [{ version: "1.4.0", digest: DIGEST }] } } }));
    assert.throws(() => readCard(twin, { key: signer.key, last }), /^Error: catalog_conflict: two catalogs at seq 1792972800000000/);
  });

  it("refuses a sealed catalog it cannot act on: a channel holding a release the catalog does not list", () => {
    const card = sealed({ channels: { stable: { "acme/linear": `sha256:${"cd".repeat(32)}` } } });
    assert.throws(() => readCard(cardBytes(card), { key: signer.key }), /^Error: catalog_invalid: the channel stable holds acme\/linear at sha256:cdcd/);
  });

  it("names the release a channel holds, or else the newest not yanked", () => {
    const d = (c: string) => `sha256:${c.repeat(64)}`;
    const card: UnsignedCatalog = {
      v: 1,
      key: signer.key,
      seq: 1,
      packages: { "acme/linear": { releases: [{ version: "3", digest: d("3"), yanked: "broke sync" }, { version: "2", digest: d("2") }, { version: "1", digest: d("1") }] } },
      channels: { stable: { "acme/linear": d("1") } },
    };
    assert.equal(releaseFor(card, "acme/linear")?.version, "2");
    assert.equal(releaseFor(card, "acme/linear", "stable")?.version, "1");
    assert.equal(releaseFor(card, "acme/linear", "canary"), undefined);
    assert.equal(releaseFor(card, "bob/util"), undefined);
  });
});
