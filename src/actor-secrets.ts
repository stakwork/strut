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
 */

import { assertValidSecretName, type SecretInfo, type SecretStore } from "./secret-store.js";

/** The actor-secrets file, beside `secrets.json` under `dataDir`. */
export const ACTOR_SECRETS_FILE = "actor-secrets.json";

export interface ActorSecretStore {
  get(actor: string, name: string): Promise<string | undefined>;
  set(actor: string, name: string, value: string): Promise<void>;
  /** Returns true if it existed. */
  delete(actor: string, name: string): Promise<boolean>;
  /** One actor's secret NAMES + metadata — never values. */
  list(actor: string): Promise<SecretInfo[]>;
}

const PREFIX = "A_";

/** `A_<hex(actor)>_` — the key prefix every one of an actor's entries shares. */
function actorPrefix(actor: string): string {
  if (!actor) throw new Error("actor is required");
  return `${PREFIX}${Buffer.from(actor, "utf8").toString("hex")}_`;
}

function keyFor(actor: string, name: string): string {
  assertValidSecretName(name);
  return actorPrefix(actor) + name;
}

/** An actor-secret store over any `SecretStore` (one JSON file, or memory). */
export function actorSecretStore(secrets: SecretStore): ActorSecretStore {
  return {
    async get(actor, name) {
      return secrets.get(keyFor(actor, name));
    },
    async set(actor, name, value) {
      return secrets.set(keyFor(actor, name), value);
    },
    async delete(actor, name) {
      return secrets.delete(keyFor(actor, name));
    },
    async list(actor) {
      const prefix = actorPrefix(actor);
      return (await secrets.list())
        .filter((s) => s.name.startsWith(prefix))
        .map((s) => ({ ...s, name: s.name.slice(prefix.length) }));
    },
  };
}
