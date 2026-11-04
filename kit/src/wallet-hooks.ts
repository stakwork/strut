/** The wallet hooks (specs/WALLET.md, plans/app-payments.md §2.4): an app's
 *  way to the person's Lightning wallet through its host — in Peel, the
 *  person's Sphinx account. Over the provider's wallet client; a page whose
 *  host offers no wallet sees `available: false` and every call refused. */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStrutWallet } from "./provider.js";
import {
  WalletError,
  type Budget, type GrantedConnection, type ListTransactionsParams, type LookupInvoiceParams, type LookupPaymentParams,
  type MakeInvoiceParams, type MethodParams, type MethodResults, type PayInvoiceParams, type PayKeysendParams,
  type PayLightningAddressParams, type Payment, type PaymentLookup, type PaymentState, type Transaction, type WalletInfo,
  type WalletMethod, type WalletNotification,
} from "./wallet/protocol.js";

export interface UseWallet {
  /** The host offers a wallet. */
  available: boolean;
  /** Which: "sphinx" in Peel. */
  wallet?: string;
  /** This app holds a connection (`get_info` lists a granted method). */
  connected: boolean;
  /** `get_info`, read once the host offers a wallet. */
  info?: WalletInfo;
  /** Ask the person for the connection the app's `app.yaml` requests. */
  connect(): Promise<GrantedConnection>;
  payInvoice(params: PayInvoiceParams): Promise<Payment>;
  /** `pubkey` may be a Sphinx address, `<pubkey>_<lsp_pubkey>_<scid>`. */
  payKeysend(params: PayKeysendParams): Promise<Payment>;
  payLightningAddress(params: PayLightningAddressParams): Promise<Payment>;
  makeInvoice(params: MakeInvoiceParams): Promise<Transaction>;
  lookupPayment(params: LookupPaymentParams): Promise<PaymentLookup>;
  lookupInvoice(params: LookupInvoiceParams): Promise<Transaction>;
  getBudget(): Promise<Budget>;
  getBalance(): Promise<{ balance: number }>;
  listTransactions(params?: ListTransactionsParams): Promise<{ transactions: Transaction[]; total_count?: number }>;
  /** The host's notifications for this app; returns the unsubscribe. */
  on(listener: (notification: WalletNotification) => void): () => void;
}

/** The person's wallet, through the host. A call made with no connection
 *  yet asks for it first (`connect`), once, and goes on. */
export function useWallet(): UseWallet {
  const wallet = useStrutWallet();
  const capability = wallet.capability();
  const [info, setInfo] = useState<WalletInfo>();

  useEffect(() => {
    if (!capability) return;
    let live = true;
    wallet.call("get_info").then((i) => live && setInfo(i), () => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, !!capability]);

  return useMemo(() => {
    const refresh = () => wallet.call("get_info").then(setInfo, () => undefined);
    const connect = async () => {
      const r = await wallet.call("connect");
      void refresh();
      return r.connection;
    };
    async function call<M extends WalletMethod>(method: M, params?: MethodParams[M]): Promise<MethodResults[M]> {
      try {
        return await wallet.call(method, params);
      } catch (err) {
        if (!(err instanceof WalletError) || err.code !== "UNAUTHORIZED") throw err;
        await connect();
        return wallet.call(method, params);
      }
    }
    const connected = info ? info.methods.some((m) => m !== "connect" && m !== "get_info") : !!capability?.connected;
    return {
      available: !!capability,
      ...(capability ? { wallet: capability.wallet } : {}),
      connected,
      ...(info ? { info } : {}),
      connect,
      payInvoice: (p) => call("pay_invoice", p),
      payKeysend: (p) => call("pay_keysend", p),
      payLightningAddress: (p) => call("pay_lightning_address", p),
      makeInvoice: (p) => call("make_invoice", p),
      lookupPayment: (p) => call("lookup_payment", p),
      lookupInvoice: (p) => call("lookup_invoice", p),
      getBudget: () => call("get_budget", {}),
      getBalance: () => call("get_balance", {}),
      listTransactions: (p) => call("list_transactions", p ?? {}),
      on: (listener) => wallet.on(listener),
    } satisfies UseWallet;
  }, [wallet, capability, info]);
}

export interface UseTransaction {
  state?: PaymentState;
  preimage?: string;
  feesPaid?: number;
  settledAt?: number;
  failureReason?: string;
}

/** How often a pending payment is looked up while the page is visible, when
 *  the connection grants `lookup_payment` (the notifications come first). */
export const TRANSACTION_POLL_MS = 15_000;

function fromPayment(p: Payment | undefined): UseTransaction {
  if (!p) return {};
  return {
    state: p.state,
    ...(p.preimage ? { preimage: p.preimage } : {}),
    ...(p.fees_paid !== undefined ? { feesPaid: p.fees_paid } : {}),
    ...(p.settled_at !== undefined ? { settledAt: p.settled_at } : {}),
    ...(p.failure_reason ? { failureReason: p.failure_reason } : {}),
  };
}

/** Follow one payment from what a pay call answered: `pending` until the
 *  host's `payment_sent` / `payment_failed` (or a lookup) says otherwise.
 *  A Sphinx keysend to someone offline waits at the LSP, so this may be
 *  hours. */
export function useTransaction(payment: Payment | undefined): UseTransaction {
  const wallet = useStrutWallet();
  const id = payment?.transaction_id;
  const [t, setT] = useState<UseTransaction>(() => fromPayment(payment));
  const canLookup = useRef(true);

  useEffect(() => {
    setT(fromPayment(payment));
    canLookup.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, payment?.state]);

  useEffect(() => {
    if (!id) return;
    return wallet.on((n) => {
      if (n.notification.transaction_id !== id) return;
      if (n.notification_type !== "payment_sent" && n.notification_type !== "payment_failed") return;
      const x = n.notification;
      setT({
        state: n.notification_type === "payment_sent" ? "settled" : "failed",
        ...(x.preimage ? { preimage: x.preimage } : {}),
        ...(x.fees_paid !== undefined ? { feesPaid: x.fees_paid } : {}),
        ...(x.settled_at !== undefined ? { settledAt: x.settled_at } : {}),
        ...(x.failure_reason ? { failureReason: x.failure_reason } : {}),
      });
    });
  }, [wallet, id]);

  useEffect(() => {
    if (!id || t.state !== "pending") return;
    let live = true;
    const tick = async () => {
      if (!canLookup.current || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
      try {
        const r = await wallet.call("lookup_payment", { transaction_id: id });
        if (!live) return;
        const state: PaymentState = r.state === "settled" ? "settled" : ["failed", "expired", "canceled"].includes(r.state) ? "failed" : "pending";
        if (state === "pending") return;
        setT({
          state,
          ...(r.details.preimage ? { preimage: r.details.preimage } : {}),
          ...(r.fees_paid !== undefined ? { feesPaid: r.fees_paid } : {}),
          ...(r.settled_at !== undefined ? { settledAt: r.settled_at } : {}),
          ...(r.failure_reason ? { failureReason: r.failure_reason } : {}),
        });
      } catch (err) {
        // Not granted, not offered: the notifications alone tell.
        if (err instanceof WalletError && ["RESTRICTED", "NOT_IMPLEMENTED", "UNAUTHORIZED"].includes(err.code)) canLookup.current = false;
      }
    };
    const timer = setInterval(tick, TRANSACTION_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [wallet, id, t.state]);

  return t;
}
