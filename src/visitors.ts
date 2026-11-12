/**
 * SIGNED-IN VISITORS (plans/app-repos.md §5; work item 4). A visitor of a
 * public app may stay anonymous, or sign in by signing strut's challenge
 * (auth.ts "Visitors") with a key and become that key's actor here. This
 * module is the seam and the rules, with no routes (createStrut mounts
 * `/visitors/*`):
 *
 * - VERIFIERS: a few signature checks, each naming the actor a key is —
 *   `ecdsa-p256` (a WebCrypto key: `p256:<compressed hex>`),
 *   `ecdsa-secp256k1` (an LNURL-auth linking key), `bip340` (a Nostr key)
 *   and `ln-message` (a Lightning signed message: a Sphinx key, signed the
 *   way sphinx-rs's `sign_bytes` signs), all `secp:<x-only hex>`, so one
 *   secp256k1 key is one person whichever way it signed. `webauthn` is
 *   named and not built: a method that needs it is refused until it lands.
 * - METHODS: where a key lives is the CLIENT's business (a host-page
 *   provider, web/src/visitor-signin.ts); a method names the verifier and
 *   how the request carries the signature. `key` (a browser key), `ticket`
 *   (a host vouches: `POST /auth/ticket { role: "visitor" }`, traded at
 *   `POST /auth/session`), `lnurl` (LUD-04 by QR, `lnurlPending`),
 *   `nostr` (NIP-07 + NIP-98, `nostrSigner`) and `sphinx` (the person's
 *   Sphinx account through the wallet that holds it — Peel — asked by the
 *   host page with specs/WALLET.md §1.2's `sign_in`). A box names the
 *   methods it accepts in its public view (`serve.yaml`'s `signIn`).
 * - LIMITS: writes and launches per actor per UTC day, strut's defaults
 *   changed by `serve.yaml`'s `limits`, and a budget per ADDRESS on top
 *   that no `limits` changes — a key costs nothing to make (ruled 5).
 * - The RULES a signed-in visitor's `step_run` is held to (§5.1),
 *   `signedInRefusal`, over the anonymous visitor's (`visitorRefusal`).
 */
import { createHash, randomBytes } from "node:crypto";
import { bech32Encode } from "./payments/bolt11.js";
import { GRAPH_WRITES } from "./apps/tools.js";
import { visitorRefusal, VISITOR_METHOD_NAMES, VISITOR_RUN_READS, runnableWorkflow, type PublicSurface } from "./public-surface.js";
import type { VisitorKeyMode } from "./auth.js";

// ── Verifiers ────────────────────────────────────────────────────────────

export type VerifierName = "ecdsa-p256" | "ecdsa-secp256k1" | "bip340" | "ln-message" | "webauthn";

/** One signature check: does `sig` sign `message` by `key`? The key's
 *  actor id when it does, else null — never a throw for a bad signature or
 *  a malformed key. */
export type Verifier = (message: Uint8Array, key: Uint8Array, sig: Uint8Array) => Promise<string | null>;

const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sha256 = (b: Uint8Array | string) => new Uint8Array(createHash("sha256").update(b).digest());

/** Bytes from hex, or undefined for anything that is not even-length hex. */
export function fromHex(s: unknown): Uint8Array | undefined {
  if (typeof s !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(s)) return undefined;
  return new Uint8Array(Buffer.from(s, "hex"));
}

/** What a Lightning signed message signs: sha256d of this ‖ the message. */
export const LN_MESSAGE_PREFIX = "Lightning Signed Message:";

let nist: Promise<typeof import("@noble/curves/nist")> | null = null;
let secp: Promise<typeof import("@noble/curves/secp256k1")> | null = null;

/** The verifiers strut keeps (§5.2's table). `webauthn` is the seam only. */
export const VERIFIERS: Readonly<Partial<Record<VerifierName, Verifier>>> = {
  /** WebCrypto's ECDSA P-256 with SHA-256: `sig` is IEEE P1363 (r ‖ s, 64
   *  bytes), `message` the bytes signed (hashed here, as WebCrypto does),
   *  `key` SEC1, compressed or not. */
  "ecdsa-p256": async (message, key, sig) => {
    const { p256 } = await (nist ??= import("@noble/curves/nist"));
    try {
      const point = p256.Point.fromHex(hexOf(key));
      if (sig.length !== 64) return null;
      const ok = p256.verify(sig, sha256(message), key, { prehash: false, lowS: false, format: "compact" });
      return ok ? `p256:${hexOf(point.toRawBytes(true))}` : null;
    } catch {
      return null;
    }
  },
  /** LNURL-auth (LUD-04): a DER signature over `k1` itself (32 bytes, the
   *  digest), by a compressed linking key. */
  "ecdsa-secp256k1": async (message, key, sig) => {
    const { secp256k1 } = await (secp ??= import("@noble/curves/secp256k1"));
    try {
      if (message.length !== 32) return null;
      const point = secp256k1.Point.fromHex(hexOf(key));
      const ok = secp256k1.verify(sig, message, key, { prehash: false, lowS: false, format: "der" });
      return ok ? `secp:${hexOf(point.toRawBytes(true).slice(1))}` : null;
    } catch {
      return null;
    }
  },
  /** A Lightning signed message, exactly as Sphinx makes one (sphinx
   *  `sig::sign_message`, what sphinx-rs's `sign_bytes` answers in hex):
   *  `sig` is 65 bytes, `[31 + recovery id] ‖ r ‖ s`, a recoverable ECDSA
   *  signature over sha256(sha256("Lightning Signed Message:" ‖ message)).
   *  The key it recovers must be `key`, compressed (33 bytes) — a signature
   *  over any other message, or a wrong recovery byte, recovers another. */
  "ln-message": async (message, key, sig) => {
    const { secp256k1 } = await (secp ??= import("@noble/curves/secp256k1"));
    try {
      if (sig.length !== 65 || key.length !== 33 || (key[0] !== 2 && key[0] !== 3)) return null;
      const recovery = sig[0]! - 31;
      if (recovery < 0 || recovery > 3) return null;
      const prefixed = new Uint8Array([...new TextEncoder().encode(LN_MESSAGE_PREFIX), ...message]);
      const digest = sha256(sha256(prefixed));
      const recovered = secp256k1.Signature.fromCompact(sig.slice(1)).addRecoveryBit(recovery).recoverPublicKey(digest).toRawBytes(true);
      return hexOf(recovered) === hexOf(key) ? `secp:${hexOf(key.slice(1))}` : null;
    } catch {
      return null;
    }
  },
  /** BIP-340 Schnorr over `message`, by a 32-byte x-only key. */
  bip340: async (message, key, sig) => {
    const { schnorr } = await (secp ??= import("@noble/curves/secp256k1"));
    try {
      if (key.length !== 32 || sig.length !== 64) return null;
      return schnorr.verify(sig, message, key) ? `secp:${hexOf(key)}` : null;
    } catch {
      return null;
    }
  },
};

// ── Methods ──────────────────────────────────────────────────────────────

/** The sign-ins a box may name in its public view (§5.3). */
export const VISITOR_METHODS = VISITOR_METHOD_NAMES;
export type VisitorMethod = (typeof VISITOR_METHODS)[number];
export const isVisitorMethod = (m: unknown): m is VisitorMethod => (VISITOR_METHODS as readonly unknown[]).includes(m);

/** Each method's verifier (`ticket`: none — the host's server vouches with
 *  the key) and whether it may sign with a ROOT key only: a Nostr extension
 *  signs with its one key, so it is not offered where the app asks for a
 *  key per domain. */
export const METHOD_INFO: Readonly<Record<VisitorMethod, { verifier?: VerifierName; rootOnly?: true }>> = {
  key: { verifier: "ecdsa-p256" },
  ticket: {},
  lnurl: { verifier: "ecdsa-secp256k1" },
  nostr: { verifier: "bip340", rootOnly: true },
  // The wallet derives the domain's child key itself (LUD-05) when the
  // challenge asks for one.
  sphinx: { verifier: "ln-message" },
};

/** The methods a box offers for its key mode: `signIn` less what cannot
 *  sign with a child key where the app asks for one. */
export function offeredMethods(signIn: readonly VisitorMethod[], visitorKey: VisitorKeyMode): VisitorMethod[] {
  return signIn.filter((m) => !(visitorKey === "domain" && METHOD_INFO[m].rootOnly));
}

/** The request's host name, as a challenge binds it: the proxy's
 *  `x-forwarded-host` else `Host`, lowercase, with no port — the domain
 *  LUD-05 derives a child key from. */
export function hostOfRequest(headers: { forwardedHost?: string; host?: string; url: string }): string {
  const raw = headers.forwardedHost?.split(",")[0]?.trim() || headers.host || new URL(headers.url).host;
  return raw.toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
}

// ── Nostr (NIP-98 over NIP-07) ───────────────────────────────────────────

/** A Nostr event as NIP-01 serializes it. */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** NIP-98's kind, and how far its `created_at` may be from now. */
export const NIP98_KIND = 27235;
const NIP98_SKEW_S = 60;

/** What a NIP-98 `Authorization: Nostr <base64 event>` signs for this
 *  request, once its form holds: the URL (`urlOk`, else `req.url` exactly)
 *  and method it names, the body's sha256 as its `payload`, a `created_at`
 *  within a minute, its id. Its BIP-340 signature over the id by `key` is
 *  the caller's to check (`VERIFIERS.bip340`). Else the reason it does not. */
export async function nostrSigner(
  authorization: string | undefined,
  req: { url: string; method: string; body: string },
  now = Date.now(),
  urlOk: (u: string) => boolean = (u) => u === req.url,
): Promise<{ key: Uint8Array; sig: Uint8Array; id: Uint8Array } | { error: string }> {
  const m = /^Nostr\s+(\S+)\s*$/i.exec(authorization ?? "");
  if (!m) return { error: "nostr: send the signed NIP-98 event as Authorization: Nostr <base64 event>" };
  let ev: NostrEvent;
  try {
    ev = JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8")) as NostrEvent;
  } catch {
    return { error: "nostr: the Authorization event is not base64 JSON" };
  }
  if (!ev || typeof ev !== "object" || ev.kind !== NIP98_KIND || !Array.isArray(ev.tags) || typeof ev.content !== "string" || typeof ev.created_at !== "number") {
    return { error: `nostr: the event is not a NIP-98 event (kind ${NIP98_KIND})` };
  }
  const tag = (name: string) => ev.tags.find((t) => Array.isArray(t) && t[0] === name)?.[1];
  if (Math.abs(now / 1000 - ev.created_at) > NIP98_SKEW_S) return { error: "nostr: the event's created_at is not within a minute of now" };
  if (!urlOk(tag("u") ?? "")) return { error: `nostr: the event's u tag is not ${req.url}` };
  if ((tag("method") ?? "").toUpperCase() !== req.method.toUpperCase()) return { error: `nostr: the event's method tag is not ${req.method}` };
  if (tag("payload") !== hexOf(sha256(req.body))) return { error: "nostr: the event's payload tag is not the sha256 of this body" };
  const key = fromHex(ev.pubkey);
  const sig = fromHex(ev.sig);
  if (!key || key.length !== 32 || !sig || sig.length !== 64) return { error: "nostr: the event's pubkey or sig is not hex of the right length" };
  const id = sha256(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]));
  if (hexOf(id) !== ev.id) return { error: "nostr: the event's id is not the hash of its content" };
  return { key, sig, id };
}

// ── LNURL-auth (LUD-04) ──────────────────────────────────────────────────
//
// A wallet on a phone cannot answer the page that shows its QR, so this is
// the one method with state: the page registers its challenge and gets a
// `k1` (32 random bytes) and the LNURL to show; the wallet calls back
// `GET /visitors/lnurl?k1&sig&key`; the page asks again with its challenge
// and `k1` and gets the session. The challenge is spent at registration
// (its minute is too short to scan a code), and the entry lives
// `LNURL_PENDING_MS`. A `k1` alone never buys the session: the page
// presents the challenge whose hash the entry keeps, which never left it.

/** How long a registered LNURL login may wait for its wallet. */
export const LNURL_PENDING_MS = 5 * 60_000;
const LNURL_PENDING_MAX = 10_000;

interface LnurlEntry {
  /** sha256 of the challenge that registered it. */
  check: string;
  host: string;
  exp: number;
  actor?: string;
}

export interface LnurlLogins {
  /** A new login for a spent challenge: its `k1` and when it ends. */
  register(challenge: string, host: string, now?: number): { k1: string; exp: number };
  /** The wallet's callback: the linking key's actor, or why not. */
  sign(k1: string, sig: Uint8Array, key: Uint8Array, now?: number): Promise<{ actor: string } | { error: string }>;
  /** The page's poll: `{ actor }` once signed (and the login is gone),
   *  `{ pending }` before, else why not. */
  take(k1: string, challenge: string, host: string, now?: number): { actor: string } | { pending: true; exp: number } | { error: string };
}

export function createLnurlLogins(): LnurlLogins {
  const pending = new Map<string, LnurlEntry>();
  const sweep = (now: number) => {
    for (const [k, e] of pending) if (e.exp <= now) pending.delete(k);
  };
  const checkOf = (challenge: string) => hexOf(sha256(challenge));
  return {
    register(challenge, host, now = Date.now()) {
      sweep(now);
      if (pending.size >= LNURL_PENDING_MAX) pending.delete(pending.keys().next().value!);
      const k1 = randomBytes(32).toString("hex");
      const exp = now + LNURL_PENDING_MS;
      pending.set(k1, { check: checkOf(challenge), host, exp });
      return { k1, exp };
    },
    async sign(k1, sig, key, now = Date.now()) {
      const e = pending.get(k1);
      if (!e || e.exp <= now) return { error: "this login has expired or is not this server's: scan a new code" };
      if (e.actor) return { error: "this login is already signed" };
      const actor = await VERIFIERS["ecdsa-secp256k1"]!(new Uint8Array(Buffer.from(k1, "hex")), key, sig);
      if (!actor) return { error: "the signature does not hold for k1 and key" };
      e.actor = actor;
      return { actor };
    },
    take(k1, challenge, host, now = Date.now()) {
      const e = pending.get(k1);
      if (!e || e.exp <= now || e.check !== checkOf(challenge) || e.host !== host) return { error: "no LNURL login for this challenge and k1 (or it expired): start again" };
      if (!e.actor) return { pending: true, exp: e.exp };
      pending.delete(k1);
      return { actor: e.actor };
    },
  };
}

/** LUD-04's login URL for `k1` under `base` (the box's own origin), and
 *  LUD-01's bech32 LNURL of it — what the sheet's QR code holds. */
export function lnurlLogin(base: string, k1: string): { url: string; lnurl: string } {
  const url = `${base.replace(/\/+$/, "")}/visitors/lnurl?tag=login&k1=${k1}&action=login`;
  return { url, lnurl: bech32Encode("lnurl", new TextEncoder().encode(url)).toUpperCase() };
}

// ── Limits (ruled 5) ─────────────────────────────────────────────────────

/** What one signed-in visitor may do in a UTC day. */
export interface VisitorLimits {
  /** `app/state` sets, graph writes and error reports. */
  writesPerDay: number;
  /** `run/launch`es — free ones and runnable ones alike. */
  launchesPerDay: number;
}

/** Strut's defaults; `serve.yaml`'s `limits` (the public view's) changes them. */
export const DEFAULT_VISITOR_LIMITS: Readonly<VisitorLimits> = { writesPerDay: 1000, launchesPerDay: 100 };

/** The limits in force: strut's defaults with the public view's over them. */
export function visitorLimits(surface: Pick<PublicSurface, "visitors">): VisitorLimits {
  return { ...DEFAULT_VISITOR_LIMITS, ...(surface.visitors?.limits ?? {}) };
}
/** What every signed-in visitor from ONE address may do in a UTC day,
 *  together — on top of each one's limits, whatever `limits` says: a key
 *  costs nothing to make. Ten visitors' defaults (a school, a café). */
export const ADDRESS_VISITOR_LIMITS: Readonly<VisitorLimits> = { writesPerDay: 10_000, launchesPerDay: 1_000 };

export type BudgetKind = "write" | "launch";

export interface VisitorBudget {
  /** Why one more `kind` by this actor from this address is refused today, or null. */
  check(kind: BudgetKind, actor: string, address: string, limits: VisitorLimits): string | null;
  /** Count one. */
  spend(kind: BudgetKind, actor: string, address: string): void;
}

/** The counts, in memory: a restart forgets the day's. */
export function createVisitorBudget(now: () => number = Date.now): VisitorBudget {
  let day = "";
  const counts = new Map<string, number>();
  const today = () => {
    const d = new Date(now()).toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      counts.clear();
    }
  };
  const field = (kind: BudgetKind) => (kind === "write" ? "writesPerDay" : "launchesPerDay");
  const words = (kind: BudgetKind) => (kind === "write" ? "writes" : "launches");
  return {
    check(kind, actor, address, limits) {
      today();
      const mine = counts.get(`${kind}|a|${actor}`) ?? 0;
      if (mine >= limits[field(kind)]) return `visitor_limit: ${limits[field(kind)]} ${words(kind)} a day for one visitor — this one has used them; try again tomorrow (UTC)`;
      const theirs = counts.get(`${kind}|ip|${address}`) ?? 0;
      if (theirs >= ADDRESS_VISITOR_LIMITS[field(kind)]) return `visitor_limit: ${ADDRESS_VISITOR_LIMITS[field(kind)]} ${words(kind)} a day from one address, for every visitor on it together; try again tomorrow (UTC)`;
      return null;
    },
    spend(kind, actor, address) {
      today();
      for (const k of [`${kind}|a|${actor}`, `${kind}|ip|${address}`]) counts.set(k, (counts.get(k) ?? 0) + 1);
    },
  };
}

/** Is this call one a visitor's write budget counts? */
export function visitorWrite(type: string, config: Record<string, unknown>): boolean {
  if (type === "app/state") return !!config["set"] && typeof config["set"] === "object" && Object.keys(config["set"] as object).length > 0;
  return type === "app/report-error" || GRAPH_WRITES.has(type);
}

// ── The rules (§5.1) ─────────────────────────────────────────────────────

export interface SignedInRules {
  /** The node types the app declares (`data.graph.types`). */
  declared: readonly string[];
  /** Can the granted workflow's closure spend (an `agent`, an `llm`, …)?
   *  Unknown or unreadable counts as yes. */
  spends: (workflow: string) => Promise<boolean>;
}

/**
 * Why a SIGNED-IN visitor's call is refused, or null — checked after the
 * app's own grants (`grantRefusal`), like `visitorRefusal`, which it widens
 * by exactly §5.1's list:
 * - `app/state` (its own) and `app/report-error`;
 * - a graph write (the declared-type check is the door's, `graphWriteRefusal`)
 *   and `graph/find` on a type the app declares;
 * - `run/launch` of a granted workflow whose closure spends nothing (as the
 *   visitor), and the reads of its own runs of one; a spending workflow only
 *   as one anyone may run (`runnable`), through the public run door.
 * Everything else is the anonymous visitor's rule: the reads the public
 * view opens, never a private one.
 */
export async function signedInRefusal(
  surface: PublicSurface,
  live: string | undefined,
  app: { name: string; version: string },
  type: string,
  config: Record<string, unknown>,
  rules: SignedInRules,
): Promise<string | null> {
  const anonymous = visitorRefusal(surface, live, app, type, config);
  if (anonymous === null) return null;
  if (!surface.apps.some((a) => a.name === app.name) || live !== app.version) return anonymous;
  if (type.startsWith("graph/") && config["namespace"] !== undefined) return `${type}: a visitor reads and writes the workspace's own namespace — leave out \`namespace\``;
  if (type === "app/state" || type === "app/report-error" || GRAPH_WRITES.has(type)) return null;
  if (type === "graph/find") {
    const t = config["node_type"];
    if (typeof t === "string" && rules.declared.some((d) => d.toLowerCase() === t.toLowerCase())) return null;
    return `graph/find: a visitor reads the types this app declares (${rules.declared.length ? rules.declared.join(", ") : "none"}), not "${String(t)}"`;
  }
  if (type === "run/launch" || VISITOR_RUN_READS.has(type)) {
    const wf = typeof config["workflow"] === "string" ? config["workflow"] : "";
    if (runnableWorkflow(surface, wf)) return anonymous;
    if (!(await rules.spends(wf))) return null;
    return `workflow "${wf}" can spend (a model call, a paid step): a visitor starts it only as one anyone may run here — priced, or free under a daily cap (the public view's runnable list, serve.yaml's runnable)`;
  }
  return anonymous;
}
