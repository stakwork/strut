/**
 * A strut that BUYS (plans/paid-runs.md §10 "Another strut", work item 9):
 * the CVE case — an hourly automation that runs a workflow another strut
 * sells, through that strut's public door, with no peer record.
 *
 * - The SELLER is a base URL (`https://cve.example`, or a strut under a
 *   path, `https://swarm.example:3355/lab`), https only: the credit held
 *   there is a bearer credential. Everything strut asks of it goes through
 *   the guarded http (src/guarded-http.ts): no loopback, private or
 *   metadata address, credentials dropped on a redirect to another origin.
 * - The CREDIT this strut holds there is one L402 token (§4), kept in
 *   `entitlements.json` — an encrypted `FileSecretStore` file of its own
 *   beside `payments.json` and `peers.json` (the file plans/marketplace.md
 *   §6 reserves), one entry per seller, `ENTITLEMENT_<sha256(seller)>` →
 *   the record as JSON. Never `secrets.json`, and readable by no step: the
 *   secrets capability answers nothing for an `ENTITLEMENT_` name wherever it
 *   is set (env.ts `hiddenFromSteps`), and what a step gets is
 *   `ctx.services.remote`, which makes a request with the credential
 *   injected and never hands it out — the peers capability's rule.
 * - SPENDING within the credit needs no ask (decision 16): `remote/list`,
 *   `remote/run-workflow`, `remote/call` present it as
 *   `Authorization: L402 <macaroon>:<preimage>`. With none, or too little,
 *   the step fails saying what the seller asks (the 402's price). It never
 *   pays.
 * - BUYING is `remote/buy-credit { url, usd }`, a proposal an ADMIN
 *   accepted (`approver: "admin"`). Its door (`buyCredit`) opens only for
 *   the accepted record on disk, as `package/install`'s does. It asks the
 *   seller for the credit (`POST /public/credit { usd }`, presenting the
 *   token held so the new one inherits it, §4.5), checks the challenge
 *   (the invoice and the macaroon name one payment; the macaroon buys the
 *   dollars asked; the sats are within `QUOTE_TOLERANCE` of this server's
 *   own rate), keeps the PURCHASE on file, then pays through item 7's
 *   withdrawals service (`purpose: "purchase"`): one payment per payment
 *   hash, its pending handling, its payer, one entry in the books.
 * - A purchase ends with the token stored, whether the payment settled at
 *   once or later: `check()` (every minute, and at boot) claims it from the
 *   seller (`POST /public/credit/claim`) until it settles or the invoice
 *   ends. It never pays: a purchase the payer never sent ends with the
 *   invoice. A retry of the same proposal reuses the purchase's invoice, so
 *   a purchase is never paid twice. A token is stored only when its
 *   preimage hashes to its payment hash. One purchase per seller at a time:
 *   two would each inherit the same credit, and the second token stored
 *   would drop the first.
 * - A remote RUN's token (the seller's receipt, §3) is kept in the seller's
 *   record while a step waits on it, never in the run log, and let go when
 *   the step ends.
 */

import { createHash } from "node:crypto";
import type { HttpCapability, HttpResponse } from "./capabilities.js";
import type { SecretStore } from "./secret-store.js";
import type { Proposal } from "./proposals.js";
import { decodeBolt11, Bolt11Error } from "./payments/bolt11.js";
import { decodeIdentifier, L402Error, macaroonFromBase64, readCaveats } from "./l402.js";
import { microsToUsd, usdToMicros } from "./payments/ledger.js";
import { satsForUsd, type ExchangeRate } from "./payments/rate.js";
import type { WithdrawAnswer } from "./payments/withdrawals.js";

/** The file, under the data directory, beside `payments.json`. */
export const ENTITLEMENTS_FILE = "entitlements.json";
/** Every name in it starts so; the secrets capability answers nothing for
 *  one (env.ts `HIDDEN_FROM_STEPS_PREFIXES`). */
export const ENTITLEMENT_PREFIX = "ENTITLEMENT_";
/** How often `start()` claims the purchases still out. */
export const PURCHASE_CHECK_MS = 60_000;
/** How long one read of a remote run waits there (the seller holds ≤ 55 s). */
export const RUN_READ_WAIT_S = 25;
/** One request to a seller, at most (a read waits `RUN_READ_WAIT_S` there). */
export const REMOTE_REQUEST_TIMEOUT_MS = 40_000;
/** A tool call, at most: the seller stops one at 60 s. */
export const REMOTE_CALL_TIMEOUT_MS = 90_000;
/** A seller's sats for the dollars asked may be this much over this
 *  server's own rate, no more (the two read different sources). */
export const QUOTE_TOLERANCE = 0.1;
/** Reads of a remote run that fail in a row before the step gives up. */
export const RUN_READ_FAILURES_MAX = 6;
/** A remote run's token is kept this long at most: a step that never let
 *  go of one (it failed while the run went on) cannot resume it later
 *  than boot's auto-resume would (7 days). */
export const RUN_TOKEN_KEEP_MS = 7 * 24 * 60 * 60_000;

// ── errors ──────────────────────────────────────────────────────────────

export type RemoteErrorCode =
  | "bad_url"
  | "payment_required"
  | "token_refused"
  | "remote_refused"
  | "remote_unavailable"
  | "not_found"
  | "run_unknown"
  | "buy_needs_person"
  | "no_pay_credential"
  | "purchase_in_flight"
  | "bad_challenge"
  | "quote_too_high"
  | "payment_failed"
  | "not_selling";

/** What the seller asked, on a 402. */
export interface SellerPrice {
  usd: number;
  sats: number;
  reason?: string;
  remaining_usd?: number;
}

export class RemoteError extends Error {
  constructor(
    readonly code: RemoteErrorCode,
    message: string,
    readonly detail: { status?: number; retryAfter?: number; price?: SellerPrice } = {},
  ) {
    super(message.startsWith(`${code}: `) ? message : `${code}: ${message}`);
    this.name = "RemoteError";
  }
}

// ── the seller ──────────────────────────────────────────────────────────

/** A seller's base URL from what a person or a model wrote: https, no
 *  credentials, no query, no trailing `/` or `/public`. Its origin is
 *  lower-cased and its default port dropped, so one seller is one record. */
export function sellerOf(raw: string): string {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new RemoteError("bad_url", `${JSON.stringify(String(raw).slice(0, 200))} is not a URL: name the seller's strut server, https://…`);
  }
  if (u.protocol !== "https:") throw new RemoteError("bad_url", `${u.origin} is not https: the credit this strut server holds at a seller is a bearer credential, sent over https only`);
  if (u.username || u.password) throw new RemoteError("bad_url", "a seller's URL carries no credentials");
  let path = u.pathname.replace(/\/+$/, "");
  if (path.endsWith("/public")) path = path.slice(0, -"/public".length);
  return `${u.origin}${path}`;
}

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const keyOf = (seller: string) => `${ENTITLEMENT_PREFIX}${sha256(seller)}`;
const enc = (s: string) => encodeURIComponent(s);
/** A step type in a URL: each segment encoded, the slashes kept (the
 *  public tool route matches `:type{.+}`). */
const typePath = (type: string) => type.split("/").map(enc).join("/");

/** Dollars for a sentence. */
export function usdText(n: number): string {
  if (!Number.isFinite(n)) return "$?";
  return n === 0 || Math.abs(n) >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toPrecision(2)}`;
}

// ── the record ──────────────────────────────────────────────────────────

/** The credit this strut holds at a seller: one L402 token. */
export interface HeldCredit {
  macaroon: string;
  preimage: string;
  tokenId: string;
  paymentHash: string;
  boughtAt: string;
  /** What this token's purchase bought, before what it inherited. */
  usd: number;
  sats: number;
  /** When its credit ends (the macaroon's `strut_valid_until`). */
  expires: string;
  /** It inherits the token held before it (§4.5). */
  carried?: string;
  proposal?: string;
}

/** A purchase asked for and not yet stored. */
export interface Purchase {
  proposal: string;
  actor?: string;
  usd: number;
  sats: number;
  msat: number;
  invoice: string;
  macaroon: string;
  paymentHash: string;
  tokenId: string;
  /** Unix seconds, when the invoice expires. */
  invoiceExpiresAt: number;
  /** Unix seconds, when the credit ends. */
  validUntil: number;
  /** The seller said the new token inherits the one presented. */
  carries: boolean;
  /** Epoch ms, when it was asked for. */
  at: number;
  /** The payer was asked (and may have sent it). */
  sent?: boolean;
  checkedAt?: number;
  lastError?: string;
}

export interface SellerRecord {
  seller: string;
  credit?: HeldCredit;
  purchase?: Purchase;
  /** A remote run's token while a step waits on it, by `<workflow>\n<runId>`;
   *  `at` epoch ms, when it was launched. */
  runs?: Record<string, { token: string; at: number }>;
}

// ── the capability ──────────────────────────────────────────────────────

/** A runnable item as a seller lists it (`GET /public`'s `runnable`). */
export interface RemoteRunnable {
  kind: "workflow" | "step";
  name: string;
  description?: string;
  base: number;
  markup: number;
  capUsd: number | null;
  reserve: number;
  results?: string;
  input?: unknown;
  recent?: { days: number; runs: number; average: number };
}

/** What this strut holds at a seller, as a step may see it: never the token. */
export interface RemoteCredit {
  seller: string;
  held: boolean;
  remaining_usd?: number;
  remaining_sats?: number;
  held_usd?: number;
  spent_usd?: number;
  paid_usd?: number;
  expires?: string;
  expired?: boolean;
  replaced?: boolean;
  /** The seller could not be asked, or refused the token. */
  error?: string;
  /** A purchase is on its way. */
  buying?: { usd: number; at: string };
}

export interface RemoteListing {
  seller: string;
  runnable: RemoteRunnable[];
  credit: RemoteCredit;
}

/** A run launched on a seller. No token: the capability keeps it. */
export interface RemoteRunHandle {
  seller: string;
  workflow: string;
  runId: string;
  existing?: boolean;
  /** On a priced launch: what was set aside and what is left. */
  credit?: { held_usd?: number; remaining_usd?: number; remaining_sats?: number; expires?: string };
}

/** The launcher's view of a remote run (§17.4), as far as the seller shows it. */
export interface RemoteRunView {
  status: string;
  output?: unknown;
  error?: { message: string };
  /** Dollars, once it ended and was charged. */
  charged?: number;
  durationMs?: number;
  totals?: unknown;
}

export interface BuyCreditResult {
  seller: string;
  usd: number;
  sats: number;
  paymentHash: string;
  /** `stored`: the token is held, spendable now. `paying`: the payment is
   *  on its way; strut claims the token every minute and stores it then. */
  state: "stored" | "paying";
  feeMsat?: number;
  /** The balance there once stored (best effort). */
  credit?: RemoteCredit;
  note?: string;
}

export interface RemoteCapability {
  /** What the seller sells (`GET /public`'s `runnable`) and what is held there. */
  list(url: string): Promise<RemoteListing>;
  /** The credit held at the seller and its balance there. */
  credit(url: string): Promise<RemoteCredit>;
  /** Launch a workflow the seller sells, presenting the credit held. */
  launch(url: string, workflow: string, o: { input?: unknown; key: string }): Promise<RemoteRunHandle>;
  /** Wait for a launched run to end: its view. */
  wait(h: Pick<RemoteRunHandle, "seller" | "workflow" | "runId">, o?: { signal?: AbortSignal }): Promise<RemoteRunView>;
  /** Cancel a launched run (best effort). */
  cancel(h: Pick<RemoteRunHandle, "seller" | "workflow" | "runId">): Promise<void>;
  /** Let go of a launched run's token. */
  release(h: Pick<RemoteRunHandle, "seller" | "workflow" | "runId">): Promise<void>;
  /** Call a tool the seller sells, presenting the credit held. */
  call(url: string, type: string, config: unknown): Promise<{ seller: string; type: string; output: unknown; credit?: RemoteRunHandle["credit"] & { charged_usd?: number } }>;
  /** This server's wallet can pay (never the payer itself). */
  canPay(): Promise<boolean>;
  /** The door `remote/buy-credit` runs: only for an accepted proposal. */
  buyCredit(url: string, usd: number, o: { proposal: string; actor?: string }): Promise<BuyCreditResult>;
}

// ── the service ─────────────────────────────────────────────────────────

export interface RemoteDeps {
  /** `entitlements.json` (memory where strut keeps nothing on disk). */
  store: SecretStore;
  /** The guarded http. */
  http: HttpCapability;
  /** Item 7's withdrawals service: the one way sats go out. */
  withdraw: (o: { invoice: string; msat: number; actor?: string; purpose: "purchase" }) => Promise<WithdrawAnswer>;
  /** The wallet has a pay credential. */
  canPay: () => Promise<boolean>;
  /** A proposal record on disk, by id. */
  proposal: (id: string) => Promise<Proposal | null>;
  /** This server's rate, to hold a seller's quote to. */
  rate?: () => Promise<ExchangeRate>;
  now?: () => number;
}

export interface RemoteService {
  capability: RemoteCapability;
  /** Claim every purchase still out; what each came to. */
  check(): Promise<Array<{ seller: string; state: "stored" | "pending" | "ended" | "skipped" | "unread"; error?: string }>>;
  /** What is held and being bought, per seller (an admin's read): no token. */
  held(): Promise<Array<{ seller: string; credit?: Omit<HeldCredit, "macaroon" | "preimage">; purchase?: Omit<Purchase, "macaroon" | "invoice">; runs: number }>>;
  start(ms?: number): void;
  /** Stop the minute's claims, once a claim and the writes in flight are
   *  done (`close()` awaits it: a token being stored reaches the file). */
  stop(): Promise<void>;
}

export function createRemote(deps: RemoteDeps): RemoteService {
  const now = deps.now ?? Date.now;
  const writes = new Map<string, Promise<unknown>>();
  const buying = new Map<string, Promise<unknown>>();
  let timer: NodeJS.Timeout | undefined;
  let checking: Promise<unknown> | null = null;

  const read = async (seller: string): Promise<SellerRecord> => {
    const raw = await deps.store.get(keyOf(seller));
    if (!raw) return { seller };
    try {
      const rec = JSON.parse(raw) as SellerRecord;
      return rec && rec.seller === seller ? rec : { seller };
    } catch {
      console.warn(`[remote] the record for ${seller} in ${ENTITLEMENTS_FILE} could not be read; it is treated as empty`);
      return { seller };
    }
  };
  /** One write per seller at a time; `fn` returns the record to keep. */
  const update = (seller: string, fn: (rec: SellerRecord) => SellerRecord): Promise<SellerRecord> => {
    const prior = writes.get(seller) ?? Promise.resolve();
    const next = prior.then(async () => {
      const rec = fn(await read(seller));
      if (rec.runs) {
        const keep = now() - RUN_TOKEN_KEEP_MS;
        rec.runs = Object.fromEntries(Object.entries(rec.runs).filter(([, r]) => r && typeof r.token === "string" && r.at >= keep));
      }
      const empty = !rec.credit && !rec.purchase && !Object.keys(rec.runs ?? {}).length;
      if (empty) await deps.store.delete(keyOf(seller));
      else await deps.store.set(keyOf(seller), JSON.stringify(rec));
      return rec;
    });
    const kept = next.catch(() => undefined);
    writes.set(seller, kept);
    void kept.then(() => {
      if (writes.get(seller) === kept) writes.delete(seller);
    });
    return next;
  };
  /** One purchase per seller at a time: a second waits for the first. */
  const oneBuy = <T>(seller: string, fn: () => Promise<T>): Promise<T> => {
    const prior = buying.get(seller) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    const kept = next.catch(() => undefined);
    buying.set(seller, kept);
    void kept.then(() => {
      if (buying.get(seller) === kept) buying.delete(seller);
    });
    return next;
  };

  const credential = (c: HeldCredit) => `L402 ${c.macaroon}:${c.preimage}`;

  /** A request to a seller; a network failure is `remote_unavailable`. */
  const ask = async (seller: string, method: "GET" | "POST", path: string, o: { body?: unknown; authorization?: string; timeout?: number } = {}): Promise<HttpResponse> => {
    try {
      return await deps.http(`${seller}${path}`, {
        method,
        headers: { accept: "application/json", ...(o.authorization ? { authorization: o.authorization } : {}) },
        ...(o.body !== undefined ? { body: o.body } : {}),
        timeout: o.timeout ?? REMOTE_REQUEST_TIMEOUT_MS,
      });
    } catch (err) {
      throw new RemoteError("remote_unavailable", `${seller} could not be reached (${err instanceof Error ? err.message : String(err)})`);
    }
  };

  const errorText = (r: HttpResponse): string => {
    const b = r.body as { error?: unknown } | string | undefined;
    const text = typeof b === "string" ? b : typeof b?.error === "string" ? b.error : "";
    return text.replace(/\s+/g, " ").trim().slice(0, 300);
  };
  const retryAfter = (r: HttpResponse): number | undefined => {
    const n = Number(r.headers["retry-after"]);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };

  /** A seller's answer that is not what was asked for, as an error. */
  const refusal = (seller: string, what: string, r: HttpResponse, held: HeldCredit | undefined): RemoteError => {
    const said = errorText(r);
    if (r.status === 402) {
      const b = (r.body ?? {}) as Partial<SellerPrice> & { error?: string };
      const price: SellerPrice = {
        usd: typeof b.usd === "number" ? b.usd : NaN,
        sats: typeof b.sats === "number" ? b.sats : NaN,
        ...(typeof b.reason === "string" ? { reason: b.reason } : {}),
        ...(typeof b.remaining_usd === "number" ? { remaining_usd: b.remaining_usd } : {}),
      };
      const why =
        price.reason === "expired"
          ? "the credit this strut server holds there has expired"
          : price.reason === "replaced"
            ? "the credit this strut server holds there was replaced by a newer token"
            : held
              ? `the credit this strut server holds there is short${price.remaining_usd !== undefined ? ` (${usdText(price.remaining_usd)} left)` : ""}`
              : "this strut server holds no credit there";
      const suggest = Number.isFinite(price.usd) ? Math.max(0.01, Math.ceil(price.usd * 100) / 100) : undefined;
      return new RemoteError(
        "payment_required",
        `${seller} asks ${usdText(price.usd)}${Number.isFinite(price.sats) ? ` (${price.sats} sats)` : ""} for ${what}: ${why}. ` +
          `This step never pays: an admin buys credit there with remote/buy-credit { url: "${seller}", usd: ${suggest ?? "<dollars>"} } — a proposal they accept — and then it runs.`,
        { status: 402, price },
      );
    }
    if (r.status === 401) {
      return new RemoteError("token_refused", `${seller} refused the credit this strut server holds there (${said || "invalid_token"}): it buys new credit with remote/buy-credit`, { status: 401 });
    }
    if (r.status === 404) return new RemoteError("not_found", `${seller} does not sell ${what} (404${said ? `: ${said}` : ""}): read what it sells with remote/list`, { status: 404 });
    const after = retryAfter(r);
    if (r.status === 429 || r.status >= 500) {
      return new RemoteError("remote_unavailable", `${seller} answered ${r.status} for ${what}${said ? `: ${said}` : ""}${after !== undefined ? ` (try again in ${after} s)` : ""}`, { status: r.status, ...(after !== undefined ? { retryAfter: after } : {}) });
    }
    return new RemoteError("remote_refused", `${seller} refused ${what} (${r.status}${said ? `: ${said}` : ""})`, { status: r.status });
  };

  const balance = async (seller: string, rec: SellerRecord): Promise<RemoteCredit> => {
    const buyingNow = rec.purchase ? { buying: { usd: rec.purchase.usd, at: new Date(rec.purchase.at).toISOString() } } : {};
    if (!rec.credit) return { seller, held: false, ...buyingNow };
    try {
      const r = await ask(seller, "GET", "/public/credit", { authorization: credential(rec.credit) });
      if (r.status !== 200) return { seller, held: true, expires: rec.credit.expires, error: errorText(r) || `the seller answered ${r.status}`, ...buyingNow };
      const b = r.body as Record<string, unknown>;
      const num = (k: string) => (typeof b[k] === "number" ? { [k]: b[k] as number } : {});
      return {
        seller,
        held: true,
        ...num("remaining_usd"),
        ...num("remaining_sats"),
        ...num("held_usd"),
        ...num("spent_usd"),
        ...num("paid_usd"),
        ...(typeof b["expires"] === "string" ? { expires: b["expires"] } : {}),
        ...(b["expired"] === true ? { expired: true } : {}),
        ...(b["replaced"] === true ? { replaced: true } : {}),
        ...buyingNow,
      };
    } catch (err) {
      return { seller, held: true, expires: rec.credit.expires, error: err instanceof Error ? err.message : String(err), ...buyingNow };
    }
  };

  const runKey = (h: { workflow: string; runId: string }) => `${h.workflow}\n${h.runId}`;

  // ── buying ──

  /** The seller's challenge, checked before anything is paid. */
  const checkChallenge = async (seller: string, usd: number, r: HttpResponse): Promise<Omit<Purchase, "proposal" | "actor" | "at">> => {
    const b = (r.body ?? {}) as Record<string, unknown>;
    if (typeof b["invoice"] !== "string" || typeof b["macaroon"] !== "string") {
      throw new RemoteError("bad_challenge", `${seller} answered 402 without an invoice and a macaroon: it is not a strut server's credit door`);
    }
    let inv;
    try {
      inv = decodeBolt11(b["invoice"]);
    } catch (err) {
      throw new RemoteError("bad_challenge", `${seller}'s invoice does not read (${err instanceof Bolt11Error ? err.message : String(err)})`);
    }
    if (inv.msat === undefined) throw new RemoteError("bad_challenge", `${seller}'s invoice names no amount`);
    let quote, id;
    try {
      const m = macaroonFromBase64(b["macaroon"]);
      id = decodeIdentifier(m.id);
      const caveats = readCaveats(m.caveats);
      if (caveats.narrowed) throw new L402Error("bad_caveat", "the new token already carries a holder's caveats");
      quote = caveats.quote;
    } catch (err) {
      throw new RemoteError("bad_challenge", `${seller}'s macaroon does not read as a strut credit token (${err instanceof Error ? err.message : String(err)})`);
    }
    if (id.paymentHash !== inv.paymentHash) throw new RemoteError("bad_challenge", `${seller}'s macaroon names another payment than its invoice`);
    if (quote.sats * 1000 !== inv.msat) throw new RemoteError("bad_challenge", `${seller}'s macaroon says ${quote.sats} sats, its invoice asks ${inv.msat} msat`);
    if (quote.credit < usdToMicros(usd)) {
      throw new RemoteError("bad_challenge", `${seller}'s token would buy ${usdText(microsToUsd(quote.credit))}, not the ${usdText(usd)} accepted: nothing was paid`);
    }
    if (quote.validUntil * 1000 <= now()) throw new RemoteError("bad_challenge", `${seller}'s token would already have ended`);
    if (inv.expiresAt * 1000 <= now()) throw new RemoteError("bad_challenge", `${seller}'s invoice has already expired`);
    // The seller's rate is its own; it is held to this server's.
    const rate = await deps.rate?.().catch(() => undefined);
    if (rate) {
      const fair = satsForUsd(usd, rate);
      if (quote.sats > Math.ceil(fair * (1 + QUOTE_TOLERANCE))) {
        throw new RemoteError(
          "quote_too_high",
          `${seller} asks ${quote.sats} sats for ${usdText(usd)}; at this server's rate (${rate.source}, $${Math.round(rate.usdPerBtc)} per bitcoin) that is ${fair} sats, and more than ${Math.round(QUOTE_TOLERANCE * 100)}% over is refused: nothing was paid`,
        );
      }
    }
    return {
      usd,
      sats: quote.sats,
      msat: inv.msat,
      invoice: inv.invoice,
      macaroon: b["macaroon"] as string,
      paymentHash: inv.paymentHash,
      tokenId: id.tokenId,
      invoiceExpiresAt: inv.expiresAt,
      validUntil: quote.validUntil,
      carries: b["carries"] === true,
    };
  };

  /** Keep a purchase's token, once its preimage proves it was paid. */
  const store = async (seller: string, p: Purchase, preimage: string): Promise<boolean> => {
    if (!/^[0-9a-f]{64}$/i.test(preimage) || sha256(Buffer.from(preimage, "hex")) !== p.paymentHash) return false;
    await update(seller, (rec) => {
      const { purchase: _p, ...rest } = rec;
      // Only this purchase: a record moved on since is not overwritten.
      if (rec.purchase && rec.purchase.paymentHash !== p.paymentHash) return rec;
      if (rec.credit?.paymentHash === p.paymentHash) return rest;
      return {
        ...rest,
        credit: {
          macaroon: p.macaroon,
          preimage: preimage.toLowerCase(),
          tokenId: p.tokenId,
          paymentHash: p.paymentHash,
          boughtAt: new Date(now()).toISOString(),
          usd: p.usd,
          sats: p.sats,
          expires: new Date(p.validUntil * 1000).toISOString(),
          ...(p.carries && rec.credit ? { carried: rec.credit.tokenId } : {}),
          proposal: p.proposal,
        },
      };
    });
    console.log(`[remote] credit bought from ${seller} is held: ${usdText(p.usd)} (${p.sats} sats), token ${p.tokenId.slice(0, 12)}…`);
    return true;
  };
  const dropPurchase = (seller: string, p: Purchase, why: string) =>
    update(seller, (rec) => {
      if (rec.purchase?.paymentHash !== p.paymentHash) return rec;
      const { purchase: _p, ...rest } = rec;
      console.log(`[remote] the purchase of ${usdText(p.usd)} from ${seller} ended without credit: ${why}`);
      return rest;
    });

  /** Ask the seller whether a purchase settled (§4.4): it answers the
   *  preimage once its wallet saw the payment. */
  const claim = async (seller: string, p: Purchase): Promise<"stored" | "pending" | "ended"> => {
    const r = await ask(seller, "POST", "/public/credit/claim", { body: { macaroon: p.macaroon } });
    if (r.status !== 200) throw new RemoteError("remote_unavailable", `${seller}'s claim answered ${r.status}${errorText(r) ? `: ${errorText(r)}` : ""}`);
    const b = r.body as { state?: string; preimage?: string };
    if (b.state === "settled" && typeof b.preimage === "string") {
      if (await store(seller, p, b.preimage)) return "stored";
      throw new RemoteError("bad_challenge", `${seller} claims the purchase settled, but its preimage does not hash to the payment: nothing is stored`);
    }
    if (b.state === "expired") {
      await dropPurchase(seller, p, "the seller's invoice ended unpaid");
      return "ended";
    }
    return "pending";
  };

  const capability: RemoteCapability = {
    async list(url) {
      const seller = sellerOf(url);
      const r = await ask(seller, "GET", "/public");
      if (r.status !== 200 || !r.body || typeof r.body !== "object") {
        if (r.status === 404 || r.status === 200) throw new RemoteError("not_found", `${seller} serves no public view (GET /public answered ${r.status}): it is not a strut server that sells runs`);
        throw refusal(seller, "its public view", r, undefined);
      }
      const runnable = Array.isArray((r.body as { runnable?: unknown }).runnable) ? ((r.body as { runnable: RemoteRunnable[] }).runnable) : [];
      const pick = (i: RemoteRunnable): RemoteRunnable => ({
        kind: i.kind,
        name: i.name,
        ...(typeof i.description === "string" ? { description: i.description.slice(0, 500) } : {}),
        base: i.base,
        markup: i.markup,
        capUsd: i.capUsd ?? null,
        reserve: i.reserve,
        ...(i.results ? { results: i.results } : {}),
        ...(i.input !== undefined ? { input: i.input } : {}),
        ...(i.recent ? { recent: i.recent } : {}),
      });
      return { seller, runnable: runnable.filter((i) => i && (i.kind === "workflow" || i.kind === "step") && typeof i.name === "string").map(pick), credit: await balance(seller, await read(seller)) };
    },

    async credit(url) {
      const seller = sellerOf(url);
      return balance(seller, await read(seller));
    },

    async launch(url, workflow, o) {
      const seller = sellerOf(url);
      const held = (await read(seller)).credit;
      const r = await ask(seller, "POST", `/public/workflows/${enc(workflow)}/run`, {
        body: { ...(o.input !== undefined ? { input: o.input } : {}), key: o.key },
        ...(held ? { authorization: credential(held) } : {}),
      });
      if (r.status !== 202) throw refusal(seller, `a run of ${workflow}`, r, held);
      const b = r.body as { runId?: unknown; token?: unknown; existing?: unknown; credit?: RemoteRunHandle["credit"] };
      if (typeof b?.runId !== "string" || typeof b.token !== "string") throw new RemoteError("remote_refused", `${seller} answered 202 without a run id and its token`);
      const handle: RemoteRunHandle = { seller, workflow, runId: b.runId, ...(b.existing === true ? { existing: true } : {}), ...(b.credit && typeof b.credit === "object" ? { credit: b.credit } : {}) };
      const token = b.token;
      await update(seller, (rec) => ({ ...rec, runs: { ...(rec.runs ?? {}), [runKey(handle)]: { token, at: now() } } }));
      return handle;
    },

    async wait(h, o = {}) {
      const seller = sellerOf(h.seller);
      const token = (await read(seller)).runs?.[runKey(h)]?.token;
      if (!token) throw new RemoteError("run_unknown", `this strut server holds no token for run ${h.runId} of ${h.workflow} at ${seller}: it cannot read it`);
      let failures = 0;
      let terminalSeen = 0;
      for (;;) {
        if (o.signal?.aborted) throw new RemoteError("remote_refused", "the wait was stopped");
        let r: HttpResponse;
        try {
          r = await ask(seller, "GET", `/public/workflows/${enc(h.workflow)}/runs/${enc(h.runId)}?wait=${RUN_READ_WAIT_S}`, { authorization: `Bearer ${token}` });
        } catch (err) {
          if (++failures >= RUN_READ_FAILURES_MAX) throw err;
          await new Promise((res) => setTimeout(res, Math.min(30_000, 1000 * 2 ** failures)));
          continue;
        }
        if (r.status === 404) throw new RemoteError("run_unknown", `${seller} does not know run ${h.runId} of ${h.workflow} (404)`);
        if (r.status !== 200) {
          if (r.status >= 500 || r.status === 429) {
            if (++failures >= RUN_READ_FAILURES_MAX) throw refusal(seller, `run ${h.runId} of ${h.workflow}`, r, undefined);
            await new Promise((res) => setTimeout(res, Math.min(30_000, 1000 * 2 ** failures)));
            continue;
          }
          throw refusal(seller, `run ${h.runId} of ${h.workflow}`, r, undefined);
        }
        failures = 0;
        const v = r.body as Record<string, unknown>;
        const status = typeof v["status"] === "string" ? (v["status"] as string) : "running";
        const terminal = status === "success" || status === "error" || status === "cancelled";
        // Done once it was charged (§17.4: `charged` appears when the run
        // ended and the ledger recorded it); a seller that never says so
        // is taken at its status after a few reads.
        if (typeof v["charged"] === "number" || (terminal && ++terminalSeen >= 3)) {
          const err = v["error"] as { message?: unknown } | undefined;
          return {
            status,
            ...(v["output"] !== undefined ? { output: v["output"] } : {}),
            ...(err && typeof err.message === "string" ? { error: { message: err.message } } : {}),
            ...(typeof v["charged"] === "number" ? { charged: v["charged"] as number } : {}),
            ...(typeof v["durationMs"] === "number" ? { durationMs: v["durationMs"] as number } : {}),
            ...(v["totals"] !== undefined ? { totals: v["totals"] } : {}),
          };
        }
        if (terminal) await new Promise((res) => setTimeout(res, 500));
      }
    },

    async cancel(h) {
      const seller = sellerOf(h.seller);
      const token = (await read(seller)).runs?.[runKey(h)]?.token;
      if (!token) return;
      await ask(seller, "POST", `/public/workflows/${enc(h.workflow)}/runs/${enc(h.runId)}/cancel`, { authorization: `Bearer ${token}` }).catch(() => undefined);
    },

    async release(h) {
      const seller = sellerOf(h.seller);
      await update(seller, (rec) => {
        if (!rec.runs?.[runKey(h)]) return rec;
        const { [runKey(h)]: _gone, ...runs } = rec.runs;
        return { ...rec, runs };
      });
    },

    async call(url, type, config) {
      const seller = sellerOf(url);
      const held = (await read(seller)).credit;
      const r = await ask(seller, "POST", `/public/steps/${typePath(type)}/run`, {
        body: { config: config ?? {} },
        ...(held ? { authorization: credential(held) } : {}),
        timeout: REMOTE_CALL_TIMEOUT_MS,
      });
      if (r.status !== 200) throw refusal(seller, `a call of ${type}`, r, held);
      const b = (r.body ?? {}) as { output?: unknown; credit?: Record<string, unknown> };
      return { seller, type, output: b.output, ...(b.credit && typeof b.credit === "object" ? { credit: b.credit } : {}) };
    },

    canPay: () => deps.canPay(),

    async buyCredit(url, usd, o) {
      const seller = sellerOf(url);
      // The door: an ACCEPTED proposal of this very step, for this seller
      // and this amount, the person's edits included.
      const rec = typeof o?.proposal === "string" ? await deps.proposal(o.proposal) : null;
      const asked = rec ? ({ ...(rec.input as object), ...((rec.decision?.input as object | undefined) ?? {}) } as { url?: unknown; usd?: unknown }) : {};
      let askedSeller: string | undefined;
      try {
        askedSeller = typeof asked.url === "string" ? sellerOf(asked.url) : undefined;
      } catch {
        askedSeller = undefined;
      }
      if (!rec || rec.step !== "remote/buy-credit" || rec.status !== "accepted" || askedSeller !== seller || asked.usd !== usd) {
        throw new RemoteError(
          "buy_needs_person",
          `buying credit at ${seller} runs only as the apply of a proposal an admin accepted for it` + (rec ? ` (proposal ${rec.id} is ${rec.status}, for ${rec.step})` : ""),
        );
      }
      if (!Number.isFinite(usd) || usd <= 0) throw new RemoteError("bad_challenge", "usd is a number of dollars above 0");
      if (!(await deps.canPay())) {
        throw new RemoteError("no_pay_credential", "this strut server's wallet has no pay credential (Earnings → Wallet): nothing was paid");
      }
      return oneBuy(seller, () => buy(seller, usd, o.proposal, o.actor));
    },
  };

  const buy = async (seller: string, usd: number, proposal: string, actor: string | undefined): Promise<BuyCreditResult> => {
    let rec = await read(seller);
    let p = rec.purchase;
    if (p && p.proposal !== proposal) {
      // Another purchase is out: ask the seller where it stands first. One
      // never handed to the payer never went, and is over.
      const state = p.sent ? await claim(seller, p).catch(() => "pending" as const) : (await dropPurchase(seller, p, "it was never paid, and another purchase was accepted"), "ended" as const);
      if (state === "pending") {
        throw new RemoteError("purchase_in_flight", `a purchase of ${usdText(p.usd)} from ${seller} (proposal ${p.proposal}) is still being paid: once it settles or its invoice ends, this one can go — accept it again then`);
      }
      rec = await read(seller);
      p = undefined;
    }
    if (p) {
      // This proposal accepted again: the same invoice, never a second. It
      // ends only when the seller says its invoice ended unpaid, or when it
      // was never handed to the payer — a payment that may have settled is
      // never dropped for a seller that does not answer.
      const state = await claim(seller, p).catch(() => "unknown" as const);
      if (state === "stored") return { seller, usd: p.usd, sats: p.sats, paymentHash: p.paymentHash, state: "stored", credit: await balance(seller, await read(seller)) };
      if (state !== "ended" && p.invoiceExpiresAt * 1000 <= now()) {
        if (p.sent) {
          throw new RemoteError(
            "remote_unavailable",
            `the invoice of this purchase from ${seller} has expired, and the seller has not said whether it was paid: the purchase is kept and claimed every minute — nothing is paid again`,
          );
        }
        await dropPurchase(seller, p, "its invoice expired before it was paid");
      }
      if (state === "ended" || p.invoiceExpiresAt * 1000 <= now()) {
        rec = await read(seller);
        p = undefined;
      }
    }
    if (!p) {
      let r = await ask(seller, "POST", "/public/credit", { body: { usd }, ...(rec.credit ? { authorization: credential(rec.credit) } : {}) });
      // A token the seller no longer takes: buy without it (nothing carries).
      if (r.status === 401 && rec.credit) r = await ask(seller, "POST", "/public/credit", { body: { usd } });
      if (r.status === 404) throw new RemoteError("not_selling", `${seller} sells no credit (POST /public/credit answered 404): nothing was paid`);
      if (r.status !== 402) throw refusal(seller, "credit", r, rec.credit);
      const challenge = await checkChallenge(seller, usd, r);
      p = { ...challenge, proposal, ...(actor ? { actor } : {}), at: now() };
      const fresh = p;
      // On file before anything is paid: a crash mid-pay leaves it to claim.
      await update(seller, (r2) => ({ ...r2, purchase: fresh }));
    }
    const purchase = p;
    await update(seller, (r2) => (r2.purchase?.paymentHash === purchase.paymentHash ? { ...r2, purchase: { ...r2.purchase, sent: true } } : r2));
    let paid: WithdrawAnswer;
    try {
      paid = await deps.withdraw({ invoice: purchase.invoice, msat: purchase.msat, ...(actor ? { actor } : {}), purpose: "purchase" });
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      // Refused before anything went: the purchase is over.
      if (["not_an_invoice", "no_amount", "amount_mismatch", "expired", "bad_fee", "no_pay_credential", "wallet_refused", "bad_request"].includes(code)) {
        await dropPurchase(seller, purchase, err instanceof Error ? err.message : String(err));
      } else {
        await update(seller, (r2) => (r2.purchase?.paymentHash === purchase.paymentHash ? { ...r2, purchase: { ...r2.purchase, lastError: err instanceof Error ? err.message : String(err), checkedAt: now() } } : r2));
      }
      throw new RemoteError("payment_failed", `paying ${seller} for ${usdText(purchase.usd)} of credit did not go: ${err instanceof Error ? err.message : String(err)}`);
    }
    const base = { seller, usd: purchase.usd, sats: purchase.sats, paymentHash: purchase.paymentHash, ...(paid.feeMsat ? { feeMsat: paid.feeMsat } : {}) };
    if (paid.state === "failed") {
      await dropPurchase(seller, purchase, paid.error ?? "the payment failed");
      throw new RemoteError("payment_failed", `the payment to ${seller} failed${paid.error ? `: ${paid.error}` : ""} — nothing was paid; accept the proposal again to try again`);
    }
    if (paid.state === "settled") {
      const stored = (paid.preimage && (await store(seller, purchase, paid.preimage))) || (await claim(seller, purchase).catch(() => "pending" as const)) === "stored";
      if (stored) {
        const credit = await balance(seller, await read(seller));
        return { ...base, state: "stored", credit };
      }
    }
    return {
      ...base,
      state: "paying",
      note: `the payment ${paid.state === "settled" ? "settled, and the seller has not seen it yet" : "is on its way"}: strut claims the credit from ${seller} every minute and holds it once it settles — nothing is paid again`,
    };
  };

  const service: RemoteService = {
    capability,

    check() {
      if (checking) return Promise.resolve([]);
      const run = (async () => {
        const out: Array<{ seller: string; state: "stored" | "pending" | "ended" | "skipped" | "unread"; error?: string }> = [];
        for (const info of await deps.store.list()) {
          if (!info.name.startsWith(ENTITLEMENT_PREFIX)) continue;
          const raw = await deps.store.get(info.name);
          let rec: SellerRecord | undefined;
          try {
            rec = raw ? (JSON.parse(raw) as SellerRecord) : undefined;
          } catch {
            rec = undefined;
          }
          const p = rec?.purchase;
          if (!rec || !p) continue;
          const seller = rec.seller;
          if (buying.has(seller)) {
            out.push({ seller, state: "skipped", error: "a purchase from it is being paid now" });
            continue;
          }
          try {
            out.push({ seller, state: await claim(seller, p) });
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            await update(seller, (r2) => (r2.purchase?.paymentHash === p.paymentHash ? { ...r2, purchase: { ...r2.purchase, lastError: error, checkedAt: now() } } : r2)).catch(() => undefined);
            out.push({ seller, state: "unread", error });
          }
        }
        return out;
      })();
      checking = run.finally(() => {
        checking = null;
      });
      return run;
    },

    async held() {
      const out: Awaited<ReturnType<RemoteService["held"]>> = [];
      for (const info of await deps.store.list()) {
        if (!info.name.startsWith(ENTITLEMENT_PREFIX)) continue;
        const raw = await deps.store.get(info.name);
        try {
          const rec = JSON.parse(raw ?? "") as SellerRecord;
          const { macaroon: _m, preimage: _p, ...credit } = rec.credit ?? ({} as HeldCredit);
          const { macaroon: _pm, invoice: _i, ...purchase } = rec.purchase ?? ({} as Purchase);
          out.push({ seller: rec.seller, ...(rec.credit ? { credit } : {}), ...(rec.purchase ? { purchase } : {}), runs: Object.keys(rec.runs ?? {}).length });
        } catch {
          // An entry that does not read is nothing held.
        }
      }
      return out.sort((a, b) => a.seller.localeCompare(b.seller));
    },

    start(ms = PURCHASE_CHECK_MS) {
      if (timer) return;
      const tick = () => {
        void service.check().catch((err) => console.warn(`[remote] claiming purchases failed: ${err instanceof Error ? err.message : String(err)}`));
      };
      timer = setInterval(tick, ms);
      timer.unref?.();
      tick();
    },

    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await Promise.all([checking, ...writes.values(), ...buying.values()].map((p) => Promise.resolve(p).catch(() => undefined)));
    },
  };
  return service;
}
