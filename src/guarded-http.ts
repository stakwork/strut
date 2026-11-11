/**
 * An http capability for a STRANGER's URL (SSRF): what a request this
 * server makes on someone else's behalf, or to someone it has no record of,
 * goes through. Every URL, and every redirect's, is checked before it is
 * fetched — `http(s)` only, never a loopback, private, link-local (the
 * cloud's metadata at 169.254.169.254), multicast or reserved address, nor
 * a name that resolves to one (aieo's `validateFetchUrl`, loaded on the
 * first request); redirects are followed by hand, at most 5, and — as fetch
 * does — a hop to another origin carries no `Authorization`, `Cookie` or
 * `Proxy-Authorization`; each request at most `timeoutMs`.
 *
 * Two users: a public tool's bag (plans/paid-runs.md §6, src/public-tools.ts,
 * which built it first) and the `remote/*` steps (§10 "Another strut",
 * src/remote.ts), which call a seller's public door with the credit this
 * strut holds there.
 *
 * Known limit: the address is checked by resolving the name, and the fetch
 * resolves it again, so a host that answers the two lookups differently
 * (DNS rebinding) can pass the check. Pinning the checked address closes it.
 */

import { httpCapability, type FetchLike, type HttpCapability } from "./capabilities.js";

/** The default cap on one request. */
export const GUARDED_HTTP_TIMEOUT_MS = 30_000;

/** Resolve a hostname to its addresses (tests pass their own). */
export type HostLookup = (hostname: string) => Promise<string[]>;

/** The headers a redirect to another origin never carries, as fetch drops
 *  them: the caller's credentials were meant for the host it named. */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(["authorization", "cookie", "proxy-authorization"]);

/** `headers` without the credential ones, names compared in any case;
 *  an object or a `Headers`, given back as a plain object. */
export function withoutCredentials(headers: HeadersInit | Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const entries: Array<[string, string]> =
    headers instanceof Headers ? [...headers.entries()] : Array.isArray(headers) ? (headers as Array<[string, string]>) : Object.entries(headers as Record<string, string>);
  return Object.fromEntries(entries.filter(([k]) => !CREDENTIAL_HEADERS.has(k.toLowerCase())));
}

/** The guarded capability. `timeoutMs` is the most any one request may take
 *  (a caller's own `timeout` is held under it). */
export function guardedHttp(o: { fetch?: typeof globalThis.fetch; lookup?: HostLookup; timeoutMs?: number } = {}): HttpCapability {
  const fetchImpl = o.fetch ?? globalThis.fetch;
  const limit = o.timeoutMs ?? GUARDED_HTTP_TIMEOUT_MS;
  const guarded: FetchLike = async (raw, init = {}) => {
    const { validateFetchUrl } = await import("./aieo/fetch.js");
    const check = (u: string) => validateFetchUrl(u, o.lookup ? { lookup: o.lookup } : {});
    let url = await check(raw);
    let req = { ...init };
    for (let hop = 0; ; hop++) {
      const res = await fetchImpl(url.toString(), { ...req, redirect: "manual" } as RequestInit);
      if (![301, 302, 303, 307, 308].includes(res.status)) return res as unknown as Awaited<ReturnType<FetchLike>>;
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!location) throw new Error(`redirect (${res.status}) without a Location header`);
      if (hop >= 5) throw new Error("too many redirects (more than 5)");
      const next = await check(new URL(location, url).toString());
      // As fetch does: credentials go no further than the origin they were
      // sent to.
      if (next.origin !== url.origin) {
        const headers = withoutCredentials(req.headers);
        req = { ...req, ...(headers ? { headers } : {}) };
      }
      url = next;
      // As fetch does: a 303, or a 301/302 after a POST, goes on as a GET.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && (req.method ?? "GET").toUpperCase() === "POST")) {
        const { body: _b, ...rest } = req;
        req = { ...rest, method: "GET" };
      }
    }
  };
  const inner = httpCapability(guarded);
  return (url, opts = {}) => inner(url, { ...opts, timeout: Math.min(opts.timeout ?? limit, limit) });
}
