/**
 * The PAYER (plans/paid-runs.md §9, "The payer"): the one thing in strut that
 * moves sats out. Built from the wallet's PAY credential — the Sphinx
 * daemon's pay token, or an NWC connection that may pay — and nothing else
 * holds that credential.
 *
 * Never on the services bag, never handed to a step. createStrut holds ONE
 * (`strut.payments.payer()`), and exactly two doors call it:
 * `POST /earnings/withdraw` (§8, withdrawals.ts) and an accepted
 * `remote/buy-credit` proposal (§10, a later item). With no pay credential
 * `payer()` is null and both say so: a server can sell without paying.
 *
 * Two calls: `pay` an invoice, and `status` — where a payment that answered
 * `pending` stands now. Every answer is `{ state: settled | pending | failed }`
 * with the fee; a refusal before anything was sent (not an invoice, the
 * wallet's own, expired, a fee cap the wallet cannot keep, no balance)
 * throws a `LightningError` carrying the wallet's own code.
 */

import { createHash } from "node:crypto";
import { httpCapability, type HttpCapability, type HttpResponse } from "../capabilities.js";
import { decodeBolt11 } from "./bolt11.js";
import { lspFeeFloorMsat } from "./fee.js";
import { LightningError, checkPaymentHash } from "./lightning.js";
import { NwcClient, type NwcSocketFactory } from "./nwc.js";
import type { WalletCredentials } from "./settings.js";
import { daemonUrl } from "./sphinx-daemon.js";

export type PaymentState = "settled" | "pending" | "failed";

export interface PayResult {
  /** hex, 64. */
  paymentHash: string;
  state: PaymentState;
  /** The routing fee: what it cost beyond the invoice. 0 unless settled. */
  feeMsat: number;
  /** Proof of payment, once settled, when the wallet gave one that hashes
   *  to the payment hash. */
  preimage?: string;
  /** `failed`: the wallet's words. */
  error?: string;
}

export interface PayRequest {
  /** BOLT11, with an amount. */
  invoice: string;
  /** The routing fee the payment may cost at most (see `capsFee`). */
  maxFeeMsat: number;
}

export interface Payer {
  readonly provider: "sphinx" | "nwc";
  /** Whether the wallet keeps `maxFeeMsat`. The daemon does (and refuses one
   *  below its LSP's own limit, `minFeeMsat`); NWC's `pay_invoice` takes no
   *  cap, so the wallet's own limit applies and the fee is reported after. */
  readonly capsFee: boolean;
  /** The smallest cap the wallet takes for an invoice of `msat`. */
  minFeeMsat(msat: number): number;
  /** Pay an invoice. `pending`: sent, no answer yet — read it with `status`. */
  pay(req: PayRequest): Promise<PayResult>;
  /** Where a payment stands now: one that answered `pending`, or one whose
   *  pay call never answered. With the daemon this POSTs the invoice again
   *  (its pay is idempotent per payment hash: a settled or pending one is
   *  read, only a FAILED one is paid again); with NWC it looks it up. */
  status(req: PayRequest & { paymentHash: string }): Promise<PayResult>;
}

// ── the fee (fee.ts) ──────────────────────────────────────────────────────

export { defaultMaxFeeMsat, lspFeeFloorMsat } from "./fee.js";

const sha256hex = (hexIn: string) => createHash("sha256").update(Buffer.from(hexIn, "hex")).digest("hex");

/** A preimage the wallet gave, kept only when it hashes to the payment. */
function provenPreimage(v: unknown, paymentHash: string): string | undefined {
  if (typeof v !== "string") return undefined;
  const p = v.toLowerCase();
  return /^[0-9a-f]{64}$/.test(p) && sha256hex(p) === paymentHash ? p : undefined;
}

function wholeMsat(v: unknown): number {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function checkPayRequest(req: PayRequest): void {
  if (!req || typeof req.invoice !== "string" || !req.invoice.trim()) throw new LightningError("bad_request", "pay takes { invoice, maxFeeMsat }");
  if (!Number.isSafeInteger(req.maxFeeMsat) || req.maxFeeMsat < 0) throw new LightningError("bad_request", "maxFeeMsat must be a whole number of msat, 0 or more");
}

// ── the Sphinx daemon ─────────────────────────────────────────────────────

/** The daemon waits up to 60 s for the LSP before answering `pending`
 *  (sphinx `PAY_WAIT_MS`): the call must outlast it. */
export const DAEMON_PAY_TIMEOUT_MS = 75_000;

export interface SphinxDaemonPayerOptions {
  url: string;
  /** The daemon's PAY token. */
  payToken: string;
  http?: HttpCapability;
  timeoutMs?: number;
}

/**
 * `POST /pay { invoice, max_fee_msat }` with the pay token
 * (specs/LIGHTNING.md, stakwork/sphinx#428): `{ payment_hash, state, fee_msat,
 * preimage?, error? }`, after waiting up to 60 s for the LSP. Idempotent per
 * payment hash, so `status` POSTs the same invoice again; there is no GET.
 * A 400 is a refusal before anything was sent, its `code` the daemon's
 * (`bad_request`, `own_invoice`, `expired`, `max_fee_too_low`).
 */
export class SphinxDaemonPayer implements Payer {
  readonly provider = "sphinx" as const;
  readonly capsFee = true;
  readonly #url: string;
  readonly #token: string;
  readonly #http: HttpCapability;
  readonly #timeoutMs: number;

  constructor(opts: SphinxDaemonPayerOptions) {
    this.#url = daemonUrl(opts.url);
    if (typeof opts.payToken !== "string" || !opts.payToken.trim()) throw new Error("the daemon's pay token is empty");
    this.#token = opts.payToken.trim();
    this.#http = opts.http ?? httpCapability();
    this.#timeoutMs = opts.timeoutMs ?? DAEMON_PAY_TIMEOUT_MS;
  }

  minFeeMsat(msat: number): number {
    return lspFeeFloorMsat(msat);
  }

  async pay(req: PayRequest): Promise<PayResult> {
    checkPayRequest(req);
    let res: HttpResponse;
    try {
      res = await this.#http(`${this.#url}/pay`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#token}`, accept: "application/json" },
        body: { invoice: req.invoice.trim(), max_fee_msat: req.maxFeeMsat },
        timeout: this.#timeoutMs,
      });
    } catch (err) {
      const why = err instanceof Error ? (err.name === "TimeoutError" ? `no answer in ${this.#timeoutMs / 1000} s` : err.message) : String(err);
      throw new LightningError("wallet_unavailable", `the Sphinx daemon at ${this.#url} did not answer POST /pay: ${why}`);
    }
    const said = res.body && typeof res.body === "object" && !Array.isArray(res.body) ? (res.body as Record<string, unknown>) : {};
    if (!res.ok) {
      const message = typeof said["error"] === "string" ? said["error"] : typeof res.body === "string" && res.body ? res.body.slice(0, 200) : `HTTP ${res.status}`;
      const walletCode = typeof said["code"] === "string" ? said["code"] : undefined;
      if (res.status === 401 || res.status === 403) throw new LightningError("wallet_unauthorized", `the Sphinx daemon refused the pay token on POST /pay: ${message}`, walletCode);
      if (res.status >= 500) throw new LightningError("wallet_unavailable", `the Sphinx daemon failed POST /pay: ${message}`, walletCode);
      if (res.status === 404 && walletCode === "not_found" && /^no route /.test(message)) {
        throw new LightningError("wallet_refused", `the Sphinx daemon at ${this.#url} has no POST /pay: it predates the API strut pays through (specs/LIGHTNING.md)`, walletCode);
      }
      throw new LightningError("wallet_refused", `the Sphinx daemon refused POST /pay: ${message}`, walletCode);
    }
    const state = said["state"];
    if (state !== "settled" && state !== "pending" && state !== "failed") {
      throw new LightningError("wallet_bad_answer", `the daemon's payment state ${JSON.stringify(state)} is not settled, pending or failed`);
    }
    let paymentHash: string;
    try {
      paymentHash = checkPaymentHash(said["payment_hash"]);
    } catch {
      throw new LightningError("wallet_bad_answer", "the daemon's POST /pay answered no payment_hash");
    }
    const preimage = state === "settled" ? provenPreimage(said["preimage"], paymentHash) : undefined;
    return {
      paymentHash,
      state,
      feeMsat: state === "settled" ? wholeMsat(said["fee_msat"]) : 0,
      ...(preimage ? { preimage } : {}),
      ...(state === "failed" ? { error: typeof said["error"] === "string" && said["error"] ? said["error"] : "the payment failed" } : {}),
    };
  }

  async status(req: PayRequest & { paymentHash: string }): Promise<PayResult> {
    const out = await this.pay(req);
    if (out.paymentHash !== checkPaymentHash(req.paymentHash)) throw new LightningError("wallet_bad_answer", "the daemon answered for another payment");
    return out;
  }
}

// ── NWC ───────────────────────────────────────────────────────────────────

/** How long an NWC `pay_invoice` is waited on before it reads as pending. */
export const NWC_PAY_TIMEOUT_MS = 60_000;

export interface NwcPayerOptions {
  /** The connection that may pay. */
  payUrl: string;
  /** The receive connection: a lookup the pay connection does not allow is
   *  asked there. */
  url?: string;
  timeoutMs?: number;
  socket?: NwcSocketFactory;
}

/** NWC's codes for a payment that went out and did not arrive: a `failed`
 *  answer. Any other error is a refusal before sending. */
const NWC_FAILED = new Set(["PAYMENT_FAILED"]);

/**
 * `pay_invoice { invoice }` over the pay connection (NIP-47): `{ preimage,
 * fees_paid? }`. NIP-47 takes no fee cap: the wallet's own limit applies.
 * A call published to the relay that gets no answer in time is `pending`
 * (the wallet may be paying it); `status` reads it with `lookup_invoice`.
 */
export class NwcPayer implements Payer {
  readonly provider = "nwc" as const;
  readonly capsFee = false;
  readonly #pay: NwcClient;
  readonly #receive: NwcClient | null;
  readonly #timeoutMs: number;

  constructor(opts: NwcPayerOptions) {
    this.#timeoutMs = opts.timeoutMs ?? NWC_PAY_TIMEOUT_MS;
    this.#pay = new NwcClient({ url: opts.payUrl, timeoutMs: Math.min(this.#timeoutMs, 15_000), ...(opts.socket ? { socket: opts.socket } : {}) });
    this.#receive = opts.url ? new NwcClient({ url: opts.url, timeoutMs: Math.min(this.#timeoutMs, 15_000), ...(opts.socket ? { socket: opts.socket } : {}) }) : null;
  }

  minFeeMsat(): number {
    return 0;
  }

  async pay(req: PayRequest): Promise<PayResult> {
    checkPayRequest(req);
    let paymentHash: string;
    try {
      paymentHash = decodeBolt11(req.invoice).paymentHash;
    } catch (err) {
      throw new LightningError("bad_request", err instanceof Error ? err.message : String(err));
    }
    let published = false;
    let result: Record<string, unknown>;
    try {
      result = await this.#pay.request("pay_invoice", { invoice: req.invoice.trim() }, { timeoutMs: this.#timeoutMs, onPublished: () => (published = true) });
    } catch (err) {
      if (!(err instanceof LightningError)) throw err;
      if (err.walletCode && NWC_FAILED.has(err.walletCode)) {
        return { paymentHash, state: "failed", feeMsat: 0, error: err.message.replace(/^wallet_refused: /, "") };
      }
      // On the relay and no answer: the wallet may be paying it.
      if (published && err.code === "wallet_unavailable") return { paymentHash, state: "pending", feeMsat: 0 };
      throw err;
    }
    const preimage = provenPreimage(result["preimage"], paymentHash);
    // A pay that answers with no preimage that proves it: read where it stands.
    if (!preimage) return this.status({ ...req, paymentHash });
    return { paymentHash, state: "settled", feeMsat: wholeMsat(result["fees_paid"]), preimage };
  }

  async status(req: PayRequest & { paymentHash: string }): Promise<PayResult> {
    const paymentHash = checkPaymentHash(req.paymentHash);
    let r: Record<string, unknown>;
    try {
      r = await this.#pay.request("lookup_invoice", { payment_hash: paymentHash });
    } catch (err) {
      if (!(err instanceof LightningError)) throw err;
      if (err.code === "wallet_unauthorized" && this.#receive) r = await this.#lookupOnReceive(paymentHash);
      else if (err.code === "invoice_unknown") return { paymentHash, state: "failed", feeMsat: 0, error: "the wallet has no payment for this invoice" };
      else throw err;
    }
    const state = r["state"];
    const preimage = provenPreimage(r["preimage"], paymentHash);
    if (state === "settled" || (state === undefined && typeof r["settled_at"] === "number")) {
      return { paymentHash, state: "settled", feeMsat: wholeMsat(r["fees_paid"]), ...(preimage ? { preimage } : {}) };
    }
    if (state === "failed" || state === "expired") return { paymentHash, state: "failed", feeMsat: 0, error: `the wallet says the payment ${state}` };
    return { paymentHash, state: "pending", feeMsat: 0 };
  }

  async #lookupOnReceive(paymentHash: string): Promise<Record<string, unknown>> {
    try {
      return await this.#receive!.request("lookup_invoice", { payment_hash: paymentHash });
    } catch (err) {
      if (err instanceof LightningError && err.code === "invoice_unknown") return { state: "failed" };
      throw err;
    }
  }
}

// ── which ─────────────────────────────────────────────────────────────────

/** The payer a wallet on file can make, or null when it has no pay
 *  credential. Server code's alone. */
export function payerFor(settings: WalletCredentials, deps: { http?: HttpCapability; socket?: NwcSocketFactory } = {}): Payer | null {
  if (settings.provider === "sphinx") {
    return settings.payToken ? new SphinxDaemonPayer({ url: settings.url, payToken: settings.payToken, ...(deps.http ? { http: deps.http } : {}) }) : null;
  }
  return settings.payUrl ? new NwcPayer({ payUrl: settings.payUrl, url: settings.url, ...(deps.socket ? { socket: deps.socket } : {}) }) : null;
}
