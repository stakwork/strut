// The Earnings app's own words (plans/paid-runs.md §8), pure: what strut's
// tab says from its pieces, said for a page whose wallet settings live with
// whoever runs the server. The figures are the kit's (`@strut/kit/folds`
// earnings), the same strut's own tab writes with. Tested by
// src/apps/earnings.test.ts.

export interface WalletInfo {
  provider: "sphinx" | "nwc" | null;
  receive: boolean;
  pay: boolean;
  url?: string;
  relays?: string[];
  env?: boolean;
  host?: boolean;
  check?: { ok: true; msat: number } | { ok: false; error: string };
}

export interface PendingSend {
  paymentHash: string;
  msat: number;
  at: number;
  purpose: "withdrawal" | "purchase" | "worker";
  payer: string;
  stale: boolean;
  reading: boolean;
  otherWallet: boolean;
  answered?: boolean;
  lastError?: string;
}

/** Why Withdraw is off, or null when it may be pressed. */
export function withdrawBlocked(w: { provider: string | null; receive: boolean; pay: boolean } | undefined): string | null {
  if (!w || (!w.provider && !w.pay)) return "No wallet is set on this server.";
  if (!w.pay) return "The wallet can receive but not pay: whoever runs this server adds its pay credential.";
  return null;
}

/** Why Add sats is off, or null. */
export function addBlocked(w: { receive: boolean } | undefined): string | null {
  return w?.receive ? null : "No wallet that receives is set on this server.";
}

/** The wallet in a line: which one, and who sets it. */
export function walletLine(w: WalletInfo | undefined): string {
  if (!w) return "";
  if (w.host) return "This server's host provides the wallet.";
  if (!w.provider) return "No wallet is set: nothing can be sold for sats until one is.";
  const which = w.provider === "sphinx" ? "Sphinx daemon" : "NWC wallet";
  const where = w.url ?? w.relays?.join(", ") ?? "";
  const who = w.env ? "set by this server's deployment" : "set in strut's console";
  return `${which}${where ? ` at ${where}` : ""}, ${who}.`;
}

/** A send still out, in a line: where it stands and what a person may do. */
export function pendingState(p: PendingSend): string {
  if (p.reading) return "being read now";
  if (p.otherWallet) return `went out through another wallet (${p.payer || "an earlier one"})`;
  if (p.stale) return "stale: the wallet will not say more — record it as paid if it left the wallet, or drop it";
  if (p.answered) return "sent, not settled yet: read again every minute";
  return "the wallet never answered: read it now";
}

/** Whether a person decides a send by hand (Record as paid, Drop). */
export const decidesByHand = (p: PendingSend): boolean => p.stale || p.otherWallet;

/** The Add sats amounts offered first. */
export const DEPOSIT_PRESETS = [10_000, 50_000, 100_000, 500_000] as const;
/** What the server accepts (src/payments/deposits.ts). */
export const DEPOSIT_MAX_SATS = 10_000_000;

/** An amount typed for Add sats: whole sats, 1 to the most, else why not. */
export function depositAmount(text: string): { sats: number } | { error: string } {
  const t = text.replace(/[,_\s]/g, "");
  if (!t) return { error: "" };
  if (!/^\d+$/.test(t)) return { error: "A whole number of sats." };
  const sats = Number(t);
  if (sats < 1) return { error: "At least 1 sat." };
  if (sats > DEPOSIT_MAX_SATS) return { error: `At most ${DEPOSIT_MAX_SATS.toLocaleString("en-US")} sats at a time.` };
  return { sats };
}
