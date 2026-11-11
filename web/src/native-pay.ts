// ── A visitor's credit, paid with one tap in a native host (specs/WALLET.md §1.2)
//
// When this page is the main frame of a native host's web view (Peel), the
// host wallet pays a visitor's priced launch before anyone sees a QR code:
// strut's UI asks the native host what it takes (`host_capability`), sends
// ONE `buy_credit` with the invoice it checked (./challenge), and gets back
// the payment — settled with a preimage that proves it, pending, or a
// refusal. The credit token is then `<macaroon>:<preimage>`, kept by this
// page and never handed to the native host or the frame. Anything but a
// proven payment — no native host, one that does not buy credit, a decline,
// a failed or pending payment, a preimage that proves nothing, no answer
// before the invoice ends — and the sheet shows the invoice as a QR code,
// whose claim (./visitor-pay `createClaimKeeper`) was running from the
// start: a payment the native host did make still buys the credit.
//
// Pure, apart from the native host it is handed, so the root test run
// covers it (native-pay.test.ts); ./app-host wires it, the sheet
// (components/PaymentSheet.tsx) draws it.

import { buyCreditNatively, probeHostWallet, type CreditPurchase, type NativeWallet } from "@strut/kit/wallet";
import type { CheckedChallenge } from "./challenge";
import type { PaymentRequired } from "./visitor-pay";

/** The longest the page waits on the native wallet's sheet, as for an app's
 *  sheets (specs/WALLET.md §1.1's 10 minutes): the invoice's end, at most. */
export const WALLET_WAIT_MAX_MS = 10 * 60_000;
/** How long the native host has to say what it takes. */
export const WALLET_PROBE_MS = 5_000;

/** What the native host is asked to buy: the checked invoice, the server's
 *  quote, and what the credit is for — the server, the app, the workflow. */
export function creditPurchaseOf(
  p: PaymentRequired,
  checked: CheckedChallenge,
  ctx: { seller: string; app: { name: string; version: string; title: string }; workflow: string },
): CreditPurchase {
  return {
    invoice: checked.invoice.invoice,
    payment_hash: checked.paymentHash,
    amount: checked.msat,
    sats: p.sats,
    usd: p.usd,
    ...(p.rate ? { rate: { usd_per_btc: p.rate.usdPerBtc, at: p.rate.at, source: p.rate.source } } : {}),
    description: (p.description ?? `${ctx.workflow}: credit`).slice(0, 1000),
    expires_at: checked.expiresAt,
    seller: ctx.seller,
    app: { name: ctx.app.name.slice(0, 1000), version: ctx.app.version.slice(0, 1000), title: (ctx.app.title || ctx.app.name).slice(0, 1000) },
    workflow: (ctx.workflow || "a workflow").slice(0, 1000),
    credit: {
      carries: !!p.carries,
      ...(p.reason === "short" || p.reason === "expired" || p.reason === "replaced" ? { reason: p.reason } : {}),
      ...(typeof p.remaining_usd === "number" && p.remaining_usd >= 0 ? { remaining_usd: p.remaining_usd } : {}),
    },
  };
}

/** How long to wait on the native wallet: until the invoice ends, never
 *  past `WALLET_WAIT_MAX_MS`, and 0 once it has ended. */
export function walletWaitMs(expiresAt: number, nowMs = Date.now()): number {
  return Math.max(0, Math.min(WALLET_WAIT_MAX_MS, expiresAt * 1000 - nowMs));
}

/** How the native wallet's try ended, as the sheet reads it. */
export type WalletAnswer =
  | { outcome: "paid"; credential: string }
  | { outcome: "pending" }
  | { outcome: "fallback"; reason: string; declined: boolean };

/** Ask the native host to pay (above). Never throws. */
export async function payWithNativeWallet(o: {
  native: NativeWallet;
  purchase: CreditPurchase;
  macaroon: string;
  timeoutMs: number;
  signal?: AbortSignal;
  probeMs?: number;
}): Promise<WalletAnswer> {
  const cap = await probeHostWallet(o.native, o.probeMs ?? WALLET_PROBE_MS);
  if (!cap?.ops.includes("buy_credit")) return { outcome: "fallback", reason: "this wallet does not pay for a page's credit", declined: false };
  const r = await buyCreditNatively(o.native, o.purchase, {
    timeoutMs: o.timeoutMs,
    ...(o.signal ? { signal: o.signal } : {}),
    cancel: cap.ops.includes("buy_credit_cancel"),
  });
  if (r.outcome === "paid") return { outcome: "paid", credential: `${o.macaroon}:${r.preimage}` };
  if (r.outcome === "pending") return { outcome: "pending" };
  return { outcome: "fallback", reason: r.message, declined: r.code === "USER_REJECTED" };
}

/** The wallet ask the sheet runs first, or undefined — no native host here
 *  (a plain browser), or no app to name — and the sheet shows the invoice
 *  as a QR code from the start. */
export function walletAsk(o: {
  native: NativeWallet | undefined;
  p: PaymentRequired;
  checked: CheckedChallenge;
  seller: string;
  app: { name: string; version: string; title: string } | undefined;
  workflow: string;
  now?: () => number;
}): ((signal: AbortSignal) => Promise<WalletAnswer>) | undefined {
  const { native, app } = o;
  if (!native || !app) return undefined;
  const purchase = creditPurchaseOf(o.p, o.checked, { seller: o.seller, app, workflow: o.workflow });
  return (signal) =>
    payWithNativeWallet({ native, purchase, macaroon: o.p.macaroon, timeoutMs: walletWaitMs(o.checked.expiresAt, (o.now ?? Date.now)()), signal });
}

/** The sheet's line over the QR code after the wallet did not pay. */
export function fallbackNote(a: Extract<WalletAnswer, { outcome: "fallback" }>): string {
  if (a.declined) return "You declined in your wallet. Pay this invoice from another wallet, or cancel.";
  return `Your wallet did not pay it (${a.reason}). Pay this invoice from another wallet, or cancel.`;
}
