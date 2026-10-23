import { createHash } from "node:crypto";

/** The one place the vault key is looked up. Nothing else reads this secret name. */
export const VAULT_KEY_SECRET = "STRUT_ANONYMIZATION_VAULT_KEY";

export type KeyPurpose = { vault: "file"; owner?: string };
export type KeyMaterial = { kid: string; material: Uint8Array };

/** What a provider may read from the step context (structural: `StepContext` fits). */
export interface KeyCtx {
  services?: unknown;
}

/** Where the vault's key comes from. The default reads a deployment secret; a per-user or
 *  envelope-encryption provider replaces it by passing another one to the vault. `null` = no key. */
export interface KeyProvider {
  get(ctx: KeyCtx, purpose: KeyPurpose): Promise<KeyMaterial | null>;
}

type Secrets = { get(name: string): Promise<string | undefined> };

export const secretKeyProvider: KeyProvider = {
  async get(ctx) {
    const secrets = (ctx.services as { secrets?: Secrets } | undefined)?.secrets;
    if (!secrets) return null;
    const value = await secrets.get(VAULT_KEY_SECRET);
    if (!value) return null;
    // the kid names the key without revealing it; a different value is a different key
    const kid = createHash("sha256").update(VAULT_KEY_SECRET + ":" + value).digest("hex").slice(0, 8);
    return { kid, material: new TextEncoder().encode(value) };
  },
};
