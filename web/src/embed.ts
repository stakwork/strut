// ── Embedded deep links ────────────────────────────────────────────────────
// The UI mirrors what's on screen into the address bar (?wf / run / v / chat)
// so a link reopens it. Embedded cross-origin (Hive iframes the lab at
// /org/<slug>/strut), that address bar is the iframe's own, which the host
// cannot see. A host that wants to mirror the params passes its origin as
// ?embed_origin= on the embed URL; we remember it (sessionStorage, like
// ?key=), strip it, and post every deep-link change to that origin only.
// The host does the reverse on load: it copies its own params onto the
// embed URL, which the app already reads.

const ORIGIN_STORAGE = "strut/embedOrigin";

/** The params that make up a deep link. Never `key` or `embed_origin`.
 *  `elicit` is the builder's open question (plans/elicitation.md) — the
 *  link a host shows for a secret. */
export const DEEP_LINK_PARAMS = ["wf", "run", "v", "chat", "elicit"] as const;

/** The message posted to the host after each change. */
export interface LocationMessage {
  type: "strut:location";
  params: Record<string, string>;
}

/** The deep-link subset of a query string, empty values dropped. */
export function deepLinkParams(search: string): Record<string, string> {
  const p = new URLSearchParams(search);
  const out: Record<string, string> = {};
  for (const k of DEEP_LINK_PARAMS) {
    const v = p.get(k);
    if (v) out[k] = v;
  }
  return out;
}

function captureEmbedOrigin(): void {
  try {
    const url = new URL(location.href);
    const origin = url.searchParams.get("embed_origin");
    if (origin === null) return;
    // Only a bare origin — never a URL with a path someone could smuggle in.
    if (new URL(origin).origin === origin) sessionStorage.setItem(ORIGIN_STORAGE, origin);
    url.searchParams.delete("embed_origin");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  } catch {
    // bad origin / no storage — we just don't report to the host
  }
}
if (typeof window !== "undefined") captureEmbedOrigin();

function reportLocation(): void {
  if (window.parent === window) return;
  let origin: string | null = null;
  try {
    origin = sessionStorage.getItem(ORIGIN_STORAGE);
  } catch {}
  if (!origin) return;
  const msg: LocationMessage = { type: "strut:location", params: deepLinkParams(location.search) };
  window.parent.postMessage(msg, origin);
}

/** `history.replaceState` + tell the embedding host, if there is one. */
export function replaceUrl(url: string | URL): void {
  history.replaceState(null, "", url);
  reportLocation();
}
