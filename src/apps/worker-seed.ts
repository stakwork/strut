/**
 * `strut/worker` (plans/human-steps.md §5): a worker app every server has,
 * for task types whose answer is a photo and plain fields — strut/views'
 * `WorkerPage`, which draws any task with no view of its own. A type names
 * it as its `app`; an admin puts it in the public view for workers to sign
 * in. Seeded at boot by tree hash like `strut/staff` (./staff-seed.ts),
 * after `strut/views` (it imports it). First-party, but its grants are the
 * worker's steps alone, and a visitor's page gets no first-party rights.
 * `worker: false` seeds nothing.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceStore } from "../workspace.js";
import type { Kit, KitLocation } from "./kit.js";
import { seedBundledApp } from "./views-seed.js";

export const WORKER_APP = "strut/worker";
/** The app's sources: `src/apps/worker/` (`build/apps/worker/` once built). */
export const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "worker");

export interface WorkerSeedOptions {
  workspace: WorkspaceStore;
  kit?: Kit | KitLocation;
  dir?: string;
  cacheDir?: string;
}

/** Seed `strut/worker`. Null when there is no built kit. */
export async function seedWorkerApp(opts: WorkerSeedOptions): Promise<{ version: string; changed: boolean } | null> {
  return seedBundledApp({
    workspace: opts.workspace,
    name: WORKER_APP,
    dir: opts.dir ?? WORKER_DIR,
    ...(opts.kit ? { kit: opts.kit } : {}),
    ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
  });
}
