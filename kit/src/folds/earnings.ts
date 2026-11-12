/** EARNINGS (plans/paid-runs.md §8): the words and figures every place
 *  that shows what a server earned writes them with — strut's own Earnings
 *  tab (`web/src/earnings.ts` re-exports them) and the `strut/earnings` app.
 *  Dollars for earned, cost and margin; sats for what a wallet holds. Pure. */

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
