/**
 * `strut/earnings` (specs/API.md §14.14, plans/paid-runs.md §8–§10): strut's
 * Earnings tab as an app strut ships — the wallet, Add sats, Withdraw, what
 * was earned, the credit bought elsewhere — for a host that frames apps for
 * an admin (Stadeum's org admin pages) and never shows strut's own UI.
 * Seeded at boot by tree hash like `strut/knowledge` (./views-seed.ts), and
 * first-party: its `earnings/*` steps answer it only when its viewer is an
 * admin. `admin: true` in its manifest leaves it out of anyone else's
 * `GET /apps`. `earnings: false` seeds nothing.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceStore } from "../workspace.js";
import type { Kit, KitLocation } from "./kit.js";
import { seedBundledApp } from "./views-seed.js";

export const EARNINGS_APP = "strut/earnings";
/** The app's sources: `src/apps/earnings/` (`build/apps/earnings/` once built). */
export const EARNINGS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "earnings");

export interface EarningsSeedOptions {
  workspace: WorkspaceStore;
  kit?: Kit | KitLocation;
  dir?: string;
  cacheDir?: string;
}

/** Seed `strut/earnings`. Null when there is no built kit. */
export async function seedEarningsApp(opts: EarningsSeedOptions): Promise<{ version: string; changed: boolean } | null> {
  return seedBundledApp({
    workspace: opts.workspace,
    name: EARNINGS_APP,
    dir: opts.dir ?? EARNINGS_DIR,
    ...(opts.kit ? { kit: opts.kit } : {}),
    ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
  });
}
