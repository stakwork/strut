// ── A priced launch's challenge, checked before anyone pays it ──────────────
// (plans/paid-runs.md §4, §10; specs/API.md §17.5, §17.6)
//
// A visitor's page that launches a priced workflow gets `{ payment_required:
// { macaroon, invoice, usd, sats, … } }` from the server it runs on — this
// strut, or ANOTHER strut server whose public app this UI hosts (§17.9).
// Before the host shows that invoice, or asks a native wallet to pay it,
// it holds the challenge to what a strut server writes: the invoice is
// BOLT11 and asks for an amount, it has not ended, the macaroon is a
// libmacaroons v2 L402 token naming the SAME payment hash — so its
// preimage is what opens the credit — and the sats agree three ways (the
// challenge, the macaroon's `strut_sats`, the invoice). A challenge that
// fails is junk: nothing is shown or paid.
//
// The server can still charge what it likes; what this rules out is a
// payment that buys nothing (an invoice the macaroon does not name) and a
// sheet that shows one price while the invoice asks another. Pure — no
// Buffer, no node:crypto — so the page and the root test run share it
// (challenge.test.ts).

import { Bolt11Error, decodeBolt11, type DecodedInvoice } from "../../src/payments/bolt11.js";
import type { PaymentRequired } from "./visitor-pay";

/** What a host reads off an L402 macaroon: the payment hash its identifier
 *  names and its first-party caveats, as `key=value` strings. */
export interface ReadMacaroon {
  paymentHash: string;
  tokenId: string;
  caveats: string[];
}

const FIELD_EOS = 0;
const FIELD_LOCATION = 1;
const FIELD_IDENTIFIER = 2;
const FIELD_VID = 4;
const FIELD_SIGNATURE = 6;
/** strut's own limit (src/l402.ts `MACAROON_MAX_BYTES`). */
const MACAROON_MAX_BYTES = 8 * 1024;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function base64Bytes(s: string): Uint8Array {
  const t = s.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) throw new Error("the macaroon is not base64");
  const bin = atob(t.padEnd(Math.ceil(t.length / 4) * 4, "="));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A libmacaroons v2 binary macaroon (base64, standard or URL-safe), read
 *  for its identifier and caveats. Throws on anything else. The signature
 *  is not checked: only the server that minted it holds its key. */
export function readMacaroon(b64: string): ReadMacaroon {
  const buf = base64Bytes(b64);
  if (buf.length > MACAROON_MAX_BYTES) throw new Error("the macaroon is too long");
  if (buf[0] !== 2) throw new Error("not a libmacaroons v2 macaroon");
  let pos = 1;
  const uvarint = () => {
    let n = 0;
    let mul = 1;
    for (let i = 0; i < 5; i++) {
      if (pos >= buf.length) throw new Error("the macaroon is cut short");
      const b = buf[pos++]!;
      n += (b & 0x7f) * mul;
      if (b < 0x80) return n;
      mul *= 128;
    }
    throw new Error("a length in the macaroon is too long");
  };
  const bytes = (n: number) => {
    if (n > buf.length - pos) throw new Error("the macaroon is cut short");
    const out = buf.subarray(pos, pos + n);
    pos += n;
    return out;
  };
  const section = () => {
    const fields = new Map<number, Uint8Array>();
    let last = 0;
    for (;;) {
      const type = uvarint();
      if (type === FIELD_EOS) return fields;
      if (type <= last || (type !== FIELD_LOCATION && type !== FIELD_IDENTIFIER && type !== FIELD_VID)) throw new Error("the macaroon's fields are out of order");
      last = type;
      fields.set(type, bytes(uvarint()));
    }
  };
  const head = section();
  const id = head.get(FIELD_IDENTIFIER);
  if (!id) throw new Error("the macaroon has no identifier");
  const caveats: string[] = [];
  for (;;) {
    const s = section();
    if (s.size === 0) break;
    if (caveats.length >= 64) throw new Error("the macaroon has too many caveats");
    const cid = s.get(FIELD_IDENTIFIER);
    if (!cid) throw new Error("a caveat has no identifier");
    // A third-party caveat (a verification id) is never strut's: the
    // server would refuse the token, so the challenge is junk.
    if (s.has(FIELD_VID)) throw new Error("the macaroon carries a third-party caveat");
    caveats.push(new TextDecoder().decode(cid));
  }
  if (uvarint() !== FIELD_SIGNATURE || bytes(uvarint()).length !== 32 || pos !== buf.length) throw new Error("the macaroon's signature is malformed");
  // L402's identifier: version 0 (two bytes), the payment hash, a token id.
  if (id.length !== 66 || id[0] !== 0 || id[1] !== 0) throw new Error("the macaroon's identifier is not an L402 one");
  return { paymentHash: hex(id.subarray(2, 34)), tokenId: hex(id.subarray(34, 66)), caveats };
}

/** One caveat's value (`strut_sats=…` → its value), the first that names it. */
function caveat(m: ReadMacaroon, key: string): string | undefined {
  const c = m.caveats.find((x) => x.startsWith(`${key}=`));
  return c?.slice(key.length + 1);
}

/** A challenge that checked out: the invoice as decoded, and what its
 *  payment proves. */
export interface CheckedChallenge {
  invoice: DecodedInvoice;
  paymentHash: string;
  msat: number;
  /** Unix seconds: when the invoice ends. */
  expiresAt: number;
}

/** Hold a challenge to what a strut server writes (above): its checked
 *  facts, or why it is junk — a sentence a page can show. `nowMs` is the
 *  clock. */
export function checkChallenge(p: PaymentRequired, nowMs = Date.now()): { ok: true; checked: CheckedChallenge } | { ok: false; error: string } {
  const junk = (why: string) => ({ ok: false as const, error: `the server's payment request does not check out: ${why}, so nothing was paid` });
  let invoice: DecodedInvoice;
  try {
    invoice = decodeBolt11(p.invoice);
  } catch (err) {
    return junk(err instanceof Bolt11Error ? `its invoice is not one (${err.message})` : "its invoice is not one");
  }
  let mac: ReadMacaroon;
  try {
    mac = readMacaroon(p.macaroon);
  } catch (err) {
    return junk(err instanceof Error ? err.message : "its macaroon is not one");
  }
  if (mac.paymentHash !== invoice.paymentHash) return junk("the invoice and the macaroon name different payments");
  if (invoice.msat === undefined) return junk("the invoice names no amount");
  if (!Number.isSafeInteger(p.sats) || p.sats <= 0) return junk("it names no price in sats");
  if (invoice.msat !== p.sats * 1000) return junk(`the invoice asks ${invoice.msat / 1000} sats, not the ${p.sats} it says`);
  if (caveat(mac, "strut_sats") !== String(p.sats)) return junk("the macaroon was minted for another amount");
  const credit = Number(caveat(mac, "strut_credit"));
  if (!Number.isFinite(p.usd) || p.usd < 0 || !Number.isFinite(credit) || Math.abs(credit - Math.round(p.usd * 1_000_000)) > 1) {
    return junk("the macaroon was minted for another amount of credit");
  }
  if (invoice.expiresAt * 1000 <= nowMs) return junk("its invoice has already ended");
  return { ok: true, checked: { invoice, paymentHash: invoice.paymentHash, msat: invoice.msat, expiresAt: invoice.expiresAt } };
}
