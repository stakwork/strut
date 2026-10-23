/**
 * An app's HISTORY, stored once per file: what keeps hundreds of versions
 * of an app from being hundreds of copies of it. Every version's source
 * files go into the app's object store, `<app>/.objects/<aa>/<sha256>`,
 * once each — a version that changes one file adds one file — and a
 * version is its TREE, `<app>/.trees/<vN>.json`: each path and the sha256
 * of its bytes, the same per-file hashes the version's tree hash
 * (`treeHash`, src/version.ts) is made of, so the tree reproduces the
 * version's identity exactly. `dist/` is never in it: the built document is
 * derived from the sources and the kit, ~97% of a version's bytes (1.44 MB
 * of a 1.48 MB version of the OpenHealth benchmark app, 2026-10-23).
 *
 * The version's DIRECTORY, `<app>/<vN>/` (`materializeAppVersion`'s path),
 * is then a cache: kept for the active version and the newest few
 * (`APP_VERSIONS_KEPT`), removed for the rest once their tree is recorded,
 * and restored from the tree — and rebuilt — when one is read again
 * (src/apps/apps.ts). Both stores live beside the version directories,
 * named with a dot, which no app name segment or version label can start
 * with.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { treeFiles } from "../version.js";

/** How many versions keep their directory besides the active one. */
export const APP_VERSIONS_KEPT = 5;

/** A version's sources: each path and the sha256 of its bytes. */
export interface AppTree {
  /** The version's tree hash, recomputed from `files`. */
  hash: string;
  files: Record<string, string>;
}

/** The app's folder (where its versions, objects and trees live), from a version's directory. */
const appFolder = (versionDir: string) => dirname(versionDir);
const versionOf = (versionDir: string) => versionDir.slice(appFolder(versionDir).length + 1);
const objectPath = (versionDir: string, sha: string) => join(appFolder(versionDir), ".objects", sha.slice(0, 2), sha);
const treePath = (versionDir: string) => join(appFolder(versionDir), ".trees", `${versionOf(versionDir)}.json`);

/** The tree hash of a path → sha256 map: `treeHash`'s computation, without the files. */
export function hashOfTree(files: Record<string, string>): string {
  const h = createHash("sha256");
  for (const rel of Object.keys(files).sort()) h.update(`${rel}\0${files[rel]}\n`);
  return h.digest("hex");
}

/** Write a file by way of a sibling and a rename, so a reader never sees half of it. */
async function writeWhole(path: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
}

/**
 * Record the version whose directory this is: each source file into the
 * object store (skipped when already there), then its tree — only when the
 * directory still holds `hash`, the version's identity; a directory edited
 * since is never recorded as the version. Returns the directory's tree
 * either way, so the caller can tell.
 */
export async function recordTree(versionDir: string, hash: string): Promise<AppTree> {
  const files: Record<string, string> = {};
  const bytesOf = new Map<string, Uint8Array>();
  for (const rel of await treeFiles(versionDir)) {
    const bytes = await readFile(join(versionDir, rel));
    const sha = createHash("sha256").update(bytes).digest("hex");
    files[rel] = sha;
    bytesOf.set(sha, bytes);
  }
  const tree: AppTree = { hash: hashOfTree(files), files };
  if (tree.hash !== hash) return tree;
  for (const [sha, bytes] of bytesOf) {
    const at = objectPath(versionDir, sha);
    if (!(await readFile(at).then(() => true, () => false))) await writeWhole(at, bytes);
  }
  await writeWhole(treePath(versionDir), JSON.stringify(tree));
  return tree;
}

/** The version's tree, or null when none was recorded. */
export async function readTree(versionDir: string): Promise<AppTree | null> {
  try {
    const tree = JSON.parse(await readFile(treePath(versionDir), "utf8")) as AppTree;
    return tree && typeof tree.hash === "string" && tree.files && typeof tree.files === "object" ? tree : null;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/** Write a recorded version's sources into `to` (a new directory): the
 *  directory the version was published as, without `dist/`. */
export async function restoreSources(versionDir: string, tree: AppTree, to: string): Promise<void> {
  for (const [rel, sha] of Object.entries(tree.files)) {
    const bytes = await readFile(objectPath(versionDir, sha));
    const at = join(to, rel);
    await mkdir(dirname(at), { recursive: true });
    await writeFile(at, bytes);
  }
}

/** Remove a version's directory, only when its tree — of this version, `hash` — is recorded. */
export async function evictVersionDir(versionDir: string, hash: string): Promise<boolean> {
  if ((await readTree(versionDir))?.hash !== hash) return false;
  await rm(versionDir, { recursive: true, force: true });
  return true;
}

/** Which versions keep their directory: the active one and the newest `kept`. */
export function keptVersions(versions: readonly string[], active: string, kept = APP_VERSIONS_KEPT): Set<string> {
  const n = (v: string) => parseInt(v.slice(1), 10) || 0;
  return new Set([active, ...[...versions].sort((a, b) => n(b) - n(a)).slice(0, kept)]);
}
