/**
 * The LISTING request (plans/index-listing.md §1) — src/packages/listing.ts:
 * the base and host rules, the shape, and the seal. The TEST VECTOR below
 * is the contract for another implementation: the same key and request
 * must give the same fingerprint, seal and bytes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, fingerprintOf, keyFromSeed, sealCard, type UnsignedCatalog } from "./card.js";
import { baseProblem, catalogUrlOf, hostMatches, hostOf, hostPatternProblem, listingProblem, perMinute, readListing, sealListing, type UnsignedListing } from "./listing.js";

/** RFC 8032 §7.1, TEST 1 — the key card.test.ts uses. */
const signer = keyFromSeed(Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex"));
const index = keyFromSeed(Buffer.alloc(32, 1));

const VECTOR = {
  unsigned: {
    v: 1,
    index: "tkrq8zmwb8a3m9k15csu3q17qmfgqnp9dskbrg9uq1rydpyxp7qy",
    prefix: "acme",
    key: "47pjoycnsrfmxikm95jh13y88e8qnhzu5kungjpxyepgt7a8krpy",
    base: "https://acme.sphinx.chat:3355/lab",
    description: "Acme's tools",
    seq: 1794268800000000,
  } satisfies UnsignedListing,
  fingerprint: "sha256:358641d2b3812c7fd665ca9eda5ba17c2f3614661f61914254edca71b5df9244",
  sig: "8767fb2b24a0401f9ba997f964614beea759ae1ffd1c5d0bd7defc7b1d41d30195335d742d18ffc50c98c10263dc62c6e149f9844712e601b2ba992ae91cca0b",
  bytes:
    '{"base":"https://acme.sphinx.chat:3355/lab","description":"Acme\'s tools","index":"tkrq8zmwb8a3m9k15csu3q17qmfgqnp9dskbrg9uq1rydpyxp7qy","key":"47pjoycnsrfmxikm95jh13y88e8qnhzu5kungjpxyepgt7a8krpy","prefix":"acme","seq":1794268800000000,"sig":"8767fb2b24a0401f9ba997f964614beea759ae1ffd1c5d0bd7defc7b1d41d30195335d742d18ffc50c98c10263dc62c6e149f9844712e601b2ba992ae91cca0b","v":1}',
};

describe("the listing request", () => {
  it("matches the test vector: the fingerprint, the seal under strut-listing, the bytes", () => {
    assert.equal(index.key, VECTOR.unsigned.index);
    assert.equal(signer.key, VECTOR.unsigned.key);
    const sealed = sealListing(VECTOR.unsigned, signer.privateKey);
    assert.equal(fingerprintOf(VECTOR.unsigned as unknown as UnsignedCatalog), VECTOR.fingerprint);
    assert.equal(sealed.sig, VECTOR.sig);
    assert.equal(canonicalJson(sealed), VECTOR.bytes);
    assert.deepEqual(readListing(VECTOR.bytes), sealed);
  });

  it("is read only in its one form, with its own seal, by its own key", () => {
    const sealed = sealListing({ ...VECTOR.unsigned }, signer.privateKey);
    // Indented: the same object, another byte form.
    assert.throws(() => readListing(JSON.stringify(sealed, null, 2)), /listing_invalid: the request is not in its RFC 8785 form/);
    // A changed member breaks the seal.
    assert.throws(() => readListing(canonicalJson({ ...sealed, prefix: "evil" })), /listing_invalid: the seal is not/);
    // The same fields sealed as a CATALOG never pass as a request: each kind has its domain.
    const asCatalog = sealCard({ ...VECTOR.unsigned } as unknown as UnsignedCatalog, signer.privateKey);
    assert.throws(() => readListing(canonicalJson(asCatalog)), /listing_invalid: the seal is not/);
    // Signed by another key than the one it names.
    const other = keyFromSeed(Buffer.alloc(32, 7));
    const forged = sealListing({ ...VECTOR.unsigned }, other.privateKey);
    assert.throws(() => readListing(canonicalJson(forged)), /the seal is not/);
    assert.throws(() => readListing("x".repeat(9000)), /at most 8192 bytes/);
    assert.throws(() => readListing("not json"), /not JSON/);
    assert.throws(() => readListing(canonicalJson({ ...sealed, extra: 1 })), /"extra" is not a member/);
  });

  it("takes a base that is an origin and at most one path segment, https unless allowed", () => {
    assert.equal(baseProblem("https://acme.sphinx.chat:3355/lab"), undefined);
    assert.equal(baseProblem("https://strut.acme.com"), undefined);
    assert.equal(baseProblem("https://strut.acme.com/"), undefined);
    assert.match(baseProblem("http://strut.acme.com")!, /not https/);
    assert.equal(baseProblem("http://127.0.0.1:3000", { allowHttp: true }), undefined);
    assert.match(baseProblem("https://h.example/jobs/x/files")!, /at most one path segment/);
    assert.match(baseProblem("https://h.example/lab?t=abc")!, /no query/);
    assert.match(baseProblem("https://h.example/lab#x")!, /no query/);
    assert.match(baseProblem("https://u:p@h.example")!, /no credentials/);
    assert.match(baseProblem("ftp://h.example")!, /not https/);
    assert.match(baseProblem(42)!, /base is the server's address/);
    // The index fetches it from an open route: public names only.
    for (const inside of ["https://127.0.0.1", "https://10.0.0.5:3355/lab", "https://[::1]", "https://localhost", "https://box.local", "https://db.internal", "https://intranet"]) {
      assert.match(baseProblem(inside)!, /not a public name/, inside);
    }
    // The index builds the one URL it reads, from the base alone.
    assert.equal(catalogUrlOf("https://acme.sphinx.chat:3355/lab/"), "https://acme.sphinx.chat:3355/lab/packages/catalog?public=1");
    assert.equal(catalogUrlOf("https://strut.acme.com"), "https://strut.acme.com/packages/catalog?public=1");
  });

  it("matches hosts: exact, one label under a domain, the port as written, case-blind", () => {
    const swarm = hostOf("https://swarmGcVVgq.sphinx.chat:3355/lab");
    assert.equal(swarm, "swarmgcvvgq.sphinx.chat:3355");
    assert.ok(hostMatches("*.sphinx.chat:3355", swarm));
    assert.ok(hostMatches("*.SPHINX.chat:3355", swarm));
    assert.ok(!hostMatches("*.sphinx.chat:3355", "a.b.sphinx.chat:3355"), "one label only");
    assert.ok(!hostMatches("*.sphinx.chat:3355", "x.sphinx.chat"), "another port");
    assert.ok(!hostMatches("*.sphinx.chat", "x.sphinx.chat:3355"), "no port in the pattern: the default only");
    assert.ok(hostMatches("*.sphinx.chat", hostOf("https://x.sphinx.chat:443/lab")));
    assert.ok(!hostMatches("*.sphinx.chat:3355", "sphinx.chat:3355"));
    assert.ok(!hostMatches("*.sphinx.chat:3355", "evilsphinx.chat:3355"));
    assert.ok(hostMatches("strut.acme.com", "strut.acme.com"));
    assert.ok(!hostMatches("strut.acme.com", "x.strut.acme.com"));
    assert.ok(hostMatches("*", "anything.example:8443"));
    for (const ok of ["*", "*.sphinx.chat:3355", "strut.acme.com", "127.0.0.1:3000"]) assert.equal(hostPatternProblem(ok), undefined, ok);
    for (const bad of ["", "*.", "a..b", "*.*.x", "http://x", "x/y", 3]) assert.ok(hostPatternProblem(bad), String(bad));
  });

  it("checks the shape: a removal names no base, an ask names one", () => {
    const sig = "a".repeat(128);
    const base = { v: 1, index: index.key, prefix: "acme", key: signer.key, seq: 1, sig };
    assert.equal(listingProblem({ ...base, remove: true }), undefined);
    assert.match(listingProblem(base)!, /base/);
    assert.equal(listingProblem({ ...base, base: "https://h.example/lab", live: true }), undefined);
    assert.match(listingProblem({ ...base, base: "https://h.example", prefix: "Acme" })!, /prefix/);
    assert.match(listingProblem({ ...base, base: "https://h.example", description: "x".repeat(281) })!, /280/);
    assert.match(listingProblem({ ...base, base: "https://h.example", url: "javascript:x" })!, /homepage/);
    assert.match(listingProblem({ ...base, base: "https://h.example", remove: false })!, /remove/);
    assert.match(listingProblem({ ...base, base: "https://h.example", v: 2 })!, /v is 1/);
  });

  it("budgets an open route per address a minute", () => {
    let t = 0;
    const budget = perMinute(2, () => t);
    assert.ok(budget.allow("a"));
    assert.ok(budget.allow("a"));
    assert.ok(!budget.allow("a"));
    assert.ok(budget.allow("b"), "another address has its own");
    t = 60_000;
    assert.ok(budget.allow("a"), "a new minute");
  });
});
