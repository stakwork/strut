// ── The app host's pure parts (plans/apps.md §7.3) ─────────────────────────
// What ./app-host decides without the bridge: where a page's `ui/open-link`
// leads, and what its `ui/message` becomes in the builder chat. Kept apart
// from ./app-host, which imports the MCP packages, so the root test run —
// which installs no web/node_modules — can test them.

/** The deep-link params a strut link may carry (./embed). */
const STRUT_PARAMS = new Set(["wf", "run", "v", "job", "app", "chat"]);

/** Where `ui/open-link` leads: the SPA's own navigation for a link to THIS
 *  strut (the same origin and mount, carrying strut's deep-link params —
 *  `?wf=`, `?run=`, `?job=`, `?app=`), a new tab for anything else. Pure:
 *  `here` is the page's own location. */
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

/** How the sidebar and `?app=` name an app: its name for one here,
 *  `@<peer>/<name>` for a peer's, hosted through the read-through
 *  (plans/apps.md §7.4). An app name never starts with `@` (the pin), so
 *  the two never meet. */
export function appKey(app: { name: string; peer?: string }): string {
  return app.peer ? `@${app.peer}/${app.name}` : app.name;
}

/** `appKey` read back: which app a key names, and on which peer — what
 *  the page alone (`?solo=1`) needs to read that one listing. A peer id has
 *  no `/`, so the name is everything after the first one. Null for a key
 *  that names nothing (`@acme`, `@/x`, ""). */
export function parseAppKey(key: string): { name: string; peer?: string } | null {
  if (!key.startsWith("@")) return key ? { name: key } : null;
  const slash = key.indexOf("/");
  const peer = key.slice(1, slash);
  const name = key.slice(slash + 1);
  return slash > 0 && peer && name ? { name, peer } : null;
}

/** What `ui/message` from an app becomes in the builder chat: the text,
 *  prefixed with which app it is about — the builder edits the directory. */
export function appMessage(app: { name: string; version: string }, text: string): string {
  return `About the app "${app.name}" (${app.version}, open in front of me): ${text.trim()}`;
}
