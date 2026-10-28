import type { Context, Next } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppRef } from "./core.js";
import { bootEnv } from "./env.js";

/**
 * Deployment-scoped shared-secret auth. `createStrut` puts `requireApiKey`
 * in front of EVERY route — reads included — so with a key configured
 * nothing is served without it (see the gate there for the two things that
 * are: the UI's own files and a bare `/health`).
 *
 * If `STRUT_API_KEY` is set in the environment, every request must present
 * `Authorization: Bearer <key>` (or `?key=`) matching that value — or a
 * SESSION cookie the key bought at `POST /auth/session` (see "Sessions"
 * below: the browser's way in, so the page never holds the key). If unset,
 * the middleware is permissive (dev mode) — it logs a one-time warning at
 * boot so the lax posture is visible.
 *
 * The same secret authenticates first-party services in both directions
 * within a deployment: mcp uses it to register steps with strut, and strut's
 * uploaded step files use it to call back to mcp. See AGENTS.md.
 *
 * A second, narrower key, `STRUT_PEER_KEY`, is what ANOTHER strut holds for
 * this one (plans/federation.md §3): it authenticates like the deployment
 * key, but the request it carries is `peer`-scoped (`scopeFromKey`) — the
 * gate in createStrut lets it read, launch a run, and control a run a peer
 * launched, nothing else. A PERSON TOKEN (`POST /peers/tokens`, "Person
 * tokens" below) is the same key attenuated to one actor: `peer:person`.
 */

const ENV_VAR = "STRUT_API_KEY";
const PEER_ENV = "STRUT_PEER_KEY";

let warned = false;

/** Read the configured key at request time. Returns undefined if unset. */
function configuredKey(): string | undefined {
  const v = bootEnv()[ENV_VAR];
  return v && v.length > 0 ? v : undefined;
}

/** Read the configured peer key at request time. Returns undefined if unset. */
function configuredPeerKey(): string | undefined {
  const v = bootEnv()[PEER_ENV];
  return v && v.length > 0 ? v : undefined;
}

/** The key a request presents: `Authorization: Bearer`, else `?key=`. */
function presentedKey(authorization: string | undefined, queryKey?: string | null): string | undefined {
  const match = (authorization ?? "").match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || queryKey?.trim() || undefined;
}

/** Emit a one-time stderr warning if running without a configured key. */
export function warnIfUnconfigured(): void {
  if (warned) return;
  warned = true;
  if (!configuredKey()) {
    console.warn(
      `[strut] ${ENV_VAR} is not set — every endpoint is unauthenticated (dev mode).`,
    );
  }
}

/**
 * Does this request carry the deployment key? As `Authorization: Bearer`,
 * or as `?key=` for what a browser loads without headers (an artifact in an
 * `<img>` / `<video>` / new tab). Permissive when the env var is unset.
 */
export function carriesApiKey(c: Context): boolean {
  return inProcessOf(c) !== undefined || apiKeyMatches(c.req.header("authorization"), c.req.query("key")) || sessionOf(c) !== undefined;
}

// ── In-process requests ──────────────────────────────────────────────────
//
// A request strut makes to its OWN app, in this process, on someone's
// behalf: the page of strut's UI that `app/look` opens in a run's browser,
// whose every request is answered by `app.fetch` instead of over the
// network (BrowserService `lookAtApp`). Marked by the Request OBJECT, which
// nothing outside this process can hand in: it carries the key's rights
// (the gate, `requireApiKey`, scope `full`) and names its actor itself,
// whatever its headers say — the browser never holds a credential.

const IN_PROCESS = new WeakMap<Request, { actor?: string }>();

/** Mark `req` as strut's own, made for `actor`; returns it. */
export function inProcessRequest(req: Request, actor?: string): Request {
  IN_PROCESS.set(req, actor ? { actor } : {});
  return req;
}

/** The mark `inProcessRequest` left on this request, if any. */
export function inProcessOf(c: Context): { actor?: string } | undefined {
  return IN_PROCESS.get(c.req.raw);
}

/**
 * Does this request carry the PEER key (`STRUT_PEER_KEY`)? As Bearer or
 * `?key=`, like the deployment key. False when the env var is unset: an
 * unset peer key opens nothing.
 */
export function carriesPeerKey(c: Context): boolean {
  const expected = configuredPeerKey();
  return !!expected && presentedKey(c.req.header("authorization"), c.req.query("key")) === expected;
}

/** The 401 every gate answers a request with no credential it accepts. */
export function unauthorized(c: Context) {
  return c.json({ error: "unauthorized: valid Authorization: Bearer <STRUT_API_KEY> required" }, 401);
}

/**
 * Hono middleware that gates a route on the deployment key — or, for a
 * read, the peer key or a person token (a peer may read every route).
 * Permissive when `STRUT_API_KEY` is unset.
 */
export async function requireApiKey(c: Context, next: Next) {
  const read = c.req.method === "GET" || c.req.method === "HEAD";
  if (!carriesApiKey(c) && !(read && (carriesPeerKey(c) || personOf(c) !== undefined))) return unauthorized(c);
  return next();
}

/**
 * The check behind `carriesApiKey`, for a caller with no Hono context — the
 * dictation WebSocket's upgrade, where the key rides as `?key=` because a
 * browser's WebSocket cannot set headers — or, signed in, as the session
 * cookie (`cookie`): an upgrade is a GET, and a cross-site page's WebSocket
 * never carries a SameSite cookie. Permissive (true) when `STRUT_API_KEY`
 * is unset.
 */
export function apiKeyMatches(authorization: string | undefined, queryKey?: string | null, cookie?: string): boolean {
  const expected = configuredKey();
  if (!expected) return true;
  const got = presentedKey(authorization, queryKey);
  if (!!got && got === expected) return true;
  return cookie !== undefined && sessionFromCookie(cookie) !== undefined;
}

// ── Scope ────────────────────────────────────────────────────────────────

/**
 * What a request may do (plans/federation.md §3). `full`: everything — the
 * deployment key, and every request in dev mode. `peer`: what another strut
 * needs to dispatch work here and read it back — every read, launching a
 * run, and cancel / pause / resume of a run a peer launched (`origin:
 * "peer"` on its `run.start`); every other route answers 403. Enforced by
 * the one gate in createStrut; a host decides it per request through
 * `createStrut({ resolveScope })`, as it decides the actor.
 *
 * `peer:person` (plans/chained-orchestrators.md §2): a peer request whose
 * actor is its CREDENTIAL's own subject — a person token here, mcp's
 * `lab:peer` JWT with a `sub` — never a header. A plain `peer`'s actor is
 * `x-strut-actor`, which the calling strut sets to whoever its run is for,
 * so any strut holding the key can name anyone. Everything a `peer` may do
 * a `peer:person` may (`isPeerScope`), and more: launch a workflow that
 * says `peer: person`, open its own actor's sessions (runner.ts
 * `bindPeer`), and — once rooms land (§3) — join its actor's room.
 */
export type Scope = "full" | "peer" | "peer:person";

/** Is this a peer's request — a strut's, or a person's through one? */
export function isPeerScope(scope: Scope | undefined): boolean {
  return scope === "peer" || scope === "peer:person";
}

/** The default `resolveScope`: `full` for the deployment key (or its
 *  session), else `peer:person` for a person token, `peer` for the peer
 *  key, and `full` for the rest (dev mode). */
export function scopeFromKey(c: Context): Scope {
  if (inProcessOf(c)) return "full";
  if (configuredKey() && carriesApiKey(c)) return "full";
  if (personOf(c)) return "peer:person";
  return carriesPeerKey(c) ? "peer" : "full";
}

// ── File read tokens ─────────────────────────────────────────────────────
//
// A browser loads an artifact without headers — a link, an `<img>`, a frame
// — so something has to ride in the URL. It used to be the deployment key,
// which made `allow-scripts` on an HTML artifact impossible: a document can
// always read its own `location`, so a page an agent wrote could have lifted
// the key and sent it anywhere. A file token is the deployment key
// ATTENUATED to one scope — the files of one run (`/artifacts/:runId` and
// everything under it) or of one job (`/jobs/:id/files` and under) — reads
// only. Leaked, it is worth exactly the files the page already
// shows. It is an HMAC of the scope under a deployment secret, so it needs
// no store and is minted by the listing routes (`GET /artifacts/:runId`,
// `GET /jobs/:id/files` → `token`) for whoever got past the gate.
//
// The secret is `STRUT_API_KEY`, else `STRUT_SECRET_KEY` when set: a strut
// behind a HOST's gate (mcp's `/lab`) has no API key of its own but does
// have the secret-store key, and the host hands a file read carrying `?t=`
// straight to strut to judge. So the invariant every file route keeps is:
// a `?t=` strut cannot vouch for is refused, whatever the gate's mode — and
// with no secret at all nothing is minted and every `?t=` is refused.

/** What a file token opens: one run's artifacts, one job's files, or one
 *  app VERSION's directory (`app:<name>@<vN>`, plans/apps.md §7.2 — the
 *  token the served document carries as the app's identity). */
export type FileScope = { kind: "run" | "job" | "app"; id: string };

const SECRET_ENV = "STRUT_SECRET_KEY";

/** What signs a file token: the API key, else the secret-store key when it
 *  is set (never its dev default — a forgeable token is no credential). */
function tokenSecret(): string | undefined {
  const secret = bootEnv()[SECRET_ENV];
  return configuredKey() ?? (secret && secret.length > 0 ? secret : undefined);
}

/** The read token for a scope; undefined with no secret to sign it (dev
 *  mode: everything is open, there is nothing to attenuate). */
export function fileToken(scope: FileScope): string | undefined {
  const secret = tokenSecret();
  if (!secret) return undefined;
  return createHmac("sha256", secret).update(`${scope.kind}:${scope.id}`).digest("base64url");
}

/** The scope a path reads from — `/artifacts/<runId>[/…]`,
 *  `/jobs/<id>/files[/…]` or `/apps/<name>/<vN>/files[/…]`, the id decoded
 *  as the route decodes it — or undefined for any other path. */
export function fileScopeOf(path: string): FileScope | undefined {
  try {
    const app = path.match(/^\/apps\/([^/]+)\/(v\d+|preview-[0-9a-f]{12})\/files(?:\/|$)/);
    if (app) return { kind: "app", id: `${decodeURIComponent(app[1]!)}@${app[2]}` };
    const m = path.match(/^\/artifacts\/([^/]+)(?:\/|$)/) ?? path.match(/^\/jobs\/([^/]+)\/files(?:\/|$)/);
    if (!m) return undefined;
    return { kind: path.startsWith("/jobs/") ? "job" : "run", id: decodeURIComponent(m[1]!) };
  } catch {
    return undefined;
  }
}

// ── The app's identity ───────────────────────────────────────────────────
//
// An app's page holds ONE credential, its file token (plans/apps.md §7.2):
// the file route writes it into `<meta name="strut-app-token">` as it
// serves `dist/index.html` under a valid `?t=`, and the kit sends it as
// `step_run`'s `app` argument on every call. The host relays the call as it
// is and names nothing, so what the meta carries must say WHICH app it is
// as well as prove it: `app:<name>@<vN>.<token>` — the scope, then the
// token `fileToken` mints for it. The door splits it at the last `.` (a
// token is base64url, a version label has no dot), recomputes the token
// for the scope it names and compares. With no secret to sign under (dev
// mode, where the gate is open and nothing is minted) the identity is the
// scope alone, `app:<name>@<vN>.`, and the door takes it at its word —
// the open posture, where the grants still box the page but nothing
// proves which page is calling.

/** What the served document carries as the app's identity. */
export function appIdentity(name: string, version: string): string {
  return `app:${name}@${version}.${fileToken({ kind: "app", id: `${name}@${version}` }) ?? ""}`;
}

/** The app an identity names, once its token holds — or undefined: not an
 *  app's identity, a token strut cannot vouch for, or an unsigned one on a
 *  strut that signs. A workspace app at a version. */
export function appOfIdentity(identity: unknown): AppRef | undefined {
  if (typeof identity !== "string") return undefined;
  const dot = identity.lastIndexOf(".");
  if (dot < 0) return undefined;
  const scope = identity.slice(0, dot);
  const got = identity.slice(dot + 1);
  const app = scope.match(/^app:(.+)@(v\d+|preview-[0-9a-f]{12})$/);
  if (!app) return undefined;
  const [, name, version] = app as unknown as [string, string, string];
  const ref: AppRef = { name, version };
  const expected = fileToken({ kind: "app", id: `${name}@${version}` });
  if (expected === undefined) return got === "" ? ref : undefined;
  if (expected.length !== got.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(got))) return undefined;
  return ref;
}

/** Does this request carry a valid file token (`?t=`) for the scope its
 *  path reads from? A read (GET / HEAD) under a scope only; a token on any
 *  other path, or for another run, job or app, opens nothing. */
export function carriesFileToken(c: Context): boolean {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return false;
  const got = c.req.query("t")?.trim();
  const scope = fileScopeOf(c.req.path);
  if (!got || !scope) return false;
  const expected = fileToken(scope);
  return !!expected && expected.length === got.length && timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}

/** Does this request carry a `?t=` strut cannot vouch for? The file routes
 *  refuse such a request whatever the gate's mode: a host that delegates
 *  token-bearing reads to an open strut relies on it. */
export function carriesBadFileToken(c: Context): boolean {
  return c.req.query("t") !== undefined && !carriesFileToken(c);
}

/**
 * The default `resolveActor` (plans/mothership-cost-control.md §2): the
 * `x-strut-actor` header, honored only when the request also carries the
 * deployment key AND a key is configured, or carries the peer key — a
 * peer's launch names the person it is for (`strut/run-workflow` sends its
 * run's principal), never the machine. With neither key configured nothing
 * is honored — an unauthenticated caller must never pick who pays. A host
 * that authenticates requests itself (mcp's JWT) passes its own hook. A
 * person token names its actor itself, and no header changes that.
 */
export function actorFromHeader(c: Context): string | undefined {
  const own = inProcessOf(c);
  if (own) return own.actor;
  const person = personOf(c);
  if (person) return person.actor;
  const keyed = configuredKey() && apiKeyMatches(c.req.header("authorization"), c.req.query("key"));
  // A session names its actor itself: who signed in, not a header the page
  // could set to anything.
  if (!keyed && !carriesPeerKey(c)) return sessionOf(c)?.actor;
  const v = c.req.header("x-strut-actor")?.trim();
  return v ? v : undefined;
}

// ── Sessions ─────────────────────────────────────────────────────────────
//
// A strut whose UI faces the internet with no host in front used to keep
// STRUT_API_KEY itself in the browser (localStorage) and send it on every
// request: one long-lived bearer secret, no expiry, no revocation. A
// SESSION trades the key for something short-lived the page never reads:
// `POST /auth/session { key, actor? }` — the login, open to everyone, a
// wrong key a slow 401 — answers a matching key with an HttpOnly cookie
// holding `{ actor?, exp }` signed under the same secret a file token is
// (`tokenSecret`: the API key, else STRUT_SECRET_KEY). Stateless like the
// file token: no store, nothing to clean up, and rotating the secret ends
// every session. A session is the key's equal (`carriesApiKey`, scope
// `full`), never more; its actor is who signed in (`actorFromHeader`).
// `DELETE /auth/session` clears the cookie. `STRUT_SESSION_HOURS` (12) is
// its life.
//
// CSRF. The browser attaches the cookie to every request it makes to this
// origin, so a page on another site must not be able to spend it.
// `SameSite=Lax` keeps it off every cross-site subresource request — a
// fetch, an <img>, a frame, a form POST, a WebSocket — and leaves only a
// top-level navigation the person clicks, a GET whose answer only they see.
// Two more rules hold for a browser that ignores SameSite, and for a page
// of an untrusted origin served from strut's own: (1) a request that is
// not a read is honored only with `x-strut-ui: 1`, a header the UI sends
// on every call and no cross-site form can set; (2) a FILE read
// (`fileScopeOf`: a run's artifacts, a job's files; or a peer's, read
// through `/peers/<id>/…`) is never opened by the cookie alone either —
// the header or the `?t=` token, as always. So a
// sandboxed artifact page (an opaque origin, which Lax already treats as
// cross-site) cannot reach another run's files through the person's
// session: an <img> or a navigation has no header, and a fetch with one is
// a cross-origin preflight the file route does not grant. The UI's listing
// fetch carries the header, mints the token, and every link carries that.

const SESSION_COOKIE = "strut_session";
const SESSION_HOURS_ENV = "STRUT_SESSION_HOURS";
const DEFAULT_SESSION_HOURS = 12;
const UI_HEADER = "x-strut-ui";

/** What a session cookie holds: who signed in, and when it ends (ms). */
export interface Session {
  actor?: string;
  exp: number;
}

/** A session's life: `STRUT_SESSION_HOURS`, default 12. */
export function sessionTtlMs(): number {
  const h = Number(bootEnv()[SESSION_HOURS_ENV]);
  return (Number.isFinite(h) && h > 0 ? h : DEFAULT_SESSION_HOURS) * 3_600_000;
}

/** A signed token's kinds: a session cookie, a person token, a catalog
 *  read token. The kind is in the HMAC input, so one is never accepted as
 *  another. */
type ClaimsKind = "session" | "person" | "catalog";

function sign(kind: ClaimsKind, payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`${kind}:${payload}`).digest("base64url");
}

/** `base64url(json).hmac` over `claims` under the token secret, or
 *  undefined with no secret to sign it. */
function signClaims(kind: ClaimsKind, claims: Record<string, unknown>, secret = tokenSecret()): string | undefined {
  if (!secret) return undefined;
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(kind, payload, secret)}`;
}

/** The claims a signed token holds, if the signature holds and its `exp`
 *  has not passed; undefined otherwise (and always with no secret). */
function readClaims(kind: ClaimsKind, token: string, now: number): { exp: number; [claim: string]: unknown } | undefined {
  const secret = tokenSecret();
  if (!secret) return undefined;
  const dot = token.indexOf(".");
  if (dot <= 0) return undefined;
  const payload = token.slice(0, dot);
  const got = token.slice(dot + 1);
  const expected = sign(kind, payload, secret);
  if (expected.length !== got.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(got))) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const claims = parsed as Record<string, unknown>;
  const exp = claims["exp"];
  if (typeof exp !== "number" || !(exp > now)) return undefined;
  return { ...claims, exp };
}

/** The signed token for a session — `base64url(json).hmac` — or undefined
 *  with no secret to sign it. */
export function sessionToken(session: Session): string | undefined {
  return signClaims("session", { ...(session.actor ? { actor: session.actor } : {}), exp: session.exp });
}

/** The session a token names, if the signature holds and it has not
 *  expired; undefined otherwise (and always with no secret). */
export function verifySessionToken(token: string, now = Date.now()): Session | undefined {
  const claims = readClaims("session", token, now);
  if (!claims) return undefined;
  const { actor, exp } = claims;
  if (actor !== undefined && typeof actor !== "string") return undefined;
  return actor ? { actor, exp } : { exp };
}

/**
 * The login: a key matching `STRUT_API_KEY` buys a session for `ttlMs`
 * (default `sessionTtlMs()`), as the cookie value and the session it
 * names. Undefined for a wrong key, and with no key configured — an open
 * strut has nothing to sign in to.
 */
export function issueSession(key: string, actor?: string, ttlMs = sessionTtlMs()): { token: string; session: Session } | undefined {
  const expected = configuredKey();
  if (!expected || key.length !== expected.length || !timingSafeEqual(Buffer.from(key), Buffer.from(expected))) return undefined;
  const session: Session = { ...(actor ? { actor } : {}), exp: Date.now() + ttlMs };
  const token = sessionToken(session);
  return token ? { token, session } : undefined;
}

/** The `Set-Cookie` value that stores a session token, or clears it
 *  (`token` undefined). `Secure` on https, where the cookie must never
 *  travel in clear; a local strut is plain http. */
export function sessionCookie(token: string | undefined, exp: number, secure: boolean): string {
  const maxAge = token ? Math.max(1, Math.floor((exp - Date.now()) / 1000)) : 0;
  return `${SESSION_COOKIE}=${token ?? ""}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Is this request on https — directly, or behind a proxy that says so? */
export function isSecureRequest(c: Context): boolean {
  const forwarded = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === "https";
  return c.req.url.startsWith("https:");
}

/** The session a `Cookie` header carries, verified — the CSRF rules aside
 *  (for the WebSocket upgrade, a GET; everything else asks `sessionOf`). */
export function sessionFromCookie(cookie: string | undefined): Session | undefined {
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return value ? verifySessionToken(value) : undefined;
  }
  return undefined;
}

/**
 * The session this request may spend: a valid cookie, honored on a read
 * that is not a file read, or on any request carrying `x-strut-ui: 1` —
 * the CSRF rules above. Undefined otherwise.
 */
export function sessionOf(c: Context): Session | undefined {
  const session = sessionFromCookie(c.req.header("cookie"));
  if (!session) return undefined;
  if (c.req.header(UI_HEADER) === "1") return session;
  const read = c.req.method === "GET" || c.req.method === "HEAD";
  const fileRead = fileScopeOf(c.req.path) || /^\/peers\/[^/]+\/./.test(c.req.path);
  return read && !fileRead ? session : undefined;
}

// ── Person tokens ────────────────────────────────────────────────────────
//
// The peer key stands for a STRUT, and its request names a person only by
// `x-strut-actor`, which the calling strut sets to whoever its run is for:
// any strut holding the key can name anyone. A PERSON TOKEN is the peer key
// attenuated to one actor (plans/chained-orchestrators.md §2, §4): its
// request is `peer:person`, its actor is the one it was minted for, and no
// header changes that. It is what a person's own strut (a laptop) holds in
// its peer record for this one, the standalone twin of mcp's `lab:peer`
// JWT with a `sub`. `POST /peers/tokens { actor, days? }` mints one (`full`
// scope only). Signed like a session — `strut-person.<claims>.<hmac>` under
// the file token's secret — and stateless like one: no store, and rotating
// the secret revokes every one. Bearer only: a token a machine holds for
// weeks never rides in a URL.

const PERSON_PREFIX = "strut-person.";
/** A person token's default life, mcp's `lab:peer` default. */
export const PERSON_TOKEN_DAYS = 60;

/** What a person token holds: the actor, and when it ends (ms). */
export interface PersonToken {
  actor: string;
  exp: number;
}

/** A person token for `actor`, living `ttlMs` — or undefined with no
 *  secret to sign it (dev mode with no `STRUT_SECRET_KEY`). `secret` is for
 *  a process that mints for a strut it is not (`strut move serve`, before the
 *  strut it receives has started): that strut's `STRUT_API_KEY`, else its
 *  `STRUT_SECRET_KEY`, as `tokenSecret` picks. */
export function personToken(actor: string, ttlMs = PERSON_TOKEN_DAYS * 86_400_000, secret?: string): { token: string; exp: number } | undefined {
  const exp = Date.now() + ttlMs;
  const signed = signClaims("person", { actor, exp }, secret ?? tokenSecret());
  return signed ? { token: `${PERSON_PREFIX}${signed}`, exp } : undefined;
}

/** The person a token names, if it is one, its signature holds and it has
 *  not expired; undefined otherwise. */
export function verifyPersonToken(token: string, now = Date.now()): PersonToken | undefined {
  if (!token.startsWith(PERSON_PREFIX)) return undefined;
  const claims = readClaims("person", token.slice(PERSON_PREFIX.length), now);
  if (!claims || typeof claims.actor !== "string" || !claims.actor) return undefined;
  return { actor: claims.actor, exp: claims.exp };
}

/** The person token this request carries as `Authorization: Bearer`,
 *  verified — never `?key=`. */
export function personOf(c: Context): PersonToken | undefined {
  const match = (c.req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? verifyPersonToken(token) : undefined;
}

// ── Catalog read tokens ──────────────────────────────────────────────────
//
// What a SUBSCRIBER holds to read this strut's published catalog and the
// archives it names (plans/marketplace.md §12.1): §6's package token,
// narrowed to one catalog. `strut-catalog.<claims>.<hmac>` — the publisher
// key, who it was minted for, when it ends — signed like a person token
// and as stateless: rotating the secret ends every one. It is a read of two
// routes, `GET /packages/catalog` and `GET /packages/:publisher/:name/archive`
// (a digest the catalog names), taken as `?t=` — what a host's gate in
// front of strut hands through, as it does a file token — and nothing
// else: no run, no workflow, no launch. Leaked, it is worth the packages,
// which every subscriber holds anyway. `POST /publisher/tokens { subscriber,
// days? }` mints one (`full` scope only).

const CATALOG_PREFIX = "strut-catalog.";
/** A catalog token's default life, a person token's. */
export const CATALOG_TOKEN_DAYS = 60;
/** The routes a catalog token opens. */
export const CATALOG_TOKEN_PATH = /^\/packages\/(?:catalog|[^/]+\/[^/]+\/archive)$/;

export interface CatalogToken {
  /** The publisher key whose catalog it reads. */
  key: string;
  /** Who it was minted for: what a fleet's operator names the subscriber by. */
  subscriber: string;
  exp: number;
}

/** A catalog token, living `ttlMs` — or undefined with no secret to sign it. */
export function catalogToken(key: string, subscriber: string, ttlMs = CATALOG_TOKEN_DAYS * 86_400_000): { token: string; exp: number } | undefined {
  const exp = Date.now() + ttlMs;
  const signed = signClaims("catalog", { key, subscriber, exp });
  return signed ? { token: `${CATALOG_PREFIX}${signed}`, exp } : undefined;
}

export function verifyCatalogToken(token: string, now = Date.now()): CatalogToken | undefined {
  if (!token.startsWith(CATALOG_PREFIX)) return undefined;
  const claims = readClaims("catalog", token.slice(CATALOG_PREFIX.length), now);
  if (!claims || typeof claims["key"] !== "string" || typeof claims["subscriber"] !== "string") return undefined;
  return { key: claims["key"], subscriber: claims["subscriber"], exp: claims.exp };
}

/** The catalog token a READ of one of its routes carries as `?t=`, verified. */
export function catalogTokenOf(c: Context): CatalogToken | undefined {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return undefined;
  if (!CATALOG_TOKEN_PATH.test(c.req.path)) return undefined;
  const t = c.req.query("t")?.trim();
  return t ? verifyCatalogToken(t) : undefined;
}

/**
 * `STRUT_MOTHERSHIP_REQUIRED=1`: every LLM call must have someone to bill.
 * Read by the Mothership module (a call with no principal, or no delegation
 * for it, is a step error) and by the scheduler (an automation on an
 * ownerless workflow is refused at the door instead of dying at its first
 * LLM step) — see plans/mothership-cost-control.md §2.
 */
export function principalRequired(): boolean {
  return bootEnv()["STRUT_MOTHERSHIP_REQUIRED"] === "1";
}

/** Test-only: reset the one-time-warning state so tests stay deterministic. */
export function _resetAuthState(): void {
  warned = false;
}
