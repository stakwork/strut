// ── A visitor's credit, paid with one tap in a native host (specs/WALLET.md §1.2)
//
// When this page is the main frame of a native host's web view (Peel), the
// host's wallet pays a visitor's priced launch before anyone sees a QR code.
// strut's UI asks the native host once per page what it takes
// (`host_capability`, `createHostWalletProbe`), sends ONE `buy_credit` with
// the invoice it checked (./challenge), and reads the answer:
// - **paid**: settled, with a preimage that PROVES it. The credit token is
//   `<macaroon>:<preimage>`, kept by this page, never handed to the native
//   host or the frame.
// - **pending**: the person tapped and the payment was sent (or says it
//   settled, unproven). The invoice is NOT shown again: a seller holding the
//   first payment knows the preimage and could settle a second one.
//   `buy_credit_status` and the claim say how it ends.
// - **fallback**: nothing was sent. That is a decline, a refusal (the
//   native host wants a fresh tap: "Pay with ⟨wallet⟩" gives it one), a
//   payment that failed, or no answer before the invoice ends. The invoice
//   is shown as a QR code.
// The invoice is claimed (./visitor-pay `createClaimKeeper`) from the start,
// so a payment whose answer was lost still buys the credit.
//
// Pure, apart from the native host it is handed, so the root test run
// covers it (native-pay.test.ts); ./app-host wires it, the sheet
// (components/PaymentSheet.tsx) draws it.

import {
  NATIVE_WALLET_HANDLER, buyCreditNatively, creditStatusNatively, nativeWalletOf, probeHostWallet,
  type CreditPurchase, type CreditReplyOutcome, type HostWalletCapability, type NativeWallet, type WalletErrorCode,
} from "@strut/kit/wallet";
import type { CheckedChallenge } from "./challenge";
import type { PaymentRequired } from "./visitor-pay";

/** The longest the page waits on the native wallet's sheet, as for an app's
 *  sheets (specs/WALLET.md §1.1's 10 minutes): the invoice's end, at most. */
export const WALLET_WAIT_MAX_MS = 10 * 60_000;
/** How long the native host has to say what it takes. */
export const WALLET_PROBE_MS = 5_000;

/** A native host that buys credit, as this page found it. */
export interface HostWallet {
  native: NativeWallet;
  cap: HostWalletCapability;
}

/** The native host's capability, asked ONCE per page — again only when the
 *  handler itself changed — so no sheet ever waits on the question: the
 *  relay asks it as it connects, a priced launch reads the answer. Resolves
 *  undefined with no native host, or one that does not buy credit. */
export function createHostWalletProbe(probe: (native: NativeWallet) => Promise<HostWalletCapability | undefined> = (n) => probeHostWallet(n, WALLET_PROBE_MS)) {
  let known: { handler: unknown; found: Promise<HostWallet | undefined> } | undefined;
  return (win: unknown): Promise<HostWallet | undefined> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (win as any)?.webkit?.messageHandlers?.[NATIVE_WALLET_HANDLER];
    if (known && known.handler === handler) return known.found;
    const native = nativeWalletOf(win);
    const found = native
      ? probe(native).then((cap) => (cap?.ops.includes("buy_credit") ? { native, cap } : undefined), () => undefined)
      : Promise.resolve(undefined);
    known = { handler, found };
    return found;
  };
}

/** What the native host is asked to buy: the checked invoice, the server's
 *  figures, and what the credit is for — the server, the app, the workflow. */
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

/** How a try of the native wallet ended, as the sheet reads it. */
export type WalletAnswer =
  | { outcome: "paid"; credential: string }
  | { outcome: "pending" }
  | { outcome: "fallback"; reason: string; code: WalletErrorCode; declined: boolean };

/** What the sheet asks the native wallet. */
export interface WalletAsk {
  /** What the sheet calls it: the native host's own name, or "your wallet". */
  name: string;
  /** One `buy_credit`. `onLate` gets the answer should it come after the
   *  sheet stopped waiting (the person chose the invoice): a payment sent
   *  after all hides the QR code. */
  pay(signal: AbortSignal, onLate?: (a: WalletAnswer) => void): Promise<WalletAnswer>;
  /** Where a pending purchase stands, when the native host answers that. */
  status?(): Promise<WalletAnswer>;
}

function answerOf(r: CreditReplyOutcome, macaroon: string): WalletAnswer {
  if (r.outcome === "paid") return { outcome: "paid", credential: `${macaroon}:${r.preimage}` };
  if (r.outcome === "pending") return { outcome: "pending" };
  return { outcome: "fallback", reason: r.message, code: r.code, declined: r.code === "USER_REJECTED" };
}

/** The wallet ask the sheet runs first, or undefined — no native host here
 *  (a plain browser), one that does not buy credit, or no app to name — and
 *  the sheet shows the invoice as a QR code from the start. */
export function walletAsk(o: {
  wallet: HostWallet | undefined;
  p: PaymentRequired;
  checked: CheckedChallenge;
  seller: string;
  app: { name: string; version: string; title: string } | undefined;
  workflow: string;
  now?: () => number;
}): WalletAsk | undefined {
  const { wallet, app } = o;
  if (!wallet || !app || !wallet.cap.ops.includes("buy_credit")) return undefined;
  const purchase = creditPurchaseOf(o.p, o.checked, { seller: o.seller, app, workflow: o.workflow });
  const macaroon = o.p.macaroon;
  return {
    name: wallet.cap.wallet ?? "your wallet",
    pay: async (signal, onLate) =>
      answerOf(
        await buyCreditNatively(wallet.native, purchase, {
          timeoutMs: walletWaitMs(o.checked.expiresAt, (o.now ?? Date.now)()),
          signal,
          cancel: wallet.cap.ops.includes("buy_credit_cancel"),
          ...(onLate ? { onLate: (r: CreditReplyOutcome) => onLate(answerOf(r, macaroon)) } : {}),
        }),
        macaroon,
      ),
    ...(wallet.cap.ops.includes("buy_credit_status")
      ? { status: async () => answerOf(await creditStatusNatively(wallet.native, purchase.payment_hash), macaroon) }
      : {}),
  };
}

/** The sheet's line over the QR code after the wallet did not pay. */
export function fallbackNote(a: Extract<WalletAnswer, { outcome: "fallback" }>, name = "your wallet"): string {
  const Name = name[0]!.toUpperCase() + name.slice(1);
  if (a.declined) return `You declined in ${name}. Pay this invoice from another wallet, or ask ${name} again.`;
  if (a.code === "RESTRICTED") return `${Name} did not pay it (${a.reason}). Press Pay with ${name} to confirm there, or pay this invoice from another wallet.`;
  if (a.code === "PAYMENT_FAILED") return `${Name} could not pay it (${a.reason}): nothing was paid. Pay this invoice from another wallet, or try ${name} again.`;
  return `${Name} did not pay it (${a.reason}). Pay this invoice from another wallet, or try ${name} again.`;
}

/** How long a payment may stay `pending` before the sheet says it is
 *  taking long — a server may hold it until the invoice ends. */
export const PAYING_LONG_MS = 60_000;
/** How often the sheet asks where a pending payment stands. */
export const STATUS_EVERY_MS = 3_000;
