// ── Packages in the UI, the pure parts ──────────────────────────────────────
//
// What the Publish dialog's Packages tab works out (plans/packages-ux.md). Names stay
// bare where they are made, and a package is what a person PICKS on its
// page: so the page groups the workflows here by category, leaves out what
// an installed package or the host brought, reads off a dry build what
// comes along with the picks, starts from what the newest release held,
// and suggests the next version.

/** A package name: `publisher/name`, two lowercase segments — the server's
 *  PACKAGE_NAME (src/packages/format.ts). */
export const PACKAGE_NAME = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

/** The part of a package name a person types — `tools` in `stakwork/tools`;
 *  the publisher is the server's. */
export const PACKAGE_SEGMENT = /^[a-z][a-z0-9-]{0,63}$/;

/** The package prefix a name sits under: its first two segments when a
 *  third names the item (`stakwork/tools/summarize` → `stakwork/tools`);
 *  null for a name with fewer. */
export function packageOf(name: string): string | null {
  const parts = name.split("/");
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : null;
}

/** An item an installed package brought: someone else's to publish. */
export function isInstalledName(name: string, installed: readonly string[]): boolean {
  const pkg = packageOf(name);
  return !!pkg && installed.includes(pkg);
}

/** A service's stamp — any `publisher` but the builder's `ai` — marks the
 *  host's own item, which no package carries (src/packages/build.ts). */
export const isHostsStamp = (publisher?: string) => publisher !== undefined && publisher !== "ai";

/** An item's path in the package `pkg`: the rest of a name under its
 *  prefix, a bare name as it is. */
export const pathIn = (pkg: string, name: string) => (name.startsWith(`${pkg}/`) ? name.slice(pkg.length + 1) : name);

export interface PickerGroup {
  /** The sidebar's category; null for none. */
  category: string | null;
  names: string[];
}

/** The workflows a package may take, grouped by category for its page —
 *  every workflow here but an installed package's and the host's (a seed's,
 *  or one a service published), names sorted, categories by name with the
 *  uncategorized last. `q` keeps the names (or categories) that contain it. */
export function pickerGroups(
  workflows: ReadonlyArray<{ name: string; category?: string; publisher?: string; activeSource?: string }>,
  opts: { installed?: readonly string[]; q?: string } = {},
): PickerGroup[] {
  const q = opts.q?.trim().toLowerCase() ?? "";
  const groups = new Map<string | null, string[]>();
  for (const w of workflows) {
    if (isInstalledName(w.name, opts.installed ?? []) || isHostsStamp(w.publisher) || w.activeSource === "seed") continue;
    const category = w.category?.trim() || null;
    if (q && !w.name.toLowerCase().includes(q) && !(category ?? "").toLowerCase().includes(q)) continue;
    const names = groups.get(category) ?? [];
    names.push(w.name);
    groups.set(category, names);
  }
  return [...groups]
    .map(([category, names]) => ({ category, names: names.sort() }))
    .sort((a, b) => (a.category === null ? 1 : b.category === null ? -1 : a.category.localeCompare(b.category)));
}

/** What a dry build carries beyond the picks, read off its files and
 *  sorted by kind: the workflows and apps it adds, every step (helpers left
 *  out), the Concept pages under each root named, and the graph types it
 *  adds — the parents of the types named — each by its path in the package;
 *  the picks it does NOT carry — the host's own, which the installing
 *  strut has; and, from the build's `leftToInstaller`, what it reaches
 *  that the installing strut must already have (`needs`: a seed of this
 *  strut's host, a service's item), with the build's warnings left to show
 *  once those are said. */
export function comesAlong(
  pkg: string,
  files: readonly string[],
  picked: { workflows: readonly string[]; apps: readonly string[]; concepts?: readonly string[]; conceptsAlone?: readonly string[]; types?: readonly string[] },
  built: { warnings?: readonly string[]; leftToInstaller?: ReadonlyArray<{ kind: string; name: string }> } = {},
): {
  workflows: string[];
  steps: string[];
  apps: string[];
  concepts: { roots: string[]; pages: number };
  types: string[];
  leftOut: string[];
  needs: string[];
  warnings: string[];
} {
  const workflows = new Set<string>();
  const steps = new Set<string>();
  const apps = new Set<string>();
  const types = new Set<string>();
  let pages = 0;
  for (const f of files) {
    const wf = /^workflows\/(.+)\.yaml$/.exec(f);
    const step = /^steps\/(.+)\.ts$/.exec(f);
    const app = /^apps\/([^/]+)\//.exec(f);
    const type = /^graph\/(.+)\.yaml$/.exec(f);
    const page = /^concepts\/(.+)\.md$/.exec(f);
    if (type) types.add(type[1]!);
    else if (page) pages++;
    else if (wf) workflows.add(wf[1]!);
    else if (step && !step[1]!.split("/").pop()!.startsWith("_")) steps.add(step[1]!);
    else if (app) apps.add(app[1]!);
  }
  const pickedWf = new Set(picked.workflows.map((n) => pathIn(pkg, n)));
  const pickedApps = new Set(picked.apps.map((n) => pathIn(pkg, n)));
  // A page's file is its node key, not its name; a build that answered
  // carries every Concept named (one missing refuses it).
  const roots = pages ? [...(picked.concepts ?? []), ...(picked.conceptsAlone ?? [])].sort() : [];
  const left = built.leftToInstaller ?? [];
  return {
    workflows: [...workflows].filter((p) => !pickedWf.has(p)).sort(),
    steps: [...steps].sort(),
    apps: [...apps].filter((p) => !pickedApps.has(p)).sort(),
    concepts: { roots, pages: Math.max(0, pages - roots.length) },
    // A parent of a named type comes along; the names match case-blind, as the graph's do.
    types: [...types].filter((t) => !(picked.types ?? []).some((n) => n.toLowerCase() === t.toLowerCase())).sort(),
    leftOut: [...picked.workflows.filter((n) => !workflows.has(pathIn(pkg, n))), ...picked.apps.filter((n) => !apps.has(pathIn(pkg, n)))].sort(),
    needs: [...new Set(left.map((l) => l.name))].sort(),
    // Each one's warning (src/packages/build.ts) is what `needs` says.
    warnings: (built.warnings ?? []).filter((w) => !left.some((l) => w.startsWith(`the ${l.kind} ${l.name} is left to the installing strut`))),
  };
}

/** Names grouped by their namespace — everything before the last `/` —
 *  so twenty `openlaw/*` steps read as one line: `[{ ns: "openlaw", names:
 *  ["climbs", "runs"] }]`; a bare name's namespace is "". Namespaces sorted,
 *  the bare ones last. */
export function byNamespace(names: readonly string[]): Array<{ ns: string; names: string[] }> {
  const groups = new Map<string, string[]>();
  for (const n of names) {
    const cut = n.lastIndexOf("/");
    const ns = cut < 0 ? "" : n.slice(0, cut);
    const list = groups.get(ns) ?? [];
    list.push(cut < 0 ? n : n.slice(cut + 1));
    groups.set(ns, list);
  }
  return [...groups]
    .map(([ns, list]) => ({ ns, names: list.sort() }))
    .sort((a, b) => (a.ns === "" ? 1 : b.ns === "" ? -1 : a.ns.localeCompare(b.ns)));
}

/** The picks a release held, as the names they have HERE: an item's name
 *  inside the package is a bare name here, or the same under the prefix;
 *  one that is neither (gone since) is left out. A subflow the release
 *  carried is ticked too — it comes along either way. */
export function picksFromRelease(
  pkg: string,
  items: ReadonlyArray<{ kind: string; name: string; alone?: boolean }>,
  here: { workflows: ReadonlySet<string>; apps: ReadonlySet<string> },
): { workflows: string[]; apps: string[]; concepts: string[]; conceptsAlone: string[]; types: string[] } {
  const local = (set: ReadonlySet<string>, name: string) => (set.has(name) ? name : set.has(`${pkg}/${name}`) ? `${pkg}/${name}` : null);
  const out = { workflows: [] as string[], apps: [] as string[], concepts: [] as string[], conceptsAlone: [] as string[], types: [] as string[] };
  for (const item of items) {
    // A page the release carried alone is picked alone again: its pages here stay here.
    if (item.kind === "concept") (item.alone ? out.conceptsAlone : out.concepts).push(item.name);
    else if (item.kind === "type") out.types.push(item.name);
    else if (item.kind === "workflow") {
      const n = local(here.workflows, item.name);
      if (n) out.workflows.push(n);
    } else if (item.kind === "app") {
      const n = local(here.apps, item.name);
      if (n) out.apps.push(n);
    }
  }
  return { workflows: out.workflows.sort(), apps: out.apps.sort(), concepts: out.concepts.sort(), conceptsAlone: out.conceptsAlone.sort(), types: out.types.sort() };
}

/** An installed package as the sidebar shows it: its name, version and
 *  where it came from — `GET /packages`. */
export interface InstalledRef {
  package: string;
  version?: string;
  source?: { ref: string };
}

export interface SidebarGroup<W> {
  /** The collapse key: a category, `pkg:<publisher/name>` for an installed
   *  package's group, "" for the uncategorized. */
  key: string;
  /** What the header shows: the category; for an installed package its
   *  segment (`tools`), or its whole name when another group would read the
   *  same. */
  label: string;
  /** Set on an installed package's group: drawn from what is installed,
   *  never from a category, so nothing local mixes into it. */
  installed?: InstalledRef;
  wfs: W[];
}

/** The sidebar's groups (plans/packages-ux.md §4): a workflow an installed
 *  package brought sits in that package's group, whatever its category; any
 *  other in its category, or the uncategorized group. Nothing is written for
 *  it — uninstall the package and the group is gone. Unordered: the sidebar
 *  orders groups by recency. */
export function sidebarGroups<W extends { name: string; category?: string }>(
  workflows: readonly W[],
  installed: readonly InstalledRef[],
): SidebarGroup<W>[] {
  const byName = new Map(installed.map((p) => [p.package, p]));
  const groups = new Map<string, SidebarGroup<W>>();
  for (const wf of workflows) {
    const pkg = packageOf(wf.name);
    const inst = pkg ? byName.get(pkg) : undefined;
    const key = inst ? `pkg:${inst.package}` : (wf.category ?? "");
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, label: inst ? inst.package : (wf.category ?? ""), ...(inst ? { installed: inst } : {}), wfs: [] }));
    g.wfs.push(wf);
  }
  // A package's segment alone, unless another group would read the same.
  const all = [...groups.values()];
  const segment = (p: string) => p.slice(p.indexOf("/") + 1);
  for (const g of all) {
    if (!g.installed) continue;
    const seg = segment(g.installed.package);
    const clash = all.some((o) => o !== g && (o.installed ? segment(o.installed.package) === seg : o.label === seg));
    g.label = clash ? g.installed.package : seg;
  }
  return all;
}

/** A workflow's name in its sidebar group: inside an installed package's
 *  group, its name inside the package (`summarize` for
 *  `acme/tools/summarize`); elsewhere, the name. */
export function nameInGroup(name: string, group: Pick<SidebarGroup<unknown>, "installed">): string {
  const pkg = group.installed?.package;
  return pkg && name.startsWith(`${pkg}/`) ? name.slice(pkg.length + 1) : name;
}

/** An installed package's header hover: name, version, where from. */
export function installedTitle(p: InstalledRef): string {
  return [p.package, p.version, p.source?.ref ? `installed from ${p.source.ref}` : "installed"].filter(Boolean).join(" · ");
}

/** How the UI names a package: the package segment alone when it is this
 *  strut's publisher's (`stakwork/tools` → `tools`), the whole name
 *  otherwise — the publisher is the server's, never typed. */
export function packageLabel(pkg: string, publisher?: string): string {
  return publisher && pkg.startsWith(`${publisher}/`) ? pkg.slice(publisher.length + 1) : pkg;
}

/** The version to suggest after `newest`: its last number up by one
 *  (`1.4.0` → `1.4.1`, `v3` → `v4`); `1.0.0` for a first release, and the
 *  label unchanged when it has no number to raise. */
export function nextVersion(newest?: string): string {
  if (!newest) return "1.0.0";
  return newest.replace(/(\d+)(\D*)$/, (_, n: string, rest: string) => `${Number(n) + 1}${rest}`);
}
