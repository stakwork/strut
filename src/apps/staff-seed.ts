/**
 * `strut/staff` (plans/human-steps.md §9, specs/API.md §14.15): the task
 * store's staff routes as a page — the queue, task types, workers and what
 * they answered, the tests — for strut's own UI and for a host that frames
 * apps for an admin (Stadeum). Seeded at boot by tree hash like
 * `strut/earnings` (./earnings-seed.ts), after `strut/views` (it imports
 * `TaskForm`), and first-party: its `staff/*` steps answer it only when its
 * viewer is an admin. `admin: true` in its manifest leaves it out of anyone
 * else's `GET /apps`. `staff: false` seeds nothing.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceStore } from "../workspace.js";
import type { Kit, KitLocation } from "./kit.js";
import { seedBundledApp } from "./views-seed.js";

export const STAFF_APP = "strut/staff";
/** The app's sources: `src/apps/staff/` (`build/apps/staff/` once built). */
export const STAFF_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "staff");

export interface StaffSeedOptions {
  workspace: WorkspaceStore;
  kit?: Kit | KitLocation;
  dir?: string;
  cacheDir?: string;
}

/** Seed `strut/staff`. Null when there is no built kit. */
export async function seedStaffApp(opts: StaffSeedOptions): Promise<{ version: string; changed: boolean } | null> {
  return seedBundledApp({
    workspace: opts.workspace,
    name: STAFF_APP,
    dir: opts.dir ?? STAFF_DIR,
    ...(opts.kit ? { kit: opts.kit } : {}),
    ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
  });
}
