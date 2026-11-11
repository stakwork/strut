// ── Which page the UI shows (plans/member-rights.md) ───────────────────────
// What `App` renders, decided from the address and the session before any
// of it loads: the store front, one thing alone (`?solo=1`), a MEMBER's
// list of apps, or the operator's shell. Pure, so the root test run covers
// it (no web/node_modules there).
import { soloTheme } from "./app-links";
import { remoteBase } from "./remote-app";

/** The session the page runs under, as `GET /auth/session` says: a host's
 *  ticket names the role; the key login (and the key itself) none. */
export interface PageSession {
  actor?: string;
  role?: "admin" | "member" | "visitor";
}

/** A SERVED box's page (plans/app-repos.md §4.2): the server writes
 *  `<meta name="strut-serve" content="<app>">` into `/` — the app's name,
 *  empty while nothing is deployed yet. `key`: this browser holds the key. */
export interface ServedBox {
  app: string;
  key: boolean;
}

export type Page =
  | { kind: "store" }
  | { kind: "unserved" }
  | { kind: "app"; app: string; input: string | null; visitor: boolean; from?: string; theme?: "light" | "dark" }
  /** A `from` this host does not open (./remote-app `remoteBase`): why. */
  | { kind: "refused"; message: string }
  | { kind: "artifact"; artifact: string }
  | { kind: "member-apps" }
  | { kind: "shell" };

/**
 * The page for this address and session.
 *  - On a SERVED box (`served`): its app alone, as a visitor's page, at any
 *    address — `?input=` and `?theme=` as for any app alone. Only `?shell=1`
 *    with the key or a session goes on to the rules below: the operator's
 *    console. Nothing deployed yet: a page that says so.
 *  - `?store=1`: the store front, whoever asks.
 *  - `?app=<name>&from=<base>` (`&public=1`, `&solo=1` implied): another
 *    strut server's public app, alone, with this UI as its host
 *    (./remote-app); a `from` it does not open is a page saying why.
 *  - `?solo=1` beside `?app=` or `?artifact=`: that alone, as before.
 *  - A MEMBER (a host signed them in as one): an app or a file it names
 *    alone, `?solo=1` or not — a member's session opens nothing else — and
 *    otherwise the list of the apps here. Never the shell: every route it
 *    reads is an admin's.
 *  - Anyone else: the shell.
 */
export function pickPage(search: string | URLSearchParams, signedIn: PageSession | null, served: ServedBox | null = null): Page {
  const p = typeof search === "string" ? new URLSearchParams(search) : search;
  // A VISITOR's session (plans/app-repos.md §5) opens the public apps and
  // nothing of this page's: as none here.
  const session = signedIn?.role === "visitor" ? null : signedIn;
  if (served && !(p.get("shell") === "1" && (served.key || session))) {
    if (!served.app) return { kind: "unserved" };
    const theme = soloTheme(p.get("theme"));
    return { kind: "app", app: served.app, input: p.get("input"), visitor: true, ...(theme ? { theme } : {}) };
  }
  if (p.get("store") === "1") return { kind: "store" };
  // Another strut server's public app, this UI its host: alone, whoever
  // asks — it reads nothing of this strut's — and never this strut's app
  // of the same name when the server is not one it opens.
  const from = p.get("from");
  const remoteApp = p.get("app");
  if (from !== null && remoteApp) {
    const r = remoteBase(from);
    if ("error" in r) return { kind: "refused", message: `Not opened: ${r.error}.` };
    const theme = soloTheme(p.get("theme"));
    return { kind: "app", app: remoteApp, input: p.get("input"), visitor: true, from: r.base, ...(theme ? { theme } : {}) };
  }
  const member = session?.role === "member";
  if (p.get("solo") === "1" || member) {
    const app = p.get("app");
    if (app) {
      const theme = soloTheme(p.get("theme"));
      return { kind: "app", app, input: p.get("input"), visitor: p.get("public") === "1", ...(theme ? { theme } : {}) };
    }
    const artifact = p.get("artifact");
    if (artifact) return { kind: "artifact", artifact };
  }
  return member ? { kind: "member-apps" } : { kind: "shell" };
}

/** strut's own assistant: first on a member's list. */
export const ASSISTANT_APP = "strut/jamie";
/** Apps that are no page: a component library other apps import. */
const LIBRARIES = new Set(["strut/views"]);

/** A member's apps as their list shows them: no libraries; the assistant
 *  first, then the apps pinned as tabs, then the rest by title. */
export function memberApps<T extends { name: string; title: string; pinned?: boolean }>(apps: T[]): T[] {
  const rank = (a: T) => (a.name === ASSISTANT_APP ? 0 : a.pinned ? 1 : 2);
  return apps
    .filter((a) => !LIBRARIES.has(a.name))
    .sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title) || a.name.localeCompare(b.name));
}

/** The link that opens an app alone. */
export function soloAppHref(name: string): string {
  return `?${new URLSearchParams({ app: name, solo: "1" }).toString()}`;
}
