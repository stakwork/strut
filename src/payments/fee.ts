/**
 * The routing-fee cap a withdrawal is paid with (plans/paid-runs.md §8).
 * Pure and browser-safe: the Withdraw dialog shows the same figure the
 * route sends (payer.ts re-exports it).
 */

/** The Sphinx LSP's own routing-fee limit for an invoice of `msat` (CLN
 *  `pay`'s defaults, sphinx `wasm/daemon/src/wallet.ts` `lspFeeCapMsat`):
 *  0.5% of the amount, or 5 sats when that is more. The daemon refuses a
 *  `max_fee_msat` below it (`max_fee_too_low`). */
export function lspFeeFloorMsat(msat: number): number {
  return Math.max(5000, Math.floor(msat * 0.005));
}

/** The cap a withdrawal is paid with when the person names none: the LSP's
 *  own limit, which is also the most the daemon's LSP ever charges, so a
 *  higher one would buy nothing. An NWC wallet is shown the same figure. */
export function defaultMaxFeeMsat(msat: number): number {
  return lspFeeFloorMsat(msat);
}
