/**
 * The wallet's HTTP door (plans/paid-runs.md §9, decision 20): the
 * Earnings tab's Wallet form. FULL SCOPE only — the deployment key or an
 * admin's session. The gate refuses a member's session every route and a
 * peer or a person token every write; these refuse a peer's read too.
 *
 * `GET /earnings/wallet`: which provider is set and whether it can receive
 * and pay, never a credential (`?check=1` also asks the wallet its balance).
 * `PUT /earnings/wallet`: set it, change it, or remove it (`{ provider:
 * null }`). 501 for both when the host brought its own `services.lightning`.
 * When the ENVIRONMENT names the wallet (`LIGHTNING_*`), the deployment
 * owns it and writes it again at every boot: `GET` says so (`env: true`)
 * and `PUT` is a 409, so a change here never looks made and then comes
 * undone at the next restart.
 */

import type { Context, Hono } from "hono";
import type { LightningCapability } from "./lightning.js";
import { checkWalletUpdate, walletInfo, type WalletCredentials, type WalletInfo, type WalletSettings } from "./settings.js";

/** What `GET` says, and `PUT` refuses with, when the environment names the wallet. */
export const ENV_WALLET_NOTE =
  "set by this server's deployment (LIGHTNING_* in its environment), which writes it again at every boot: change it there";

/** How long `check` waits for the wallet's balance. */
export const WALLET_CHECK_MS = 5_000;

export interface WalletRoutesDeps {
  /** Whether the request is full scope (the key, an admin's session). */
  isFull: (c: Context) => Promise<boolean>;
  /** The host brought its own `services.lightning`: strut holds no wallet. */
  injected: boolean;
  /** What is on file. */
  settings: () => Promise<WalletSettings | null>;
  /** Write it (or remove it) and put the capability on the bag. */
  setWallet: (creds: WalletCredentials | null) => Promise<WalletSettings | null>;
  /** The capability as it is now, for `check`. */
  lightning: () => LightningCapability | null;
  /** The environment names a wallet, which replaces this one at the next boot. */
  envWallet: boolean;
}

/** `{ ok, msat }` from a balance read, or `{ ok: false, error }`. */
export async function checkWallet(lightning: LightningCapability | null, ms = WALLET_CHECK_MS): Promise<{ ok: true; msat: number } | { ok: false; error: string }> {
  if (!lightning) return { ok: false, error: "no wallet is set" };
  let timer: NodeJS.Timeout | undefined;
  try {
    const { msat } = await Promise.race([
      lightning.balance(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`wallet_unavailable: no answer in ${ms / 1000} s`)), ms);
      }),
    ]);
    return { ok: true, msat };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export function walletRoutes(app: Hono, deps: WalletRoutesDeps): void {
  const refuse = async (c: Context) => {
    if (!(await deps.isFull(c))) return c.json({ error: "forbidden: the wallet is an admin's: the deployment key or an admin's session" }, 403);
    if (deps.injected) return c.json({ error: "this server's host provides the wallet (services.lightning): strut neither holds nor changes it" }, 501);
    return null;
  };
  const answer = async (info: WalletInfo, check: boolean) => ({
    ...info,
    ...(check ? { check: await checkWallet(deps.lightning()) } : {}),
    ...(deps.envWallet ? { env: true, note: ENV_WALLET_NOTE } : {}),
  });

  app.get("/earnings/wallet", async (c) => {
    const refused = await refuse(c);
    if (refused) return refused;
    const check = c.req.query("check") === "1" || c.req.query("check") === "true";
    return c.json(await answer(walletInfo(await deps.settings()), check));
  });

  app.put("/earnings/wallet", async (c) => {
    const refused = await refuse(c);
    if (refused) return refused;
    if (deps.envWallet) return c.json({ error: `wallet_from_env: the wallet is ${ENV_WALLET_NOTE}` }, 409);
    const body = await c.req.json().catch(() => undefined);
    let creds: WalletCredentials | null;
    try {
      creds = checkWalletUpdate(body, await deps.settings());
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    let saved: WalletSettings | null;
    try {
      saved = await deps.setWallet(creds);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return c.json(await answer(walletInfo(saved), saved !== null));
  });
}
