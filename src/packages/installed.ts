/**
 * What is INSTALLED (plans/marketplace.md §3): a FOLD over the workspace,
 * never a store. A workflow, step or app version that a package install
 * wrote carries `upstream` (and `source: "install"`); a Concept a package wrote
 * carries the stamp `pkg/<package>/<file>@<hash>`. Grouped by package, each
 * item says which version the install put there and whether the active one
 * is still it — `modified` is a fork, which an update never activates over
 * and an uninstall leaves in place.
 *
 * A Concept has no versions: whether it was edited is its text against the
 * file it came from, read from the package's directory in the cache
 * (`<dataDir>/packages/sha256-…/`, kept since the install).
 */
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { GraphBackend } from "../graph/backend.js";
import { conceptEdited, parseConceptFile } from "../concept-seed.js";
import { loadYaml } from "../yaml.js";
import {
  packagePrefixOf,
  versionLabelOrder,
  type Upstream,
  type VersionSource,
  type WorkspaceStore,
} from "../workspace.js";
import type { PackageCache } from "./cache.js";
import { MANIFEST_FILE, PACKAGE_DIGEST } from "./format.js";

/** The stamp prefix of a package's Concepts (`seedConcepts`' set prefix). */
export const conceptPrefix = (pkg: string): string => `pkg/${pkg}/`;

export interface InstalledItem {
  kind: "workflow" | "step" | "app" | "concept";
  name: string;
  /** A `_` step file: published with its namespace, never registered. */
  helper?: true;
  /** The version the install published (a workflow's, step's or app's). */
  installed?: string;
  /** The active version (a workflow's, step's or app's). */
  active?: string;
  /** The active version is not the installed one — a fork — or a Concept's
   *  text is no longer its file's. Absent when that cannot be told: a
   *  Concept whose file the cache no longer holds. */
  modified?: boolean;
}

export interface InstalledPackage {
  package: string;
  /** Read off the install's version records; for a package of Concepts
   *  alone, off its directory in the cache when it is there. */
  version?: string;
  digest?: string;
  source?: { ref: string };
  /** What its steps may read (the fence, src/packages/fence.ts). */
  secrets?: string[];
  items: InstalledItem[];
}

export interface InstalledDeps {
  workspace: WorkspaceStore;
  cache: PackageCache;
  graph?: GraphBackend;
}

interface VersionRecord {
  source?: VersionSource;
  upstream?: Upstream;
}

/** The version an install put there: the newest one the install door wrote,
 *  else (a record from before steps kept their door) the oldest that names
 *  a package. */
function installedVersion(versions: Record<string, VersionRecord>): string | undefined {
  const labels = Object.keys(versions).sort(versionLabelOrder);
  return [...labels].reverse().find((l) => versions[l]!.source === "install" && versions[l]!.upstream) ?? labels.find((l) => versions[l]!.upstream);
}

/** Every installed package, sorted by name, its items by kind then name. */
export async function listInstalledPackages(deps: InstalledDeps): Promise<InstalledPackage[]> {
  const packages = new Map<string, InstalledPackage>();
  const entry = (name: string): InstalledPackage => {
    let p = packages.get(name);
    if (!p) packages.set(name, (p = { package: name, items: [] }));
    return p;
  };
  const note = (kind: "workflow" | "step" | "app", name: string, versions: Record<string, VersionRecord>, active: string) => {
    const installed = installedVersion(versions);
    const upstream = installed ? versions[installed]!.upstream : undefined;
    // An item is its package's only under its prefix.
    if (!installed || !upstream || packagePrefixOf(name) !== upstream.package) return;
    const p = entry(upstream.package);
    if (!p.digest) Object.assign(p, { version: upstream.version, digest: upstream.digest, source: upstream.source, secrets: upstream.secrets });
    const helper = kind === "step" && name.split("/").pop()!.startsWith("_");
    p.items.push({ kind, name, ...(helper ? { helper: true as const } : {}), installed, active, modified: active !== installed });
  };

  for (const w of await deps.workspace.listWorkflows()) {
    if (!packagePrefixOf(w.name)) continue;
    const meta = await deps.workspace.getWorkflowMetadata(w.name);
    if (meta) note("workflow", w.name, meta.versions, meta.active);
  }
  // Every custom step, helpers included (the listing leaves helpers out).
  for (const type of Object.keys(await deps.workspace.getActiveStepHashes())) {
    if (!packagePrefixOf(type)) continue;
    const meta = await deps.workspace.getStepMetadata(type);
    if (meta) note("step", type, meta.versions, meta.active);
  }
  for (const a of await deps.workspace.listApps()) {
    if (!packagePrefixOf(a.name)) continue;
    const rec = await deps.workspace.getApp(a.name);
    if (rec) note("app", a.name, rec.versions, rec.active);
  }
  for (const c of await packageConcepts(deps.graph)) {
    const p = entry(c.package);
    if (!p.digest) await fromCache(deps.cache, p, c);
    const text = p.digest ? await readText(join(deps.cache.dirOf(p.digest), "concepts", c.file)) : undefined;
    // The file this node was stamped from is the one at that digest only when the hashes agree.
    const file = text !== undefined && conceptHash(text) === c.hash ? parseConceptFile(c.file, text, conceptPrefix(c.package)) : undefined;
    p.items.push({ kind: "concept", name: c.name, ...(file ? { modified: conceptEdited(c, file) } : {}) });
  }

  const kinds = ["workflow", "step", "app", "concept"];
  return [...packages.values()]
    .map((p) => ({ ...p, items: p.items.sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.package.localeCompare(b.package));
}

export interface PackageConcept {
  package: string;
  /** `concepts/<file>` in the package. */
  file: string;
  /** The first 12 hex of the file's sha256, as the stamp carries it. */
  hash: string;
  name: string;
  ref_id: string;
  description?: unknown;
  docs?: unknown;
}

/** Every live Concept a package wrote, read off its stamp. */
export async function packageConcepts(graph: GraphBackend | undefined, pkg?: string): Promise<PackageConcept[]> {
  if (!graph) return [];
  const d = graph.dialect;
  const rows = await graph.query(
    `MATCH ${d.node("c", "Concept", { namespace: "$ns" })} WHERE ${d.live("c")} AND c.unique_source_id STARTS WITH $prefix
     RETURN ${d.project("c", ["ref_id", "name", "unique_source_id", "description", "docs"])} AS p`,
    { ns: graph.namespace, prefix: pkg ? conceptPrefix(pkg) : "pkg/" },
  );
  const out: PackageConcept[] = [];
  for (const r of rows) {
    const p = r["p"] as Record<string, unknown>;
    const m = /^pkg\/([^/]+\/[^/]+)\/([^/]+)@([0-9a-f]+)$/.exec(String(p["unique_source_id"] ?? ""));
    if (!m) continue;
    out.push({
      package: m[1]!,
      file: m[2]!,
      hash: m[3]!,
      name: String(p["name"]),
      ref_id: String(p["ref_id"]),
      ...(p["description"] != null ? { description: p["description"] } : {}),
      ...(p["docs"] != null ? { docs: p["docs"] } : {}),
    });
  }
  return out;
}

/** A package of Concepts alone has no version record: its digest is the
 *  cached directory of that package whose page hashes to the stamp. */
async function fromCache(cache: PackageCache, p: InstalledPackage, c: PackageConcept): Promise<void> {
  let names: string[];
  try {
    names = await readdir(cache.root);
  } catch {
    return;
  }
  for (const n of names.sort()) {
    const digest = n.replace("-", ":");
    if (!PACKAGE_DIGEST.test(digest)) continue;
    const dir = cache.dirOf(digest);
    const manifest = await readText(join(dir, MANIFEST_FILE));
    let parsed: { package?: unknown; version?: unknown } | undefined;
    try {
      parsed = manifest === undefined ? undefined : (loadYaml(manifest) as typeof parsed);
    } catch {
      continue;
    }
    if (parsed?.package !== p.package) continue;
    const text = await readText(join(dir, "concepts", c.file));
    if (text === undefined || conceptHash(text) !== c.hash) continue;
    p.digest = digest;
    if (typeof parsed.version === "string") p.version = parsed.version;
    return;
  }
}

/** A page's hash as its stamp carries it (`stampOf`, concept-seed.ts). */
export const conceptHash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}
