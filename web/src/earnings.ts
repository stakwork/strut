// ── Earnings: the pure parts of what the four places show ──────────────────
//
// plans/paid-runs.md §8. Dollars for earned, cost and margin (decision 27),
// sats for what the wallet holds and for what workers are owed
// (plans/human-steps.md §8.1). The words are the kit's
// (kit/src/folds/earnings.ts), which the `strut/earnings` app writes with
// too; the Withdraw dialog reads an invoice with the server's own reader
// (src/payments/withdraw-reading.ts over bolt11.ts and fee.ts: browser-safe),
// so what the person confirms is what `POST /earnings/withdraw` checks.

export {
  RANGES,
  byEarned,
  coverLine,
  fmtExpiresIn,
  fmtSats,
  fmtUsd,
  priceLine,
  rangeFrom,
  sendPurposeNote,
  shortOfWorkersRefusal,
  showsWorkers,
  subjectLabel,
  usdOfMsat,
  withdrawRefusal,
  workersAcceptedLine,
  workersDayMsat,
  workersOutLine,
  workersOwedSub,
  workersPaidSub,
  type RangeId,
  type WorkersView,
} from "@strut/kit/folds";
export { maxWithdrawMsat, readWithdrawInvoice, shortOfWorkers, type WithdrawReading } from "../../src/payments/withdraw-reading.js";

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
