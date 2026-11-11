/**
 * L402 (plans/paid-runs.md §4): the CREDIT TOKEN a buyer pays for and
 * presents, as bytes and as rules. Pure: no wallet, no ledger, no clock it
 * does not take. The service that asks the wallet and the ledger is
 * `src/public-credit.ts`.
 *
 * - **The format** is libmacaroons v2 binary (`encodeMacaroon` /
 *   `decodeMacaroon`), base64 on the wire, so any macaroon library reads a
 *   token and appends a caveat. Not gatekey's format: the Mothership's
 *   macaroons are signed JSON. Tested byte for byte against Go's
 *   `gopkg.in/macaroon.v2` (`src/fixtures/l402-macaroons.json`, made by
 *   `scripts/l402-fixtures/`).
 * - **The HMAC chain** is libmacaroons': the root key is first derived
 *   (`HMAC-SHA256("macaroons-key-generator", key)`), the identifier signed
 *   with it, and each caveat signs over the signature before it. A third-
 *   party caveat chains as libmacaroons does, so a token carrying one still
 *   verifies — and is then refused, since strut cannot discharge it.
 * - **The identifier** is L402's, 66 bytes: version `0` (2 bytes, big
 *   endian), the invoice's payment hash (32), a random token id (32).
 * - **The root key** of a token is `HMAC-SHA256(L402_ROOT, token id)`:
 *   derived, so nothing is stored per token (`L402_ROOT` lives in
 *   `payments.json`, `PaymentsSettings.l402Root`).
 * - **The caveats** (§4.2's table). Strut writes, in this order:
 *   `services=strut:0`, `strut_sats`, `strut_credit` (the locked quote, in
 *   micro-dollars), `strut_valid_until` (unix seconds), and `strut_carry`
 *   — the token it inherits from (§4.5), or `none`. Strut writes
 *   `strut_carry` on EVERY token, so the fifth caveat is always strut's: were
 *   it written only on a token that inherits, a holder could append one to
 *   a token of four and point its first use at another token's credit. A
 *   HOLDER may append `strut_capabilities`, `strut_max_charge`,
 *   `strut_valid_until` and `services`; every one must hold, so a repeat
 *   can only narrow. Anything else REFUSES the token: a restriction strut
 *   cannot read must not be dropped (L402's own text skips unknown caveats;
 *   this is stricter on purpose), and strut's own five may not be repeated.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The location strut writes on a macaroon. Not signed; informational. */
export const L402_LOCATION = "strut";
/** L402's service line: one service, tier 0. */
export const L402_SERVICE = "strut:0";
/** The longest macaroon strut decodes, as bytes. A holder's caveats fit many
 *  times over; a megabyte of them is refused before any HMAC is computed. */
export const MACAROON_MAX_BYTES = 8 * 1024;
/** The most caveats strut reads on one token. */
export const CAVEATS_MAX = 64;

/** Why a token is refused, before the ledger or the wallet is asked. */
export type L402ErrorCode = "bad_macaroon" | "bad_identifier" | "bad_signature" | "bad_preimage" | "bad_caveat";

export class L402Error extends Error {
  constructor(
    readonly code: L402ErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "L402Error";
  }
}

// ── libmacaroons v2 binary ──────────────────────────────────────────────

const FIELD_EOS = 0;
const FIELD_LOCATION = 1;
const FIELD_IDENTIFIER = 2;
const FIELD_VID = 4;
const FIELD_SIGNATURE = 6;

export interface Caveat {
  /** The caveat's identifier: a first-party caveat's condition (`key=value`). */
  id: Buffer;
  /** A third-party caveat's location. */
  location?: string;
  /** A third-party caveat's verification id. */
  vid?: Buffer;
}

export interface Macaroon {
  /** "" when the macaroon names none. */
  location: string;
  id: Buffer;
  caveats: Caveat[];
  signature: Buffer;
}

function uvarint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}

function field(type: number, data: Buffer): Buffer {
  return Buffer.concat([uvarint(type), uvarint(data.length), data]);
}

/** A macaroon as libmacaroons v2 binary. */
export function encodeMacaroon(m: Macaroon): Buffer {
  const parts: Buffer[] = [Buffer.from([2])];
  if (m.location) parts.push(field(FIELD_LOCATION, Buffer.from(m.location, "utf8")));
  parts.push(field(FIELD_IDENTIFIER, m.id), Buffer.from([FIELD_EOS]));
  for (const c of m.caveats) {
    if (c.location) parts.push(field(FIELD_LOCATION, Buffer.from(c.location, "utf8")));
    parts.push(field(FIELD_IDENTIFIER, c.id));
    if (c.vid?.length) parts.push(field(FIELD_VID, c.vid));
    parts.push(Buffer.from([FIELD_EOS]));
  }
  parts.push(Buffer.from([FIELD_EOS]), field(FIELD_SIGNATURE, m.signature));
  return Buffer.concat(parts);
}

/** A reader over the bytes; every read checks the length left. */
class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}
  done(): boolean {
    return this.pos >= this.buf.length;
  }
  uvarint(): number {
    let n = 0;
    let mul = 1;
    for (let i = 0; i < 5; i++) {
      if (this.pos >= this.buf.length) throw new L402Error("bad_macaroon", "the macaroon is cut short");
      const b = this.buf[this.pos++]!;
      n += (b & 0x7f) * mul;
      if (b < 0x80) return n;
      mul *= 128;
    }
    throw new L402Error("bad_macaroon", "a length is too long");
  }
  bytes(n: number): Buffer {
    if (n > this.buf.length - this.pos) throw new L402Error("bad_macaroon", "the macaroon is cut short");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return Buffer.from(out);
  }
}

/** One section of fields up to its end marker, each type at most once and
 *  in increasing order (libmacaroons v2). An empty section is the end of
 *  the caveats. */
function section(r: Reader): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  let last = 0;
  for (;;) {
    const type = r.uvarint();
    if (type === FIELD_EOS) return out;
    if (type <= last) throw new L402Error("bad_macaroon", "a field is out of order or repeated");
    if (type !== FIELD_LOCATION && type !== FIELD_IDENTIFIER && type !== FIELD_VID) throw new L402Error("bad_macaroon", `an unexpected field (${type})`);
    last = type;
    out.set(type, r.bytes(r.uvarint()));
  }
}

/** libmacaroons v2 binary → a macaroon. Throws `bad_macaroon` for anything
 *  else: v1, JSON, trailing bytes, a missing identifier or signature. */
export function decodeMacaroon(bytes: Buffer): Macaroon {
  if (bytes.length > MACAROON_MAX_BYTES) throw new L402Error("bad_macaroon", `the macaroon is over ${MACAROON_MAX_BYTES} bytes`);
  if (bytes[0] !== 2) throw new L402Error("bad_macaroon", "not a libmacaroons v2 binary macaroon");
  const r = new Reader(bytes);
  r.pos = 1;
  const head = section(r);
  const id = head.get(FIELD_IDENTIFIER);
  if (!id) throw new L402Error("bad_macaroon", "the macaroon has no identifier");
  if (head.has(FIELD_VID)) throw new L402Error("bad_macaroon", "the macaroon's header carries a verification id");
  const caveats: Caveat[] = [];
  for (;;) {
    const s = section(r);
    if (s.size === 0) break;
    if (caveats.length >= CAVEATS_MAX) throw new L402Error("bad_macaroon", `more than ${CAVEATS_MAX} caveats`);
    const cid = s.get(FIELD_IDENTIFIER);
    if (!cid) throw new L402Error("bad_macaroon", "a caveat has no identifier");
    const loc = s.get(FIELD_LOCATION);
    const vid = s.get(FIELD_VID);
    caveats.push({ id: cid, ...(loc?.length ? { location: loc.toString("utf8") } : {}), ...(vid?.length ? { vid } : {}) });
  }
  if (r.uvarint() !== FIELD_SIGNATURE) throw new L402Error("bad_macaroon", "the macaroon has no signature");
  const signature = r.bytes(r.uvarint());
  if (signature.length !== 32) throw new L402Error("bad_macaroon", "the signature is not 32 bytes");
  if (!r.done()) throw new L402Error("bad_macaroon", "bytes after the signature");
  const location = head.get(FIELD_LOCATION);
  return { location: location ? location.toString("utf8") : "", id, caveats, signature };
}

const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** base64 (standard or URL-safe, padded or not) → a macaroon. */
export function macaroonFromBase64(s: string): Macaroon {
  const t = s.trim();
  if (!t || t.length > Math.ceil((MACAROON_MAX_BYTES * 4) / 3) + 4 || !BASE64.test(t)) throw new L402Error("bad_macaroon", "not base64");
  return decodeMacaroon(Buffer.from(t, "base64"));
}

/** A macaroon as standard base64, padded: what the challenge hands out. */
export function macaroonToBase64(m: Macaroon): string {
  return encodeMacaroon(m).toString("base64");
}

// ── The HMAC chain ──────────────────────────────────────────────────────

const KEY_GENERATOR = Buffer.from("macaroons-key-generator", "utf8");
const hmac = (key: Buffer, data: Buffer): Buffer => createHmac("sha256", key).update(data).digest();

/** libmacaroons' key derivation: a variable-length key to the 32 bytes the
 *  chain starts from. */
function derivedKey(rootKey: Buffer): Buffer {
  return hmac(KEY_GENERATOR, rootKey);
}

/** The signature after one more caveat. */
function chain(sig: Buffer, c: Caveat): Buffer {
  if (!c.vid?.length) return hmac(sig, c.id);
  return hmac(sig, Buffer.concat([hmac(sig, c.vid), hmac(sig, c.id)]));
}

/** The signature a macaroon with this identifier and these caveats has
 *  under `rootKey`. */
export function signatureFor(rootKey: Buffer, id: Buffer, caveats: Caveat[]): Buffer {
  let sig = hmac(derivedKey(rootKey), id);
  for (const c of caveats) sig = chain(sig, c);
  return sig;
}

/** A new macaroon, signed with `rootKey`, its first-party caveats in order. */
export function mintMacaroon(rootKey: Buffer, id: Buffer, location: string, caveats: string[]): Macaroon {
  const cs = caveats.map((c) => ({ id: Buffer.from(c, "utf8") }));
  return { location, id: Buffer.from(id), caveats: cs, signature: signatureFor(rootKey, id, cs) };
}

/** A HOLDER's narrowing: one more first-party caveat, chained from the
 *  macaroon's own signature. No key is needed — what a holder does before
 *  handing a token to a sub-agent (§4.2). */
export function addCaveat(m: Macaroon, caveat: string): Macaroon {
  const c: Caveat = { id: Buffer.from(caveat, "utf8") };
  return { ...m, caveats: [...m.caveats, c], signature: chain(m.signature, c) };
}

/** Whether the macaroon's signature is the chain under `rootKey`. */
export function verifySignature(m: Macaroon, rootKey: Buffer): boolean {
  const want = signatureFor(rootKey, m.id, m.caveats);
  return want.length === m.signature.length && timingSafeEqual(want, m.signature);
}

// ── L402's identifier ───────────────────────────────────────────────────

export const IDENTIFIER_BYTES = 66;
const HEX32 = /^[0-9a-f]{64}$/;

export interface L402Identifier {
  /** hex, the invoice's payment hash. */
  paymentHash: string;
  /** hex, 32 random bytes: the token's id in the ledger. */
  tokenId: string;
}

export function encodeIdentifier(i: L402Identifier): Buffer {
  if (!HEX32.test(i.paymentHash) || !HEX32.test(i.tokenId)) throw new L402Error("bad_identifier", "the payment hash and the token id are 64 hex characters each");
  return Buffer.concat([Buffer.from([0, 0]), Buffer.from(i.paymentHash, "hex"), Buffer.from(i.tokenId, "hex")]);
}

export function decodeIdentifier(id: Buffer): L402Identifier {
  if (id.length !== IDENTIFIER_BYTES) throw new L402Error("bad_identifier", `the identifier is ${id.length} bytes, not ${IDENTIFIER_BYTES}`);
  const version = id.readUInt16BE(0);
  if (version !== 0) throw new L402Error("bad_identifier", `identifier version ${version} is not known`);
  return { paymentHash: id.subarray(2, 34).toString("hex"), tokenId: id.subarray(34, 66).toString("hex") };
}

/** A token's root key: `HMAC-SHA256(L402_ROOT, token id)`. */
export function tokenRootKey(l402Root: Buffer, tokenId: string): Buffer {
  if (!HEX32.test(tokenId)) throw new L402Error("bad_identifier", "a token id is 64 hex characters");
  return hmac(l402Root, Buffer.from(tokenId, "hex"));
}

/** A fresh token id: 32 random bytes, hex. */
export function newTokenId(): string {
  return randomBytes(32).toString("hex");
}

// ── Strut's caveats ─────────────────────────────────────────────────────

/** What strut wrote: the quote, locked (§4.1). */
export interface StrutQuote {
  /** What the invoice was for. */
  sats: number;
  /** What those sats buy, in micro-dollars. */
  credit: number;
  /** When the credit ends, unix seconds (a year after the purchase). */
  validUntil: number;
  /** The token this one inherits from (§4.5), hex. */
  carry?: string;
}

/** What holders appended. Each list is one caveat each: every one must hold. */
export interface HolderCaveats {
  /** `strut_capabilities`: each the items it allows, `<kind>:<name>`. */
  capabilities: string[][];
  /** `strut_max_charge`: micro-dollars. */
  maxCharge: number[];
  /** `strut_valid_until`: unix seconds. */
  validUntil: number[];
}

export interface StrutCaveats {
  quote: StrutQuote;
  holder: HolderCaveats;
  /** A holder appended something: the token is never carried from (§4.5). */
  narrowed: boolean;
}

const CAVEAT = /^([a-z_]+)=(.*)$/s;
/** `strut_carry`'s value on a token that inherits nothing. */
export const NO_CARRY = "none";

function count(name: string, v: string, o: { positive?: boolean } = {}): number {
  if (!/^\d{1,16}$/.test(v)) throw new L402Error("bad_caveat", `${name} is not a whole number: ${JSON.stringify(v.slice(0, 40))}`);
  const n = Number(v);
  if (!Number.isSafeInteger(n) || (o.positive && n <= 0)) throw new L402Error("bad_caveat", `${name} is out of range: ${v}`);
  return n;
}

/** `services=` is a comma list of `name:tier`; strut's must be there at 0. */
function servesStrut(v: string): boolean {
  return v.split(",").map((s) => s.trim()).includes(L402_SERVICE);
}

/** `<kind>:<name>` for `strut_capabilities`: an item a public run or call names. */
export const capabilityOf = (item: { kind: "workflow" | "step"; name: string }): string => `${item.kind}:${item.name}`;

/** The caveats of a token strut minted, read whole. Throws `bad_caveat` for
 *  a third-party caveat, an unknown condition, strut's own caveats missing,
 *  out of order or repeated, and a value that does not parse. */
export function readCaveats(caveats: Caveat[]): StrutCaveats {
  const conds = caveats.map((c, i) => {
    if (c.vid?.length || c.location) throw new L402Error("bad_caveat", "a third-party caveat: strut cannot discharge it");
    const m = CAVEAT.exec(c.id.toString("utf8"));
    if (!m) throw new L402Error("bad_caveat", `caveat ${i + 1} is not key=value`);
    return { key: m[1]!, value: m[2]! };
  });
  const own = ["services", "strut_sats", "strut_credit", "strut_valid_until", "strut_carry"] as const;
  for (let i = 0; i < own.length; i++) {
    if (conds[i]?.key !== own[i]) throw new L402Error("bad_caveat", `strut's caveat ${own[i]} is not where strut wrote it`);
  }
  if (conds[0]!.value !== L402_SERVICE) throw new L402Error("bad_caveat", `services is not ${L402_SERVICE}`);
  const quote: StrutQuote = {
    sats: count("strut_sats", conds[1]!.value, { positive: true }),
    credit: count("strut_credit", conds[2]!.value, { positive: true }),
    validUntil: count("strut_valid_until", conds[3]!.value, { positive: true }),
  };
  const carry = conds[4]!.value;
  if (carry !== NO_CARRY && !HEX32.test(carry)) throw new L402Error("bad_caveat", "strut_carry is not a token id");
  if (carry !== NO_CARRY) quote.carry = carry;
  const holder: HolderCaveats = { capabilities: [], maxCharge: [], validUntil: [] };
  for (const { key, value } of conds.slice(own.length)) {
    if (key === "strut_capabilities") {
      const items = value.split(",").map((s) => s.trim()).filter(Boolean);
      if (!items.length || items.some((s) => !/^(workflow|step):[^,]+$/.test(s))) throw new L402Error("bad_caveat", "strut_capabilities is a list of <workflow|step>:<name>");
      holder.capabilities.push(items);
    } else if (key === "strut_max_charge") holder.maxCharge.push(count("strut_max_charge", value));
    else if (key === "strut_valid_until") holder.validUntil.push(count("strut_valid_until", value));
    else if (key === "services") {
      // A narrower services line must still name strut, at its tier.
      if (!servesStrut(value)) throw new L402Error("bad_caveat", `a services caveat without ${L402_SERVICE}`);
    } else if (key === "strut_sats" || key === "strut_credit" || key === "strut_carry") {
      throw new L402Error("bad_caveat", `${key} is strut's to write, once`);
    } else throw new L402Error("bad_caveat", `a caveat strut does not know: ${key}`);
  }
  return { quote, holder, narrowed: conds.length > own.length };
}

/** The caveats strut writes on a new token, in order. */
export function strutCaveats(q: StrutQuote): string[] {
  return [
    `services=${L402_SERVICE}`,
    `strut_sats=${q.sats}`,
    `strut_credit=${q.credit}`,
    `strut_valid_until=${q.validUntil}`,
    `strut_carry=${q.carry ?? NO_CARRY}`,
  ];
}

/** A new credit token: the identifier, strut's caveats, signed under the
 *  token's root key. */
export function mintToken(l402Root: Buffer, o: { paymentHash: string; tokenId?: string; quote: StrutQuote }): { macaroon: Macaroon; tokenId: string } {
  const tokenId = o.tokenId ?? newTokenId();
  const id = encodeIdentifier({ paymentHash: o.paymentHash, tokenId });
  return { macaroon: mintMacaroon(tokenRootKey(l402Root, tokenId), id, L402_LOCATION, strutCaveats(o.quote)), tokenId };
}

// ── A presented token ───────────────────────────────────────────────────

/** `Authorization: L402 <macaroon>:<preimage>` (or `LSAT`, the scheme's old
 *  name). The preimage may be absent: `claim` takes the macaroon alone. */
export interface Presented {
  macaroon: string;
  preimage?: string;
}

/** The credential in an Authorization header, or undefined when it is not
 *  the L402 scheme. A comma-separated list of macaroons (an L402 client
 *  with discharges) is not read: strut issues none. */
export function parseAuthorization(header: string | undefined): Presented | undefined {
  const m = /^\s*(?:L402|LSAT)\s+(\S+?)\s*$/i.exec(header ?? "");
  if (!m) return undefined;
  const v = m[1]!;
  const i = v.lastIndexOf(":");
  if (i < 0) return { macaroon: v };
  const preimage = v.slice(i + 1);
  return { macaroon: v.slice(0, i), ...(preimage ? { preimage } : {}) };
}

/** A token whose bytes, signature, preimage and caveats are good (§4.3
 *  steps 1 to 3, before the request's own conditions): what the ledger and
 *  the wallet are then asked about. */
export interface VerifiedToken extends StrutCaveats, L402Identifier {
  macaroon: Macaroon;
  /** hex, when it was presented. */
  preimage?: string;
}

/** Decode, recompute the chain under the token's root key, check the
 *  preimage (unless `requirePreimage: false`, `claim`'s case) and read the
 *  caveats. Throws `L402Error`. */
export function verifyToken(p: Presented, l402Root: Buffer, o: { requirePreimage?: boolean } = {}): VerifiedToken {
  const macaroon = macaroonFromBase64(p.macaroon);
  const ident = decodeIdentifier(macaroon.id);
  if (!verifySignature(macaroon, tokenRootKey(l402Root, ident.tokenId))) throw new L402Error("bad_signature", "the macaroon was not signed by this server");
  let preimage: string | undefined;
  if (p.preimage !== undefined || o.requirePreimage !== false) {
    preimage = (p.preimage ?? "").trim().toLowerCase();
    if (!HEX32.test(preimage)) throw new L402Error("bad_preimage", "the preimage is 64 hex characters");
    if (createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex") !== ident.paymentHash) {
      throw new L402Error("bad_preimage", "the preimage does not match the invoice's payment hash");
    }
  }
  return { macaroon, ...ident, ...readCaveats(macaroon.caveats), ...(preimage ? { preimage } : {}) };
}

/** Why a verified token may not be used for this request (§4.3 step 3),
 *  else undefined. `expired`: strut's own end or a holder's has passed.
 *  `not_this_item`: a holder's `strut_capabilities` leaves it out.
 *  `over_max_charge`: the reserve is above a holder's `strut_max_charge`. */
export function tokenRefusal(t: VerifiedToken, o: { now: number; item?: { kind: "workflow" | "step"; name: string }; reserve?: number }): "expired" | "not_this_item" | "over_max_charge" | undefined {
  const nowS = Math.floor(o.now / 1000);
  if (t.quote.validUntil <= nowS || t.holder.validUntil.some((v) => v <= nowS)) return "expired";
  if (o.item) {
    const cap = capabilityOf(o.item);
    if (t.holder.capabilities.some((list) => !list.includes(cap))) return "not_this_item";
  }
  if (o.reserve !== undefined && t.holder.maxCharge.some((m) => o.reserve! > m)) return "over_max_charge";
  return undefined;
}
