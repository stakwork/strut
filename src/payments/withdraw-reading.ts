/**
 * A BOLT11 invoice read for a WITHDRAWAL (plans/paid-runs.md §8): the amount
 * it asks, the fee cap it is paid with, and why it cannot be paid, before
 * anything is sent. Pure and browser-safe: strut's own Withdraw dialog
 * (web/src/earnings.ts re-exports it) and the `earnings/read-invoice` step
 * the `strut/earnings` app calls read an invoice with this, so what the
 * person confirms is what `POST /earnings/withdraw` checks.
 *
 * Given what WORKERS are owed (plans/human-steps.md §8.1), it also says when
 * the amount would leave the wallet short of it. The dialogs refuse then, as
 * the route does (`409 short_of_workers`: ruling 7, 5a warned, 5b refuses).
 */

import { Bolt11Error, decodeBolt11, type DecodedInvoice } from "./bolt11.js";
import { defaultMaxFeeMsat } from "./fee.js";

/** Dollars for msat at a rate (dollars per bitcoin). */
const usdOfMsat = (msat: number, usdPerBtc: number): number => (msat / 1000 / 100_000_000) * usdPerBtc;

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
  /** Paid, it would leave the wallet short of what workers are owed (when
   *  the balance and what is owed are known): what would be left at the
   *  least — the amount and its whole fee cap out — and by how much it
   *  falls short. */
  shortOfWorkers?: { afterMsat: number; owedMsat: number; shortMsat: number };
}

/** What paying `msat` with a fee of at most `maxFeeMsat` leaves of
 *  `balanceMsat` at the least, and how far short of `owedMsat` that is;
 *  undefined when it covers what is owed. */
export function shortOfWorkers(o: { balanceMsat: number; msat: number; maxFeeMsat: number; owedMsat: number }): WithdrawReading["shortOfWorkers"] {
  if (o.owedMsat <= 0) return undefined;
  const afterMsat = Math.max(0, o.balanceMsat - o.msat - o.maxFeeMsat);
  return afterMsat < o.owedMsat ? { afterMsat, owedMsat: o.owedMsat, shortMsat: o.owedMsat - afterMsat } : undefined;
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
  o: { balanceMsat?: number; usdPerBtc?: number; nowMs?: number; provider?: string | null; owedToWorkersMsat?: number } = {},
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
  const maxFeeMsat = defaultMaxFeeMsat(inv.msat);
  const short =
    o.balanceMsat !== undefined && o.owedToWorkersMsat
      ? shortOfWorkers({ balanceMsat: o.balanceMsat, msat: inv.msat, maxFeeMsat, owedMsat: o.owedToWorkersMsat })
      : undefined;
  return {
    ok: true,
    invoice: inv,
    msat: inv.msat,
    maxFeeMsat,
    expiresIn,
    ...(o.usdPerBtc ? { usd: usdOfMsat(inv.msat, o.usdPerBtc) } : {}),
    overBalance: o.balanceMsat !== undefined && inv.msat > maxWithdrawMsat(o.provider, o.balanceMsat),
    ...(inv.network !== "bc" ? { network: NETWORKS[inv.network] ?? inv.network } : {}),
    ...(short ? { shortOfWorkers: short } : {}),
  };
}

