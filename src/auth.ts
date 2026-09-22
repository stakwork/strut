import type { Context, Next } from "hono";

/**
 * Deployment-scoped shared-secret auth for step-registration mutations.
 *
 * If `STRUT_API_KEY` is set in the environment, every gated request must
 * present `Authorization: Bearer <key>` matching that value. If unset, the
 * middleware is permissive (dev mode) — it logs a one-time warning at boot
 * so the lax posture is visible.
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
      `[strut] ${ENV_VAR} is not set — step registration is unauthenticated (dev mode).`,
    );
  }
}

/**
 * Hono middleware that gates step-registration mutations on a bearer
 * token matching `STRUT_API_KEY`. Permissive when the env var is unset.
 */
export async function requireApiKey(c: Context, next: Next) {
  if (!apiKeyMatches(c.req.header("authorization"))) {
    return c.json(
      { error: "unauthorized: valid Authorization: Bearer <STRUT_API_KEY> required" },
      401,
    );
  }

  return next();
}

/**
 * Does a request carry the deployment key? Accepts `Authorization: Bearer`
 * and, when the caller passes it, a `?key=` query value — the WebSocket
 * dictation route needs the latter because a browser's WebSocket cannot set
 * headers. Permissive (true) when `STRUT_API_KEY` is unset.
 */
export function apiKeyMatches(authorization: string | undefined, queryKey?: string | null): boolean {
  const expected = configuredKey();
  if (!expected) return true;
  const match = (authorization ?? "").match(/^Bearer\s+(.+)$/i);
  const got = match?.[1]?.trim() || queryKey?.trim();
  return !!got && got === expected;
}

/**
 * The default `resolveActor` (plans/mothership-cost-control.md §2): the
 * `x-strut-actor` header, honored only when the request also carries the
 * deployment key AND a key is configured. With `STRUT_API_KEY` unset nothing
 * is honored — an unauthenticated caller must never pick who pays. A host
 * that authenticates requests itself (mcp's JWT) passes its own hook.
 */
export function actorFromHeader(c: Context): string | undefined {
  if (!configuredKey() || !apiKeyMatches(c.req.header("authorization"))) return undefined;
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
