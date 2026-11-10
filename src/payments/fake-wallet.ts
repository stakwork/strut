/**
 * A wallet in memory, for tests and the later items' tests
 * (plans/paid-runs.md §9 "A fake, for tests"). It makes invoices, and a
 * test settles them on command, in full or SHORT (§4.3 credits a short
 * payment in proportion), expires them, lists them, and can be taken down
 * (every call `wallet_unavailable`) to test a 503.
 *
 * Its invoices are not BOLT11: `lnfake1<msat>n<payment hash>`, which no
 * wallet pays. Its preimages are real: sha256(preimage) is the payment
 * hash, so an L402 check runs against it unchanged.
 */

import { createHash, randomBytes } from "node:crypto";
import { LightningError, checkPaymentHash, type Invoice, type InvoiceLookup, type LightningProvider, type ReceivedPayment } from "./lightning.js";

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
}

const FAKE_PREFIX = "lnfake1";

export class FakeWallet implements LightningProvider {
  readonly #now: () => number;
  readonly #defaultExpiry: number;
  readonly #invoices = new Map<string, FakeInvoice>();
  #startMsat: number;
  #down: string | null = null;
  /** Every call made, in order: what a test asserts on. */
  readonly calls: Array<{ method: "makeInvoice" | "lookup" | "received" | "balance"; arg?: unknown }> = [];

  constructor(opts: FakeWalletOptions = {}) {
    this.#now = opts.now ?? Date.now;
    this.#startMsat = opts.startMsat ?? 0;
    this.#defaultExpiry = opts.defaultExpirySecs ?? 3600;
  }

  // ── the capability ─────────────────────────────────────────────────────

  async makeInvoice(o: { msat: number; description?: string; expirySecs?: number }): Promise<Invoice> {
    this.calls.push({ method: "makeInvoice", arg: o });
    this.#up();
    const preimage = randomBytes(32).toString("hex");
    const payment_hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
    const now = this.#now();
    const inv: FakeInvoice = {
      invoice: `${FAKE_PREFIX}${o.msat}n${payment_hash}`,
      payment_hash,
      preimage,
      msat: o.msat,
      ...(o.description !== undefined ? { description: o.description } : {}),
      createdAt: now,
      expiresAt: now + (o.expirySecs ?? this.#defaultExpiry) * 1000,
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
    const hash = ref.startsWith(FAKE_PREFIX) ? ref.slice(ref.lastIndexOf("n") + 1) : ref.toLowerCase();
    const inv = this.#invoices.get(hash);
    if (!inv) throw new Error(`fake wallet: no invoice ${ref.slice(0, 80)}`);
    return inv;
  }
}
