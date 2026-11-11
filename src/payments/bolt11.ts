/**
 * BOLT11, read: what an invoice asks for, before strut pays it
 * (plans/paid-runs.md §8, Withdraw: "the dialog takes a BOLT11 invoice, shows
 * the amount it asks for"). The amount, the payment hash, the description,
 * when it was made and when it expires.
 *
 * Pure and browser-safe (no Buffer, no node:*): the Withdraw dialog decodes
 * with this same file (web/src imports it), so what the person confirms is
 * what `POST /earnings/withdraw` checks. The signature is NOT verified: the
 * wallet does that when it pays, and an invoice whose signature is wrong is
 * refused there. A reader that only shows and checks the amount needs no
 * curve.
 *
 * Tested against BOLT11's own test vectors (bolt11.test.ts).
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/** msat in one BTC, as a bigint. */
const MSAT_PER_BTC = 100_000_000_000n;
/** BOLT11's default expiry when the invoice names none: an hour. */
export const DEFAULT_EXPIRY_SECS = 3600;

export interface DecodedInvoice {
  /** The invoice, lowercased. */
  invoice: string;
  /** The currency prefix after `ln`: `bc` mainnet, `tb` testnet, `tbs`
   *  signet, `bcrt` regtest. */
  network: string;
  /** What it asks for; absent when it names no amount. */
  msat?: number;
  /** hex, 64. */
  paymentHash: string;
  description?: string;
  /** hex, 64: the `h` field, for a description too long to carry. */
  descriptionHash?: string;
  /** The payee's node key (the `n` field), hex, when it names one. */
  payee?: string;
  /** Unix seconds, when it was made. */
  timestamp: number;
  /** Seconds it lasts after `timestamp`. */
  expirySecs: number;
  /** Unix seconds. */
  expiresAt: number;
}

export class Bolt11Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Bolt11Error";
  }
}

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/** Bech32 (not bech32m), no length limit: an invoice is longer than 90. */
function bech32Decode(s: string): { hrp: string; words: number[] } {
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) throw new Bolt11Error("the invoice mixes upper and lower case");
  const text = s.toLowerCase();
  const sep = text.lastIndexOf("1");
  if (sep < 1 || sep + 7 > text.length) throw new Bolt11Error("the invoice is not bech32: no `1` before its data");
  const hrp = text.slice(0, sep);
  const words: number[] = [];
  for (const ch of text.slice(sep + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) throw new Bolt11Error(`the invoice has a character bech32 does not use: ${JSON.stringify(ch)}`);
    words.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...words]) !== 1) throw new Bolt11Error("the invoice's checksum is wrong: a character was mistyped or it was cut");
  return { hrp, words: words.slice(0, -6) };
}

/** 5-bit words → bytes, the trailing bits dropped. */
function wordsToBytes(words: number[]): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  return Uint8Array.from(out);
}

function wordsToInt(words: number[]): number {
  let n = 0;
  for (const w of words) n = n * 32 + w;
  return n;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The human-readable part's amount → msat, or undefined for none. */
function amountMsat(amount: string): number | undefined {
  if (!amount) return undefined;
  const m = /^([1-9]\d*)([munp]?)$/.exec(amount);
  if (!m) throw new Bolt11Error(`the invoice's amount is not BOLT11's: ${JSON.stringify(amount)}`);
  const n = BigInt(m[1]!);
  let msat: bigint;
  switch (m[2]) {
    case "m":
      msat = (n * MSAT_PER_BTC) / 1_000n;
      break;
    case "u":
      msat = (n * MSAT_PER_BTC) / 1_000_000n;
      break;
    case "n":
      msat = (n * MSAT_PER_BTC) / 1_000_000_000n;
      break;
    case "p":
      // A tenth of a msat per pico-bitcoin: the last digit must be 0.
      if (n % 10n !== 0n) throw new Bolt11Error("the invoice asks for a fraction of a millisatoshi");
      msat = n / 10n;
      break;
    default:
      msat = n * MSAT_PER_BTC;
  }
  if (msat > BigInt(Number.MAX_SAFE_INTEGER)) throw new Bolt11Error("the invoice asks for more than strut counts");
  return Number(msat);
}

/** Decode a BOLT11 invoice, or throw a `Bolt11Error` saying what is wrong.
 *  A `lightning:` prefix and surrounding space are taken off. */
export function decodeBolt11(raw: string): DecodedInvoice {
  const s = (typeof raw === "string" ? raw : "").trim().replace(/^lightning:/i, "");
  if (!s) throw new Bolt11Error("no invoice");
  const { hrp, words } = bech32Decode(s);
  const h = /^ln(bcrt|bc|tbs|tb|sb)(\w*)$/.exec(hrp);
  if (!h) throw new Bolt11Error(`not a Lightning invoice: it starts ${JSON.stringify(hrp.slice(0, 8))}, not lnbc, lntb, lntbs or lnbcrt`);
  const msat = amountMsat(h[2]!);
  // timestamp (7 words) … tagged fields … signature (104 words).
  if (words.length < 7 + 104) throw new Bolt11Error("the invoice is too short");
  const timestamp = wordsToInt(words.slice(0, 7));
  const tagged = words.slice(7, words.length - 104);
  let paymentHash: string | undefined;
  let description: string | undefined;
  let descriptionHash: string | undefined;
  let payee: string | undefined;
  let expirySecs = DEFAULT_EXPIRY_SECS;
  let pCount = 0;
  for (let i = 0; i < tagged.length; ) {
    if (i + 3 > tagged.length) throw new Bolt11Error("the invoice's fields are cut");
    const type = CHARSET[tagged[i]!];
    const len = tagged[i + 1]! * 32 + tagged[i + 2]!;
    const data = tagged.slice(i + 3, i + 3 + len);
    if (data.length !== len) throw new Bolt11Error("the invoice's fields are cut");
    i += 3 + len;
    // A field of the wrong length is skipped, as BOLT11 tells a reader to.
    if (type === "p" && len === 52) {
      pCount++;
      paymentHash = hex(wordsToBytes(data));
    } else if (type === "d") {
      description = new TextDecoder("utf-8", { fatal: false }).decode(wordsToBytes(data));
    } else if (type === "h" && len === 52) {
      descriptionHash = hex(wordsToBytes(data));
    } else if (type === "n" && len === 53) {
      payee = hex(wordsToBytes(data));
    } else if (type === "x") {
      expirySecs = wordsToInt(data);
    }
  }
  if (!paymentHash) throw new Bolt11Error("the invoice has no payment hash");
  if (pCount > 1) throw new Bolt11Error("the invoice has two payment hashes");
  return {
    invoice: s.toLowerCase(),
    network: h[1]!,
    ...(msat !== undefined ? { msat } : {}),
    paymentHash,
    ...(description !== undefined ? { description } : {}),
    ...(descriptionHash ? { descriptionHash } : {}),
    ...(payee ? { payee } : {}),
    timestamp,
    expirySecs,
    expiresAt: timestamp + expirySecs,
  };
}

// ── Writing one, for tests ───────────────────────────────────────────────

function bytesToWords(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

function intToWords(n: number, len?: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    out.unshift(v % 32);
    v = Math.floor(v / 32);
  } while (v > 0);
  while (len !== undefined && out.length < len) out.unshift(0);
  return out;
}

const fromHex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));

/**
 * An invoice in BOLT11's form with a zeroed signature, for tests and the
 * stand-in wallets: every reader here decodes it, no wallet pays it.
 * `msat` must be a whole number of msat that BOLT11's amount can say (any
 * multiple of 100 msat, or a whole number of msat through `p`).
 */
export function encodeBolt11(o: { msat?: number; paymentHash: string; description?: string; timestamp?: number; expirySecs?: number; network?: string }): string {
  let amount = "";
  if (o.msat !== undefined) {
    const msat = BigInt(o.msat);
    amount = msat % 100n === 0n ? `${msat / 100n}n` : `${msat * 10n}p`;
  }
  const hrp = `ln${o.network ?? "bc"}${amount}`;
  const field = (type: string, data: number[]) => [CHARSET.indexOf(type), Math.floor(data.length / 32), data.length % 32, ...data];
  const words = [
    ...intToWords(o.timestamp ?? Math.floor(Date.now() / 1000), 7),
    ...field("p", bytesToWords(fromHex(o.paymentHash))),
    ...(o.description !== undefined ? field("d", bytesToWords(new TextEncoder().encode(o.description))) : []),
    ...(o.expirySecs !== undefined ? field("x", intToWords(o.expirySecs)) : []),
    ...new Array(104).fill(0),
  ];
  const mod = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join("")}`;
}
