/**
 * `payments.json`: the encrypted file that holds what paid runs keep secret
 * from every step (plans/paid-runs.md decision 20, §9). Beside `peers.json`,
 * a `FileSecretStore` with a filename of its own, and NEVER the deployment's
 * `secrets.json`: a step reads every deployment secret by name, and a
 * credential that can pay must be readable by nothing on the services bag.
 *
 * Today it holds the WALLET: which provider, its receive credential, and its
 * pay credential when there is one (kept here for the payer, item 7; never
 * handed to `ctx.services.lightning`). Item 5 adds `L402_ROOT` the same
 * way: one name, one accessor on `PaymentsSettings`.
 *
 * Set two ways: from the environment at boot (`walletFromEnv`, the
 * `LIGHTNING_*` names, which the env scrub takes out of `process.env` and
 * the secrets capability never answers), or by a person through
 * `PUT /earnings/wallet` (`checkWalletUpdate`).
 */

import type { SecretStore } from "../secret-store.js";
import { daemonUrl } from "./sphinx-daemon.js";
import { parseNwcUrl } from "./nwc-url.js";

/** The file, under the data directory. */
export const PAYMENTS_FILE = "payments.json";

/** The names `payments.json` holds. One per thing; a later item adds its own. */
export const PAYMENTS_KEYS = {
  /** The wallet's settings, as JSON (`WalletSettings`). */
  wallet: "WALLET",
} as const;

/** The environment names a wallet is set from at boot. Every one is hidden
 *  from steps (`hiddenFromSteps`, capabilities.ts: the `LIGHTNING_` prefix). */
export const WALLET_ENV = [
  "LIGHTNING_DAEMON_URL",
  "LIGHTNING_DAEMON_TOKEN",
  "LIGHTNING_DAEMON_PAY_TOKEN",
  "LIGHTNING_NWC_URL",
  "LIGHTNING_NWC_PAY_URL",
] as const;

export type WalletProviderKind = "sphinx" | "nwc";

/** The Sphinx daemon (the treasury): its URL, its RECEIVE token, and its PAY
 *  token for the payer. */
export interface SphinxWallet {
  provider: "sphinx";
  url: string;
  token: string;
  payToken?: string;
}

/** An NWC wallet: a receive-only connection URL, and one that may pay. */
export interface NwcWallet {
  provider: "nwc";
  url: string;
  payUrl?: string;
}

export type WalletCredentials = SphinxWallet | NwcWallet;

/** What is on file: the credentials, who set them and when. */
export type WalletSettings = WalletCredentials & {
  /** `env`: from `LIGHTNING_*` at a boot; `api`: `PUT /earnings/wallet`. */
  from: "env" | "api";
  setAt: string;
};

/** What `GET /earnings/wallet` answers: never a credential. */
export interface WalletInfo {
  provider: WalletProviderKind | null;
  /** A receive credential is on file: the server can sell. */
  receive: boolean;
  /** A pay credential is on file: Withdraw (item 7) can pay. */
  pay: boolean;
  /** The daemon's URL (no credential in it). Sphinx only: an NWC URL is one. */
  url?: string;
  /** The NWC connection's relays, by host (no credential in them). */
  relays?: string[];
  from?: "env" | "api";
  setAt?: string;
}

/** What a host's own `services.lightning` is reported as: strut neither
 *  holds nor changes it. */
export const HOST_WALLET = "host";

/** `payments.json` as code reads it. Credentials come back only through
 *  `wallet()`, which is server code's (the providers, the payer), never a
 *  route's. */
export class PaymentsSettings {
  readonly #store: SecretStore;
  constructor(store: SecretStore) {
    this.#store = store;
  }

  async wallet(): Promise<WalletSettings | null> {
    const raw = await this.#store.get(PAYMENTS_KEYS.wallet);
    if (!raw) return null;
    try {
      return checkStored(JSON.parse(raw));
    } catch (err) {
      console.warn(`[payments] the wallet on file in ${PAYMENTS_FILE} could not be read (${err instanceof Error ? err.message : String(err)}); no wallet is set`);
      return null;
    }
  }

  /** Replace the wallet on file, or remove it (`null`). */
  async setWallet(settings: WalletSettings | null): Promise<void> {
    if (settings === null) await this.#store.delete(PAYMENTS_KEYS.wallet);
    else await this.#store.set(PAYMENTS_KEYS.wallet, JSON.stringify(settings));
  }
}

function checkStored(v: unknown): WalletSettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const creds = checkCredentials(o);
  return { ...creds, from: o["from"] === "env" ? "env" : "api", setAt: typeof o["setAt"] === "string" ? o["setAt"] : new Date(0).toISOString() };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Whole credentials, checked: throws a sentence naming the field (never a
 *  value). */
export function checkCredentials(o: Record<string, unknown>): WalletCredentials {
  if (o["provider"] === "sphinx") {
    const url = str(o["url"]);
    const token = str(o["token"]);
    if (!url) throw new Error("the Sphinx daemon's url is required");
    if (!token) throw new Error("the Sphinx daemon's receive token is required");
    const payToken = str(o["payToken"]);
    if (payToken && payToken === token) throw new Error("the pay token is the receive token: give the daemon's pay token, or leave it out");
    return { provider: "sphinx", url: daemonUrl(url), token, ...(payToken ? { payToken } : {}) };
  }
  if (o["provider"] === "nwc") {
    const url = str(o["url"]);
    if (!url) throw new Error("the NWC connection url is required");
    parseNwcUrl(url);
    const payUrl = str(o["payUrl"]);
    if (payUrl) {
      parseNwcUrl(payUrl);
      if (payUrl === url) throw new Error("the pay connection is the receive connection: give a connection that may pay, or leave it out");
    }
    return { provider: "nwc", url, ...(payUrl ? { payUrl } : {}) };
  }
  throw new Error('provider must be "sphinx" or "nwc"');
}

/** Two sets of credentials are the same wallet. */
export function sameCredentials(a: WalletCredentials, b: WalletCredentials): boolean {
  if (a.provider === "sphinx" && b.provider === "sphinx") return a.url === b.url && a.token === b.token && a.payToken === b.payToken;
  if (a.provider === "nwc" && b.provider === "nwc") return a.url === b.url && a.payUrl === b.payUrl;
  return false;
}

/**
 * The wallet the environment names at boot, or null when it names none.
 * `LIGHTNING_DAEMON_URL` + `LIGHTNING_DAEMON_TOKEN` (+ `_PAY_TOKEN`) is the
 * Sphinx daemon; `LIGHTNING_NWC_URL` (+ `LIGHTNING_NWC_PAY_URL`) is NWC.
 * Both, or a pay credential with no receive one, throws: a bad value fails
 * the boot, like `STRUT_PEERS`.
 */
export function walletFromEnv(env: Record<string, string | undefined>): WalletCredentials | null {
  const set = (k: (typeof WALLET_ENV)[number]) => str(env[k]);
  const daemon = set("LIGHTNING_DAEMON_URL") || set("LIGHTNING_DAEMON_TOKEN") || set("LIGHTNING_DAEMON_PAY_TOKEN");
  const nwc = set("LIGHTNING_NWC_URL") || set("LIGHTNING_NWC_PAY_URL");
  if (daemon && nwc) throw new Error("LIGHTNING_DAEMON_* and LIGHTNING_NWC_* are both set: the server has one wallet");
  try {
    if (daemon) {
      if (!set("LIGHTNING_DAEMON_URL")) throw new Error("LIGHTNING_DAEMON_URL is required with LIGHTNING_DAEMON_TOKEN or LIGHTNING_DAEMON_PAY_TOKEN");
      if (!set("LIGHTNING_DAEMON_TOKEN")) throw new Error("LIGHTNING_DAEMON_TOKEN (the daemon's receive token) is required with LIGHTNING_DAEMON_URL");
      return checkCredentials({ provider: "sphinx", url: set("LIGHTNING_DAEMON_URL"), token: set("LIGHTNING_DAEMON_TOKEN"), payToken: set("LIGHTNING_DAEMON_PAY_TOKEN") });
    }
    if (nwc) {
      if (!set("LIGHTNING_NWC_URL")) throw new Error("LIGHTNING_NWC_URL (a receive connection) is required with LIGHTNING_NWC_PAY_URL");
      return checkCredentials({ provider: "nwc", url: set("LIGHTNING_NWC_URL"), payUrl: set("LIGHTNING_NWC_PAY_URL") });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message.startsWith("LIGHTNING_") ? message : `LIGHTNING_*: ${message}`);
  }
  return null;
}

/**
 * A person's `PUT /earnings/wallet` body over what is on file → the
 * credentials to write, or `null` to remove the wallet. `{ provider: null }`
 * removes it. For the provider already on file, a field left out keeps what
 * is on file (a pay credential added without typing the receive one again)
 * and `null` removes a pay credential; a new provider needs every field.
 * Throws a sentence for anything else.
 */
export function checkWalletUpdate(body: unknown, current: WalletCredentials | null): WalletCredentials | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("the body is { provider, … }");
  const b = body as Record<string, unknown>;
  if (b["provider"] === null) return null;
  const fields = b["provider"] === "sphinx" ? ["url", "token", "payToken"] : b["provider"] === "nwc" ? ["url", "payUrl"] : null;
  if (!fields) throw new Error('provider must be "sphinx", "nwc", or null to remove the wallet');
  const unknown = Object.keys(b).filter((k) => k !== "provider" && !fields.includes(k));
  if (unknown.length) throw new Error(`a ${b["provider"]} wallet takes ${fields.join(", ")}; not ${unknown.join(", ")}`);
  const merged: Record<string, unknown> = { ...(current && current.provider === b["provider"] ? current : {}) };
  for (const k of fields) {
    if (!(k in b)) continue;
    if (b[k] === null) delete merged[k];
    else merged[k] = b[k];
  }
  merged["provider"] = b["provider"];
  return checkCredentials(merged);
}

/** What a route may show of a wallet. */
export function walletInfo(settings: WalletSettings | null): WalletInfo {
  if (!settings) return { provider: null, receive: false, pay: false };
  const common = { receive: true, from: settings.from, setAt: settings.setAt };
  if (settings.provider === "sphinx") return { provider: "sphinx", ...common, pay: !!settings.payToken, url: settings.url };
  // The relays' hosts only: a relay URL may carry a query of its own.
  return { provider: "nwc", ...common, pay: !!settings.payUrl, relays: parseNwcUrl(settings.url).relays.map((r) => new URL(r).host) };
}
