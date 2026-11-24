/**
 * Actor secrets — per-actor credentials (plans/code-change.md §3.2).
 *
 * The secret store behind `ctx.services.secrets` is deployment-global by
 * design: one `secrets.json`, one Secrets dialog, one `list_secrets`. Some
 * credentials are a PERSON's, not the deployment's — the GitHub token a
 * workflow clones and pushes with must be the token of whoever launched the
 * run, so a PR is authored by them and reaches only what they can reach.
 * A host (hive) holds those tokens and pushes them here, per actor, the way
 * it pushes Mothership delegations (`mothership.ts`).
 *
 * What a step sees is unchanged: `ctx.services.secrets.get("GITHUB_TOKEN")`.
 * The runner binds the bag's `secrets` to the run's PRINCIPAL once per run
 * (`SecretsCapability.forPrincipal`, capabilities.ts), so inside that run a
 * name resolves the principal's value first, then the deployment's, then
 * env. Every consumer inherits it — the `secretsEnv` of `agent` and `exec`,
 * every lib step's `cfg.token ?? secrets.get(NAME)`, cassette scrubbing.
 *
 * Storage is one entry per (actor, name) in any `SecretStore`, encoded as
 * `A_<hex(actor)>_<NAME>`: actors carry `-` (hive's `{login}-{id}`), which
 * secret names refuse, and hex has no `_`, so the split is unambiguous. The
 * standard server keeps them in a THIRD encrypted `FileSecretStore` file,
 * `actor-secrets.json`, beside `secrets.json` and `mothership.json` — never
 * in `GET /secrets`, the Secrets dialog, or the builder's `list_secrets`.
 * An actor's secrets are not the deployment's.
 *
 * **Secrets that refresh themselves** (stadeum plans/software.md §5 item 8).
 * An OAuth access token (Google's) lasts about an hour. A host that connects
 * a person writes the token with its expiry, its refresh token and the
 * connect seam's provider (`set(…, refresh)`). Those three sit in a second
 * entry, `AR_<hex(actor)>_<NAME>`, that no reader is handed. When a read
 * finds the value within five minutes of its end, the store first asks the
 * connect seam for a new one (`connectRefresher`), keeps the new pair, and
 * hands over the new value. So every reader gets a live token with no code
 * of its own. One (actor, name) refreshes one at a time: a provider that
 * rotates its refresh tokens (GitLab, Microsoft) invalidates the old pair,
 * so two runs spending the same one would cost the person their connection.
 * Nothing here names a provider.
 */

import { bootEnv } from "./env.js";
import { assertValidSecretName, type SecretInfo, type SecretStore } from "./secret-store.js";

/** The actor-secrets file, beside `secrets.json` under `dataDir`. */
export const ACTOR_SECRETS_FILE = "actor-secrets.json";

/** What a refreshing secret keeps beside its value. Never handed to a reader. */
export interface SecretRefresh {
  /** Seconds the value lasts from now. */
  expiresIn: number;
  refreshToken: string;
  /** The connect seam's provider: the refresh URL's `:provider`. */
  provider: string;
}

export interface ActorSecretStore {
  /** The value. One with a refresh near its end is refreshed first; one the
   *  provider refused to refresh is removed (undefined). Throws
   *  `secret_refresh:` when the refresh could not be done this time. */
  get(actor: string, name: string): Promise<string | undefined>;
  /** Without `refresh`, a plain value: any refresh kept before is dropped. */
  set(actor: string, name: string, value: string, refresh?: SecretRefresh): Promise<void>;
  /** Returns true if it existed. */
  delete(actor: string, name: string): Promise<boolean>;
  /** One actor's secret NAMES + metadata — never values. */
  list(actor: string): Promise<SecretInfo[]>;
  /** The actors who hold `name` as their own, sorted: never a value, and
   *  never the deployment's (a store of its own). A schedule for each
   *  person fires once for each (src/scheduler.ts). */
  holders(name: string): Promise<string[]>;
}

/** The connect seam's answer to one refresh (`RefreshSecret`). */
export type RefreshAnswer =
  /** A new access token; `refreshToken` only when the provider rotated it. */
  | { ok: true; accessToken: string; expiresIn: number; refreshToken?: string }
  /** The provider refused the refresh token: the person connects again. */
  | { ok: false; refused: true; error?: string }
  /** Not refreshed this time (no answer, or one that is not 200 or 400). */
  | { ok: false; refused?: false; status?: number };

/** Spend `refreshToken` at the connect seam for `provider`. */
export type RefreshSecret = (provider: string, refreshToken: string) => Promise<RefreshAnswer>;

/** A value is refreshed when a read finds it this close to its end. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** How long strut waits for the connect seam. */
const REFRESH_TIMEOUT_MS = 15_000;

/** A provider is a path segment of the refresh URL. */
const PROVIDER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isValidProvider(provider: unknown): provider is string {
  return typeof provider === "string" && PROVIDER_RE.test(provider);
}

const PREFIX = "A_";
const REFRESH_PREFIX = "AR_";

/** `A_<hex(actor)>_` — the key prefix every one of an actor's entries shares. */
function actorPrefix(actor: string, prefix = PREFIX): string {
  if (!actor) throw new Error("actor is required");
  return `${prefix}${Buffer.from(actor, "utf8").toString("hex")}_`;
}

function keyFor(actor: string, name: string): string {
  assertValidSecretName(name);
  return actorPrefix(actor) + name;
}

/** Where a value's refresh is kept: never listed (`list` reads `A_`). */
function refreshKeyFor(actor: string, name: string): string {
  return actorPrefix(actor, REFRESH_PREFIX) + name;
}

interface Kept {
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  provider: string;
}

function readKept(raw: string | undefined): Kept | undefined {
  if (raw === undefined) return undefined;
  try {
    const k = JSON.parse(raw) as Kept;
    if (typeof k.refreshToken === "string" && typeof k.expiresAt === "number" && isValidProvider(k.provider)) return k;
  } catch {}
  return undefined;
}

const nearEnd = (k: Kept): boolean => k.expiresAt - Date.now() < REFRESH_MARGIN_MS;

/** Each backing store's queue per entry, shared by every store built over
 *  it, so two wrappers never refresh one secret at once. */
interface Locks {
  /** The last write or refresh of each entry, in order. */
  queue: Map<string, Promise<unknown>>;
  /** A refresh under way: readers that come meanwhile wait for its answer. */
  refreshing: Map<string, Promise<string | undefined>>;
}
const LOCKS = new WeakMap<SecretStore, Locks>();

function locksOf(store: SecretStore): Locks {
  let l = LOCKS.get(store);
  if (!l) LOCKS.set(store, (l = { queue: new Map(), refreshing: new Map() }));
  return l;
}

/** Run `fn` after every earlier write or refresh of `key` has finished. */
function inTurn<T>(locks: Locks, key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.queue.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  locks.queue.set(key, tail);
  void tail.then(() => {
    if (locks.queue.get(key) === tail) locks.queue.delete(key);
  });
  return run;
}

/**
 * An actor-secret store over any `SecretStore` (one JSON file, or memory).
 * With `refresh` (`connectRefresher`), a value with a refresh is renewed
 * when a read finds it near its end; without it, it is handed over as it is.
 */
export function actorSecretStore(secrets: SecretStore, opts: { refresh?: RefreshSecret } = {}): ActorSecretStore {
  const locks = locksOf(secrets);
  const refreshSecret = opts.refresh;

  /** Inside the entry's turn: a reader before us may have refreshed it. */
  async function renew(actor: string, name: string): Promise<string | undefined> {
    const key = keyFor(actor, name);
    const rkey = refreshKeyFor(actor, name);
    const value = await secrets.get(key);
    const kept = readKept(await secrets.get(rkey));
    if (value === undefined || !kept || !nearEnd(kept) || !refreshSecret) return value;
    const answer = await refreshSecret(kept.provider, kept.refreshToken).catch((): RefreshAnswer => ({ ok: false }));
    if (answer.ok) {
      // The value first: a crash between the two leaves the new token with
      // the old refresh, which the next read spends again.
      await secrets.set(key, answer.accessToken);
      await secrets.set(
        rkey,
        JSON.stringify({
          refreshToken: answer.refreshToken ?? kept.refreshToken,
          expiresAt: Date.now() + answer.expiresIn * 1000,
          provider: kept.provider,
        } satisfies Kept),
      );
      return answer.accessToken;
    }
    if (answer.refused) {
      await secrets.delete(key);
      await secrets.delete(rkey);
      const why = answer.error && /^[\w.-]{1,64}$/.test(answer.error) ? ` (${answer.error})` : "";
      console.warn(`[strut] ${kept.provider} refused the refresh of a person's ${name}${why}: removed it, so they connect again`);
      return undefined;
    }
    const said = answer.status ? `it answered ${answer.status}` : "it did not answer";
    throw new Error(`secret_refresh: ${name} has expired and the connect service could not refresh it (${said}). Try again.`);
  }

  return {
    async get(actor, name) {
      const key = keyFor(actor, name);
      const value = await secrets.get(key);
      if (value === undefined || !refreshSecret) return value;
      const kept = readKept(await secrets.get(refreshKeyFor(actor, name)));
      if (!kept || !nearEnd(kept)) return value;
      const under = locks.refreshing.get(key);
      if (under) return under;
      const p: Promise<string | undefined> = inTurn(locks, key, () => renew(actor, name)).finally(() => {
        if (locks.refreshing.get(key) === p) locks.refreshing.delete(key);
      });
      locks.refreshing.set(key, p);
      return p;
    },
    async set(actor, name, value, refresh) {
      const key = keyFor(actor, name);
      const rkey = refreshKeyFor(actor, name);
      if (refresh) {
        if (!isValidProvider(refresh.provider)) throw new Error(`invalid provider "${String(refresh.provider).slice(0, 80)}"`);
        if (typeof refresh.refreshToken !== "string" || !refresh.refreshToken) throw new Error("refresh token is required");
        if (typeof refresh.expiresIn !== "number" || !(refresh.expiresIn > 0) || !Number.isFinite(refresh.expiresIn)) {
          throw new Error("expires in must be a positive number of seconds");
        }
      }
      return inTurn(locks, key, async () => {
        await secrets.set(key, value);
        if (!refresh) {
          await secrets.delete(rkey);
          return;
        }
        await secrets.set(
          rkey,
          JSON.stringify({
            refreshToken: refresh.refreshToken,
            expiresAt: Date.now() + refresh.expiresIn * 1000,
            provider: refresh.provider,
          } satisfies Kept),
        );
      });
    },
    async delete(actor, name) {
      const key = keyFor(actor, name);
      return inTurn(locks, key, async () => {
        await secrets.delete(refreshKeyFor(actor, name));
        return secrets.delete(key);
      });
    },
    async list(actor) {
      const prefix = actorPrefix(actor);
      return (await secrets.list())
        .filter((s) => s.name.startsWith(prefix))
        .map((s) => ({ ...s, name: s.name.slice(prefix.length) }));
    },
    async holders(name) {
      assertValidSecretName(name);
      // `A_<hex(actor)>_<NAME>`: hex has no `_`, so what lies between is one actor.
      const suffix = `_${name}`;
      const out: string[] = [];
      for (const s of await secrets.list()) {
        if (!s.name.startsWith(PREFIX) || !s.name.endsWith(suffix)) continue;
        const hex = s.name.slice(PREFIX.length, -suffix.length);
        if (/^(?:[0-9a-f]{2})+$/.test(hex)) out.push(Buffer.from(hex, "hex").toString("utf8"));
      }
      return out.sort();
    },
  };
}

/**
 * The connect seam's refresh (stadeum plans/software.md §2.1):
 * `POST ${CONNECT_URL}/api/connect/${provider}/refresh`, with `CONNECT_TOKEN`
 * as the bearer and `{ refresh_token }` as the body. Undefined unless both
 * are set: then a value with an expiry is handed over as it is.
 *
 * `200 { access_token, expires_in, refresh_token? }` is a new pair; `400`
 * is the provider refusing the refresh token. Anything else (`401`, `404`,
 * a `5xx`, a body that is not the pair, no answer in 15 s, a redirect) is
 * not refreshed this time.
 */
export function connectRefresher(
  env: Record<string, string | undefined> = bootEnv(),
  fetchImpl: typeof fetch = fetch,
): RefreshSecret | undefined {
  const url = env["CONNECT_URL"]?.trim().replace(/\/+$/, "");
  const token = env["CONNECT_TOKEN"]?.trim();
  if (!url || !token) return undefined;
  if (!/^https?:\/\/[^/]/.test(url)) {
    console.warn(`[strut] CONNECT_URL is not an http(s) URL: secrets are not refreshed`);
    return undefined;
  }
  return async (provider, refreshToken) => {
    if (!isValidProvider(provider)) return { ok: false };
    let res: Response;
    try {
      res = await fetchImpl(`${url}/api/connect/${provider}/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
        redirect: "error",
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
    } catch {
      return { ok: false };
    }
    const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (res.status === 400) return { ok: false, refused: true, ...(typeof body?.["error"] === "string" ? { error: body["error"] } : {}) };
    if (res.status !== 200) return { ok: false, status: res.status };
    const accessToken = body?.["access_token"];
    const expiresIn = body?.["expires_in"];
    const rotated = body?.["refresh_token"];
    if (typeof accessToken !== "string" || !accessToken || typeof expiresIn !== "number" || !(expiresIn > 0)) {
      return { ok: false, status: 200 };
    }
    return { ok: true, accessToken, expiresIn, ...(typeof rotated === "string" && rotated ? { refreshToken: rotated } : {}) };
  };
}
