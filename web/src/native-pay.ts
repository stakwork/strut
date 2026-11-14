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
// The same native host SIGNS A VISITOR IN (`sign_in`, specs/WALLET.md §1.2):
// the person's Sphinx account signs the seller's visitor challenge, method
// `sphinx` (plans/app-payments.md §4.4). `signInAsk` builds what the sign-in
// flow asks it: the request checked as the native host will check it (the
// challenge is for the SELLER's host, and has not ended), one `sign_in`, its
// answer read; the session is then the provider's (../visitor-signin).
//
// It also builds the APP's identity for its own wallet connection
// (`nativeWalletApp`, specs/WALLET.md §1.1), naming the seller, for a
// member's page and a visitor's alike.
//
// Pure, apart from the native host it is handed, so the root test run
// covers it (native-pay.test.ts); ./app-host wires it, the sheets
// (components/PaymentSheet.tsx, components/SignInSheet.tsx) draw it.

import {
  NATIVE_WALLET_HANDLER, buyCreditNatively, connectionRequestProblems, creditStatusNatively, nativeWalletAppProblems, nativeWalletOf,
  probeHostWallet, signInNatively, signInRequestProblems, visitorChallengeClaims,
  type ConnectionRequest, type CreditPurchase, type CreditReplyOutcome, type HostWalletCapability, type NativeWallet, type NativeWalletApp,
  type SignInRequest, type WalletErrorCode,
} from "@strut/kit/wallet";
import type { CheckedChallenge } from "./challenge";
import type { PaymentRequired } from "./visitor-pay";

/** The longest the page waits on the native wallet's sheet, as for an app's
 *  sheets (specs/WALLET.md §1.1's 10 minutes): the invoice's end, at most. */
export const WALLET_WAIT_MAX_MS = 10 * 60_000;
/** How long the native host has to say what it takes. */
export const WALLET_PROBE_MS = 5_000;

/** A native host that buys credit or signs a visitor in, as this page found it. */
export interface HostWallet {
  native: NativeWallet;
  cap: HostWalletCapability;
}

/** The native host's capability, asked ONCE per page — again only when the
 *  handler itself changed — so no sheet ever waits on the question: the
 *  relay asks it as it connects, a priced launch or a sign-in reads the
 *  answer. Resolves undefined with no native host, or one that neither buys
 *  credit nor signs a visitor in. */
export function createHostWalletProbe(probe: (native: NativeWallet) => Promise<HostWalletCapability | undefined> = (n) => probeHostWallet(n, WALLET_PROBE_MS)) {
  let known: { handler: unknown; found: Promise<HostWallet | undefined> } | undefined;
  return (win: unknown): Promise<HostWallet | undefined> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (win as any)?.webkit?.messageHandlers?.[NATIVE_WALLET_HANDLER];
    if (known && known.handler === handler) return known.found;
    const native = nativeWalletOf(win);
    const found = native
      ? probe(native).then((cap) => (cap?.ops.includes("buy_credit") || cap?.ops.includes("sign_in") ? { native, cap } : undefined), () => undefined)
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

// ── Signing a visitor in through the native wallet (`sign_in`) ─────────────

/** How a `sign_in` ended, as the sign-in flow reads it: the key and its
 *  signature to post as method `sphinx`, or why not — `declined` when the
 *  person said no on the native host's sheet. */
export type SignInAnswerOf =
  | { outcome: "signed"; key: string; sig: string; address?: string }
  | { outcome: "refused"; code: WalletErrorCode; message: string; declined: boolean };

/** What the sign-in flow asks the native wallet. */
export interface SignInAsk {
  /** What the sheet calls it: the native host's own name, or "your wallet". */
  name: string;
  /** One `sign_in` of `challenge` (the seller's, just fetched). */
  sign(challenge: string): Promise<SignInAnswerOf>;
}

/** The sign-in ask, or undefined — no native host here, one that does not
 *  sign a visitor in, or no app to name: then `sphinx` is not offered. */
export function signInAsk(o: {
  wallet: HostWallet | undefined;
  seller: string;
  app: { name: string; version: string; title: string } | undefined;
  now?: () => number;
}): SignInAsk | undefined {
  const { wallet, app } = o;
  if (!wallet || !app || !wallet.cap.ops.includes("sign_in")) return undefined;
  const now = o.now ?? Date.now;
  return {
    name: wallet.cap.wallet ?? "your wallet",
    async sign(challenge) {
      const request: SignInRequest = {
        v: 1,
        op: "sign_in",
        seller: o.seller,
        app: { name: app.name.slice(0, 1000), version: app.version.slice(0, 1000), title: (app.title || app.name).slice(0, 1000) },
        challenge,
      };
      // A seller's junk — a challenge for another host, one that ended —
      // is never put to the wallet.
      const problems = signInRequestProblems(request, now());
      if (problems.length) return { outcome: "refused", code: "BAD_REQUEST", message: `the server's sign-in challenge does not check out: ${problems.join("; ")}, so nothing was signed`, declined: false };
      // The seller refuses a challenge past its end: wait no longer.
      const r = await signInNatively(wallet.native, request, { timeoutMs: visitorChallengeClaims(challenge)!.exp - now() });
      return r.outcome === "signed" ? r : { ...r, declined: r.code === "USER_REJECTED" };
    },
  };
}

/** The sheet's line after the wallet did not sign the visitor in. */
export function signInNote(a: Extract<SignInAnswerOf, { outcome: "refused" }>, name = "your wallet"): string {
  const Name = name[0]!.toUpperCase() + name.slice(1);
  if (a.declined) return `You declined in ${name}.`;
  if (a.code === "RESTRICTED") return `${Name} did not sign you in (${a.message}). Press Sign in with ${name} to confirm there.`;
  return `${Name} did not sign you in (${a.message}).`;
}

// ── The app's own wallet connection (specs/WALLET.md §1.1) ────────────────
// Not the host's: an app whose version requests a wallet (`app.yaml`'s
// `wallet:`) is offered the native host's, and its `strut/wallet/*` calls
// are relayed there (`relayNativeWallet`). A member's page and a VISITOR's
// alike (plans/app-payments.md §11 R8): this server's public app, or
// another server's (`from`). The identity names the SELLER, so the native
// host keys the connection by the server whose app it is.

/** The strut server a page's app is of, as its base URL: what `seller`
 *  names in a purchase, a sign-in and an app's identity. Another server's
 *  (`from`), or this one's: the UI's API prefix (`apiBase`) on the page's
 *  own address (`href`). */
export function sellerOf(from: string | undefined, apiBase: string, href: string): string {
  return from ?? new URL(`${apiBase}/`, href).href.replace(/\/+$/, "");
}

/** The app as a native host's wallet names it (`NativeWalletApp`), for a
 *  version that requests a wallet; undefined for one that asks for none,
 *  or for a request that is not one (a stranger's server may answer
 *  anything): then the page is offered no wallet. `request` is the
 *  version's `wallet:` — from its `dist/build.json` for a member's page,
 *  from the public read (`GET /public/apps/:name`, this server's or
 *  `from`'s) for a visitor's. */
export function nativeWalletApp(o: {
  app: { name: string; version: string; peer?: string };
  title: string;
  request: unknown;
  seller: string;
}): NativeWalletApp | undefined {
  if (!o.request || connectionRequestProblems(o.request).length) return undefined;
  const app: NativeWalletApp = {
    name: o.app.name,
    version: o.app.version,
    ...(o.app.peer ? { peer: o.app.peer } : {}),
    seller: o.seller,
    title: o.title,
    request: o.request as ConnectionRequest,
  };
  return nativeWalletAppProblems(app).length ? undefined : app;
}
