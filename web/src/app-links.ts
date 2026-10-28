// ── The app host's pure parts (plans/apps.md §7.3) ─────────────────────────
// What ./app-host decides without the bridge: where a page's `ui/open-link`
// leads, and what its `ui/message` becomes in the builder chat. Kept apart
// from ./app-host, which imports the MCP packages, so the root test run —
// which installs no web/node_modules — can test them.

/** The deep-link params a strut link may carry (./embed). `input` rides
 *  beside `app`: what the app is opened with. */
const STRUT_PARAMS = new Set(["wf", "run", "v", "job", "app", "input", "chat"]);

/** Where `ui/open-link` leads: the SPA's own navigation for a link to THIS
 *  strut (the same origin and mount, carrying strut's deep-link params —
 *  `?wf=`, `?run=`, `?job=`, `?app=` with its `input`), a new tab for
 *  anything else. Pure: `here` is the page's own location. */
export function strutLink(url: string, here: { origin: string; pathname: string }): Record<string, string> | null {
  let u: URL;
  try {
    u = new URL(url, `${here.origin}${here.pathname}`);
  } catch {
    return null;
  }
  if (u.origin !== here.origin) return null;
  const mount = here.pathname.replace(/\/[^/]*$/, "/");
  const path = u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
  if (path !== mount && u.pathname !== here.pathname) return null;
  const params: Record<string, string> = {};
  for (const [k, v] of u.searchParams) if (STRUT_PARAMS.has(k) && v) params[k] = v;
  return Object.keys(params).length ? params : null;
}

/** What `?input=` opens an app with (plans/apps.md §7.1): the app's own
 *  query string inside the one param, read back as flat strings —
 *  `view=%2Fruns&run=123` is `{ view: "/runs", run: "123" }` — which the
 *  host sends as `ui/notifications/tool-input`. The keys are the app's: a
 *  host copies the value and never reads it. Undefined for no value, or
 *  one with no keys. */
export function appToolInput(input: string | null | undefined): Record<string, string> | undefined {
  if (!input) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(input)) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

/** A strut link from a PEER's app, as this strut's UI follows it. The page
 *  names apps where it lives, so `app=<name>` is that peer's
 *  `@<peer>/<name>`, its `input` kept. Anything else — a workflow, a run, a
 *  job, an app on the peer's own peer — is the peer's to open: null. */
export function peerAppLink(params: Record<string, string>, peer: string): Record<string, string> | null {
  const app = params["app"];
  if (!app || app.startsWith("@")) return null;
  return { app: `@${peer}/${app}`, ...(params["input"] ? { input: params["input"] } : {}) };
}

/** Whether a link's `app` key names the app on screen — its name and peer,
 *  and its version when the key pins one. */
export function namesApp(key: string | undefined, app: { name: string; version: string; peer?: string }): boolean {
  const to = key ? parseAppKey(key) : null;
  return !!to && to.name === app.name && to.peer === app.peer && (!to.version || to.version === app.version);
}

/** How the sidebar and `?app=` name an app: its name for one here,
 *  `@<peer>/<name>` for a peer's, hosted through the read-through
 *  (plans/apps.md §7.4). An app name never starts with `@` (the pin), so
 *  the two never meet. */
export function appKey(app: { name: string; peer?: string }): string {
  return app.peer ? `@${app.peer}/${app.name}` : app.name;
}

/** `appKey` read back: which app a key names, and on which peer — what
 *  the page alone (`?solo=1`) needs to read that one listing. A peer id has
 *  no `/`, so the name is everything after the first one. A key may end in
 *  `@vN`, the pin an import takes (`hive/ui@v3`): that version rather than
 *  the live one — a draft, for `app/look` — or in `@preview-<hex>`, an
 *  unpublished build `app/look { path }` hosts. Null for a key that names nothing
 *  (`@acme`, `@/x`, "", `bench@`). */
export function parseAppKey(key: string): { name: string; peer?: string; version?: string } | null {
  const pin = key.match(/^(.+)@(v\d+|preview-[0-9a-f]{12})$/);
  const version = pin?.[2];
  const rest = pin ? pin[1]! : key;
  if (!pin && /@[^/]*$/.test(key.slice(1))) return null;
  const at = version ? { version } : {};
  if (!rest.startsWith("@")) return rest ? { name: rest, ...at } : null;
  const slash = rest.indexOf("/");
  const peer = rest.slice(1, slash);
  const name = rest.slice(slash + 1);
  return slash > 0 && peer && name ? { name, peer, ...at } : null;
}

/** Is this version label a preview's (`app/look { path }`), not a `vN`? */
export const isPreviewVersion = (version: string | undefined): boolean => !!version && /^preview-[0-9a-f]{12}$/.test(version);

/** What `ui/message` from an app becomes in the builder chat: the text,
 *  prefixed with which app it is about — the builder edits the directory. */
export function appMessage(app: { name: string; version: string }, text: string): string {
  return `About the app "${app.name}" (${app.version}, open in front of me): ${text.trim()}`;
}
