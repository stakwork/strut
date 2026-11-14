/** EARNINGS (plans/paid-runs.md §8): the words and figures every place
 *  that shows what a server earned writes them with — strut's own Earnings
 *  tab (`web/src/earnings.ts` re-exports them) and the `strut/earnings` app.
 *  Dollars for earned, cost and margin; sats for what a wallet holds, and for
 *  what workers are owed for accepted answers (plans/human-steps.md §8.1),
 *  beside the wallet's cover of it. Pure. */

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
  if (r.code === "short_of_workers") return `Refused: ${said}. Their pay comes out of this wallet; add sats or withdraw less.`;
  if (r.code === "balance_unknown") return `Refused: ${said}.`;
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

// ── What workers are owed (plans/human-steps.md §8.1, "The books") ─────────
//
// A debt in SATS for accepted answers, beside the credit owed as service,
// which is in dollars. The wallet must hold it, held and withdrawable both:
// its COVER is the balance less what workers are owed. A strut that never
// paid a worker shows none of it.

/** `GET /earnings`' `workers`. */
export interface WorkersView {
  owedMsat: number;
  heldMsat: number;
  withdrawableMsat: number;
  payees: number;
  accepted: { answers: number; msat: number; days: Array<{ day: string; answers: number; msat: number; takenBackAnswers: number; takenBackMsat: number }> };
  takenBack: { answers: number; msat: number };
  /** Payouts on their way now (plans/human-steps.md §8.2); absent on a strut from before them. */
  outMsat?: number;
  /** Paid to workers in the range, from their withdrawals: the sats they received and the fees. */
  paidOut?: { count: number; msat: number; feeMsat: number; days: Array<{ day: string; count: number; msat: number; feeMsat: number }> };
}

/** Whether a page shows what workers are owed: once any worker was paid
 *  (something is owed, or answers earned in the range, or a payout went out
 *  or is on its way). A strut that never paid one reads as it did before
 *  workers were paid. */
export function showsWorkers(w: WorkersView | undefined): w is WorkersView {
  return !!w && (w.owedMsat > 0 || w.payees > 0 || w.accepted.answers > 0 || w.takenBack.answers > 0 || (w.paidOut?.count ?? 0) > 0 || (w.outMsat ?? 0) > 0);
}

/** The line under "Paid to workers": `3 withdrawals · fees 12 sats`. */
export function workersPaidSub(w: WorkersView): string {
  const p = w.paidOut ?? { count: 0, feeMsat: 0 };
  return `${p.count} withdrawal${p.count === 1 ? "" : "s"} · fees ${fmtSats(p.feeMsat)}`;
}

/** What a send still on its way is for, after its amount: nothing for a
 *  person's withdrawal. */
export function sendPurposeNote(purpose: "withdrawal" | "purchase" | "worker"): string {
  return purpose === "purchase" ? " · credit" : purpose === "worker" ? " · a worker's payout" : "";
}

/** Payouts still on their way to workers, in a line; null when none. */
export function workersOutLine(w: WorkersView): string | null {
  return (w.outMsat ?? 0) > 0 ? `${fmtSats(w.outMsat!)} on its way to workers: reserved, not yet settled.` : null;
}

/** The line under "Owed to workers": `≈ $19.00 · 9,000 sats held, 10,000
 *  sats withdrawable · 2 workers` (or `all held`, `all withdrawable`).
 *  Dollars at the rate of the moment. */
export function workersOwedSub(w: WorkersView, usdPerBtc?: number): string {
  const parts: string[] = [];
  if (usdPerBtc && w.owedMsat > 0) parts.push(`≈ ${fmtUsd(usdOfMsat(w.owedMsat, usdPerBtc))}`);
  if (w.owedMsat > 0) {
    parts.push(
      w.withdrawableMsat <= 0 ? "all held" : w.heldMsat <= 0 ? "all withdrawable" : `${fmtSats(w.heldMsat)} held, ${fmtSats(w.withdrawableMsat)} withdrawable`,
    );
  }
  parts.push(`${w.payees} worker${w.payees === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** The answers the range accepted, in a line: `12 answers accepted, 30,000
 *  sats; 1 taken back (2,000 sats).` */
export function workersAcceptedLine(w: WorkersView): string {
  const a = w.accepted;
  const head = `${a.answers} answer${a.answers === 1 ? "" : "s"} accepted from workers, earning ${fmtSats(a.msat)}`;
  return w.takenBack.answers > 0 ? `${head}; ${w.takenBack.answers} of them taken back (${fmtSats(w.takenBack.msat)}).` : `${head}.`;
}

/** A day's Workers cell: the sats that day's answers earned, less what of
 *  them was taken back since. */
export const workersDayMsat = (d: { msat: number; takenBackMsat: number }): number => d.msat - d.takenBackMsat;

/** Whether the wallet covers what workers are owed, in a line; `short` when
 *  it does not. Null when nothing is owed or the balance was not read. */
export function coverLine(wallet: { coverMsat?: number; owedToWorkersMsat?: number } | undefined): { text: string; short: boolean } | null {
  const owed = wallet?.owedToWorkersMsat ?? 0;
  if (!wallet || owed <= 0 || wallet.coverMsat === undefined) return null;
  if (wallet.coverMsat >= 0) return { short: false, text: `Covers the ${fmtSats(owed)} workers are owed, with ${fmtSats(wallet.coverMsat)} to spare.` };
  return { short: true, text: `Short of what workers are owed by ${fmtSats(-wallet.coverMsat)}: they are owed ${fmtSats(owed)}. Add sats to cover it.` };
}

/** Withdraw's refusal when paying would leave the wallet short of what
 *  workers are owed (plans/human-steps.md §8.2, ruling 7: 5a warned, 5b
 *  refuses; `POST /earnings/withdraw` answers `409 short_of_workers`). The
 *  most it may ask is the amount less the shortfall: the fee cap falls with
 *  the amount, so that always leaves what is owed. */
export function shortOfWorkersRefusal(s: { afterMsat: number; owedMsat: number; shortMsat: number }, msat: number): string {
  return `Refused: paying this would leave the wallet ${fmtSats(s.shortMsat)} short of the ${fmtSats(s.owedMsat)} workers are owed for accepted answers. Withdraw at most ${fmtSats(Math.max(0, msat - s.shortMsat))}.`;
}
