/**
 * The app store's FILES (plans/apps.md §1.3): a workspace app's version is a
 * directory under `<dataDir>/apps/<name>/<vN>/` on every backend — `dist/`
 * included, as published — the rule artifacts, cassettes and jobs follow:
 * the inherently local things hang off `dataDir`, and the workspace store
 * keeps only POINTERS (`WorkspaceStore.publishApp`, `getApp`, …), so a
 * version is never a 20 MB graph property. This module is the paths and
 * the copies; `materializeAppVersion` (the store's) names the directory.
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { treeFiles } from "../version.js";

/** `<dataDir>/apps` — where every workspace app's versions live. */
export function appsRoot(dataDir: string): string {
  return join(dataDir, "apps");
}

/**
 * An app's name: workflow-style segments (`hvac-invoices`), `/`-joined
 * under a package prefix (`acme/hvac/invoices`, `strut/views`). Each
 * segment starts with a letter or digit, so `_metadata.json` is never one;
 * none is a version label (`v3`), since the versions are directories beside
 * the metadata; `@` is the version pin (`hive/ui@v3`).
 */
export function validateAppName(name: string): void {
  if (!name) throw new Error("app name cannot be empty");
  if (name.length > 120) throw new Error(`Invalid app name "${name}": too long`);
  if (name.includes("@")) throw new Error(`Invalid app name "${name}": "@" is reserved for version pins (name@vN)`);
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//") || name.includes("\\")) throw new Error(`Invalid app name "${name}": malformed path`);
  for (const seg of name.split("/")) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(seg) || seg === "." || seg === "..") {
      throw new Error(`Invalid app name "${name}": each segment must match [A-Za-z0-9][A-Za-z0-9_.-]*`);
    }
    if (/^v\d+$/.test(seg)) throw new Error(`Invalid app name "${name}": a segment may not be a version label (${seg})`);
    if (seg === "data.db") throw new Error(`Invalid app name "${name}": "data.db" is the app's database`);
  }
}

/** A PREVIEW's label (`apps.preview`): an unpublished build hosted under a
 *  label of its own, in place of a `vN`, for `app/look { path }`. */
export const PREVIEW_LABEL_RE = /^preview-[0-9a-f]{12}$/;
export const isPreviewLabel = (label: string): boolean => PREVIEW_LABEL_RE.test(label);

/** `<appsRoot>/<name segments>` — the app's folder: its versions, its database. */
export function appDir(root: string, name: string): string {
  return join(root, ...name.split("/"));
}

/** `<appsRoot>/<name>/<vN>` — one version's directory, as published. */
export function appVersionDir(root: string, name: string, version: string): string {
  return join(appDir(root, name), version);
}

/** An absolute path inside a version's directory, or a throw: the file
 *  routes' guard, as `jobFilePath` is the job routes'. */
export function appFilePath(root: string, relPath: string): string {
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`apps: path escapes the app directory: ${relPath}`);
  return abs;
}

/** What never travels with an app's files: a dependency tree, the database. */
function copyExcluded(name: string): boolean {
  return name === "node_modules" || name === "data.db";
}

/** Every file in a version's directory (the file listing), sorted —
 *  `dist/` included, `node_modules/`, `data.db` and dotfiles left out. */
export function listAppFiles(dir: string): Promise<string[]> {
  return treeFiles(dir, (_rel, name) => name.startsWith(".") || copyExcluded(name));
}

/** Copy an app directory (`node_modules/` and `data.db` never; `dist/` only
 *  when asked). Replaces `to` when it exists. */
export async function copyAppDir(from: string, to: string, opts: { dist: boolean }): Promise<void> {
  const base = resolve(from);
  await rm(to, { recursive: true, force: true });
  await mkdir(dirname(to), { recursive: true });
  await cp(base, to, {
    recursive: true,
    filter: (src) => {
      const rel = src === base ? "" : src.slice(base.length + 1);
      if (!rel) return true;
      const top = rel.split(sep)[0]!;
      if (!opts.dist && top === "dist") return false;
      return !rel.split(sep).some(copyExcluded);
    },
  });
}

/** Is `dir` absent or empty? (Where `app/init` and `app/checkout` may write.) */
export async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return false;
    return (await treeFiles(dir, () => false)).length === 0;
  } catch (err: any) {
    if (err?.code === "ENOENT") return true;
    throw err;
  }
}

/** A path → content map (`POST /apps { files }`): text as a string, binary
 *  as `{ base64 }`. Written under `dir`, every path guarded. */
export async function writeAppFiles(dir: string, files: Record<string, string | { base64: string }>): Promise<void> {
  const root = resolve(dir);
  await mkdir(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = appFilePath(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    if (typeof content === "string") await writeFile(abs, content, "utf-8");
    else if (content && typeof content === "object" && typeof content.base64 === "string") await writeFile(abs, Buffer.from(content.base64, "base64"));
    else throw new Error(`files["${rel}"]: a string, or { base64 } for a binary file`);
  }
}

/** A file's bytes, or null when it is not there. */
export async function readAppFile(root: string, relPath: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(appFilePath(root, relPath)));
  } catch (err: any) {
    if (err?.code === "ENOENT" || err?.code === "EISDIR") return null;
    throw err;
  }
}
