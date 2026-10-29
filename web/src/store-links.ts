// The STORE FRONT's pure parts (plans/marketplace.md §7, the store;
// components/Store.tsx draws it): what is on screen, read from and written
// to the URL — `?store=1` is the page, `pkg=` a package, `concept=` a Concept
// page, `q=` a search — and the DEEP LINK out of it. The store runs on an
// index strut for anyone, with no credential, so nothing here installs:
// "Install" is a link INTO the visitor's own strut, `?install=<name>`, which
// the shell opens in its Packages dialog (parseInstallLink), the index's key
// and catalog URL riding along so a strut that does not follow that index
// yet can start to. Tested in store-links.test.ts.

export type StoreView =
  | { view: "browse"; q?: string }
  | { view: "package"; pkg: string }
  | { view: "concept"; concept: string };

export const PACKAGE_NAME_RE = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

/** Which store view a URL's query names. `?store=1` alone is the browse
 *  page; a `pkg` that is not a package name is ignored. */
export function parseStoreView(search: string): StoreView {
  const p = new URLSearchParams(search);
  const pkg = p.get("pkg");
  if (pkg && PACKAGE_NAME_RE.test(pkg)) return { view: "package", pkg };
  // `concept=` with no name is the tree's index page.
  const concept = p.get("concept");
  if (concept !== null) return { view: "concept", concept: concept.trim() };
  const q = p.get("q");
  return q?.trim() ? { view: "browse", q: q.trim() } : { view: "browse" };
}

/** The query string for a view, with `store=1` kept and nothing else. */
export function storeQuery(v: StoreView): string {
  const p = new URLSearchParams();
  p.set("store", "1");
  if (v.view === "package") p.set("pkg", v.pkg);
  else if (v.view === "concept") p.set("concept", v.concept);
  else if (v.q) p.set("q", v.q);
  return `?${p.toString()}`;
}

/** What the store hands a strut: the package by name, and the index that
 *  lists it (its key and where its card is served), so the strut can
 *  follow that index first when it does not yet. */
export interface InstallLink {
  pkg: string;
  index?: { key: string; url: string };
}

/** A strut's address as a person types it (`localhost:3000`,
 *  `https://strut.acme.example/lab/`) → its origin + mount, or null. */
export function normalizeStrutUrl(text: string): string | null {
  let s = text.trim();
  if (!s) return null;
  // No scheme (`localhost:3000` is a host and a port) → http; another
  // scheme is not a strut's address.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** The link into a strut's UI that opens its Packages dialog on the package. */
export function installLink(strutUrl: string, link: InstallLink): string {
  const p = new URLSearchParams();
  p.set("install", link.pkg);
  if (link.index) {
    p.set("index", link.index.key);
    p.set("index_url", link.index.url);
  }
  return `${strutUrl}/?${p.toString()}`;
}

const Z32_KEY_RE = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;

/** The shell's side: `?install=<name>[&index=<key>&index_url=<url>]`, or
 *  null when the query carries no (well-formed) link. An index needs both
 *  its key and a http(s) URL to be worth following. */
export function parseInstallLink(search: string): InstallLink | null {
  const p = new URLSearchParams(search);
  const pkg = p.get("install");
  if (!pkg || !PACKAGE_NAME_RE.test(pkg)) return null;
  const key = p.get("index");
  const url = p.get("index_url");
  const index = key && Z32_KEY_RE.test(key) && url && /^https?:\/\/\S+$/.test(url) ? { key, url } : undefined;
  return index ? { pkg, index } : { pkg };
}

/** The id a strut files an index under when it follows one from a link:
 *  its host, as `PUT /packages/indexes/:id` takes an id. */
export function indexIdOf(url: string): string {
  let host = "index";
  try {
    host = new URL(url).host || host;
  } catch {
    /* keep the default */
  }
  return host.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "index";
}

/** Which parameters the shell's URL sync drops once the dialog is closed. */
export const INSTALL_LINK_PARAMS = ["install", "index", "index_url"] as const;

/** An app as a search hit carries it. */
export interface HitApp {
  name: string;
  title: string;
  description?: string;
  icon?: string;
  can: { spends: boolean; acts: boolean; code: boolean };
}

/** The apps a search's hits carry, each with its package — the Browse
 *  page's first row. Sorted by title, then package. */
export function appsOf<A extends HitApp>(hits: ReadonlyArray<{ package: string; version: string; detail?: { apps: A[] } }>): Array<{ pkg: string; version: string; app: A }> {
  const out: Array<{ pkg: string; version: string; app: A }> = [];
  for (const h of hits) for (const app of h.detail?.apps ?? []) out.push({ pkg: h.package, version: h.version, app });
  return out.sort((a, b) => a.app.title.localeCompare(b.app.title) || a.pkg.localeCompare(b.pkg));
}

/** The roots of the Concept tree the index knows: pages whose parent is
 *  nowhere in the list (or who have none), each with how many pages sit
 *  under it, at any depth. */
export function conceptRoots<C extends { name: string; parent?: string }>(concepts: readonly C[]): Array<{ root: C; pages: number }> {
  const byName = new Map(concepts.map((c) => [c.name, c]));
  const rootOf = (c: C): C => {
    const seen = new Set<string>([c.name]);
    let cur = c;
    while (cur.parent && byName.has(cur.parent) && !seen.has(cur.parent)) {
      seen.add(cur.parent);
      cur = byName.get(cur.parent)!;
    }
    return cur;
  };
  const counts = new Map<string, number>();
  for (const c of concepts) {
    const r = rootOf(c);
    if (r !== c) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
  }
  return concepts
    .filter((c) => !c.parent || !byName.has(c.parent))
    .map((root) => ({ root, pages: counts.get(root.name) ?? 0 }))
    .sort((a, b) => b.pages - a.pages || a.root.name.localeCompare(b.root.name));
}

/** "spends · acts · code", or "reads" when a thing does none of them. */
export function canWords(can: { spends: boolean; acts: boolean; code: boolean }): string[] {
  const out: string[] = [];
  if (can.spends) out.push("spends");
  if (can.acts) out.push("acts");
  if (can.code) out.push("code");
  return out.length ? out : ["reads"];
}

/** A key, short: the first 8 and the last 6 characters. */
export const shortKey = (key: string) => (key.length > 20 ? `${key.slice(0, 8)}…${key.slice(-6)}` : key);
