/**
 * Paid runs' server half as createStrut holds it (plans/paid-runs.md §9):
 * the wallet's settings in `payments.json`, the receive capability built
 * from them, and the exchange rate. One object, `strut.payments`, so the
 * items that follow (L402 challenges, the payer, earnings) find what they
 * need in one place; `ctx.services.lightning` is the one piece a step sees.
 */

import type { HttpCapability } from "../capabilities.js";
import type { SecretStore } from "../secret-store.js";
import { lightningCapability, type LightningCapability, type LightningProvider } from "./lightning.js";
import { NwcProvider } from "./nwc.js";
import { createRate, rateSourceFor, type Rate, type RateSource } from "./rate.js";
import { PaymentsSettings, sameCredentials, walletFromEnv, walletInfo, type WalletCredentials, type WalletInfo, type WalletSettings } from "./settings.js";
import { SphinxDaemonProvider } from "./sphinx-daemon.js";

export interface Payments {
  /** `payments.json`. `wallet()` carries the credentials, the PAY one
   *  included: server code's (the payer, item 7), never a route's. */
  settings: PaymentsSettings;
  /** The exchange rate (decision 26): `read()` for a quote. */
  rate: Rate;
  /** The wallet's receive side now — what `ctx.services.lightning` is — or
   *  null with none set. A host's own when it brought one. */
  lightning(): LightningCapability | null;
  /** What `GET /earnings/wallet` answers (never a credential). */
  wallet(): Promise<WalletInfo>;
  /** Replace the wallet (`from: "api"` unless said) or remove it (`null`);
   *  the capability follows at once. Refused when the host brought its own. */
  setWallet(creds: WalletCredentials | null, from?: "env" | "api"): Promise<WalletSettings | null>;
  /** The host brought its own `services.lightning`. */
  readonly injected: boolean;
  /** The environment named a wallet at boot (it is set again at the next). */
  readonly envWallet: boolean;
}

/** The receive provider for a wallet on file. The pay credential is never
 *  passed: nothing built here can pay. */
export function receiveProvider(settings: WalletCredentials, deps: { http?: HttpCapability } = {}): LightningProvider {
  if (settings.provider === "sphinx") return new SphinxDaemonProvider({ url: settings.url, token: settings.token, ...(deps.http ? { http: deps.http } : {}) });
  return new NwcProvider({ url: settings.url });
}

export interface PaymentsDeps {
  /** Where `payments.json` lives: a `FileSecretStore` with `PAYMENTS_FILE`,
   *  or memory. */
  store: SecretStore;
  /** Strut's own http capability: the daemon's requests and the rate's. */
  http: HttpCapability;
  /** The boot environment (`LIGHTNING_*`, `STRUT_RATE_URL`). */
  env: Record<string, string | undefined>;
  /** A host's own rate source (`createStrut({ payments: { rate } })`). */
  rateSource?: RateSource;
  /** A host's own `services.lightning`: strut then holds no wallet. */
  injected?: LightningCapability;
  /** Told each time the capability changes, to put it on the services bag
   *  (or take it off: `null`). Not called when the host brought its own. */
  onChange?: (lightning: LightningCapability | null) => void;
  /** Builds a provider (tests: a fake). Default `receiveProvider`. */
  provider?: (settings: WalletCredentials) => LightningProvider;
  now?: () => Date;
}

/** Build it: the environment's wallet written to `payments.json` (a bad
 *  `LIGHTNING_*` or `STRUT_RATE_URL` throws, failing the boot), the
 *  capability built from what is on file. */
export async function createPayments(deps: PaymentsDeps): Promise<Payments> {
  const settings = new PaymentsSettings(deps.store);
  const now = deps.now ?? (() => new Date());
  const build = deps.provider ?? ((s: WalletCredentials) => receiveProvider(s, { http: deps.http }));
  const rate = createRate(rateSourceFor({ ...(deps.rateSource ? { source: deps.rateSource } : {}), url: deps.env["STRUT_RATE_URL"], http: deps.http }));

  // The environment names the wallet at every boot, as STRUT_PEERS does;
  // the same credentials keep their record (and when they were set).
  const fromEnv = walletFromEnv(deps.env);
  if (fromEnv && !deps.injected) {
    const current = await settings.wallet();
    if (!current || !sameCredentials(current, fromEnv) || current.from !== "env") {
      await settings.setWallet({ ...fromEnv, from: "env", setAt: now().toISOString() });
    }
  } else if (fromEnv && deps.injected) {
    console.warn("[payments] LIGHTNING_* is set but the host provides services.lightning: the environment's wallet is not used");
  }

  let current: LightningCapability | null = deps.injected ?? null;
  const apply = (s: WalletSettings | null) => {
    if (deps.injected) return;
    current = s ? lightningCapability(build(s)) : null;
    deps.onChange?.(current);
  };
  if (!deps.injected) {
    const onFile = await settings.wallet();
    try {
      apply(onFile);
    } catch (err) {
      // A wallet on file that no longer builds (a URL a newer strut refuses)
      // is no wallet, said once; the boot goes on.
      console.warn(`[payments] the wallet in payments.json could not be used: ${err instanceof Error ? err.message : String(err)}`);
      apply(null);
    }
  }

  return {
    settings,
    rate,
    lightning: () => current,
    wallet: async () => walletInfo(await settings.wallet()),
    async setWallet(creds, from = "api") {
      if (deps.injected) throw new Error("this server's host provides the wallet (services.lightning)");
      const saved: WalletSettings | null = creds ? { ...creds, from, setAt: now().toISOString() } : null;
      // Built before it is written: a wallet that cannot be built is refused
      // and the one on file stays.
      const next = saved ? lightningCapability(build(saved)) : null;
      await settings.setWallet(saved);
      current = next;
      deps.onChange?.(current);
      return saved;
    },
    injected: !!deps.injected,
    envWallet: !!fromEnv,
  };
}
