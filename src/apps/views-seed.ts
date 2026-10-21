/**
 * `strut/views` (plans/apps.md §3.3) — strut's components as an app other
 * apps import — seeded into the workspace when `createStrut` boots, by TREE
 * HASH the way `job.yaml` is seeded by content hash (src/job-seed.ts): a
 * changed `src/apps/views/` publishes the next version and activates it; a
 * known one does nothing (`reactivateKnown: false`), so a version a person
 * made active stays active across boots. `createStrut({ views: false })`
 * seeds nothing, and nothing in strut's core depends on it.
 *
 * A publish builds, and an app build is esbuild + Tailwind over the kit — a
 * second or so — while strut boots in every test. So the BUILD is done once
 * per machine for each (sources, kit) pair, into a cache under the OS temp
 * dir, and each workspace gets the built directory copied into its version
 * directory, as `apps.publish` would have left it. The sources are strut's
 * own, so the document is trusted as built: a person's publish always
 * builds (src/apps/apps.ts). Without a built kit (`cd kit && yarn
 * build:vendor`) nothing can build an app here, and the seed is skipped —
 * `app/build` says why.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { treeHash } from "../version.js";
import type { WorkspaceStore } from "../workspace.js";
import { buildApp } from "./build.js";
import { copyAppDir } from "./files.js";
import { kitOf, type Kit, type KitLocation } from "./kit.js";
import { readManifest, type AppManifest } from "./manifest.js";

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

const exists = async (p: string) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/** One build per (sources, kit) per process; the disk cache spans processes. */
const building = new Map<string, Promise<{ dir: string; manifest: AppManifest }>>();

async function builtCopy(src: string, hash: string, kit: Kit, cacheDir: string): Promise<{ dir: string; manifest: AppManifest }> {
  const kitId = await readFile(join(kit.vendorDir, "manifest.json"), "utf8").catch(() => kit.manifest.version);
  const key = createHash("sha256").update(`${hash}\n${kit.vendorDir}\n${kitId}`).digest("hex").slice(0, 24);
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
        const built = await buildApp(tmp, { kit, name: VIEWS_APP });
        if (!built.ok) {
          await rm(tmp, { recursive: true, force: true });
          throw new Error(`strut/views does not build: ${built.errors.join("; ")}`);
        }
        await rename(tmp, dir).catch(async () => {
          await rm(tmp, { recursive: true, force: true });
        });
      }
      const read = await readManifest(dir);
      if (!read.ok) throw new Error(`strut/views: ${read.errors.join("; ")}`);
      return { dir, manifest: read.manifest };
    })();
    building.set(key, p);
    p.catch(() => building.delete(key));
  }
  return p;
}

/** Seed `strut/views`: the boot step `createStrut` runs. Null when there is
 *  no built kit to build it with. */
export async function seedViewsApp(opts: ViewsSeedOptions): Promise<{ version: string; changed: boolean } | null> {
  const { workspace } = opts;
  const src = opts.dir ?? VIEWS_DIR;
  const hash = await treeHash(src);
  const rec = await workspace.getApp(VIEWS_APP).catch(() => null);
  const known = rec ? Object.entries(rec.versions).find(([, v]) => v.hash === hash)?.[0] : undefined;
  if (known && (await exists(join((await workspace.materializeAppVersion(VIEWS_APP, known)).path, "dist", "index.html")))) {
    return { version: known, changed: false };
  }
  let kit: Kit;
  try {
    kit = kitOf(opts.kit);
  } catch {
    return null;
  }
  const built = await builtCopy(src, hash, kit, opts.cacheDir ?? join(tmpdir(), "strut-views"));
  const r = await workspace.publishApp(VIEWS_APP, hash, built.manifest, { publisher: "strut", source: "seed", reactivateKnown: false });
  const { path } = await workspace.materializeAppVersion(VIEWS_APP, r.version);
  if (!(await exists(join(path, "dist", "index.html")))) await copyAppDir(built.dir, path, { dist: true });
  return r;
}
