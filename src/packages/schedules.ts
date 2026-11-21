/**
 * The SCHEDULES installed packages ship (`schedules:` in strut.yaml,
 * ./format.ts): what the automations' sync makes exactly
 * (`syncPackageSchedules`, src/scheduler.ts). Read like the job agent's
 * grants (src/job-seed.ts): each installed package's manifest from the
 * package cache by the digest installed, while something of the package is
 * still its own here (`holdsItsOwn`). createStrut syncs after every package
 * write and at boot, so an install makes a package's schedules, a release
 * follows them and an uninstall drops them, with nobody setting anything up.
 *
 * A package's schedule is an ordinary automation, marked with its package:
 * the same record, scheduler, list and Automate tab as any other. When it
 * runs, its name and its input are the package's; on or off is the
 * admin's, and a release keeps it.
 */
import type { PackageSchedule } from "./format.js";
import { holdsItsOwn, listInstalledPackages, type InstalledDeps } from "./installed.js";

/** One schedule an installed package ships. */
export interface InstalledSchedule extends PackageSchedule {
  package: string;
}

/** Every schedule the installed packages ship, by package. A package the
 *  cache lacks, or cannot read, ships none, with a warning — and the sync
 *  then leaves its automations as they are (`unread`), rather than drop
 *  them for a cache that will be back. */
export async function installedSchedules(deps: InstalledDeps): Promise<{ schedules: InstalledSchedule[]; unread: string[] }> {
  const schedules: InstalledSchedule[] = [];
  const unread: string[] = [];
  for (const p of await listInstalledPackages(deps)) {
    if (!holdsItsOwn(p)) continue;
    try {
      const info = await deps.cache.get(p.digest!);
      if (!info) throw new Error(`the package cache holds no ${p.digest}`);
      for (const s of info.schedules ?? []) schedules.push({ package: p.package, ...s });
    } catch (err) {
      unread.push(p.package);
      console.warn(`[automations] ${p.package}: its schedules are not read —`, err instanceof Error ? err.message : err);
    }
  }
  return { schedules, unread };
}
