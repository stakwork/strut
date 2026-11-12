// What the `earnings/*` steps answer (specs/API.md §18–§19), as this page reads it.
import type { PendingSend, WalletInfo } from "./view";

export interface EarningsRow {
  key: string;
  calls: number;
  failed: number;
  earned: number;
  cost: number;
  margin: number;
  price?: { base?: number; markup?: number };
}

export interface EarningsView {
  totals: Omit<EarningsRow, "key" | "price">;
  rows: EarningsRow[];
  outstanding: { tokens: number; usd: number; held: number };
  received: { count: number; msat: number; usd: number; days: Array<{ day: string; count: number; msat: number; usd: number }> };
  withdrawn: { count: number; msat: number; feeMsat: number; days: Array<{ day: string; count: number; msat: number; feeMsat: number }> };
  purchases: { count: number; msat: number; feeMsat: number };
  deposited: { count: number; msat: number; days: Array<{ day: string; count: number; msat: number }> };
  pending: PendingSend[];
  wallet?: WalletInfo & {
    balance?: { msat: number; sats: number; usd?: number };
    rate?: number;
    error?: string;
    expectedMsat: number;
    pendingMsat: number;
    differenceMsat?: number;
  };
}

/** `earnings/withdraw` and `earnings/withdrawal-read`. */
export type PaymentAnswer =
  | { ok: true; state: "settled" | "pending" | "failed"; paymentHash: string; msat: number; feeMsat: number; maxFeeMsat: number; error?: string; existing?: true; reading?: true }
  | { ok: false; status: number; error: string; code?: string; walletCode?: string };

/** `earnings/deposit` and `earnings/deposit-read`. */
export interface DepositAnswer {
  state: "pending" | "settled" | "expired";
  paymentHash: string;
  msat: number;
  expires: string;
  invoice?: string;
  qr?: string;
  deposit?: { at: string; msat: number };
  error?: string;
}

/** `earnings/read-invoice`. */
export type InvoiceReading =
  | { ok: true; msat: number; maxFeeMsat: number; expiresIn: number; usd?: number; overBalance: boolean; network?: string; invoice: { description?: string } }
  | { ok: false; error: string };

/** `earnings/remote-credit { balance: true }`, one seller. */
export interface HeldAtSeller {
  seller: string;
  credit?: { usd: number; sats: number; boughtAt: string; expires: string };
  purchase?: { usd: number; sats: number; at: number; sent?: boolean; lastError?: string };
  runs: number;
  balance?: { remaining_usd?: number; held_usd?: number; spent_usd?: number; expires?: string; expired?: boolean; replaced?: boolean; error?: string };
}
