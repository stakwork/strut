/**
 * The Sphinx daemon as the server's wallet (plans/paid-runs.md §9, the
 * TREASURY: a second `sphinx-daemon` container with its own seed, in no
 * tribe). Strut holds the daemon's URL and its RECEIVE token, never the
 * admin token and never the pay token, so through this provider it can
 * make invoices, look them up, list payments and read the balance, and
 * nothing else.
 *
 * The four routes it calls are the daemon API specs/LIGHTNING.md writes
 * down (today's daemon has only `POST /invoice`, answering `{ invoice, sats }`;
 * the rest is sphinx-repo work, decision 10). Each request carries
 * `Authorization: Bearer <receive token>`; the daemon's errors are its usual
 * `{ error, code }`.
 */

import { createHash } from "node:crypto";
import { httpCapability, type HttpCapability, type HttpResponse } from "../capabilities.js";
import {
  LightningError,
  checkPaymentHash,
  type Invoice,
  type InvoiceLookup,
  type LightningProvider,
  type ReceivedPayment,
} from "./lightning.js";

/** How long one call to the daemon may take. */
export const DAEMON_TIMEOUT_MS = 10_000;

export interface SphinxDaemonOptions {
  /** The daemon's base URL, http(s). Its paths are appended. */
  url: string;
  /** The RECEIVE token (invoices, lookups, the payments list, the balance). */
  token: string;
  /** How requests go out: strut's own http capability by default. */
  http?: HttpCapability;
  timeoutMs?: number;
}

/** `url` as the provider keeps it: an http(s) URL with no trailing slash,
 *  no query and no credentials in it. Throws a sentence otherwise. */
export function daemonUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`the daemon URL is not a URL: ${JSON.stringify(raw.slice(0, 100))}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("the daemon URL must be http(s)");
  if (u.username || u.password) throw new Error("the daemon URL may not carry credentials: the token is its own field");
  if (u.search || u.hash) throw new Error("the daemon URL may not carry a query or a fragment");
  return u.toString().replace(/\/+$/, "");
}

/** A unix-seconds number (the daemon's form) or an ISO string → ISO. */
function isoOf(v: unknown, what: string): string {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v * 1000).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  throw new LightningError("wallet_bad_answer", `the daemon's ${what} is not a time`);
}

/** A whole msat amount: a number, or the decimal string the core writes. */
function msatOf(v: unknown, what: string): number {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new LightningError("wallet_bad_answer", `the daemon's ${what} is not a whole msat amount`);
  return n;
}

function hexOf(v: unknown, what: string): string {
  if (typeof v !== "string" || !/^[0-9a-fA-F]{64}$/.test(v)) throw new LightningError("wallet_bad_answer", `the daemon's ${what} is not 64 hex characters`);
  return v.toLowerCase();
}

function objectOf(res: HttpResponse, route: string): Record<string, unknown> {
  if (!res.body || typeof res.body !== "object" || Array.isArray(res.body)) {
    throw new LightningError("wallet_bad_answer", `the daemon answered ${route} with no JSON object`);
  }
  return res.body as Record<string, unknown>;
}

export class SphinxDaemonProvider implements LightningProvider {
  // Private for real: `ctx.services.lightning` is a frozen object of four
  // functions over this, and nothing in this process reads the token back.
  readonly #url: string;
  readonly #token: string;
  readonly #http: HttpCapability;
  readonly #timeoutMs: number;

  constructor(opts: SphinxDaemonOptions) {
    this.#url = daemonUrl(opts.url);
    if (typeof opts.token !== "string" || !opts.token.trim()) throw new Error("the daemon's receive token is empty");
    this.#token = opts.token.trim();
    this.#http = opts.http ?? httpCapability();
    this.#timeoutMs = opts.timeoutMs ?? DAEMON_TIMEOUT_MS;
  }

  /** The daemon's base URL (no credential in it). */
  get url(): string {
    return this.#url;
  }

  async #call(method: "GET" | "POST", path: string, opts: { body?: unknown; query?: Record<string, string | number> } = {}): Promise<HttpResponse> {
    const route = `${method} ${path.replace(/\/[0-9a-f]{64}$/, "/:payment_hash")}`;
    let res: HttpResponse;
    try {
      res = await this.#http(this.#url + path, {
        method,
        headers: { authorization: `Bearer ${this.#token}`, accept: "application/json" },
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        ...(opts.query ? { query: opts.query } : {}),
        timeout: this.#timeoutMs,
      });
    } catch (err) {
      const why = err instanceof Error ? (err.name === "TimeoutError" ? `no answer in ${this.#timeoutMs / 1000} s` : err.message) : String(err);
      throw new LightningError("wallet_unavailable", `the Sphinx daemon at ${this.#url} did not answer ${route}: ${why}`);
    }
    if (res.ok) return res;
    const said = res.body && typeof res.body === "object" ? (res.body as { error?: unknown; code?: unknown }) : {};
    const message = typeof said.error === "string" ? said.error : typeof res.body === "string" && res.body ? res.body.slice(0, 200) : `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      throw new LightningError("wallet_unauthorized", `the Sphinx daemon refused the receive token on ${route}: ${message}`);
    }
    if (res.status >= 500) throw new LightningError("wallet_unavailable", `the Sphinx daemon failed ${route}: ${message}`);
    if (res.status === 404 && said.code === "not_found" && /^no route /.test(message)) {
      throw new LightningError("wallet_refused", `the Sphinx daemon at ${this.#url} has no ${route}: it predates the API strut's wallet reads (specs/LIGHTNING.md)`);
    }
    if (res.status === 404 && path.startsWith("/invoice/")) throw new LightningError("invoice_unknown", `the Sphinx daemon has no invoice ${path.slice("/invoice/".length)}`);
    throw new LightningError("wallet_refused", `the Sphinx daemon refused ${route}: ${message}`);
  }

  async makeInvoice(o: { msat: number; description?: string; expirySecs?: number }): Promise<Invoice> {
    // The daemon makes invoices in whole sats (`auto.invoice` is msat, its
    // route takes sats); an amount that is not one is the caller's to round.
    if (o.msat % 1000 !== 0) throw new LightningError("bad_request", "the Sphinx daemon makes invoices in whole sats: msat must be a multiple of 1000");
    const res = await this.#call("POST", "/invoice", {
      body: {
        sats: o.msat / 1000,
        ...(o.description !== undefined ? { description: o.description } : {}),
        ...(o.expirySecs !== undefined ? { expiry: o.expirySecs } : {}),
      },
    });
    const b = objectOf(res, "POST /invoice");
    if (typeof b["invoice"] !== "string" || !b["invoice"]) throw new LightningError("wallet_bad_answer", "the daemon's invoice is missing");
    if (b["payment_hash"] === undefined || b["expires_at"] === undefined) {
      throw new LightningError("wallet_bad_answer", "the daemon's POST /invoice answered no payment_hash or expires_at: it predates the API strut's wallet reads (specs/LIGHTNING.md)");
    }
    return { invoice: b["invoice"], payment_hash: hexOf(b["payment_hash"], "payment_hash"), expires: isoOf(b["expires_at"], "expires_at") };
  }

  async lookup(payment_hash: string): Promise<InvoiceLookup> {
    const hash = checkPaymentHash(payment_hash);
    const b = objectOf(await this.#call("GET", `/invoice/${hash}`), "GET /invoice/:payment_hash");
    const state = b["state"];
    if (state !== "pending" && state !== "settled" && state !== "expired") throw new LightningError("wallet_bad_answer", `the daemon's invoice state ${JSON.stringify(state)} is not pending, settled or expired`);
    if (b["payment_hash"] !== undefined && hexOf(b["payment_hash"], "payment_hash") !== hash) {
      throw new LightningError("wallet_bad_answer", "the daemon answered for another invoice");
    }
    if (state !== "settled") return { state };
    const preimage = b["preimage"] === undefined ? undefined : hexOf(b["preimage"], "preimage");
    // A settled invoice's preimage is what an L402 credential is checked
    // against: one that does not hash to the invoice is not believed.
    if (preimage && createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex") !== hash) {
      throw new LightningError("wallet_bad_answer", "the daemon's preimage does not hash to the invoice's payment hash");
    }
    return {
      state,
      msat: msatOf(b["msat"], "settled msat"),
      ...(b["settled_at"] !== undefined ? { settled_at: isoOf(b["settled_at"], "settled_at") } : {}),
      ...(preimage ? { preimage } : {}),
    };
  }

  async received(o: { since?: string; limit?: number }): Promise<ReceivedPayment[]> {
    const query: Record<string, number> = {};
    if (o.since) query["since"] = Math.floor(Date.parse(o.since) / 1000);
    if (o.limit !== undefined) query["limit"] = o.limit;
    const b = objectOf(await this.#call("GET", "/payments", { query }), "GET /payments");
    if (!Array.isArray(b["payments"])) throw new LightningError("wallet_bad_answer", "the daemon's GET /payments has no payments list");
    const out = (b["payments"] as unknown[]).map((p, i) => {
      if (!p || typeof p !== "object") throw new LightningError("wallet_bad_answer", `the daemon's payment ${i} is not an object`);
      const r = p as Record<string, unknown>;
      return { payment_hash: hexOf(r["payment_hash"], `payment ${i}'s payment_hash`), msat: msatOf(r["msat"], `payment ${i}'s msat`), at: isoOf(r["settled_at"], `payment ${i}'s settled_at`) };
    });
    // Oldest first, and never past `limit`, whatever order it came in.
    out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return o.limit !== undefined ? out.slice(0, o.limit) : out;
  }

  async balance(): Promise<{ msat: number }> {
    const b = objectOf(await this.#call("GET", "/balance"), "GET /balance");
    return { msat: msatOf(b["msat"], "balance") };
  }
}
