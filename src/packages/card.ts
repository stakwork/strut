/**
 * The catalog CARD (plans/marketplace.md §13): a publisher's signed list of
 * the packages it published, each with its releases newest first, and its
 * channels — which release each channel holds (§12.1). One JSON object in
 * its RFC 8785 form (JCS), sealed with the publisher's Ed25519 key.
 *
 * | Part        | Rule |
 * | ----------- | ---- |
 * | Bytes       | the object, `sig` included, in its RFC 8785 form — the only byte form a reader accepts |
 * | Digest      | `sha256:<hex>` over those bytes: what serves a catalog by hash |
 * | Fingerprint | `sha256:<hex>` over the RFC 8785 form WITHOUT `sig`: what is signed |
 * | Seal        | `sig`: Ed25519 (RFC 8032), lowercase hex, over `strut-catalog\n` + the fingerprint as written |
 * | Key         | the publisher's public key, z-base-32 (Pkarr's form); checked against the key the reader EXPECTED, never taken from the file |
 * | Version     | `v: 1`; a member a reader does not know is ignored, and the seal still covers it |
 * | Order       | `seq`: microseconds since the epoch at signing, `max(now, previous + 1)`; a reader refuses a lower one, and another catalog at the same one |
 *
 * Pure: no store, no network. `publisher.ts` keeps the key and the
 * catalogs; a subscriber (§12.1) keeps the last catalog it accepted.
 * `card.test.ts` holds a test vector — a fixed key, catalog, fingerprint,
 * seal and digest — for another implementation to check itself against.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import type { PackageManifest } from "./format.js";
import { PACKAGE_DIGEST, PACKAGE_NAME } from "./format.js";

export const CARD_VERSION = 1;
/** What the seal signs before the fingerprint, so a catalog's signature
 *  never passes as anything else the key signs (its Pkarr record, an index
 *  catalog's `strut-index\n`). */
export const CATALOG_DOMAIN = "strut-catalog\n";

/** One release of a package. With no `urls`, a reader fetches it from the
 *  archive route of the strut that served the catalog (`host: self`). */
export interface CatalogRelease {
  version: string;
  digest: string;
  urls?: string[];
  license?: string;
  requires?: PackageManifest["requires"];
  /** Withdrawn, with the reason: still fetchable, skipped by "latest". */
  yanked?: string;
}

export interface CatalogPackage {
  description?: string;
  /** Newest first; earlier ones are kept, so an installed digest stays fetchable. */
  releases: CatalogRelease[];
}

export interface UnsignedCatalog {
  v: number;
  key: string;
  seq: number;
  packages: Record<string, CatalogPackage>;
  /** Channel → package → the digest that channel holds. */
  channels?: Record<string, Record<string, string>>;
}

export interface Catalog extends UnsignedCatalog {
  sig: string;
}

// ── RFC 8785 ─────────────────────────────────────────────────────────────

/** A JSON value in its RFC 8785 form: members sorted by UTF-16 code units,
 *  no whitespace, ECMAScript's number and string forms (what
 *  `JSON.stringify` writes for a finite number and for a string). */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`catalog_invalid: ${value} has no JSON form`);
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new Error(`catalog_invalid: a ${typeof value} has no JSON form`);
}

const sha256 = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** What is signed: the catalog without its `sig`. */
export function fingerprintOf(card: UnsignedCatalog): string {
  const { sig: _sig, ...rest } = card as Catalog;
  return sha256(canonicalJson(rest));
}

/** The catalog's bytes as served, and what serves it by hash. */
export function cardBytes(card: Catalog): Buffer {
  return Buffer.from(canonicalJson(card), "utf8");
}

export function cardDigest(bytes: string | Buffer): string {
  return sha256(bytes);
}

// ── keys ─────────────────────────────────────────────────────────────────

const Z32 = "ybndrfg8ejkmcpqxot1uwisza345h769";

/** z-base-32, the form Pkarr writes a 32-byte key in (52 characters). */
export function z32Encode(bytes: Buffer): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += Z32[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += Z32[(acc << (5 - bits)) & 31];
  return out;
}

export function z32Decode(text: string, length = 32): Buffer {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of text) {
    const v = Z32.indexOf(ch);
    if (v < 0) throw new Error(`catalog_key: ${JSON.stringify(text)} is not z-base-32`);
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >> (bits - 8)) & 255);
      bits -= 8;
      acc &= (1 << bits) - 1;
    }
  }
  if (out.length !== length || acc !== 0) throw new Error(`catalog_key: ${JSON.stringify(text)} is not a ${length}-byte key in z-base-32`);
  return Buffer.from(out);
}

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/** An Ed25519 key pair from its 32-byte seed (RFC 8032's secret key). */
export function keyFromSeed(seed: Buffer): { privateKey: KeyObject; key: string } {
  if (seed.length !== 32) throw new Error("an Ed25519 seed is 32 bytes");
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const x = createPublicKey(privateKey).export({ format: "jwk" }).x!;
  return { privateKey, key: z32Encode(Buffer.from(x, "base64url")) };
}

function publicKeyOf(key: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: z32Decode(key).toString("base64url") }, format: "jwk" });
}

// ── seal and read ────────────────────────────────────────────────────────

/** The catalog sealed by `privateKey`, whose public key is `card.key`. */
export function sealCard(card: UnsignedCatalog, privateKey: KeyObject): Catalog {
  const unsigned = { ...card };
  delete (unsigned as Partial<Catalog>).sig;
  const sig = sign(null, Buffer.from(CATALOG_DOMAIN + fingerprintOf(unsigned), "utf8"), privateKey).toString("hex");
  return { ...unsigned, sig };
}

export interface ReadCardOptions {
  /** The key the reader expected: a subscription's, a `pk:` ref's. */
  key: string;
  /** The last catalog the reader accepted from that key. */
  last?: { seq: number; digest: string };
}

/**
 * A served catalog, every check of §13 in order — one byte form, the key
 * the reader expected, the version, the seal, then the order against the
 * last one accepted — or an error whose code says which failed:
 * `catalog_invalid`, `catalog_noncanonical`, `catalog_key`,
 * `catalog_version`, `catalog_seal`, `catalog_rollback`, `catalog_conflict`.
 */
export function readCard(bytes: string | Buffer, opts: ReadCardOptions): { card: Catalog; digest: string } {
  const text = typeof bytes === "string" ? bytes : bytes.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`catalog_invalid: not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("catalog_invalid: a catalog is a JSON object");
  if (canonicalJson(parsed) !== text) throw new Error("catalog_noncanonical: the catalog is not in its RFC 8785 form, the only one a reader accepts");
  const card = parsed as Catalog;
  if (card.key !== opts.key) throw new Error(`catalog_key: the catalog is ${JSON.stringify(card.key)}'s, and the reader expected ${opts.key}'s`);
  if (card.v !== CARD_VERSION) throw new Error(`catalog_version: the catalog is v ${JSON.stringify(card.v)}, and this reader reads v ${CARD_VERSION}`);
  if (typeof card.sig !== "string" || !/^[0-9a-f]{128}$/.test(card.sig)) throw new Error("catalog_seal: the catalog carries no seal (sig, 128 hex)");
  const signed = Buffer.from(CATALOG_DOMAIN + fingerprintOf(card), "utf8");
  if (!verify(null, signed, publicKeyOf(opts.key), Buffer.from(card.sig, "hex"))) throw new Error(`catalog_seal: the seal is not ${opts.key}'s over this catalog`);
  const problem = shapeProblem(card);
  if (problem) throw new Error(`catalog_invalid: ${problem}`);
  const digest = cardDigest(text);
  if (opts.last) {
    if (card.seq < opts.last.seq) throw new Error(`catalog_rollback: the catalog is at seq ${card.seq}, older than the ${opts.last.seq} already accepted`);
    if (card.seq === opts.last.seq && digest !== opts.last.digest) throw new Error(`catalog_conflict: two catalogs at seq ${card.seq} sealed by ${opts.key} — a misused or stolen key`);
  }
  return { card, digest };
}

/** What a sealed catalog must hold for a reader to act on it. */
function shapeProblem(card: Catalog): string | undefined {
  if (!Number.isSafeInteger(card.seq) || card.seq < 0) return "seq is a whole number of microseconds";
  if (!card.packages || typeof card.packages !== "object" || Array.isArray(card.packages)) return "packages is an object";
  for (const [pkg, p] of Object.entries(card.packages)) {
    if (!PACKAGE_NAME.test(pkg)) return `${JSON.stringify(pkg)} is not a package name`;
    if (!p || !Array.isArray(p.releases)) return `${pkg} has no releases list`;
    for (const r of p.releases) if (!r || typeof r.version !== "string" || !PACKAGE_DIGEST.test(r.digest)) return `a release of ${pkg} has no version or digest`;
  }
  for (const [channel, held] of Object.entries(card.channels ?? {})) {
    for (const [pkg, digest] of Object.entries(held ?? {})) {
      if (!card.packages[pkg]?.releases.some((r) => r.digest === digest)) return `the channel ${channel} holds ${pkg} at ${digest}, which the catalog does not list`;
    }
  }
  return undefined;
}

/** The release a channel holds for a package — or, with no channel, its
 *  newest release not yanked. */
export function releaseFor(card: UnsignedCatalog, pkg: string, channel?: string): CatalogRelease | undefined {
  const releases = card.packages[pkg]?.releases ?? [];
  if (channel !== undefined) {
    const digest = card.channels?.[channel]?.[pkg];
    return digest ? releases.find((r) => r.digest === digest) : undefined;
  }
  return releases.find((r) => !r.yanked);
}
