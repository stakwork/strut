/**
 * `strut/tasks` (plans/human-steps.md §5): a worker app every server has,
 * for task types whose answer is a photo and plain fields — strut/views'
 * `WorkerPage`, which draws any task with no view of its own. A type names
 * it as its `app`; an admin puts it in the public view for workers to sign
 * in. Seeded at boot by tree hash like `strut/workers` (./workers-seed.ts),
 * after `strut/views` (it imports it). First-party, but its grants are the
 * worker's steps alone, and a visitor's page gets no first-party rights.
 * `tasksApp: false` seeds nothing.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceStore } from "../workspace.js";
import type { Kit, KitLocation } from "./kit.js";
import { seedBundledApp } from "./views-seed.js";

export const TASKS_APP = "strut/tasks";
/** The app's sources: `src/apps/tasks/` (`build/apps/tasks/` once built). */
export const TASKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "tasks");

export interface TasksSeedOptions {
  workspace: WorkspaceStore;
  kit?: Kit | KitLocation;
  dir?: string;
  cacheDir?: string;
}

/** Seed `strut/tasks`. Null when there is no built kit. */
export async function seedTasksApp(opts: TasksSeedOptions): Promise<{ version: string; changed: boolean } | null> {
  return seedBundledApp({
    workspace: opts.workspace,
    name: TASKS_APP,
    dir: opts.dir ?? TASKS_DIR,
    ...(opts.kit ? { kit: opts.kit } : {}),
    ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
  });
}
