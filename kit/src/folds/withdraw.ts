/** WITHDRAW (plans/human-steps.md §8.2): whether a worker can withdraw now,
 *  read off `task/me` — the one decision the host's account widget and the
 *  Tasks app both draw from, so the two never disagree on one page. A
 *  Withdraw is offered only when one can go through; otherwise why not, and
 *  nothing at all when there is nothing to withdraw. Pure. */

/** What `task/me`'s `payout` says (src/payments/payouts.ts `view`), read
 *  loosely: a host reads the raw answer. */
export interface PayoutRead {
  on?: unknown;
  why?: unknown;
  minMsat?: unknown;
  dayLeftMsat?: unknown;
  maxMsat?: unknown;
  out?: { msat?: unknown } | undefined;
}

/** Why a worker with something to withdraw can't now. */
export type WithdrawBlock = "no_address" | "off" | "cannot_pay" | "not_here" | "day_limit" | "below_min" | "paused";

export type WithdrawState =
  /** Nothing to withdraw, or a server that says nothing of payouts: no Withdraw, nothing said. */
  | { kind: "none" }
  /** A Withdraw for `maxMsat`, the most one may ask now. */
  | { kind: "ready"; maxMsat: number }
  /** A withdrawal of `msat` on its way: none other until it lands. */
  | { kind: "out"; msat: number }
  /** Something to withdraw, and why it can't go now; `minMsat` and `feeMsat` say the minimum when `below_min`. */
  | { kind: "blocked"; why: WithdrawBlock; minMsat: number; feeMsat: number };

/** The routing-fee cap a withdrawal is paid with: the Sphinx LSP's own limit,
 *  0.5% or 5 sats when that is more. The same figure as
 *  src/payments/fee.ts `defaultMaxFeeMsat` (a test holds them equal), which a
 *  page can't import. */
export function withdrawFeeMsat(msat: number): number {
  return Math.max(5000, Math.floor(msat * 0.005));
}

/** What a worker holding `freeMsat` past its hold can do with it now. The
 *  server's `maxMsat` decides whether a Withdraw is offered; when it is 0 on
 *  an open server, the day's cap or the minimum (with the fee on top, as
 *  `payoutMaxMsat` counts it) says why, else the server's own cap for the day. */
export function withdrawState(freeMsat: number, p: PayoutRead | undefined): WithdrawState {
  if (!p) return { kind: "none" };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (typeof p.out?.msat === "number") return { kind: "out", msat: p.out.msat };
  const maxMsat = num(p.maxMsat);
  if (p.on === true && maxMsat > 0) return { kind: "ready", maxMsat };
  if (!(freeMsat > 0)) return { kind: "none" };
  const minMsat = num(p.minMsat);
  const feeMsat = withdrawFeeMsat(minMsat);
  const blocked = (why: WithdrawBlock): WithdrawState => ({ kind: "blocked", why, minMsat, feeMsat });
  switch (p.why) {
    case "no_address": return blocked("no_address");
    case "off": return blocked("off");
    case "no_wallet":
    case "no_keysend": return blocked("cannot_pay");
    case "not_here": return blocked("not_here");
  }
  if (p.on !== true) return { kind: "none" };
  if (num(p.dayLeftMsat) < minMsat) return blocked("day_limit");
  if (freeMsat < minMsat + feeMsat) return blocked("below_min");
  return blocked("paused");
}
