/**
 * The server's WALLET as steps and strut's own code see it
 * (plans/paid-runs.md §9; the receive half of plans/app-payments.md §6):
 * make an invoice, look one up, list what came in, read the balance.
 *
 * Nothing here moves a sat out. Paying is the payer's (item 7 of the plan),
 * built from a PAY credential that never reaches this capability, the
 * services bag or a step. A provider holds only what lets it RECEIVE.
 *
 * Providers: the Sphinx daemon (`sphinx-daemon.ts`), NWC, and a fake for
 * tests (`fake-wallet.ts`). Each answers the provider interface below; what
 * goes on the bag is `lightningCapability(provider)`: the four methods,
 * checked, frozen, and nothing else reachable through it.
 */

/** An invoice the wallet made. `expires` is ISO 8601. */
export interface Invoice {
  /** BOLT11. */
  invoice: string;
  /** hex, 64 characters. */
  payment_hash: string;
  expires: string;
}

export type InvoiceState = "pending" | "settled" | "expired";

/** What the wallet knows of one invoice. `msat` is what SETTLED (a short
 *  payment settles for less than the invoice asked); `preimage` only once
 *  settled. */
export interface InvoiceLookup {
  state: InvoiceState;
  msat?: number;
  /** ISO 8601. */
  settled_at?: string;
  /** hex. */
  preimage?: string;
}

/** A payment that came in. `at` is ISO 8601, when it settled. */
export interface ReceivedPayment {
  payment_hash: string;
  msat: number;
  at: string;
}

/** `ctx.services.lightning`: the plan's §9 interface, exactly. */
export interface LightningCapability {
  makeInvoice(o: { msat: number; description?: string; expirySecs?: number }): Promise<Invoice>;
  lookup(payment_hash: string): Promise<InvoiceLookup>;
  /** Settled payments, oldest first, settled at or after `since` (ISO). */
  received(o: { since?: string; limit?: number }): Promise<ReceivedPayment[]>;
  balance(): Promise<{ msat: number }>;
}

/** What a provider is: the same four methods. A provider may hold more
 *  (its own state, a test's controls); `lightningCapability` hands out the
 *  four and nothing else. */
export type LightningProvider = LightningCapability;

/** Why a wallet call failed, for a caller that answers for it:
 *  - `wallet_unavailable`: the wallet could not be reached, timed out, or
 *    failed on its side (a 5xx). Item 5 answers 503, never 402.
 *  - `wallet_unauthorized`: the wallet refused the credential.
 *  - `wallet_refused`: the wallet refused the request (a 4xx), its own words.
 *  - `invoice_unknown`: no invoice with that payment hash.
 *  - `wallet_bad_answer`: an answer that is not the shape the provider reads.
 *  - `bad_request`: the call itself is wrong (a negative amount), before
 *    anything is sent. */
export type LightningErrorCode =
  | "wallet_unavailable"
  | "wallet_unauthorized"
  | "wallet_refused"
  | "invoice_unknown"
  | "wallet_bad_answer"
  | "bad_request";

/** Every failure a provider reports. The message starts with the code
 *  (`wallet_unavailable: …`), strut's convention for an error a caller
 *  classifies. */
export class LightningError extends Error {
  readonly code: LightningErrorCode;
  constructor(code: LightningErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "LightningError";
    this.code = code;
  }
}

export const isLightningError = (err: unknown): err is LightningError => err instanceof LightningError;

/** The longest an invoice may last: a day. The plan's priced invoices last
 *  ten minutes; a wallet's default is an hour. */
export const MAX_EXPIRY_SECS = 24 * 60 * 60;
/** The most `received` lists at once. */
export const MAX_RECEIVED = 1000;
/** A description longer than BOLT11's field holds (639 bytes) is refused. */
export const MAX_DESCRIPTION_BYTES = 639;

const HASH = /^[0-9a-f]{64}$/;

/** The payment hash, lowercased, or a `bad_request`. */
export function checkPaymentHash(payment_hash: unknown): string {
  const h = typeof payment_hash === "string" ? payment_hash.trim().toLowerCase() : "";
  if (!HASH.test(h)) throw new LightningError("bad_request", "payment_hash must be 64 hex characters");
  return h;
}

function checkInvoiceRequest(o: unknown): { msat: number; description?: string; expirySecs?: number } {
  if (!o || typeof o !== "object") throw new LightningError("bad_request", "makeInvoice takes { msat, description?, expirySecs? }");
  const { msat, description, expirySecs } = o as Record<string, unknown>;
  if (typeof msat !== "number" || !Number.isSafeInteger(msat) || msat <= 0) {
    throw new LightningError("bad_request", "msat must be a whole number above 0");
  }
  if (description !== undefined && typeof description !== "string") throw new LightningError("bad_request", "description must be a string");
  if (typeof description === "string" && Buffer.byteLength(description, "utf8") > MAX_DESCRIPTION_BYTES) {
    throw new LightningError("bad_request", `description is over ${MAX_DESCRIPTION_BYTES} bytes`);
  }
  if (expirySecs !== undefined && (typeof expirySecs !== "number" || !Number.isSafeInteger(expirySecs) || expirySecs <= 0 || expirySecs > MAX_EXPIRY_SECS)) {
    throw new LightningError("bad_request", `expirySecs must be a whole number of seconds from 1 to ${MAX_EXPIRY_SECS}`);
  }
  return { msat, ...(description !== undefined ? { description } : {}), ...(expirySecs !== undefined ? { expirySecs } : {}) };
}

function checkReceivedRequest(o: unknown): { since?: string; limit?: number } {
  const { since, limit } = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
  if (since !== undefined && (typeof since !== "string" || Number.isNaN(Date.parse(since)))) {
    throw new LightningError("bad_request", "since must be an ISO 8601 time");
  }
  if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0)) {
    throw new LightningError("bad_request", "limit must be a whole number above 0");
  }
  return {
    ...(since !== undefined ? { since: new Date(since as string).toISOString() } : {}),
    limit: Math.min((limit as number | undefined) ?? 100, MAX_RECEIVED),
  };
}

/** What goes on the services bag: the provider's four methods behind the
 *  checks above, frozen. Nothing of the provider (its URL, its token, a
 *  test's controls) is reachable through it. */
export function lightningCapability(provider: LightningProvider): LightningCapability {
  return Object.freeze({
    makeInvoice: (o: { msat: number; description?: string; expirySecs?: number }) =>
      Promise.resolve().then(() => provider.makeInvoice(checkInvoiceRequest(o))),
    lookup: (payment_hash: string) => Promise.resolve().then(() => provider.lookup(checkPaymentHash(payment_hash))),
    received: (o: { since?: string; limit?: number }) => Promise.resolve().then(() => provider.received(checkReceivedRequest(o))),
    balance: () => Promise.resolve().then(() => provider.balance()),
  });
}
