/**
 * A renamed seeded app (./renamed.ts) carried over at boot, on a box that
 * ran its old name. Two steps, because createStrut builds what each needs
 * at different points:
 *
 *  1. `retireRenamedApps`, after the seeds and before any app's database
 *     is opened or migrated: the old name's own files — its SQLite
 *     (Support's tables, in `strut/staff`'s) and its viewers' state — into
 *     the new name's folder, then the old app deleted.
 *  2. `carryRenamedRecords`, once the public view is up: every task type
 *     drawn by the old name is drawn by the new one, and the public view
 *     lists the new one in its place.
 *
 * Each does nothing once done, so every later boot is a no-op.
 */
import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { PublicSurface } from "../public-surface.js";
import { APP_DB_FILE } from "./data.js";
import { appDir, appsRoot } from "./files.js";
import { RENAMED_APPS } from "./renamed.js";
import { APP_STATE_DIR } from "./state.js";

export interface RetireRenamedDeps {
  /** Where apps keep their files; none in memory. */
  dataDir?: string;
  hasApp(name: string): Promise<boolean>;
  deleteApp(name: string): Promise<unknown>;
}

/** Each old name's database (with a rollback journal a crash left) and
 *  state moved to the new name's folder, unless it has its own; then the
 *  old app deleted. What changed, a line each. */
export async function retireRenamedApps(deps: RetireRenamedDeps): Promise<string[]> {
  const done: string[] = [];
  for (const [from, to] of Object.entries(RENAMED_APPS)) {
    if (deps.dataDir) {
      const src = appDir(appsRoot(deps.dataDir), from);
      const dst = appDir(appsRoot(deps.dataDir), to);
      const moves: Array<[string, string[]]> = [[APP_DB_FILE, [`${APP_DB_FILE}-journal`]], [APP_STATE_DIR, []]];
      for (const [main, beside] of moves) {
        if (!existsSync(join(src, main)) || existsSync(join(dst, main))) continue;
        await mkdir(dst, { recursive: true });
        for (const f of [main, ...beside]) {
          if (!existsSync(join(src, f))) continue;
          await rename(join(src, f), join(dst, f));
          done.push(`${from} → ${to}: moved ${f}`);
        }
      }
    }
    if (await deps.hasApp(from)) {
      await deps.deleteApp(from);
      done.push(`${from}: deleted`);
    }
  }
  return done;
}

export interface CarryRenamedDeps {
  /** Every task type drawn by `from`, drawn by `to`: the names changed. */
  retypeApp(from: string, to: string): Promise<string[]>;
  publicView: { get(): Promise<PublicSurface>; set(next: PublicSurface): Promise<unknown> };
}

/** The task types and the public view moved from each old name to its new
 *  one. What changed, a line each. */
export async function carryRenamedRecords(deps: CarryRenamedDeps): Promise<string[]> {
  const done: string[] = [];
  for (const [from, to] of Object.entries(RENAMED_APPS)) {
    const types = await deps.retypeApp(from, to);
    if (types.length) done.push(`${from} → ${to}: task types ${types.join(", ")}`);
    const view = await deps.publicView.get();
    if (!view.apps.some((a) => a.name === from)) continue;
    const apps = view.apps.some((a) => a.name === to)
      ? view.apps.filter((a) => a.name !== from)
      : view.apps.map((a) => (a.name === from ? { ...a, name: to } : a));
    await deps.publicView.set({ ...view, apps });
    done.push(`${from} → ${to}: the public view`);
  }
  return done;
}
