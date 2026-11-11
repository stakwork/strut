/**
 * CREDIT (plans/paid-runs.md §4, §5; work item 5): what a buyer pays for and
 * spends at the public door. The bytes and the rules are `src/l402.ts`; this
 * asks the wallet, the rate and the ledger. One service, `createCredit`,
 * which the `/public` routes call and the later items reuse (a priced tool,
 * item 6; the MCP tools, item 8):
 *
 * - **`verify`** — §4.3 steps 1 to 3, local: decode, recompute the chain
 *   under the token's root key, the preimage, the caveats read whole. No
 *   wallet, no ledger. A route checks the request's own conditions next
 *   (`tokenRefusal`: the item, the reserve, the end).
 * - **`use`** — §4.3 step 4: the ledger knows the token, or this is its
 *   FIRST USE: the wallet is asked for the invoice by payment hash, which
 *   must be settled, and the token is written with its payment — credited
 *   `strut_credit` in proportion to what SETTLED of `strut_sats`, and
 *   inheriting from `strut_carry` (the ledger's `firstUse`). The wallet is
 *   asked once per token: concurrent first uses share one lookup. A wallet
 *   that cannot be reached is 503, never 402.
 * - **`challenge`** — §4.1: a 402 for an amount of dollars. Its own
 *   per-address allowance (an invoice costs the wallet a record until it
 *   expires), then the rate (read now, kept a minute; 503 when there is
 *   none, never a stale sale), the sats rounded up, an invoice of ten
 *   minutes, and a macaroon that LOCKS the quote: `strut_sats` and
 *   `strut_credit`. Nothing is stored per challenge.
 * - **`view`** — what `GET /public/credit` answers: paid, spent, set aside,
 *   remaining in dollars and in sats at the token's own rate, its end, the
 *   newest 50 entries.
 * - **`claim`** — §4.4: a payer with no preimage (a phone wallet paying a
 *   QR) polls with the macaroon alone; once the wallet says settled the
 *   answer carries the preimage, and the token's first use is recorded then.
 */
import { createHash } from "node:crypto";
import type { LightningCapability, InvoiceLookup } from "./payments/lightning.js";
import { isLightningError } from "./payments/lightning.js";
import type { ExchangeRate, Rate } from "./payments/rate.js";
import { isRateUnavailable, satsForUsd } from "./payments/rate.js";
import type { PaymentsSettings } from "./payments/settings.js";
import { CREDIT_LIFETIME_MS, LedgerError, microsToUsd, usdToMicros, type LedgerEntry, type LedgerStore, type Micros, type TokenBalance } from "./payments/ledger.js";
import { L402Error, macaroonToBase64, mintToken, verifyToken, type Presented, type VerifiedToken } from "./l402.js";

/** A priced invoice lasts ten minutes, not the wallet's hour, so a quote is
 *  not an option on the bitcoin price (§4.1). */
export const PRICED_INVOICE_SECS = 10 * 60;
/** Invoices one visitor address may have minted in a minute. */
export const PUBLIC_INVOICES_PER_MINUTE = 20;
/** Claims one visitor address may make in a minute: a page polling every
 *  couple of seconds, and room to spare. Each asks the wallet. */
export const PUBLIC_CLAIMS_PER_MINUTE = 120;
/** The most `POST /public/credit` sells at once, in dollars. */
export const CREDIT_PURCHASE_MAX_USD = 1000;
/** The least, in dollars: a cent. */
export const CREDIT_PURCHASE_MIN_USD = 0.01;
const SATS_PER_BTC = 100_000_000;

/** A refusal a route answers as it is. */
export interface CreditRefusal {
  ok: false;
  status: 400 | 401 | 429 | 503;
  /** `invalid_token`, `payment_pending`, `wallet_unavailable`,
   *  `rate_unavailable`, `too_many_invoices`, `too_many_claims`. */
  code: string;
  error: string;
  retryAfter?: number;
}

export interface UsedToken {
  ok: true;
  token: VerifiedToken;
  balance: TokenBalance;
  /** This request was the token's first use. */
  created: boolean;
}

/** The 402 (§4.1): `WWW-Authenticate` and the body that repeats it. */
export interface Challenge {
  ok: true;
  header: string;
  body: {
    error: "payment_required";
    usd: number;
    sats: number;
    rate: ExchangeRate;
    invoice: string;
    macaroon: string;
    description: string;
    /** When the invoice ends, ISO. */
    expires: string;
    /** What the presented token has free, in dollars (0 with none). */
    remaining_usd: number;
    /** Why a presented token did not do: `short`, `expired`, `replaced`. */
    reason?: string;
    /** The new token inherits the presented one's free credit (§4.5). */
    carries?: boolean;
  };
}

/** What `GET /public/credit` answers. Dollars, and sats at the token's rate. */
export interface CreditView {
  token: string;
  /** Credit in: its payment and what it inherited. */
  paid_usd: number;
  /** Credit out: its charges, and what it handed on or lost to its end. */
  spent_usd: number;
  /** Set aside for its runs in flight. */
  held_usd: number;
  /** What a launch may set aside now: 0 once replaced or past its end. */
  remaining_usd: number;
  remaining_sats: number;
  /** Dollars per bitcoin it was bought at. */
  rate: number;
  /** What its invoice settled for. */
  bought_sats: number;
  created: string;
  expires: string;
  /** Its end passed, or the sweep closed it. */
  expired: boolean;
  /** Its credit moved to a newer token (§4.5). */
  replaced: boolean;
  entries: Array<Record<string, unknown>>;
}

export type ClaimView =
  | { ok: true; state: "pending"; expires?: string }
  | { ok: true; state: "expired" }
  | { ok: true; state: "settled"; preimage: string; credential: string; msat?: number };

export interface CreditDeps {
  ledger(): Promise<LedgerStore>;
  settings: Pick<PaymentsSettings, "l402Root" | "ensureL402Root">;
  rate: Rate;
  /** The wallet's receive side now, or null with none. */
  lightning(): LightningCapability | null;
  now?: () => number;
  invoicesPerMinute?: number;
  claimsPerMinute?: number;
}

export interface Credit {
  verify(p: Presented, o?: { requirePreimage?: boolean }): Promise<{ ok: true; token: VerifiedToken } | CreditRefusal>;
  use(token: VerifiedToken): Promise<UsedToken | CreditRefusal>;
  /** `verify` then `use`. */
  check(p: Presented): Promise<UsedToken | CreditRefusal>;
  /** A 402 for `usd` of credit (micro-dollars), or for `sats` (the credit
   *  is what they buy at the rate now). */
  challenge(o: ({ usd: Micros; sats?: undefined } | { sats: number; usd?: undefined }) & { description: string; address: string; carry?: string; remaining?: Micros; reason?: string }): Promise<Challenge | CreditRefusal>;
  /** `entries: false` leaves the newest 50 out. */
  view(tokenId: string, o?: { entries?: boolean }): Promise<CreditView | undefined>;
  claim(p: Presented, address: string): Promise<ClaimView | CreditRefusal>;
  /** The server has a wallet to sell credit with now. */
  canSell(): boolean;
  /** The server ever sold credit: `L402_ROOT` is on file. Without it no
   *  token verifies, and the credit routes have nothing to answer. */
  selling(): Promise<boolean>;
}

const refuse = (status: CreditRefusal["status"], code: string, error: string, retryAfter?: number): CreditRefusal => ({
  ok: false,
  status,
  code,
  error: error.startsWith(`${code}:`) ? error : `${code}: ${error}`,
  ...(retryAfter !== undefined ? { retryAfter } : {}),
});

/** A wallet's failure as the route answers it: a 503 unless the wallet
 *  knows no such invoice, which no token of this server's can name. */
function walletRefusal(err: unknown): CreditRefusal {
  if (isLightningError(err) && err.code === "invoice_unknown") return refuse(401, "invalid_token", "this server's wallet has no invoice for this token");
  const why = err instanceof Error ? err.message : String(err);
  return refuse(503, "wallet_unavailable", `the server's wallet cannot be asked just now (${why.replace(/^wallet_unavailable: /, "")})`, 30);
}

/** A per-address allowance per minute. */
function allowance(perMinute: number, now: () => number) {
  const counts = new Map<string, { minute: number; n: number }>();
  return (who: string): boolean => {
    const minute = Math.floor(now() / 60_000);
    const at = counts.get(who);
    if (!at || at.minute !== minute) {
      if (counts.size > 10_000) for (const [k, v] of counts) if (v.minute !== minute) counts.delete(k);
      counts.set(who, { minute, n: 1 });
      return true;
    }
    return ++at.n <= perMinute;
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const satsAt = (micros: Micros, rate: number) => (micros > 0 && rate > 0 ? Math.floor((microsToUsd(micros) / rate) * SATS_PER_BTC) : 0);

/** A ledger entry as its token's holder reads it: dollars, no other token. */
function entryView(e: LedgerEntry): Record<string, unknown> {
  return {
    seq: e.seq,
    at: iso(e.at),
    kind: e.kind,
    ...(e.usd !== undefined ? { usd: microsToUsd(e.usd) } : {}),
    ...(e.msat !== undefined ? { msat: e.msat } : {}),
    ...(e.subject ? { subject: e.subject } : {}),
    ...(e.runId ? { runId: e.runId } : {}),
    ...(e.key ? { key: e.key } : {}),
    ...(e.cost !== undefined ? { cost_usd: microsToUsd(e.cost) } : {}),
    ...(e.outcome ? { outcome: e.outcome } : {}),
    ...(e.kind === "payment" && e.ref ? { payment_hash: e.ref } : {}),
  };
}

export function createCredit(deps: CreditDeps): Credit {
  const now = deps.now ?? Date.now;
  const invoiceOk = allowance(deps.invoicesPerMinute ?? PUBLIC_INVOICES_PER_MINUTE, now);
  const claimOk = allowance(deps.claimsPerMinute ?? PUBLIC_CLAIMS_PER_MINUTE, now);
  /** A token's first use in flight: concurrent requests share it, so the
   *  wallet is asked once. */
  const firstUses = new Map<string, Promise<UsedToken | CreditRefusal>>();

  const verify: Credit["verify"] = async (p, o = {}) => {
    const root = await deps.settings.l402Root();
    if (!root) return refuse(401, "invalid_token", "this server has sold no credit: no token verifies here");
    try {
      return { ok: true, token: verifyToken(p, root, o) };
    } catch (err) {
      if (err instanceof L402Error) return refuse(401, "invalid_token", err.message);
      throw err;
    }
  };

  /** Write the token from what the wallet said: settled, credited in
   *  proportion to what settled. */
  const record = async (t: VerifiedToken, found: InvoiceLookup): Promise<UsedToken | CreditRefusal> => {
    if (found.state === "pending") return refuse(503, "payment_pending", "the wallet has not settled this token's invoice yet — try again in a moment", 2);
    if (found.state !== "settled") return refuse(401, "invalid_token", "this token's invoice expired unpaid");
    const ledger = await deps.ledger();
    const askedMsat = t.quote.sats * 1000;
    try {
      const got = await ledger.firstUse({
        id: t.tokenId,
        paymentHash: t.paymentHash,
        askedMsat,
        // A settled invoice names what settled; one that does not is taken
        // to have settled in full.
        settledMsat: found.msat !== undefined && found.msat > 0 ? found.msat : askedMsat,
        credit: t.quote.credit,
        // The quote's own rate: dollars per bitcoin the locked sats bought.
        rate: (microsToUsd(t.quote.credit) / t.quote.sats) * SATS_PER_BTC,
        expires: t.quote.validUntil * 1000,
        ...(t.quote.carry ? { carryFrom: t.quote.carry } : {}),
        at: now(),
      });
      return { ok: true, token: t, balance: got.token, created: got.created };
    } catch (err) {
      if (err instanceof LedgerError && err.code === "payment_reused") return refuse(401, "invalid_token", "this token's payment bought another token");
      throw err;
    }
  };

  const use: Credit["use"] = async (t) => {
    // Before anything is awaited: requests for one token at once share one
    // read of the ledger, and one question to the wallet.
    const inFlight = firstUses.get(t.tokenId);
    if (inFlight) {
      // Its own copy of the token: a holder's caveats are this request's.
      const r = await inFlight;
      return r.ok ? { ...r, token: t, created: false } : r;
    }
    const p = (async (): Promise<UsedToken | CreditRefusal> => {
      const known = await (await deps.ledger()).token(t.tokenId);
      if (known) return { ok: true, token: t, balance: known, created: false };
      const lightning = deps.lightning();
      if (!lightning) return refuse(503, "wallet_unavailable", "this server has no wallet to ask whether the token was paid", 60);
      let found: InvoiceLookup;
      try {
        found = await lightning.lookup(t.paymentHash);
      } catch (err) {
        return walletRefusal(err);
      }
      return record(t, found);
    })().finally(() => firstUses.delete(t.tokenId));
    firstUses.set(t.tokenId, p);
    return p;
  };

  const challenge: Credit["challenge"] = async (o) => {
    const lightning = deps.lightning();
    if (!lightning) return refuse(503, "wallet_unavailable", "this server has no wallet to take a payment", 60);
    if (!invoiceOk(o.address)) return refuse(429, "too_many_invoices", `too many invoices: ${deps.invoicesPerMinute ?? PUBLIC_INVOICES_PER_MINUTE} a minute`, 60);
    let rate: ExchangeRate;
    try {
      rate = await deps.rate.read();
    } catch (err) {
      if (isRateUnavailable(err)) return refuse(503, "rate_unavailable", err.message, 60);
      throw err;
    }
    let usd: Micros;
    let sats: number;
    if (o.sats !== undefined) {
      sats = o.sats;
      usd = Math.floor((sats / SATS_PER_BTC) * rate.usdPerBtc * 1_000_000);
      if (usd < usdToMicros(CREDIT_PURCHASE_MIN_USD) || usd > usdToMicros(CREDIT_PURCHASE_MAX_USD)) {
        return refuse(400, "bad_amount", `${sats} sats is $${microsToUsd(usd)} at the rate now: credit is sold from $${CREDIT_PURCHASE_MIN_USD} to $${CREDIT_PURCHASE_MAX_USD}`);
      }
    } else {
      usd = Math.max(1, Math.round(o.usd));
      sats = Math.max(1, satsForUsd(microsToUsd(usd), rate));
    }
    const root = await deps.settings.ensureL402Root();
    let invoice: { invoice: string; payment_hash: string; expires: string };
    try {
      invoice = await lightning.makeInvoice({ msat: sats * 1000, description: o.description, expirySecs: PRICED_INVOICE_SECS });
    } catch (err) {
      return walletRefusal(err);
    }
    // A year from the purchase (decision 18): from the end of the invoice,
    // so a token bought at the last moment still has its year.
    const validUntil = Math.floor((now() + CREDIT_LIFETIME_MS) / 1000) + PRICED_INVOICE_SECS;
    const { macaroon } = mintToken(root, { paymentHash: invoice.payment_hash, quote: { sats, credit: usd, validUntil, ...(o.carry ? { carry: o.carry } : {}) } });
    const b64 = macaroonToBase64(macaroon);
    return {
      ok: true,
      header: `L402 macaroon="${b64}", invoice="${invoice.invoice}"`,
      body: {
        error: "payment_required",
        usd: microsToUsd(usd),
        sats,
        rate,
        invoice: invoice.invoice,
        macaroon: b64,
        description: o.description,
        expires: invoice.expires,
        remaining_usd: microsToUsd(Math.max(0, o.remaining ?? 0)),
        ...(o.reason ? { reason: o.reason } : {}),
        ...(o.carry ? { carries: true } : {}),
      },
    };
  };

  const view: Credit["view"] = async (tokenId, vo = {}) => {
    const ledger = await deps.ledger();
    const b = await ledger.token(tokenId);
    if (!b) return undefined;
    const expired = b.closed !== undefined || b.expires <= now();
    const replaced = b.successor !== undefined;
    const remaining = expired || replaced ? 0 : Math.max(0, b.free);
    return {
      token: b.id,
      paid_usd: microsToUsd(b.paid),
      spent_usd: microsToUsd(b.spent),
      held_usd: microsToUsd(b.held),
      remaining_usd: microsToUsd(remaining),
      remaining_sats: satsAt(remaining, b.rate),
      rate: b.rate,
      bought_sats: Math.floor(b.msat / 1000),
      created: iso(b.created),
      expires: iso(b.expires),
      expired,
      replaced,
      entries: vo.entries === false ? [] : (await ledger.entries(tokenId)).map(entryView),
    };
  };

  const claim: Credit["claim"] = async (p, address) => {
    if (!claimOk(address)) return refuse(429, "too_many_claims", `too many claims: ${deps.claimsPerMinute ?? PUBLIC_CLAIMS_PER_MINUTE} a minute`, 30);
    const v = await verify(p, { requirePreimage: false });
    if (!v.ok) return v;
    const lightning = deps.lightning();
    if (!lightning) return refuse(503, "wallet_unavailable", "this server has no wallet to ask", 60);
    let found: InvoiceLookup;
    try {
      found = await lightning.lookup(v.token.paymentHash);
    } catch (err) {
      // An invoice the wallet forgot (long expired) is expired.
      if (isLightningError(err) && err.code === "invoice_unknown") return { ok: true, state: "expired" };
      return walletRefusal(err);
    }
    if (found.state === "pending") return { ok: true, state: "pending" };
    if (found.state === "expired") return { ok: true, state: "expired" };
    const preimage = found.preimage?.toLowerCase();
    if (!preimage || createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex") !== v.token.paymentHash) {
      return refuse(503, "wallet_unavailable", "the wallet says the invoice settled but gave no preimage that matches it", 30);
    }
    // The token's first use, from this very answer: the wallet is not asked again.
    const known = await (await deps.ledger()).token(v.token.tokenId);
    if (!known) {
      const used = await record({ ...v.token, preimage }, found);
      if (!used.ok) return used;
    }
    return { ok: true, state: "settled", preimage, credential: `${p.macaroon}:${preimage}`, ...(found.msat !== undefined ? { msat: found.msat } : {}) };
  };

  return {
    verify,
    use,
    check: async (p) => {
      const v = await verify(p);
      return v.ok ? use(v.token) : v;
    },
    challenge,
    view,
    claim,
    canSell: () => deps.lightning() !== null,
    selling: async () => (await deps.settings.l402Root()) !== null,
  };
}
