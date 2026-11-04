/** `window.webln` inside an app's frame (plans/app-payments.md §2.4): WebLN's
 *  surface over the wallet client, the way Alby's NWC provider maps it —
 *  sats in, msat on the wire. Models write WebLN code unprompted, and the
 *  libraries that probe for it find it. Installed by the bootstrap when the
 *  host offers a wallet.
 *
 *  One rule beyond WebLN: a payment that may still settle never rejects (that
 *  would invite a retry, and a second payment). `sendPayment` and `keysend`
 *  resolve `{ preimage }` once settled, or, still pending after the wait,
 *  `{ preimage: null, pending: true, transactionId }` — follow it with
 *  `useTransaction`. */
import { WalletError, satsToMsat, msatToSats, type Payment, type WalletErrorCode, type WalletMethod } from "./protocol.js";
import type { WalletClient } from "./client.js";

/** How long `sendPayment` / `keysend` wait for a pending payment to settle. */
export const WEBLN_SETTLE_WAIT_MS = 60_000;

/** WebLN's error classes, by name, carrying the wallet code. */
export class WebLNError extends Error {
  constructor(name: string, message: string, readonly code: WalletErrorCode) {
    super(message);
    this.name = name;
  }
}

const ERROR_NAMES: Partial<Record<WalletErrorCode, string>> = {
  USER_REJECTED: "RejectionError",
  NOT_IMPLEMENTED: "UnsupportedMethodError",
  RESTRICTED: "UnsupportedMethodError",
  PAYMENT_FAILED: "RoutingError",
  BAD_REQUEST: "InvalidDataError",
};

function webLNError(err: unknown): WebLNError {
  if (err instanceof WebLNError) return err;
  const code: WalletErrorCode = err instanceof WalletError ? err.code : "INTERNAL";
  return new WebLNError(ERROR_NAMES[code] ?? "InternalError", err instanceof Error ? err.message : String(err), code);
}

export type WebLNPaymentResult = { preimage: string } | { preimage: null; pending: true; transactionId: string };

export interface WebLNProvider {
  enabled: boolean;
  enable(): Promise<void>;
  isEnabled(): Promise<boolean>;
  getInfo(): Promise<{ node: { alias: string; pubkey: string }; version: string; supports: string[]; methods: string[] }>;
  sendPayment(paymentRequest: string): Promise<WebLNPaymentResult>;
  sendPaymentAsync(paymentRequest: string): Promise<Record<string, never>>;
  keysend(args: { destination: string; amount: string | number; customRecords?: Record<string, string> }): Promise<WebLNPaymentResult>;
  makeInvoice(args: string | number | { amount?: string | number; defaultAmount?: string | number; defaultMemo?: string }): Promise<{ paymentRequest: string }>;
  lookupInvoice(args: { paymentHash?: string; paymentRequest?: string }): Promise<{ paymentRequest: string; preimage?: string; paid: boolean }>;
  getBalance(): Promise<{ balance: number; currency: "sats" }>;
  lnurl(lnurl: string): Promise<never>;
  signMessage(message: string): Promise<never>;
  verifyMessage(signature: string, message: string): Promise<never>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
}

/** Which WebLN methods each wallet method gives. */
const WEBLN_METHODS: Partial<Record<WalletMethod, string[]>> = {
  pay_invoice: ["sendPayment", "sendPaymentAsync"],
  pay_keysend: ["keysend"],
  make_invoice: ["makeInvoice"],
  lookup_invoice: ["lookupInvoice"],
  get_balance: ["getBalance"],
};

function utf8Hex(s: string): string {
  let hex = "";
  for (const b of new TextEncoder().encode(s)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function sats(v: string | number | undefined, what: string): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) throw new WebLNError("InvalidDataError", `${what} must be an amount of sats above 0`, "BAD_REQUEST");
  return n;
}

/** Wait for a pending payment to land, at most `waitMs`. */
async function settled(wallet: WalletClient, payment: Payment, waitMs: number): Promise<WebLNPaymentResult> {
  if (payment.state === "settled") return { preimage: payment.preimage ?? "" };
  if (payment.state === "failed") throw new WebLNError("RoutingError", payment.failure_reason ?? "the payment failed", "PAYMENT_FAILED");
  const outcome = await new Promise<{ sent: boolean; preimage?: string; reason?: string } | undefined>((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(undefined);
    }, waitMs);
    const off = wallet.on((n) => {
      if (n.notification.transaction_id !== payment.transaction_id) return;
      if (n.notification_type !== "payment_sent" && n.notification_type !== "payment_failed") return;
      clearTimeout(timer);
      off();
      resolve({ sent: n.notification_type === "payment_sent", preimage: n.notification.preimage, reason: n.notification.failure_reason });
    });
  });
  if (outcome?.sent) return { preimage: outcome.preimage ?? "" };
  if (outcome) throw new WebLNError("RoutingError", outcome.reason ?? "the payment failed", "PAYMENT_FAILED");
  return { preimage: null, pending: true, transactionId: payment.transaction_id };
}

export function createWebLN(wallet: WalletClient, opts: { settleWaitMs?: number } = {}): WebLNProvider {
  const waitMs = opts.settleWaitMs ?? WEBLN_SETTLE_WAIT_MS;
  const unsupported = async (what: string): Promise<never> => {
    throw new WebLNError("UnsupportedMethodError", `${what} is not offered to strut apps; use the kit's useWallet`, "NOT_IMPLEMENTED");
  };
  const provider: WebLNProvider = {
    enabled: false,
    async enable() {
      try {
        await wallet.call("connect");
        provider.enabled = true;
      } catch (err) {
        throw webLNError(err);
      }
    },
    async isEnabled() {
      try {
        const info = await wallet.call("get_info");
        return info.methods.some((m) => m !== "connect" && m !== "get_info");
      } catch {
        return false;
      }
    },
    async getInfo() {
      try {
        const info = await wallet.call("get_info");
        return {
          node: { alias: info.alias ?? "", pubkey: info.pubkey ?? "" },
          version: "strut-wallet-1",
          supports: ["lightning"],
          methods: ["enable", "getInfo", ...info.methods.flatMap((m) => WEBLN_METHODS[m] ?? [])],
        };
      } catch (err) {
        throw webLNError(err);
      }
    },
    async sendPayment(paymentRequest) {
      try {
        return await settled(wallet, await wallet.call("pay_invoice", { invoice: paymentRequest }), waitMs);
      } catch (err) {
        throw webLNError(err);
      }
    },
    async sendPaymentAsync(paymentRequest) {
      void wallet.call("pay_invoice", { invoice: paymentRequest }).catch(() => undefined);
      return {};
    },
    async keysend({ destination, amount, customRecords }) {
      try {
        const tlv_records = Object.entries(customRecords ?? {}).map(([type, value]) => ({ type: Number(type), value: utf8Hex(String(value)) }));
        const payment = await wallet.call("pay_keysend", {
          pubkey: destination,
          amount: satsToMsat(sats(amount, "amount")),
          ...(tlv_records.length ? { tlv_records } : {}),
        });
        return await settled(wallet, payment, waitMs);
      } catch (err) {
        throw webLNError(err);
      }
    },
    async makeInvoice(args) {
      try {
        const o = typeof args === "object" ? args : { amount: args };
        const t = await wallet.call("make_invoice", {
          amount: satsToMsat(sats(o.amount ?? o.defaultAmount, "amount")),
          ...(typeof o === "object" && "defaultMemo" in o && o.defaultMemo ? { description: o.defaultMemo } : {}),
        });
        return { paymentRequest: t.invoice ?? "" };
      } catch (err) {
        throw webLNError(err);
      }
    },
    async lookupInvoice({ paymentHash, paymentRequest }) {
      try {
        const t = await wallet.call("lookup_invoice", paymentHash ? { payment_hash: paymentHash } : { invoice: paymentRequest ?? "" });
        return { paymentRequest: t.invoice ?? paymentRequest ?? "", ...(t.preimage ? { preimage: t.preimage } : {}), paid: t.state === "settled" };
      } catch (err) {
        throw webLNError(err);
      }
    },
    async getBalance() {
      try {
        const b = await wallet.call("get_balance");
        return { balance: msatToSats(b.balance), currency: "sats" };
      } catch (err) {
        throw webLNError(err);
      }
    },
    lnurl: () => unsupported("lnurl"),
    signMessage: () => unsupported("signMessage"),
    verifyMessage: () => unsupported("verifyMessage"),
    on: () => {},
    off: () => {},
  };
  return provider;
}

/** Put `window.webln` on the page (when nothing is there) and say so, the
 *  way providers announce themselves (`webln:ready`). Returns it, or
 *  undefined when the page already had one. */
export function installWebLN(win: unknown, wallet: WalletClient): WebLNProvider | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = win as any;
  if (!w || w.webln) return undefined;
  const provider = createWebLN(wallet);
  w.webln = provider;
  try {
    w.dispatchEvent?.(new Event("webln:ready"));
  } catch {
    // No Event constructor here.
  }
  return provider;
}
