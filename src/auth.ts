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
 */

const ENV_VAR = "STRUT_API_KEY";

let warned = false;

/** Read the configured key at request time. Returns undefined if unset. */
function configuredKey(): string | undefined {
  const v = process.env[ENV_VAR];
  return v && v.length > 0 ? v : undefined;
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
 * Hono middleware that gates a route on the deployment key. Permissive when
 * the env var is unset.
 */
export async function requireApiKey(c: Context, next: Next) {
  if (!carriesApiKey(c)) {
    return c.json(
      { error: "unauthorized: valid Authorization: Bearer <STRUT_API_KEY> required" },
      401,
    );
  }

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
  const match = (authorization ?? "").match(/^Bearer\s+(.+)$/i);
  const got = match?.[1]?.trim() || queryKey?.trim();
  return !!got && got === expected;
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
// an HMAC of the scope under the key, so it needs no store, rotates with the
// key, and is minted by the listing routes (`GET /artifacts/:runId`,
// `GET /jobs/:id/files` → `token`) for whoever holds the key.

/** What a file token opens: one run's artifacts or one job's files. */
export type FileScope = { kind: "run" | "job"; id: string };

/** The read token for a scope; undefined with no key configured (dev mode:
 *  everything is open, there is nothing to attenuate). */
export function fileToken(scope: FileScope): string | undefined {
  const key = configuredKey();
  if (!key) return undefined;
  return createHmac("sha256", key).update(`${scope.kind}:${scope.id}`).digest("base64url");
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

/**
 * The default `resolveActor` (plans/mothership-cost-control.md §2): the
 * `x-strut-actor` header, honored only when the request also carries the
 * deployment key AND a key is configured. With `STRUT_API_KEY` unset nothing
 * is honored — an unauthenticated caller must never pick who pays. A host
 * that authenticates requests itself (mcp's JWT) passes its own hook.
 */
export function actorFromHeader(c: Context): string | undefined {
  if (!configuredKey() || !carriesApiKey(c)) return undefined;
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
