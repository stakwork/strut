/**
 * The apps strut SHIPS — `strut/views` (plans/apps.md §3.3), strut's
 * components as an app other apps import, and `strut/jamie`
 * (plans/jamie-app.md §5, ./jamie-seed.ts), the person's assistant —
 * seeded into the workspace when `createStrut` boots, by TREE HASH the way
 * `job.yaml` is seeded by content hash (src/job-seed.ts): a changed source
 * directory publishes the next version and activates it; a known one is
 * made active again — a seed always matches git, so a version a person made
 * active lasts until the next boot. `createStrut({ views: false })` (and
 * `jamie: false`) seeds nothing, and nothing in strut's core depends on
 * either.
 *
 * A publish builds, and an app build is esbuild + Tailwind over the kit — a
 * second or so — while strut boots in every test. So the BUILD is done once
 * per machine for each (sources, kit, imported apps) triple, into a cache
 * under the OS temp dir, and each workspace gets the built directory copied
 * into its version directory, as `apps.publish` would have left it. The
 * sources are strut's own, so the document is trusted as built: a person's
 * publish always builds (src/apps/apps.ts). An app that imports another
 * installed app (the assistant imports `strut/views`) is rebuilt in place
 * when the import's version moved, since the document carries the import
 * compiled in. Without a built kit (`cd kit && yarn build:vendor`) nothing
 * can build an app here, and the seed is skipped — `app/build` says why.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { treeFiles, treeHash } from "../version.js";
import type { WorkspaceStore } from "../workspace.js";
import { buildApp, type BuildInfo, type InstalledApp } from "./build.js";
import { copyAppDir } from "./files.js";
import { kitOf, type Kit, type KitLocation } from "./kit.js";
import { readManifest, type AppManifest } from "./manifest.js";
import { recordTree } from "./objects.js";

export const VIEWS_APP = "strut/views";
/** The app's sources: `src/apps/views/` (`build/apps/views/` once built). */
export const VIEWS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "views");

export interface ViewsSeedOptions {
  workspace: WorkspaceStore;
  kit?: Kit | KitLocation;
  /** The sources (strut's own by default). */
  dir?: string;
  /** Where built copies are kept between processes (`<tmp>/strut-views` by default). */
  cacheDir?: string;
}

export interface BundledAppSeed {
  workspace: WorkspaceStore;
  /** The app's name (a `strut/` name: only a seed publishes one). */
  name: string;
  /** Its sources, exactly as they are published (the tree hash is theirs). */
  dir: string;
  kit?: Kit | KitLocation;
  cacheDir?: string;
}

const exists = async (p: string) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/** An installed app as the build resolves an import of it: the active
 *  version (or `version`), its directory and tree hash. */
function workspaceApps(workspace: WorkspaceStore) {
  return async (name: string, version?: string): Promise<InstalledApp | null> => {
    const rec = await workspace.getApp(name, version).catch(() => null);
    if (!rec) return null;
    const { path } = await workspace.materializeAppVersion(name, rec.version);
    return { name, version: rec.version, dir: path, hash: rec.hash };
  };
}

/** Do the imports a built document carries still match what is installed?
 *  Each import's hash against the version it would resolve to now. */
async function importsCurrent(versionDir: string, resolveApp: (name: string) => Promise<InstalledApp | null>): Promise<boolean> {
  try {
    const info = JSON.parse(await readFile(join(versionDir, "dist", "build.json"), "utf8")) as BuildInfo;
    for (const imp of info.imports ?? []) {
      if (imp.pinned) continue;
      if ((await resolveApp(imp.name))?.hash !== imp.hash) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** One build per (sources, kit, imports) per process; the disk cache spans processes. */
const building = new Map<string, Promise<{ dir: string; manifest: AppManifest }>>();

async function builtCopy(
  name: string,
  src: string,
  hash: string,
  kit: Kit,
  cacheDir: string,
  resolveApp: (name: string, version?: string) => Promise<InstalledApp | null>,
  importsKey: string,
): Promise<{ dir: string; manifest: AppManifest }> {
  // The kit by its digest, which the built copy's `build.json` records.
  const key = createHash("sha256").update(`${name}\n${hash}\n${kit.vendorDir}\n${kit.digest}\n${importsKey}`).digest("hex").slice(0, 24);
  let p = building.get(key);
  if (!p) {
    p = (async () => {
      const dir = join(cacheDir, key);
      if (!(await exists(join(dir, "dist", "build.json")))) {
        // Built beside the cache entry, then moved into place: two processes
        // building at once each finish, and the second keeps the first's.
        const tmp = `${dir}.${process.pid}.${Date.now()}`;
        await mkdir(cacheDir, { recursive: true });
        await copyAppDir(src, tmp, { dist: false });
        const built = await buildApp(tmp, { kit, name, resolveApp });
        if (!built.ok) {
          await rm(tmp, { recursive: true, force: true });
          throw new Error(`${name} does not build: ${built.errors.join("; ")}`);
        }
        await rename(tmp, dir).catch(async () => {
          await rm(tmp, { recursive: true, force: true });
        });
      }
      const read = await readManifest(dir);
      if (!read.ok) throw new Error(`${name}: ${read.errors.join("; ")}`);
      return { dir, manifest: read.manifest };
    })();
    building.set(key, p);
    p.catch(() => building.delete(key));
  }
  return p;
}

/** Seed an app strut ships from `dir`: the boot step. Null when there is no
 *  built kit to build it with. */
export async function seedBundledApp(opts: BundledAppSeed): Promise<{ version: string; changed: boolean } | null> {
  const { workspace, name, dir: src } = opts;
  const resolveApp = workspaceApps(workspace);
  const hash = await treeHash(src);
  const rec = await workspace.getApp(name).catch(() => null);
  const known = rec ? Object.entries(rec.versions).find(([, v]) => v.hash === hash)?.[0] : undefined;
  const knownDir = known ? (await workspace.materializeAppVersion(name, known)).path : undefined;
  const built = knownDir && (await exists(join(knownDir, "dist", "index.html")));
  if (known && built && (await importsCurrent(knownDir, resolveApp))) {
    if (rec!.active === known) return { version: known, changed: false };
    await workspace.setActiveAppVersion(name, known);
    return { version: known, changed: true };
  }
  let kit: Kit;
  try {
    kit = kitOf(opts.kit);
  } catch {
    return null;
  }
  // What the document compiles in from other installed apps moves its
  // build, never its version: the key names each import's hash now.
  const manifestOf = await readManifest(src);
  const importsKey = manifestOf.ok ? (await importedHashes(src, resolveApp)).join("\n") : "";
  const copy = await builtCopy(name, src, hash, kit, opts.cacheDir ?? join(tmpdir(), "strut-views"), resolveApp, importsKey);
  if (known && knownDir) {
    // The version is known; only its document is behind an import that moved.
    await copyAppDir(copy.dir, knownDir, { dist: true });
    if (rec!.active !== known) await workspace.setActiveAppVersion(name, known);
    return { version: known, changed: rec!.active !== known };
  }
  const r = await workspace.publishApp(name, hash, copy.manifest, { publisher: "strut", source: "seed" });
  const { path } = await workspace.materializeAppVersion(name, r.version);
  if (!(await exists(join(path, "dist", "index.html")))) await copyAppDir(copy.dir, path, { dist: true });
  await recordTree(path, hash);
  return r;
}

/** The hashes of the installed apps `dir`'s sources import by name — a
 *  cheap scan of its `src/` for `from "<ns>/<name>"`, read against the
 *  workspace (the build itself is the authority; this only keys the cache). */
async function importedHashes(dir: string, resolveApp: (name: string) => Promise<InstalledApp | null>): Promise<string[]> {
  const names = new Set<string>();
  for (const rel of await treeFiles(join(dir, "src")).catch(() => [] as string[])) {
    if (!/\.(tsx?|jsx?)$/.test(rel)) continue;
    const text = await readFile(join(dir, "src", rel), "utf8");
    for (const m of text.matchAll(/from\s+["']([a-z0-9-]+\/[a-z0-9-]+)["']/g)) names.add(m[1]!);
  }
  const out: string[] = [];
  for (const n of [...names].sort()) {
    const app = await resolveApp(n).catch(() => null);
    if (app) out.push(`${n}@${app.hash}`);
  }
  return out;
}

/** Seed `strut/views`: the boot step `createStrut` runs. Null when there is
 *  no built kit to build it with. */
export async function seedViewsApp(opts: ViewsSeedOptions): Promise<{ version: string; changed: boolean } | null> {
  return seedBundledApp({ ...opts, name: VIEWS_APP, dir: opts.dir ?? VIEWS_DIR });
}
