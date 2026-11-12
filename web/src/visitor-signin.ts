// ── Signing a visitor in (plans/app-repos.md §5) ───────────────────────────
// The HOST page's side of a public app's sign-in: the app asks
// (`strut/visitor/sign-in`, ../app-host), this page signs the SELLER's
// challenge with a key and keeps the session. The app never sees a key.
// The seller is this strut server, or ANOTHER one whose public app this
// page hosts (`from`, ../remote-app): every call below takes it, and the
// session is kept per seller.
//
// Providers, one per method (src/visitors.ts verifies each):
//  - `key`: a non-extractable WebCrypto P-256 key, made at the first
//    sign-in and kept in this site's IndexedDB — one tap, one per browser.
//  - `nostr`: `window.nostr` (NIP-07) in this page signs a NIP-98 event for
//    `POST /visitors/session`, its `payload` the hash of the body carrying
//    the challenge.
//  - `lnurl`: a QR code any Lightning wallet signs (LUD-04); this page asks
//    until the wallet has.
//  - `sphinx`: the person's Sphinx account, through the native host this
//    page runs in (Peel): `sign_in` (specs/WALLET.md §1.2, ../native-pay
//    `signInAsk`) signs the challenge as a Lightning message.
// A host's `ticket` is no provider: it arrives as `?ticket=` (./api).
//
// The session is the visitor's cookie, and the token the sign-in returned,
// kept in this site's localStorage under the seller: framed by another site
// the browser drops the cookie, and this page sends the token instead
// (ruled 4) — always, for another server's.
import { API_BASE } from "./api";
import type { SignInAsk, SignInAnswerOf } from "./native-pay";

export type SignInMethod = "key" | "ticket" | "lnurl" | "nostr" | "sphinx";

/** What this page keeps of a signed-in visitor. */
export interface VisitorSession {
  actor: string;
  token: string;
  exp: number;
}

/** Read at call time: ./api imports this module. One per seller: this
 *  server (its base path), or another one's base URL. */
const sessionKey = (from?: string) => `strut.visitorSession:${from ?? API_BASE}`;
/** Where the seller's sign-in routes are. */
const sellerBase = (from?: string) => from ?? API_BASE;
/** Another server's: no cookie of ours, nor the UI header its CORS does
 *  not name. */
const fetchInit = (from?: string): RequestInit => (from ? { credentials: "omit" } : {});

function storage(): Storage | undefined {
  try {
    return typeof localStorage !== "undefined" ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

/** The visitor signed in to the seller, unless their session ran out. */
export function visitorSession(from?: string, now = Date.now()): VisitorSession | null {
  try {
    const raw = storage()?.getItem(sessionKey(from));
    const s = raw ? (JSON.parse(raw) as VisitorSession) : null;
    if (s && typeof s.token === "string" && typeof s.actor === "string" && typeof s.exp === "number" && s.exp > now) return s;
  } catch {}
  return null;
}

export function setVisitorSession(s: VisitorSession | null, from?: string): void {
  try {
    if (s) storage()?.setItem(sessionKey(from), JSON.stringify(s));
    else storage()?.removeItem(sessionKey(from));
  } catch {}
}

/** The headers a signed-in visitor's request carries: its token as a
 *  bearer, or — where `Authorization` carries a credit token
 *  (`POST /public/mcp`) — as `x-strut-visitor`; and, to this server, the
 *  UI header, so the cookie counts where the browser sends it. */
export function visitorAuth(beside = false, from?: string): Record<string, string> {
  const s = visitorSession(from);
  return { ...(from ? {} : { "x-strut-ui": "1" }), ...(s ? (beside ? { "x-strut-visitor": s.token } : { authorization: `Bearer ${s.token}` }) : {}) };
}

/** What `GET /visitors` says: the methods this server offers, and who this
 *  page is signed in as. */
export interface VisitorInfo {
  methods: SignInMethod[];
  visitorKey: "root" | "domain";
  actor?: string;
}

export async function visitorInfo(from?: string): Promise<VisitorInfo> {
  const res = await fetch(`${sellerBase(from)}/visitors`, { ...fetchInit(from), headers: visitorAuth(false, from), cache: "no-store" });
  if (!res.ok) return { methods: [], visitorKey: "root" };
  const info = (await res.json()) as VisitorInfo;
  // The session this page held ended (the server's secret rotated, it ran out).
  if (!info.actor && visitorSession(from)) setVisitorSession(null, from);
  return info;
}

/** The methods this BROWSER can do of those offered: a key needs WebCrypto
 *  and IndexedDB, Nostr an extension in this page, Sphinx a native host
 *  that signs a visitor in (`sphinx`: ../native-pay `signInAsk`); a ticket
 *  is the host's. */
export function usableMethods(offered: readonly SignInMethod[], o: { sphinx?: boolean } = {}): SignInMethod[] {
  return offered.filter((m) => {
    if (m === "key") return typeof crypto !== "undefined" && !!crypto.subtle && typeof indexedDB !== "undefined";
    if (m === "nostr") return typeof window !== "undefined" && !!(window as { nostr?: unknown }).nostr;
    if (m === "sphinx") return !!o.sphinx;
    return m === "lnurl";
  });
}

async function challenge(from?: string): Promise<string> {
  const res = await fetch(`${sellerBase(from)}/visitors/challenge`, { ...fetchInit(from), cache: "no-store" });
  const body = (await res.json().catch(() => null)) as { challenge?: string; error?: string } | null;
  if (!res.ok || !body?.challenge) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body.challenge;
}

/** `POST /visitors/session`: the session, kept, or the server's refusal. */
async function postSession(body: string, headers: Record<string, string> = {}, from?: string): Promise<VisitorSession | { pending: true; [k: string]: unknown }> {
  const res = await fetch(`${sellerBase(from)}/visitors/session`, {
    ...fetchInit(from),
    method: "POST",
    headers: { "content-type": "application/json", ...(from ? {} : { "x-strut-ui": "1" }), ...headers },
    body,
    cache: "no-store",
  });
  const got = (await res.json().catch(() => null)) as (VisitorSession & { pending?: true; error?: string }) | null;
  if (res.status === 202 && got?.pending) return got as { pending: true };
  if (!res.ok || !got?.token) throw new Error(got?.error ?? `${res.status} ${res.statusText}`);
  const session = { actor: got.actor, token: got.token, exp: got.exp };
  setVisitorSession(session, from);
  return session;
}

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

// ── `key`: a browser key ─────────────────────────────────────────────────

const DB = "strut-visitor";
const STORE = "keys";
const KEY_ID = "p256";

function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => open.result.close();
    };
  });
}

/** This site's key: made non-extractable at the first sign-in and kept as
 *  the CryptoKeyPair itself — its private half can sign here and never
 *  leave. */
async function browserKey(): Promise<CryptoKeyPair> {
  const kept = await idb<CryptoKeyPair | undefined>("readonly", (s) => s.get(KEY_ID));
  if (kept) return kept;
  const made = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  await idb("readwrite", (s) => s.put(made, KEY_ID));
  return made;
}

export async function signInWithKey(from?: string): Promise<VisitorSession> {
  const [c, key] = await Promise.all([challenge(from), browserKey()]);
  const pub = await crypto.subtle.exportKey("raw", key.publicKey);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(c));
  return (await postSession(JSON.stringify({ challenge: c, method: "key", key: hex(pub), sig: hex(sig) }), {}, from)) as VisitorSession;
}

// ── `sphinx`: the person's Sphinx account, through the native wallet ─────

/** How a Sphinx sign-in ended: the session, or the wallet's refusal (the
 *  person declined, it wants a fresh tap, the seller's challenge did not
 *  check out). A refusal of the SERVER's — the signature did not hold —
 *  throws, as every provider's does. */
export type SphinxSignIn = { outcome: "signed"; session: VisitorSession } | Extract<SignInAnswerOf, { outcome: "refused" }>;

/** One `sign_in` of a fresh challenge of the seller's, then the session. */
export async function signInWithSphinx(ask: SignInAsk, from?: string): Promise<SphinxSignIn> {
  const c = await challenge(from);
  const r = await ask.sign(c);
  if (r.outcome !== "signed") return r;
  const session = (await postSession(JSON.stringify({ challenge: c, method: "sphinx", key: r.key, sig: r.sig }), {}, from)) as VisitorSession;
  return { outcome: "signed", session };
}

// ── `nostr`: NIP-07 + NIP-98 ─────────────────────────────────────────────

interface Nip07 {
  signEvent(e: { kind: number; created_at: number; tags: string[][]; content: string }): Promise<Record<string, unknown>>;
}

export async function signInWithNostr(from?: string): Promise<VisitorSession> {
  const nostr = (window as { nostr?: Nip07 }).nostr;
  if (!nostr) throw new Error("no Nostr extension in this browser");
  const body = JSON.stringify({ challenge: await challenge(from), method: "nostr" });
  const payload = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  const url = new URL(`${sellerBase(from)}/visitors/session`, location.href).toString();
  const signed = await nostr.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [["u", url], ["method", "POST"], ["payload", payload]], content: "" });
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(signed))));
  return (await postSession(body, { authorization: `Nostr ${b64}` }, from)) as VisitorSession;
}

// ── `lnurl`: LNURL-auth by QR ────────────────────────────────────────────

export interface LnurlLogin {
  /** The bech32 LNURL to show (uppercase: a QR code's alphanumeric mode). */
  lnurl: string;
  /** Until when a wallet may sign it (ms). */
  exp: number;
  /** Ask whether the wallet has signed: the session, or null while not. */
  poll(): Promise<VisitorSession | null>;
}

export async function startLnurl(from?: string): Promise<LnurlLogin> {
  const c = await challenge(from);
  const got = (await postSession(JSON.stringify({ challenge: c, method: "lnurl" }), {}, from)) as { pending: true; k1: string; lnurl: string; exp: number };
  return {
    lnurl: got.lnurl,
    exp: got.exp,
    async poll() {
      const r = await postSession(JSON.stringify({ challenge: c, method: "lnurl", k1: got.k1 }), {}, from);
      return "pending" in r ? null : r;
    },
  };
}

/** A signed-in visitor's channel ticket (plans/app-repos.md §5.1): `POST
 *  /apps/:name/channel-ticket` as the visitor, for the public app at the
 *  version on screen. Refused while nobody is signed in. */
export async function visitorChannelTicket(name: string, version: string): Promise<{ ticket: string; exp: number }> {
  const res = await fetch(`${API_BASE}/apps/${encodeURIComponent(name)}/channel-ticket`, {
    method: "POST",
    headers: { "content-type": "application/json", ...visitorAuth() },
    body: JSON.stringify({ version }),
  });
  const body = (await res.json().catch(() => null)) as { ticket?: string; exp?: number; error?: string } | null;
  if (!res.ok || !body?.ticket) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return { ticket: body.ticket, exp: body.exp ?? 0 };
}

/** Sign out: the token forgotten, and this server's cookie cleared
 *  (another server's was never kept). */
export async function signOutVisitor(from?: string): Promise<void> {
  setVisitorSession(null, from);
  if (!from) await fetch(`${API_BASE}/visitors/session`, { method: "DELETE", headers: { "x-strut-ui": "1" } }).catch(() => {});
}
