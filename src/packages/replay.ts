/**
 * REPLAY (plans/managed-packages.md §1, §2): a fork — an installed
 * workflow, step or app this strut edited — carried onto a new release.
 *
 * Three versions matter. OURS is the active one. BASE is the item as the
 * release the fork was made from has it: a version in the item's own list
 * that a package door wrote, under the `upstream.digest` the fork carries
 * (every version is kept, so the package cache is not needed; it is the
 * fallback). THEIRS is the item as the new release has it. `replayFork`
 * merges the three (patch.ts); `forkFromPatch` reads the result out of a
 * patch a person or the builder handed in instead. Neither writes to the
 * workspace: the update door (install.ts) runs the gates and publishes.
 *
 * `localPatch` is the other direction, for reading: what this strut changed
 * in a package, as one patch file from the installed release to what is
 * active.
 *
 * A workflow edited in the web editor is in the CANVAS FORM (canvas-form.ts):
 * the editor re-dumps the whole file, so against a hand-written release
 * most of its lines differ and a line merge would conflict on a one-line
 * edit. When the fork is in that form, the base and the release are put
 * through the same order and dump before the merge, and "is it the
 * release's content now?" is asked of the release in that form.
 */
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppsCapability } from "../apps/apps.js";
import { canvasOrder } from "../canvas-form.js";
import { contentHash, treeFiles, treeHash } from "../version.js";
import { versionLabelOrder, type Upstream, type VersionSource, type WorkspaceStore } from "../workspace.js";
import { dumpYaml, loadYaml } from "../yaml.js";
import type { PackageCache } from "./cache.js";
import { byPackage, type InstalledPackage } from "./installed.js";
import { diffDirs, formatPatch, mergeText, mergeTrees } from "./patch.js";

export interface ReplayDeps {
  workspace: WorkspaceStore;
  cache: PackageCache;
  apps?: AppsCapability;
}

/** A fork the release ships. */
export interface Fork {
  kind: "workflow" | "step" | "app";
  name: string;
  /** Its path in the package: `workflows/sync.yaml`, `apps/issues`. */
  path: string;
  /** The release's file (a workflow, a step) or directory (an app). */
  theirs: string;
}

/** A fork's content: one text, or an app's directory. */
export type Content = { text: string } | { dir: string };

export type Replayed =
  /** The fork and the release agree on one content: the release's. */
  | { outcome: "converged"; notes: string[] }
  /** The fork already holds what the release changed (or the release did
   *  not change this item): it stands as it is. */
  | { outcome: "stands"; notes: string[] }
  /** The fork, carried onto the release. */
  | { outcome: "merged"; merged: Content; notes: string[] }
  /** It does not replay, and why. */
  | { outcome: "conflict"; why: string };

interface VersionRecord {
  hash?: string;
  source?: VersionSource;
  upstream?: Upstream;
}

/** An item's versions and which is active. */
export async function versionsOf(deps: ReplayDeps, kind: Fork["kind"], name: string): Promise<{ active: string; versions: Record<string, VersionRecord> } | undefined> {
  if (kind === "workflow") return (await deps.workspace.getWorkflowMetadata(name)) ?? undefined;
  if (kind === "step") return (await deps.workspace.getStepMetadata(name)) ?? undefined;
  return (await deps.workspace.getApp(name)) ?? undefined;
}

/** One version's content. */
async function contentAt(deps: ReplayDeps, kind: Fork["kind"], name: string, label: string): Promise<Content> {
  if (kind === "workflow") return { text: await deps.workspace.getWorkflowSource(name, label) };
  if (kind === "step") return { text: await deps.workspace.getStepVersionSource(name, label) };
  const at = await deps.apps?.versionDir(name, label);
  if (!at) throw new Error(`the app ${name} has no version ${label} here`);
  return { dir: at.path };
}

const exists = (path: string) => stat(path).then(() => true, () => false);

/** The release a fork was made from, as this strut still has it. */
async function baseOf(deps: ReplayDeps, fork: Fork, item: { active: string; versions: Record<string, VersionRecord> }): Promise<Content | undefined> {
  const labels = Object.keys(item.versions).sort(versionLabelOrder).reverse();
  const digest = item.versions[item.active]?.upstream?.digest;
  const label =
    labels.find((l) => byPackage(item.versions[l]) && item.versions[l]!.upstream!.digest === digest) ??
    // A fork that names no release: the newest one the package wrote before it.
    (digest ? undefined : labels.find((l) => byPackage(item.versions[l]) && versionLabelOrder(l, item.active) < 0));
  if (label) return contentAt(deps, fork.kind, fork.name, label);
  const cached = digest ? await deps.cache.get(digest).catch(() => undefined) : undefined;
  const path = cached ? join(cached.dir, ...fork.path.split("/")) : undefined;
  if (!path || !(await exists(path))) return undefined;
  return fork.kind === "app" ? { dir: path } : { text: await readFile(path, "utf-8") };
}

const hashOf = async (c: Content): Promise<string> => ("text" in c ? contentHash(c.text) : treeHash(c.dir));

/** A workflow's YAML in the canvas form (canvas-form.ts), as the web
 *  editor would publish it unchanged; undefined for text that is not a
 *  YAML mapping. */
export function canvasForm(text: string, name: string): string | undefined {
  try {
    const doc = loadYaml(text);
    return doc && typeof doc === "object" && !Array.isArray(doc) ? dumpYaml(canvasOrder(doc as Record<string, unknown>, name)) : undefined;
  } catch {
    return undefined;
  }
}

/** What a merged content is against the fork and the release. */
async function settle(merged: Content, theirsHash: string, oursHash: string | undefined, notes: string[]): Promise<Replayed> {
  const hash = await hashOf(merged);
  if (hash === theirsHash) return { outcome: "converged", notes };
  if (hash === oursHash) return { outcome: "stands", notes };
  return { outcome: "merged", merged, notes };
}

/** Carry one fork onto the release: a three-way merge, nothing written
 *  outside `scratch`. */
export async function replayFork(deps: ReplayDeps, git: string, scratch: string, fork: Fork): Promise<Replayed> {
  const item = await versionsOf(deps, fork.kind, fork.name);
  if (!item) return { outcome: "conflict", why: "it is not here" };
  const base = await baseOf(deps, fork, item);
  if (!base) return { outcome: "conflict", why: "this strut server no longer has the release it was edited from, so what it changed cannot be told" };
  const ours = await contentAt(deps, fork.kind, fork.name, item.active);
  const oursHash = item.versions[item.active]?.hash;
  if ("text" in ours && "text" in base) {
    let theirs = await readFile(fork.theirs, "utf-8");
    let from = base.text;
    // A fork in the canvas form is merged against the base and the release
    // in that form, so the merge sees the edit and not the editor's re-dump.
    if (fork.kind === "workflow" && canvasForm(ours.text, fork.name) === ours.text) {
      from = canvasForm(from, fork.name) ?? from;
      theirs = canvasForm(theirs, fork.name) ?? theirs;
    }
    const m = await mergeText(git, scratch, { base: from, ours: ours.text, theirs });
    if (!m.clean) return { outcome: "conflict", why: "its change here and the release's change touch the same lines" };
    return settle({ text: m.text }, contentHash(theirs), oursHash, []);
  }
  if (!("dir" in ours) || !("dir" in base)) return { outcome: "conflict", why: "its versions are not of one kind" };
  const out = join(scratch, "merged", ...fork.name.split("/"));
  const m = await mergeTrees(git, scratch, { base: base.dir, ours: ours.dir, theirs: fork.theirs, out });
  if (m.conflicts.length) return { outcome: "conflict", why: `its change here and the release's change collide in ${m.conflicts.join(", ")}` };
  const notes = m.tookTheirs.map((p) => `the app ${fork.name}: ${p} was changed here and by the release; the release's was taken (a binary file is not merged)`);
  return settle({ dir: out }, await treeHash(fork.theirs), oursHash, notes);
}

/** A fork's result read out of a patch already applied to the release's
 *  files under `layout` (the package's layout). */
export async function forkFromPatch(deps: ReplayDeps, layout: string, fork: Fork): Promise<Replayed> {
  const item = await versionsOf(deps, fork.kind, fork.name);
  if (!item) return { outcome: "conflict", why: "it is not here" };
  const path = join(layout, ...fork.path.split("/"));
  if (!(await exists(path))) return { outcome: "conflict", why: `the patch removes ${fork.path}` };
  const oursHash = item.versions[item.active]?.hash;
  if (fork.kind === "app") return settle({ dir: path }, await treeHash(fork.theirs), oursHash, []);
  return settle({ text: await readFile(path, "utf-8") }, contentHash(await readFile(fork.theirs, "utf-8")), oursHash, []);
}

/** Copy what a tree hash covers of `from` (a file, or a directory) to `to`. */
export async function copyContent(from: string, to: string): Promise<void> {
  if (!(await stat(from)).isDirectory()) {
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    return;
  }
  await mkdir(to, { recursive: true });
  for (const rel of await treeFiles(from)) {
    const dest = join(to, ...rel.split("/"));
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(from, ...rel.split("/")), dest);
  }
}

/** Write a content under `to`. */
async function writeContent(c: Content, to: string): Promise<void> {
  if ("dir" in c) return copyContent(c.dir, to);
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, c.text);
}

/** An installed item's path in its package. */
export function packagePath(pkg: string, kind: Fork["kind"], name: string): string {
  const rest = name.slice(pkg.length + 1);
  return kind === "workflow" ? `workflows/${rest}.yaml` : kind === "step" ? `steps/${rest}.ts` : `apps/${rest}`;
}

/** What this strut changed in a package (§1): one patch file from each
 *  fork's installed release to its active version, or `null` when the
 *  package has no fork. Read only. */
export async function localPatch(deps: ReplayDeps, git: string, scratch: string, pkg: InstalledPackage): Promise<string | null> {
  if (!pkg.digest) return null;
  // The release as the cache has it, where it does: an item whose content
  // the release ships under a version this strut made first is no change.
  const release = await deps.cache.get(pkg.digest).catch(() => undefined);
  const over: Record<string, string> = {};
  for (const i of pkg.items) {
    if (i.kind === "concept" || !i.modified || !i.installed || !i.active) continue;
    const path = packagePath(pkg.package, i.kind, i.name);
    const shipped = release ? join(release.dir, ...path.split("/")) : undefined;
    const theirs: Content =
      shipped && (await exists(shipped)) ? (i.kind === "app" ? { dir: shipped } : { text: await readFile(shipped, "utf-8") }) : await contentAt(deps, i.kind, i.name, i.installed);
    const ours = await contentAt(deps, i.kind, i.name, i.active);
    const hash = await hashOf(ours);
    if (hash === (await hashOf(theirs))) continue;
    await writeContent(theirs, join(scratch, "a", ...path.split("/")));
    await writeContent(ours, join(scratch, "b", ...path.split("/")));
    over[path] = hash;
  }
  if (!Object.keys(over).length) return null;
  return formatPatch({ package: pkg.package, onto: pkg.digest, over }, await diffDirs(git, scratch));
}
