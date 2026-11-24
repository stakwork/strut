// ── Embedded deep links ────────────────────────────────────────────────────
// The UI mirrors what's on screen into the address bar (?wf / run / v / chat)
// so a link reopens it. Embedded cross-origin (Hive iframes the lab at
// /org/<slug>/strut), that address bar is the iframe's own, which the host
// cannot see. A host that wants to mirror the params passes its origin as
// ?embed_origin= on the embed URL; we remember it (sessionStorage, like
// ?key=), strip it, and post every deep-link change to that origin only.
// The host does the reverse on load: it copies its own params onto the
// embed URL, which the app already reads.
//
// On a strut with a key of its own, `embed_origin` is only a host's word
// when it came beside the host's sign-in ticket (src/auth.ts "The host that
// frames it"): the server says which origin that is, in the page's
// `<meta name="strut-embed-origin">` (empty: none), and the page posts to
// that origin and takes `embed_page` on it alone — never on the bare param
// a neighbour's frame could set. A strut with no key (behind a host's gate,
// as mcp's `/lab` for Hive) writes no such meta: the param stands, as the
// gate in front decided who loads the page, but it names no `embed_page`.

const ORIGIN_STORAGE = "strut/embedOrigin";
const ORIGIN_META = "strut-embed-origin";

/** The params that make up a deep link. Never `key` or `embed_origin`.
 *  `elicit` is the builder's open question (plans/elicitation.md) — the
 *  link a host shows for a secret; `job` a job's timeline
 *  (plans/jobs-sidebar.md); `app` an app's page (plans/apps.md §7.3) and
 *  `input` what it is opened with, the app's own query (§7.1). */
export const DEEP_LINK_PARAMS = ["wf", "run", "v", "chat", "elicit", "job", "app", "input"] as const;

/** The message posted to the host after each change. */
export interface LocationMessage {
  type: "strut:location";
  params: Record<string, string>;
}

/** Posted to the host once, when what the page shows alone (`solo=1`) is
 *  on screen: the app's page has started, or the page says why it cannot.
 *  A host keeps its frame hidden until then and fades it in, so strut's
 *  own page behind the app never flashes. */
export interface ReadyMessage {
  type: "strut:ready";
}

/** Posted to the host when the page alone (`solo=1`) follows a link that
 *  asks to open ANOTHER app as the page (`open=page`): the host shows that
 *  app as its own page in place of this one. `app` is its key as the link
 *  names it; `input` what it is opened with (the link's `input`, the app's
 *  own query string), absent for a plain open. */
export interface OpenMessage {
  type: "strut:open";
  app: string;
  input?: string;
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

/** The host origin the server vouches for (`<meta name="strut-embed-origin">`):
 *  its origin, `""` for none, or undefined when the page carries no such
 *  meta (a strut with no key of its own). */
export function vouchedEmbedOrigin(): string | undefined {
  try {
    return document.querySelector(`meta[name="${ORIGIN_META}"]`)?.getAttribute("content") ?? undefined;
  } catch {
    return undefined;
  }
}

/** The host origin that asked for location reports: the one the server
 *  vouches for, else — on a strut with no key — `embed_origin` as given. */
function embedOrigin(): string | null {
  const vouched = vouchedEmbedOrigin();
  if (vouched !== undefined) return vouched || null;
  try {
    return sessionStorage.getItem(ORIGIN_STORAGE);
  } catch {
    return null;
  }
}

/** Post to the embedding host, if there is one that asked (`embed_origin`).
 *  False when there is none: not framed, or no origin to post to. */
function postToHost(msg: LocationMessage | ReadyMessage | OpenMessage): boolean {
  if (window.parent === window) return false;
  const origin = embedOrigin();
  if (!origin) return false;
  window.parent.postMessage(msg, origin);
  return true;
}

/** The query param a host names its own page with, beside `embed_origin`:
 *  where a person opens this app on the host (`https://box/` for Stadeum's
 *  home), without the app's `input`. Left on the address bar (it names no
 *  secret, and a reload keeps it); never a deep-link param. */
export const EMBED_PAGE_PARAM = "embed_page";

/** The host's page this page is shown on (`?embed_page=`): the address a
 *  person pastes to open the app there, which the app is handed as
 *  `strut/page` in its host context (@strut/kit `useShareLink`). Only while
 *  framed, and on the origin the server vouches for (`vouchedEmbedOrigin`:
 *  a host that signed the person in with a ticket, which the browser also
 *  holds the frame to): a host names its own page, never another site's,
 *  and a page that only names one gets none. So an app can take it as it
 *  is. */
export function embedPage(search = location.search, framed = window.parent !== window, origin = vouchedEmbedOrigin() || null): string | undefined {
  if (!framed) return undefined;
  const page = new URLSearchParams(search).get(EMBED_PAGE_PARAM);
  if (!page) return undefined;
  try {
    const url = new URL(page);
    return origin && url.origin === origin ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function reportLocation(): void {
  postToHost({ type: "strut:location", params: deepLinkParams(location.search) });
}

let readyReported = false;
/** Tell the embedding host the page is on screen (`ReadyMessage`). Once. */
export function reportReady(): void {
  if (readyReported) return;
  readyReported = true;
  postToHost({ type: "strut:ready" });
}

/** Ask the embedding host to show app `to` as its page (`OpenMessage`).
 *  False when nothing frames this page to ask: the page goes there itself. */
export function openInHost(to: { app: string; input?: string }): boolean {
  return postToHost({ type: "strut:open", app: to.app, ...(to.input ? { input: to.input } : {}) });
}

/** `history.replaceState` + tell the embedding host, if there is one. The
 *  entry's state (the back trail, ./nav-trail) is kept unless one is given. */
export function replaceUrl(url: string | URL, state: unknown = history.state): void {
  history.replaceState(state, "", url);
  reportLocation();
}

/** `history.pushState` + tell the embedding host: a new back-button entry. */
export function pushUrl(url: string | URL, state: unknown): void {
  history.pushState(state, "", url);
  reportLocation();
}
