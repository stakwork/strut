/** The app's WALLET CLIENT (specs/WALLET.md): an app page's side of the
 *  contract, over the MCP Apps `App` it already runs. `useWallet` and
 *  `window.webln` are both over it. No React, no dependency. */
import {
  WALLET_NOTIFICATION_METHOD, WalletError, checkParams, notificationProblems, walletCapabilityOf, walletErrorCodeOf,
  walletRequestMethod, type MethodParams, type MethodResults, type WalletCapability, type WalletMethod,
  type WalletNotification,
} from "./protocol.js";
import { PASS_THROUGH_SCHEMA } from "./relay.js";

/** How long a call that may open a sheet (`connect`, a payment) waits: the
 *  person may take their time. */
export const SHEET_TIMEOUT_MS = 10 * 60_000;
/** Every other call. */
export const CALL_TIMEOUT_MS = 60_000;

const SHEET_METHODS: ReadonlySet<WalletMethod> = new Set(["connect", "pay_invoice", "pay_keysend", "pay_lightning_address"]);

export interface WalletClient {
  /** What the host offers, or undefined: no wallet here. */
  capability(): WalletCapability | undefined;
  /** One method. Rejects with a `WalletError`. */
  call<M extends WalletMethod>(method: M, params?: MethodParams[M] | Record<string, unknown>): Promise<MethodResults[M]>;
  /** The host's notifications; returns the unsubscribe. */
  on(listener: (notification: WalletNotification) => void): () => void;
}

/** What the client needs of ext-apps' `App`. */
export interface WalletBridgeApp {
  getHostCapabilities(): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request(request: { method: string; params?: Record<string, unknown> }, resultSchema: any, options?: { timeout?: number }): Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setNotificationHandler(method: string, schemas: any, handler: (params: any) => void): void;
}

/** A client over the page's bridge. Construct it BEFORE `app.connect()`, so
 *  no notification is missed; the capability is read once the host has
 *  answered `ui/initialize`. */
export function createBridgeWallet(app: WalletBridgeApp): WalletClient {
  const listeners = new Set<(n: WalletNotification) => void>();
  app.setNotificationHandler(WALLET_NOTIFICATION_METHOD, { params: PASS_THROUGH_SCHEMA }, (params: unknown) => {
    if (notificationProblems(params).length) return;
    for (const l of listeners) l(params as WalletNotification);
  });
  return {
    capability: () => walletCapabilityOf(app.getHostCapabilities()),
    async call(method, params) {
      if (!walletCapabilityOf(app.getHostCapabilities())) throw new WalletError("NOT_IMPLEMENTED", "this page's host offers no wallet");
      const checked = checkParams(method, params ?? {});
      if (!checked.ok) throw new WalletError("BAD_REQUEST", checked.error.message);
      try {
        return (await app.request(
          { method: walletRequestMethod(method), params: checked.params as unknown as Record<string, unknown> },
          PASS_THROUGH_SCHEMA,
          { timeout: SHEET_METHODS.has(method) ? SHEET_TIMEOUT_MS : CALL_TIMEOUT_MS },
        )) as MethodResults[typeof method];
      } catch (err) {
        if (err instanceof WalletError) throw err;
        throw new WalletError(walletErrorCodeOf(err), err instanceof Error ? err.message : String(err));
      }
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The client of a page with no wallet: every call is `NOT_IMPLEMENTED`. */
export const NO_WALLET: WalletClient = {
  capability: () => undefined,
  call: async () => {
    throw new WalletError("NOT_IMPLEMENTED", "this page's host offers no wallet");
  },
  on: () => () => {},
};
