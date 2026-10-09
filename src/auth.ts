import type { Context, Next } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Deployment-scoped shared-secret auth. `createStrut` puts `requireApiKey`
 * in front of EVERY route — reads included — so with a key configured
 * nothing is served without it (see the gate there for the two things that
 * are: the UI's own files and a bare `/health`).
 *
 * If `STRUT_API_KEY` is set in the environment, every request must present
 * `Authorization: Bearer <key>` (or `?key=`) matching that value. If unset,
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
 * launched, nothing else.
 */

const ENV_VAR = "STRUT_API_KEY";
const PEER_ENV = "STRUT_PEER_KEY";

let warned = false;

/** Read the configured key at request time. Returns undefined if unset. */
function configuredKey(): string | undefined {
  const v = process.env[ENV_VAR];
  return v && v.length > 0 ? v : undefined;
}

/** Read the configured peer key at request time. Returns undefined if unset. */
function configuredPeerKey(): string | undefined {
  const v = process.env[PEER_ENV];
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
  return apiKeyMatches(c.req.header("authorization"), c.req.query("key"));
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
 * read, the peer key (a peer may read every route). Permissive when
 * `STRUT_API_KEY` is unset.
 */
export async function requireApiKey(c: Context, next: Next) {
  const read = c.req.method === "GET" || c.req.method === "HEAD";
  if (!carriesApiKey(c) && !(read && carriesPeerKey(c))) return unauthorized(c);
  return next();
}

/**
 * The check behind `carriesApiKey`, for a caller with no Hono context — the
 * dictation WebSocket's upgrade, where the key rides as `?key=` because a
 * browser's WebSocket cannot set headers. Permissive (true) when
 * `STRUT_API_KEY` is unset.
 */
export function apiKeyMatches(authorization: string | undefined, queryKey?: string | null): boolean {
  const expected = configuredKey();
  if (!expected) return true;
  const got = presentedKey(authorization, queryKey);
  return !!got && got === expected;
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
 */
export type Scope = "full" | "peer";

/** The default `resolveScope`: `peer` for a request that carries the peer
 *  key and not the deployment key, else `full`. */
export function scopeFromKey(c: Context): Scope {
  return carriesPeerKey(c) && !(configuredKey() && carriesApiKey(c)) ? "peer" : "full";
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
// only. Leaked, it is worth exactly the files the page already shows. It is
// an HMAC of the scope under a deployment secret, so it needs no store and
// is minted by the listing routes (`GET /artifacts/:runId`,
// `GET /jobs/:id/files` → `token`) for whoever got past the gate.
//
// The secret is `STRUT_API_KEY`, else `STRUT_SECRET_KEY` when set: a strut
// behind a HOST's gate (mcp's `/lab`) has no API key of its own but does
// have the secret-store key, and the host hands a file read carrying `?t=`
// straight to strut to judge. So the invariant every file route keeps is:
// a `?t=` strut cannot vouch for is refused, whatever the gate's mode — and
// with no secret at all nothing is minted and every `?t=` is refused.

/** What a file token opens: one run's artifacts or one job's files. */
export type FileScope = { kind: "run" | "job"; id: string };

const SECRET_ENV = "STRUT_SECRET_KEY";

/** What signs a file token: the API key, else the secret-store key when it
 *  is set (never its dev default — a forgeable token is no credential). */
function tokenSecret(): string | undefined {
  const secret = process.env[SECRET_ENV];
  return configuredKey() ?? (secret && secret.length > 0 ? secret : undefined);
}

/** The read token for a scope; undefined with no secret to sign it (dev
 *  mode: everything is open, there is nothing to attenuate). */
export function fileToken(scope: FileScope): string | undefined {
  const secret = tokenSecret();
  if (!secret) return undefined;
  return createHmac("sha256", secret).update(`${scope.kind}:${scope.id}`).digest("base64url");
}

/** The scope a path reads from — `/artifacts/<runId>[/…]` or
 *  `/jobs/<id>/files[/…]`, the id decoded as the route decodes it — or
 *  undefined for any other path. */
export function fileScopeOf(path: string): FileScope | undefined {
  const m = path.match(/^\/artifacts\/([^/]+)(?:\/|$)/) ?? path.match(/^\/jobs\/([^/]+)\/files(?:\/|$)/);
  if (!m) return undefined;
  try {
    return { kind: path.startsWith("/jobs/") ? "job" : "run", id: decodeURIComponent(m[1]!) };
  } catch {
    return undefined;
  }
}

/** Does this request carry a valid file token (`?t=`) for the scope its
 *  path reads from? A read (GET / HEAD) under a scope only; a token on any
 *  other path, or for another run or job, opens nothing. */
export function carriesFileToken(c: Context): boolean {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return false;
  const got = c.req.query("t")?.trim();
  if (!got) return false;
  const scope = fileScopeOf(c.req.path);
  if (!scope) return false;
  const expected = fileToken(scope);
  if (!expected || expected.length !== got.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(got));
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
 * that authenticates requests itself (mcp's JWT) passes its own hook.
 */
export function actorFromHeader(c: Context): string | undefined {
  if (!(configuredKey() && carriesApiKey(c)) && !carriesPeerKey(c)) return undefined;
  const v = c.req.header("x-strut-actor")?.trim();
  return v ? v : undefined;
}

/**
 * `STRUT_MOTHERSHIP_REQUIRED=1`: every LLM call must have someone to bill.
 * Read by the Mothership module (a call with no principal, or no delegation
 * for it, is a step error) and by the scheduler (an automation on an
 * ownerless workflow is refused at the door instead of dying at its first
 * LLM step) — see plans/mothership-cost-control.md §2.
 */
export function principalRequired(): boolean {
  return process.env["STRUT_MOTHERSHIP_REQUIRED"] === "1";
}

/** Test-only: reset the one-time-warning state so tests stay deterministic. */
export function _resetAuthState(): void {
  warned = false;
}
