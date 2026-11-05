/**
 * `strut/jamie` (plans/jamie-app.md §5): Jamie, the person's assistant —
 * the `orchestrator`'s conversations, their jobs, proposals, pull requests
 * and deliverables — as an app strut ships, seeded at boot beside
 * `strut/views` (whose components it imports) by the same tree hash
 * (./views-seed.ts). A `strut/` app at a version strut seeded is
 * FIRST-PARTY (src/apps/tools.ts `firstPartyApp`): its page acts with its
 * viewer's own rights. `jamie: false` seeds nothing.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceStore } from "../workspace.js";
import type { Kit, KitLocation } from "./kit.js";
import { VIEWS_APP, seedBundledApp } from "./views-seed.js";

export const JAMIE_APP = "strut/jamie";
/** What the app was called before it was Jamie (2026-11-05): the seed
 *  takes it out. */
export const RETIRED_APP = "strut/assistant";
/** The app's sources: `src/apps/jamie/` (`build/apps/jamie/` once built). */
export const JAMIE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "jamie");

export interface JamieSeedOptions {
  workspace: WorkspaceStore;
  kit?: Kit | KitLocation;
  dir?: string;
  cacheDir?: string;
}

/** Seed `strut/jamie`: the boot step `createStrut` runs after `strut/views`.
 *  Null when there is no built kit to build it with, or no `strut/views` to
 *  build it against (`views: false`). */
export async function seedJamieApp(opts: JamieSeedOptions): Promise<{ version: string; changed: boolean } | null> {
  if (!(await opts.workspace.getApp(VIEWS_APP).catch(() => null))) return null;
  return seedBundledApp({
    workspace: opts.workspace,
    name: JAMIE_APP,
    dir: opts.dir ?? JAMIE_DIR,
    ...(opts.kit ? { kit: opts.kit } : {}),
    ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
  });
}
