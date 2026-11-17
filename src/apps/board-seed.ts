/**
 * `strut/board`: the plan as a map on one canvas — initiatives, their
 * milestones along a road, each milestone's features beside it — as an app
 * strut ships, seeded at boot after `strut/views` (whose graph reads it
 * imports) by the same tree hash (./views-seed.ts). First-party like
 * `strut/knowledge` (src/apps/tools.ts `firstPartyApp`): it reads as its
 * viewer. `board: false` seeds nothing.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceStore } from "../workspace.js";
import type { Kit, KitLocation } from "./kit.js";
import { VIEWS_APP, seedBundledApp } from "./views-seed.js";
import { JAMIE_APP } from "./jamie-seed.js";

export const BOARD_APP = "strut/board";
/** The app's sources: `src/apps/board/` (`build/apps/board/` once built). */
export const BOARD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "board");

export interface BoardSeedOptions {
  workspace: WorkspaceStore;
  kit?: Kit | KitLocation;
  dir?: string;
  cacheDir?: string;
}

/** Seed `strut/board`. Null when there is no built kit, or no `strut/views`
 *  or `strut/jamie` to build it against (`views: false`, `jamie: false`):
 *  it compiles in the one's graph reads and the other's thread. */
export async function seedBoardApp(opts: BoardSeedOptions): Promise<{ version: string; changed: boolean } | null> {
  for (const needed of [VIEWS_APP, JAMIE_APP]) if (!(await opts.workspace.getApp(needed).catch(() => null))) return null;
  return seedBundledApp({
    workspace: opts.workspace,
    name: BOARD_APP,
    dir: opts.dir ?? BOARD_DIR,
    ...(opts.kit ? { kit: opts.kit } : {}),
    ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
  });
}
