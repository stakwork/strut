/**
 * A wallet in memory, for tests and the later items' tests
 * (plans/paid-runs.md §9 "A fake, for tests"). It makes invoices, and a
 * test settles them on command, in full or SHORT (§4.3 credits a short
 * payment in proportion), expires them, lists them, and can be taken down
 * (every call `wallet_unavailable`) to test a 503.
 *
 * Its invoices are not BOLT11: `lnfake1<msat>n<payment hash>`, which no
 * wallet pays — unless `bolt11: true`, which makes them readable BOLT11
 * (`encodeBolt11`, zero-signed), for a test where another strut's payer
 * pays them (plans/paid-runs.md §10, a strut that buys). Its preimages are
 * real: sha256(preimage) is the payment hash, so an L402 check runs
 * against it unchanged.
 */

import { createHash, randomBytes } from "node:crypto";
import { decodeBolt11, encodeBolt11 } from "./bolt11.js";
import { LightningError, checkPaymentHash, type Invoice, type InvoiceLookup, type LightningProvider, type ReceivedPayment } from "./lightning.js";
import { lspFeeFloorMsat, NO_KEYSEND, type KeysendRequest, type KeysendResult, type PayRequest, type PayResult, type Payer } from "./payer.js";

/** One invoice as the fake keeps it. Times are epoch ms. */
export interface FakeInvoice {
  invoice: string;
  payment_hash: string;
  preimage: string;
  msat: number;
  description?: string;
  createdAt: number;
  expiresAt: number;
  /** What settled, once it did: `msat` in full, or less. */
  settled?: { msat: number; at: number };
  /** Expired by `expire()`, whatever the clock says. */
  expired?: true;
}

export interface FakeWalletOptions {
  /** The clock, epoch ms. Default `Date.now`. */
  now?: () => number;
  /** msat the wallet held before any invoice here settled. */
  startMsat?: number;
  /** An invoice's lifetime when the caller names none: an hour, as the daemon. */
  defaultExpirySecs?: number;
  /** Make BOLT11 invoices a payer can read (zero-signed): for a buyer's test. */
  bolt11?: boolean;
}

const FAKE_PREFIX = "lnfake1";

export class FakeWallet implements LightningProvider {
  readonly #now: () => number;
  readonly #defaultExpiry: number;
  readonly #bolt11: boolean;
  readonly #invoices = new Map<string, FakeInvoice>();
  #startMsat: number;
  #down: string | null = null;
  /** Every call made, in order: what a test asserts on. */
  readonly calls: Array<{ method: "makeInvoice" | "lookup" | "received" | "balance"; arg?: unknown }> = [];

  constructor(opts: FakeWalletOptions = {}) {
    this.#now = opts.now ?? Date.now;
    this.#startMsat = opts.startMsat ?? 0;
    this.#defaultExpiry = opts.defaultExpirySecs ?? 3600;
    this.#bolt11 = !!opts.bolt11;
  }

  // ── the capability ─────────────────────────────────────────────────────

  async makeInvoice(o: { msat: number; description?: string; expirySecs?: number }): Promise<Invoice> {
    this.calls.push({ method: "makeInvoice", arg: o });
    this.#up();
    const preimage = randomBytes(32).toString("hex");
    const payment_hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
    const now = this.#now();
    const expirySecs = o.expirySecs ?? this.#defaultExpiry;
    const inv: FakeInvoice = {
      invoice: this.#bolt11
        ? encodeBolt11({ msat: o.msat, paymentHash: payment_hash, ...(o.description !== undefined ? { description: o.description } : {}), timestamp: Math.floor(now / 1000), expirySecs })
        : `${FAKE_PREFIX}${o.msat}n${payment_hash}`,
      payment_hash,
      preimage,
      msat: o.msat,
      ...(o.description !== undefined ? { description: o.description } : {}),
      createdAt: now,
      expiresAt: now + expirySecs * 1000,
    };
    this.#invoices.set(payment_hash, inv);
    return { invoice: inv.invoice, payment_hash, expires: new Date(inv.expiresAt).toISOString() };
  }

  async lookup(payment_hash: string): Promise<InvoiceLookup> {
    this.calls.push({ method: "lookup", arg: payment_hash });
    this.#up();
    const inv = this.#invoices.get(checkPaymentHash(payment_hash));
    if (!inv) throw new LightningError("invoice_unknown", `the fake wallet has no invoice ${payment_hash}`);
    if (inv.settled) {
      return { state: "settled", msat: inv.settled.msat, settled_at: new Date(inv.settled.at).toISOString(), preimage: inv.preimage };
    }
    return { state: this.#isExpired(inv) ? "expired" : "pending" };
  }

  async received(o: { since?: string; limit?: number }): Promise<ReceivedPayment[]> {
    this.calls.push({ method: "received", arg: o });
    this.#up();
    const since = o.since ? Date.parse(o.since) : -Infinity;
    return [...this.#invoices.values()]
      .filter((inv): inv is FakeInvoice & { settled: NonNullable<FakeInvoice["settled"]> } => !!inv.settled && inv.settled.at >= since)
      .sort((a, b) => a.settled.at - b.settled.at)
      .slice(0, o.limit ?? Infinity)
      .map((inv) => ({ payment_hash: inv.payment_hash, msat: inv.settled.msat, at: new Date(inv.settled.at).toISOString() }));
  }

  async balance(): Promise<{ msat: number }> {
    this.calls.push({ method: "balance" });
    this.#up();
    let msat = this.#startMsat;
    for (const inv of this.#invoices.values()) msat += inv.settled?.msat ?? 0;
    return { msat };
  }

  // ── a test's controls ──────────────────────────────────────────────────

  /** Pay an invoice (by its payment hash or its invoice string): in full,
   *  or `msat` of it, less than it asked (a short payment the Sphinx core
   *  settles today, plans/paid-runs.md §4.3). Throws for an invoice that
   *  is unknown, expired or already settled. Returns its preimage. */
  settle(ref: string, opts: { msat?: number } = {}): string {
    const inv = this.#find(ref);
    if (inv.settled) throw new Error(`fake wallet: ${inv.payment_hash} is already settled`);
    if (this.#isExpired(inv)) throw new Error(`fake wallet: ${inv.payment_hash} has expired`);
    const msat = opts.msat ?? inv.msat;
    if (!Number.isSafeInteger(msat) || msat <= 0 || msat > inv.msat) throw new Error(`fake wallet: settle msat must be from 1 to the invoice's ${inv.msat}`);
    inv.settled = { msat, at: this.#now() };
    return inv.preimage;
  }

  /** Expire an invoice now, whatever its lifetime. A settled one stays settled. */
  expire(ref: string): void {
    const inv = this.#find(ref);
    if (!inv.settled) inv.expired = true;
  }

  /** Every invoice made, oldest first, with its preimage. */
  invoices(): FakeInvoice[] {
    return [...this.#invoices.values()].sort((a, b) => a.createdAt - b.createdAt).map((i) => ({ ...i }));
  }

  /** Take the wallet down (`true`, or the reason) or bring it back (`false`):
   *  while down every call is `wallet_unavailable`. */
  down(on: boolean | string = true): void {
    this.#down = on === false ? null : on === true ? "the fake wallet is down" : on;
  }

  /** Add to the balance, as a payment made elsewhere would. */
  credit(msat: number): void {
    this.#startMsat += msat;
  }

  #up(): void {
    if (this.#down) throw new LightningError("wallet_unavailable", this.#down);
  }

  #isExpired(inv: FakeInvoice): boolean {
    return !!inv.expired || this.#now() >= inv.expiresAt;
  }

  #find(ref: string): FakeInvoice {
    const hash = ref.startsWith(FAKE_PREFIX) ? ref.slice(ref.lastIndexOf("n") + 1) : ref.startsWith("ln") ? decodeBolt11(ref).paymentHash : ref.toLowerCase();
    const inv = this.#invoices.get(hash);
    if (!inv) throw new Error(`fake wallet: no invoice ${ref.slice(0, 80)}`);
    return inv;
  }
}

// ── the pay side, for tests ─────────────────────────────────────────────

/** How a FakePayer answers the next pay: a state, or a refusal before
 *  anything is sent (a `LightningError`). */
export type FakePayOutcome = "settled" | "pending" | "failed" | LightningError;

/**
 * A payer in memory (payer.ts's `Payer`), for the withdraw tests and the
 * browser demo: it pays a BOLT11 invoice by the outcome a test queues
 * (settled by default), keeps a pending one until the test settles or fails
 * it, and, like the Sphinx daemon, answers a payment hash it already paid as
 * it stands, paying only a failed one again. It takes the daemon's fee floor.
 *
 * It keysends too, as the daemon's `POST /keysend` does (plans/human-steps.md
 * §8.2): by the same queued outcomes, once per id — the same id again answers
 * that payment as it stands, a failed one included — and reads one by id
 * without sending (`keysendStatus`), an id it never took `failed`.
 * `noKeysend` models a daemon without the route; `forget(id)` one that lost
 * its ledger.
 */
export class FakePayer implements Payer {
  readonly provider = "sphinx" as const;
  readonly capsFee = true;
  /** Which wallet it is: a test changes it to model another wallet. */
  id = "sphinx:fake";
  /** Outcomes for the next pays, in order; empty → settled. */
  readonly outcomes: FakePayOutcome[] = [];
  /** The fee a settled payment costs: a share of the amount, within the cap. */
  feeShare = 0.001;
  readonly #payments = new Map<string, PayResult & { msat: number; invoice: string }>();
  /** Every pay and status call, in order. */
  readonly calls: Array<{ method: "pay" | "status" | "keysend" | "keysendStatus"; paymentHash: string; maxFeeMsat: number; address?: string; msat?: number }> = [];
  /** A daemon without `POST /keysend`: every keysend is refused `no_keysend`. */
  noKeysend = false;
  /** The wallet it pays out of: each settled payment, fee included, comes
   *  off its balance, as a real wallet's would. */
  wallet?: FakeWallet;
  readonly #keysends = new Map<string, KeysendResult & { msat: number; address: string }>();

  minFeeMsat(msat: number): number {
    return lspFeeFloorMsat(msat);
  }

  async pay(req: PayRequest): Promise<PayResult> {
    const inv = this.#decode(req.invoice);
    this.calls.push({ method: "pay", paymentHash: inv.paymentHash, maxFeeMsat: req.maxFeeMsat });
    const had = this.#payments.get(inv.paymentHash);
    if (had && had.state !== "failed") return this.#answer(had);
    const outcome = this.outcomes.shift() ?? "settled";
    if (outcome instanceof LightningError) throw outcome;
    if (req.maxFeeMsat < this.minFeeMsat(inv.msat!)) {
      throw new LightningError("wallet_refused", `max_fee_msat ${req.maxFeeMsat} is below the LSP's own fee limit for ${inv.msat} msat, ${this.minFeeMsat(inv.msat!)}`, "max_fee_too_low");
    }
    const p = { paymentHash: inv.paymentHash, msat: inv.msat!, invoice: req.invoice, state: outcome, feeMsat: 0 } as PayResult & { msat: number; invoice: string };
    this.#payments.set(inv.paymentHash, p);
    if (outcome === "settled") this.#settle(p, req.maxFeeMsat);
    if (outcome === "failed") p.error = "no route found";
    return this.#answer(p);
  }

  async status(req: PayRequest & { paymentHash: string }): Promise<PayResult> {
    this.calls.push({ method: "status", paymentHash: req.paymentHash, maxFeeMsat: req.maxFeeMsat });
    const p = this.#payments.get(req.paymentHash);
    if (!p) return this.pay(req);
    if (p.state === "failed") return this.pay(req);
    return this.#answer(p);
  }

  async keysend(req: KeysendRequest): Promise<KeysendResult> {
    this.calls.push({ method: "keysend", paymentHash: req.id, maxFeeMsat: req.maxFeeMsat, address: req.address, msat: req.msat });
    if (this.noKeysend) throw new LightningError("wallet_refused", "the fake daemon has no POST /keysend", NO_KEYSEND);
    const had = this.#keysends.get(req.id);
    if (had) return this.#keysendAnswer(had);
    const outcome = this.outcomes.shift() ?? "settled";
    if (outcome instanceof LightningError) throw outcome;
    if (req.maxFeeMsat < this.minFeeMsat(req.msat)) {
      throw new LightningError("wallet_refused", `max_fee_msat ${req.maxFeeMsat} is below the LSP's own fee limit for ${req.msat} msat, ${this.minFeeMsat(req.msat)}`, "max_fee_too_low");
    }
    const k: KeysendResult & { msat: number; address: string; maxFeeMsat?: number } = { id: req.id, msat: req.msat, address: req.address, state: outcome, feeMsat: 0, maxFeeMsat: req.maxFeeMsat };
    this.#keysends.set(req.id, k);
    if (outcome === "settled") this.#settleKeysend(k, req.maxFeeMsat);
    if (outcome === "failed") k.error = "no route found";
    return this.#keysendAnswer(k);
  }

  async keysendStatus(req: { id: string }): Promise<KeysendResult> {
    this.calls.push({ method: "keysendStatus", paymentHash: req.id, maxFeeMsat: 0 });
    if (this.noKeysend) throw new LightningError("wallet_refused", "the fake daemon has no GET /keysend/:id", NO_KEYSEND);
    const k = this.#keysends.get(req.id);
    if (!k) return { id: req.id, state: "failed", feeMsat: 0, error: "the daemon never took this payment" };
    return this.#keysendAnswer(k);
  }

  /** Forget a keysend, as a daemon that lost its ledger would. */
  forget(id: string): void {
    this.#keysends.delete(id);
  }

  /** The keysends it took, by id: address, amount, state and fee. */
  keysends(): Array<{ id: string; address: string; msat: number; state: KeysendResult["state"]; feeMsat: number }> {
    return [...this.#keysends.values()].map((k) => ({ id: k.id, address: k.address, msat: k.msat, state: k.state, feeMsat: k.feeMsat }));
  }

  #settleKeysend(k: KeysendResult & { msat: number; maxFeeMsat?: number }, maxFeeMsat: number): void {
    k.state = "settled";
    k.feeMsat = Math.min(maxFeeMsat, Math.ceil(k.msat * this.feeShare));
    k.paymentHash = createHash("sha256").update(k.id).digest("hex");
    delete k.error;
    this.wallet?.credit(-(k.msat + k.feeMsat));
  }

  #keysendAnswer(k: KeysendResult): KeysendResult {
    return { id: k.id, state: k.state, feeMsat: k.state === "settled" ? k.feeMsat : 0, ...(k.paymentHash ? { paymentHash: k.paymentHash } : {}), ...(k.error && k.state === "failed" ? { error: k.error } : {}) };
  }

  /** Settle a pending payment (by its payment hash, or a keysend's id). */
  settle(paymentHash: string, maxFeeMsat = Number.MAX_SAFE_INTEGER): void {
    const k = this.#keysends.get(paymentHash);
    if (k) {
      if (k.state !== "pending") throw new Error(`fake payer: keysend ${paymentHash} is not pending`);
      this.#settleKeysend(k, Math.min(maxFeeMsat, (k as { maxFeeMsat?: number }).maxFeeMsat ?? maxFeeMsat));
      return;
    }
    const p = this.#payments.get(paymentHash);
    if (!p || p.state !== "pending") throw new Error(`fake payer: ${paymentHash} is not pending`);
    this.#settle(p, maxFeeMsat);
  }

  /** Fail a pending payment (by its payment hash, or a keysend's id). */
  fail(paymentHash: string, error = "no route found"): void {
    const k = this.#keysends.get(paymentHash);
    if (k) {
      if (k.state !== "pending") throw new Error(`fake payer: keysend ${paymentHash} is not pending`);
      k.state = "failed";
      k.error = error;
      return;
    }
    const p = this.#payments.get(paymentHash);
    if (!p || p.state !== "pending") throw new Error(`fake payer: ${paymentHash} is not pending`);
    p.state = "failed";
    p.error = error;
  }

  /** What it paid out, settled, fees included: invoices and keysends. */
  paidMsat(): number {
    let msat = 0;
    for (const p of this.#payments.values()) if (p.state === "settled") msat += p.msat + p.feeMsat;
    for (const k of this.#keysends.values()) if (k.state === "settled") msat += k.msat + k.feeMsat;
    return msat;
  }

  #settle(p: PayResult & { msat: number }, maxFeeMsat: number): void {
    p.state = "settled";
    p.feeMsat = Math.min(maxFeeMsat, Math.ceil(p.msat * this.feeShare));
    p.preimage = undefined;
    delete p.error;
    this.wallet?.credit(-(p.msat + p.feeMsat));
  }

  #answer(p: PayResult): PayResult {
    return { paymentHash: p.paymentHash, state: p.state, feeMsat: p.state === "settled" ? p.feeMsat : 0, ...(p.error && p.state === "failed" ? { error: p.error } : {}) };
  }

  #decode(invoice: string) {
    let inv;
    try {
      inv = decodeBolt11(invoice);
    } catch (err) {
      throw new LightningError("wallet_refused", `invoice is not a BOLT11 invoice: ${(err as Error).message}`, "bad_request");
    }
    if (!inv.msat) throw new LightningError("wallet_refused", "the invoice names no amount", "bad_request");
    return inv;
  }
}
