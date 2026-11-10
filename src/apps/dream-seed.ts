/**
 * `strut/dream` (plans/dream.md): what the `dream` system workflow did, run
 * by run — its report, the lessons it has learned and every step it took —
 * as an app strut ships, seeded at boot after `strut/views` (whose
 * components it imports) by the same tree hash (./views-seed.ts).
 * First-party like `strut/knowledge`. `dream: false` seeds nothing.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceStore } from "../workspace.js";
import type { Kit, KitLocation } from "./kit.js";
import { VIEWS_APP, seedBundledApp } from "./views-seed.js";

export const DREAM_APP = "strut/dream";
/** The app's sources: `src/apps/dream/` (`build/apps/dream/` once built). */
export const DREAM_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "dream");

export interface DreamSeedOptions {
  workspace: WorkspaceStore;
  kit?: Kit | KitLocation;
  dir?: string;
  cacheDir?: string;
}

/** Seed `strut/dream`. Null when there is no built kit, or no `strut/views` to build it against (`views: false`). */
export async function seedDreamApp(opts: DreamSeedOptions): Promise<{ version: string; changed: boolean } | null> {
  if (!(await opts.workspace.getApp(VIEWS_APP).catch(() => null))) return null;
  return seedBundledApp({
    workspace: opts.workspace,
    name: DREAM_APP,
    dir: opts.dir ?? DREAM_DIR,
    ...(opts.kit ? { kit: opts.kit } : {}),
    ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
  });
}
