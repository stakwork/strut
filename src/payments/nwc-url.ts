/**
 * An NWC connection URL (NIP-47): `nostr+walletconnect://<wallet pubkey>?
 * relay=<wss url>&secret=<hex>[&relay=…][&lud16=…]`. The secret is the key
 * the client signs and encrypts with, so the whole URL is a credential.
 * Pure: no dependency.
 */

export interface NwcConnection {
  /** The wallet service's pubkey, x-only hex (64). */
  walletPubkey: string;
  /** wss:// (or ws:// for a relay on this machine), at least one. */
  relays: string[];
  /** The client's secret key, hex (64). */
  secret: string;
  lud16?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Parse a connection URL, or throw a sentence naming what is wrong (never
 *  the secret). */
export function parseNwcUrl(raw: string): NwcConnection {
  const text = typeof raw === "string" ? raw.trim() : "";
  const m = /^(nostr\+walletconnect|nostrwalletconnect):\/\/([^?#/]+)\/?\?(.*)$/i.exec(text);
  if (!m) throw new Error("an NWC URL is nostr+walletconnect://<wallet pubkey>?relay=<wss url>&secret=<hex>");
  const walletPubkey = m[2]!.toLowerCase();
  if (!HEX64.test(walletPubkey)) throw new Error("the NWC URL's wallet pubkey is not 64 hex characters");
  const params = new URLSearchParams(m[3]!);
  const relays = params.getAll("relay").map((r) => r.trim()).filter(Boolean);
  if (relays.length === 0) throw new Error("the NWC URL names no relay");
  for (const r of relays) {
    let u: URL;
    try {
      u = new URL(r);
    } catch {
      throw new Error(`the NWC URL's relay is not a URL: ${JSON.stringify(r.slice(0, 100))}`);
    }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if (u.protocol !== "wss:" && !(u.protocol === "ws:" && local)) throw new Error(`the NWC URL's relay must be wss:// (ws:// only on this machine): ${u.host}`);
  }
  const secret = (params.get("secret") ?? "").trim().toLowerCase();
  if (!HEX64.test(secret)) throw new Error("the NWC URL's secret is not 64 hex characters");
  const lud16 = params.get("lud16")?.trim();
  return { walletPubkey, relays, secret, ...(lud16 ? { lud16 } : {}) };
}
