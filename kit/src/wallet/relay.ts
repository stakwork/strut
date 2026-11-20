/** The RELAY (specs/WALLET.md §1.1): what strut's UI runs when it is the main
 *  frame of a native host's web view (Peel). The app's frame asks over the
 *  MCP Apps bridge, the relay forwards each `strut/wallet/*` call to the
 *  native handler with the app it is for, and the native host's
 *  notifications come back the same way. The wallet, the connections, the
 *  budgets and the sheets are all the native host's: nothing is decided
 *  here, beyond refusing what `checkParams` refuses before it is sent.
 *
 *  No dependency: the bridge is anything with ext-apps' `AppBridge`'s
 *  `setRequestHandler` and `notification`. */
import {
  NATIVE_WALLET_GLOBAL, NATIVE_WALLET_HANDLER, WALLET_METHODS, WALLET_NOTIFICATION_METHOD, checkParams, hostWalletCapabilityOf,
  isWalletCapability, isWalletErrorCode, nativeAppKey, nativeWalletAppProblems, notificationProblems, readCreditReply, readSignInReply, walletErrorBody, walletRequestMethod,
  type CreditPurchase, type CreditReplyOutcome, type HostWalletCapability, type NativeWalletApp, type NativeWalletMessage,
  type NativeWalletReply, type SignInReplyOutcome, type SignInRequest, type WalletCapability, type WalletErrorBody, type WalletMethod,
  type WalletNotification,
} from "./protocol.js";

/** A StandardSchemaV1 that takes any value: the SDK wants one for a custom
 *  method, and the contract's own checks run elsewhere. */
export const PASS_THROUGH_SCHEMA = {
  "~standard": { version: 1 as const, vendor: "strut", validate: (value: unknown) => ({ value }) },
};

/** The native handler, as the relay calls it. */
export interface NativeWallet {
  postMessage(message: NativeWalletMessage): Promise<unknown>;
}

/** What the relay needs of ext-apps' `AppBridge`. */
export interface RelayBridge {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setRequestHandler(method: string, schemas: { params: typeof PASS_THROUGH_SCHEMA }, handler: (params: any) => unknown): void;
  notification(notification: { method: string; params?: Record<string, unknown> }): Promise<void>;
}

/** The native handler when this page is a native host's main frame
 *  (`window.webkit.messageHandlers.strutWallet`), else undefined. */
export function nativeWalletOf(win: unknown = globalThis): NativeWallet | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = (win as any)?.webkit?.messageHandlers?.[NATIVE_WALLET_HANDLER];
  if (!handler || typeof handler.postMessage !== "function") return undefined;
  return { postMessage: (message) => Promise.resolve(handler.postMessage(message)) };
}

/** Ask the native host what it offers this app. Undefined when it offers
 *  nothing, answers with something else, or not within `timeoutMs`: then
 *  the page simply has no wallet. An identity that is not one (no seller,
 *  a request that is not one: `nativeWalletAppProblems`) is never sent. */
export async function probeNativeWallet(native: NativeWallet, app: NativeWalletApp, timeoutMs = 5_000): Promise<WalletCapability | undefined> {
  if (nativeWalletAppProblems(app).length) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      native.postMessage({ v: 1, op: "capability", app }),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
    const result = (reply as { result?: unknown } | undefined)?.result;
    return isWalletCapability(result) ? result : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A JSON-RPC error the bridge answers with as it is: the SDK keeps a
 *  thrown error's `code` and `data`. */
function rpcError(body: WalletErrorBody): Error {
  return Object.assign(new Error(body.message), { code: body.code, data: body.data });
}

function errorBodyOf(raw: unknown): WalletErrorBody | undefined {
  const e = raw as { code?: unknown; message?: unknown; data?: { code?: unknown } } | undefined;
  if (!e || typeof e !== "object" || !isWalletErrorCode(e.data?.code)) return undefined;
  return walletErrorBody(e.data.code, typeof e.message === "string" && e.message ? e.message : e.data.code);
}

/** Register every `strut/wallet/*` method on the bridge, forwarded to the
 *  native host for `app`. A method the capability does not list answers
 *  `NOT_IMPLEMENTED` here; params `checkParams` refuses never leave the
 *  page. Returns what the native host's notifications for this app are
 *  handed to (`nativeWalletNotifications` routes them). */
export function relayNativeWallet(opts: {
  bridge: RelayBridge;
  native: NativeWallet;
  app: NativeWalletApp;
  capability: WalletCapability;
}): { notify(notification: WalletNotification): void } {
  const { bridge, native, app, capability } = opts;
  for (const method of WALLET_METHODS) {
    bridge.setRequestHandler(walletRequestMethod(method), { params: PASS_THROUGH_SCHEMA }, async (params: unknown) => {
      if (!capability.methods.includes(method)) {
        throw rpcError(walletErrorBody("NOT_IMPLEMENTED", `this host's wallet does not offer ${method}`));
      }
      const checked = checkParams(method as WalletMethod, params);
      if (!checked.ok) throw rpcError(checked.error);
      let reply: unknown;
      try {
        reply = await native.postMessage({ v: 1, op: "call", method, params: checked.params, app });
      } catch (err) {
        throw rpcError(walletErrorBody("INTERNAL", `the wallet did not answer: ${err instanceof Error ? err.message : String(err)}`));
      }
      const r = reply as NativeWalletReply | undefined;
      if (r && typeof r === "object" && "error" in r) {
        throw rpcError(errorBodyOf(r.error) ?? walletErrorBody("OTHER", "the wallet refused"));
      }
      if (r && typeof r === "object" && "result" in r) {
        // An app learns who signed in from `useVisitor()`, never from the
        // wallet (plans/app-payments.md §4.4): no node key reaches a page,
        // whatever the native host answered.
        if (method === "get_info" && r.result && typeof r.result === "object" && "pubkey" in r.result) {
          const { pubkey: _pubkey, ...info } = r.result as Record<string, unknown>;
          return info;
        }
        return r.result as Record<string, unknown>;
      }
      throw rpcError(walletErrorBody("INTERNAL", "the wallet answered with neither a result nor an error"));
    });
  }
  return {
    notify(notification) {
      if (!capability.notifications.includes(notification.notification_type)) return;
      if (notificationProblems(notification).length) return;
      void bridge.notification({ method: WALLET_NOTIFICATION_METHOD, params: notification as unknown as Record<string, unknown> });
    },
  };
}

type Listener = (notification: WalletNotification) => void;

/** The page's one entry for the native host's notifications,
 *  `window.strutWallet.notify(message)`, installed on first use, and the
 *  registry it routes by app (`nativeAppKey`). A message for an app no
 *  frame hosts, or one that is not a notification, is dropped. */
export function nativeWalletNotifications(win: unknown = globalThis): { register(app: { name: string; peer?: string }, listener: Listener): () => void } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = win as any;
  let registry = w.__strutWalletListeners as Map<string, Set<Listener>> | undefined;
  if (!registry) {
    registry = new Map();
    const routes = registry;
    Object.defineProperty(w, "__strutWalletListeners", { value: routes, configurable: true });
    w[NATIVE_WALLET_GLOBAL] = {
      notify(message: unknown) {
        let m = message;
        if (typeof m === "string") {
          try {
            m = JSON.parse(m);
          } catch {
            return;
          }
        }
        const n = m as { v?: unknown; app?: { name?: unknown; peer?: unknown }; notification?: unknown } | undefined;
        if (!n || n.v !== 1 || typeof n.app?.name !== "string") return;
        if (notificationProblems(n.notification).length) return;
        const key = nativeAppKey({ name: n.app.name, ...(typeof n.app.peer === "string" ? { peer: n.app.peer } : {}) });
        for (const listener of routes.get(key) ?? []) listener(n.notification as WalletNotification);
      },
    };
  }
  const routes = registry;
  return {
    register(app, listener) {
      const key = nativeAppKey(app);
      const set = routes.get(key) ?? new Set();
      set.add(listener);
      routes.set(key, set);
      return () => {
        set.delete(listener);
        if (!set.size) routes.delete(key);
      };
    },
  };
}

// ── The host's own purchase (specs/WALLET.md §1.2) ─────────────────────────

/** Ask the native host which of the host's own ops it takes. Undefined when
 *  it answers anything else, refuses, or says nothing within `timeoutMs` (an
 *  older native host): then there is no one-tap purchase, only the QR code. */
export async function probeHostWallet(native: NativeWallet, timeoutMs = 5_000): Promise<HostWalletCapability | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      native.postMessage({ v: 1, op: "host_capability" }),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
    return hostWalletCapabilityOf((reply as { result?: unknown } | undefined)?.result);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Buy credit through the native wallet: one `buy_credit`, read with
 *  `readCreditReply`. The wait ends at `timeoutMs` (the invoice's end, at the
 *  latest) or when `signal` aborts (the person chose the QR code, the page
 *  went): both a `fallback`, and the native host is asked to take its sheet
 *  down (`buy_credit_cancel`) when it said it can. Its answer, should it
 *  still come, goes to `onLate`: a payment it sent after all is no QR code's
 *  to pay again. A rejected message is a `fallback` too. Never throws. */
export async function buyCreditNatively(
  native: NativeWallet,
  purchase: CreditPurchase,
  o: { timeoutMs: number; signal?: AbortSignal; cancel?: boolean; onLate?: (outcome: CreditReplyOutcome) => void },
): Promise<CreditReplyOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  /** The page stopped waiting before the native host answered. */
  let gaveUp = false;
  const stop = (message: string): CreditReplyOutcome => ({ outcome: "fallback", code: "RESTRICTED", message });
  try {
    if (o.signal?.aborted) return stop("the page stopped waiting for the wallet");
    if (!(o.timeoutMs > 0)) return stop("the invoice has ended");
    const ended = new Promise<CreditReplyOutcome>((resolve) => {
      timer = setTimeout(() => { gaveUp = true; resolve(stop("the wallet did not answer before the invoice ended")); }, o.timeoutMs);
      onAbort = () => { gaveUp = true; resolve(stop("the page stopped waiting for the wallet")); };
      o.signal?.addEventListener("abort", onAbort, { once: true });
    });
    const answered = native.postMessage({ v: 1, op: "buy_credit", purchase }).then(
      (reply) => readCreditReply(reply, purchase.payment_hash),
      (err): CreditReplyOutcome => ({ outcome: "fallback", code: "INTERNAL", message: `the wallet did not answer: ${err instanceof Error ? err.message : String(err)}` }),
    );
    const outcome = await Promise.race([answered, ended]);
    if (gaveUp && o.onLate) void answered.then((late) => o.onLate?.(late));
    if (gaveUp && o.cancel) {
      // Its sheet may still be up: a yes now would pay for a page that has
      // moved on to the QR code (the claim would still credit it).
      native.postMessage({ v: 1, op: "buy_credit_cancel", payment_hash: purchase.payment_hash }).catch(() => undefined);
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) o.signal?.removeEventListener("abort", onAbort);
  }
}

/** Where a purchase the native host answered `pending` stands now
 *  (`buy_credit_status`), read as its first answer was. A host that does
 *  not answer within `timeoutMs`, or answers nothing a payment of this
 *  invoice, is `pending` still: the person tapped, so never the QR code on
 *  silence. Never throws. */
export async function creditStatusNatively(native: NativeWallet, paymentHash: string, timeoutMs = 5_000): Promise<CreditReplyOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      native.postMessage({ v: 1, op: "buy_credit_status", payment_hash: paymentHash }),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
    const r = await readCreditReply(reply, paymentHash);
    // Only a payment of this invoice that failed, or one proven, moves on.
    return r.outcome === "fallback" && r.code !== "PAYMENT_FAILED" ? { outcome: "pending" } : r;
  } catch {
    return { outcome: "pending" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Sign a visitor in through the native wallet (specs/WALLET.md §1.2
 *  "sign_in"): one request, read with `readSignInReply`. The wait ends at
 *  `timeoutMs` — the challenge's end: the seller refuses it after — as a
 *  `RESTRICTED` refusal. A rejected message is `INTERNAL`. Never throws. */
export async function signInNatively(native: NativeWallet, request: SignInRequest, o: { timeoutMs: number }): Promise<SignInReplyOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!(o.timeoutMs > 0)) return { outcome: "refused", code: "RESTRICTED", message: "the sign-in challenge has ended" };
    const ended = new Promise<SignInReplyOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ outcome: "refused", code: "RESTRICTED", message: "the wallet did not answer before the sign-in challenge ended" }), o.timeoutMs);
    });
    const answered = native.postMessage(request).then(
      (reply) => readSignInReply(reply),
      (err): SignInReplyOutcome => ({ outcome: "refused", code: "INTERNAL", message: `the wallet did not answer: ${err instanceof Error ? err.message : String(err)}` }),
    );
    return await Promise.race([answered, ended]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
