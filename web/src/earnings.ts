// ── Earnings: the pure parts of what the four places show ──────────────────
//
// plans/paid-runs.md §8. Dollars for earned, cost and margin (decision 27),
// sats for what the wallet holds. The Withdraw dialog reads an invoice with
// the server's own BOLT11 reader and fee rule (src/payments/bolt11.ts,
// fee.ts: browser-safe), so what the person confirms is what
// `POST /earnings/withdraw` checks.

import { Bolt11Error, decodeBolt11, type DecodedInvoice } from "../../src/payments/bolt11.js";
import { defaultMaxFeeMsat } from "../../src/payments/fee.js";

/** Dollars, the way the Earnings tab writes them: cents, but a sub-cent
 *  amount keeps four places (a single run is often a fraction of a cent). */
export function fmtUsd(usd: number): string {
  const sign = usd < 0 ? "−" : "";
  const a = Math.abs(usd);
  if (a === 0) return "$0";
  if (a < 0.01) return `${sign}$${a.toFixed(4)}`;
  return `${sign}$${a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** msat as sats, grouped: `12,345 sats`. Whole sats from 100 up (a
 *  wallet's balance is never read to the msat); a small amount, a fee, keeps
 *  up to three places. */
export function fmtSats(msat: number): string {
  const sats = msat / 1000;
  const shown = Math.abs(sats) >= 100 ? Math.round(sats) : Math.round(sats * 1000) / 1000;
  return `${shown.toLocaleString("en-US", { maximumFractionDigits: 3 })} sat${shown === 1 ? "" : "s"}`;
}

/** Dollars for msat at a rate (dollars per bitcoin). */
export const usdOfMsat = (msat: number, usdPerBtc: number): number => (msat / 1000 / 100_000_000) * usdPerBtc;

/** A ledger subject as a person reads it: `workflow:acme/rig` → the kind
 *  and the name; `expired` → credit that reached its year unused. */
export function subjectLabel(key: string): { kind: "workflow" | "tool" | "expired" | "other"; name: string } {
  if (key === "expired") return { kind: "expired", name: "Credit unused after a year" };
  const i = key.indexOf(":");
  if (i < 0) return { kind: "other", name: key };
  const kind = key.slice(0, i);
  return { kind: kind === "workflow" ? "workflow" : kind === "step" ? "tool" : "other", name: key.slice(i + 1) };
}

/** The ranges the Earnings tab offers. `from` is the first UTC day; none is
 *  all time. */
export const RANGES = [
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
  { id: "90d", label: "90 days", days: 90 },
  { id: "all", label: "All time", days: 0 },
] as const;
export type RangeId = (typeof RANGES)[number]["id"];

export function rangeFrom(id: RangeId, now = Date.now()): string | undefined {
  const r = RANGES.find((x) => x.id === id);
  if (!r || !r.days) return undefined;
  return new Date(now - (r.days - 1) * 86_400_000).toISOString().slice(0, 10);
}

/** The price an item is sold at, in a line: `$0.10 + 2× cost`, `2× cost`,
 *  `$0.25 a run`, `free`. */
export function priceLine(p: { base?: number; markup?: number } | undefined): string {
  const base = p?.base ?? 0;
  const markup = p?.markup ?? 0;
  if (!base && !markup) return "free";
  if (!markup) return `${fmtUsd(base)} a run`;
  if (!base) return `${markup}× cost`;
  return `${fmtUsd(base)} + ${markup}× cost`;
}

/** Why Withdraw is off, or null when it may be pressed. */
export function withdrawBlocked(wallet: { provider: string | null; receive: boolean; pay: boolean } | undefined): string | null {
  if (!wallet || (!wallet.provider && !wallet.pay)) return "No wallet is set: add one under Wallet below.";
  if (!wallet.pay) {
    return wallet.provider === "nwc"
      ? "The wallet can receive but not pay: add an NWC connection that may pay under Wallet below."
      : "The wallet can receive but not pay: add the daemon's pay token under Wallet below.";
  }
  return null;
}

// ── The Withdraw dialog ────────────────────────────────────────────────────

export interface WithdrawReading {
  ok: true;
  invoice: DecodedInvoice;
  msat: number;
  /** The cap it is paid with (the Sphinx LSP's own limit). */
  maxFeeMsat: number;
  /** Seconds until it expires (≤ 0: expired). */
  expiresIn: number;
  /** What it asks, at the rate shown. */
  usd?: number;
  /** It asks for more than can be withdrawn (when the balance is known). */
  overBalance: boolean;
  /** Not a mainnet invoice: which network it names (the wallet decides). */
  network?: string;
}

const NETWORKS: Record<string, string> = { tb: "testnet", tbs: "signet", bcrt: "regtest", sb: "simnet" };

/**
 * The most a person can withdraw out of a wallet holding `balanceMsat`. The
 * Sphinx daemon's provider takes the AMOUNT first and the routing fee from
 * what is left after it — taking none when too little is left — so the
 * whole balance can go. An NWC wallet keeps its routing fee back from it:
 * the amount and the fee cap must both fit.
 */
export function maxWithdrawMsat(provider: string | null | undefined, balanceMsat: number): number {
  if (provider === "nwc") {
    // The largest amount whose own fee cap still fits beside it.
    let lo = 0;
    let hi = balanceMsat;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (mid + defaultMaxFeeMsat(mid) <= balanceMsat) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  return Math.max(0, balanceMsat);
}

/** What the person pasted, read: the amount it asks, its cap, and why it
 *  cannot be paid, before anything is sent. The network is the wallet's to
 *  judge, as the route leaves it: a test stack pays a regtest invoice. */
export function readWithdrawInvoice(
  text: string,
  o: { balanceMsat?: number; usdPerBtc?: number; nowMs?: number; provider?: string | null } = {},
): WithdrawReading | { ok: false; error: string } {
  const s = text.trim();
  if (!s) return { ok: false, error: "" };
  let inv: DecodedInvoice;
  try {
    inv = decodeBolt11(s);
  } catch (err) {
    return { ok: false, error: err instanceof Bolt11Error ? `Not an invoice strut can read: ${err.message}.` : "Not a BOLT11 invoice." };
  }
  if (inv.msat === undefined) return { ok: false, error: "This invoice names no amount. Ask for one that does, so what you confirm is what is paid." };
  const expiresIn = inv.expiresAt - Math.floor((o.nowMs ?? Date.now()) / 1000);
  if (expiresIn <= 0) return { ok: false, error: "This invoice has expired. Ask for a new one." };
  return {
    ok: true,
    invoice: inv,
    msat: inv.msat,
    maxFeeMsat: defaultMaxFeeMsat(inv.msat),
    expiresIn,
    ...(o.usdPerBtc ? { usd: usdOfMsat(inv.msat, o.usdPerBtc) } : {}),
    overBalance: o.balanceMsat !== undefined && inv.msat > maxWithdrawMsat(o.provider, o.balanceMsat),
    ...(inv.network !== "bc" ? { network: NETWORKS[inv.network] ?? inv.network } : {}),
  };
}

/** A refusal from `POST /earnings/withdraw`, as the dialog says it. The
 *  wallet's own words follow when it gave them. */
export function withdrawRefusal(r: { error?: string; code?: string; walletCode?: string }): string {
  const said = (r.error ?? "").replace(/^[a-z_]+: /, "");
  switch (r.walletCode ?? r.code) {
    case "max_fee_too_low":
      return `The wallet's routing fee limit is higher than the cap: ${said}`;
    case "own_invoice":
      return "That invoice is this wallet's own: paste one from the wallet the sats should go to.";
    case "expired":
      return "The invoice expired before it was paid. Ask for a new one.";
    case "no_pay_credential":
      return "The wallet has no pay credential. Add one under Wallet.";
    case "amount_mismatch":
      return `The invoice is not for the amount confirmed: ${said}`;
    case "INSUFFICIENT_BALANCE":
      return `The wallet does not hold enough: ${said}`;
  }
  if (r.code === "wallet_unavailable") return `The wallet did not answer: ${said}. If it was sent, it shows as pending below; asking again reads where it stands.`;
  if (r.code === "wallet_unauthorized") return `The wallet refused strut's pay credential: ${said}`;
  return said || "The wallet refused the payment.";
}

/** `in 9 min`, `in 2 h`, for an invoice's expiry. */
export function fmtExpiresIn(secs: number): string {
  if (secs < 90) return `in ${Math.max(0, Math.round(secs))} s`;
  if (secs < 90 * 60) return `in ${Math.round(secs / 60)} min`;
  if (secs < 36 * 3600) return `in ${Math.round(secs / 3600)} h`;
  return `in ${Math.round(secs / 86_400)} days`;
}

/** Rows sorted for a table: most earned first, then by name. */
export function byEarned<T extends { key: string; earned: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.earned - a.earned || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
