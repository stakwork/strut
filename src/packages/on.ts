/**
 * WORKFLOWS ON GRAPH WRITES (plans/package-seams.md §2): the `on:` entries
 * installed packages ship (./format.ts), and what a write strut hears
 * starts.
 *
 * A write is heard where the live feeds hear it (src/graph-writes.ts): a
 * run's writes through `services.graph`, a step's through `ctx.registry`, a
 * proposal's apply. At each send of the reporter, its node writes are
 * folded to one op per node (`netOps`, there) and handed to the bag's
 * `onWrites`,
 * which createStrut builds over these entries: each match is launched
 * detached, as the person of the run that wrote, with input
 * `{ ref_id, type, op, by, job? }` (`by` the writing run's id, `job` its
 * job when it has one).
 *
 * The guards (`matches`):
 *   - nothing runs without a person — a run that acts for nobody starts
 *     nothing, as for a schedule;
 *   - a run that `on:` started never fires its own package's entries;
 *   - a chain across packages stops at `ON_CHAIN_MAX` runs;
 *   - a write on a Concept branch or in a trial fires nothing (the
 *     reporter is given no `onWrites` there, src/graph-writes.ts).
 *
 * Read like the schedules (./schedules.ts): each installed package's
 * manifest from the cache by the digest installed, while something of the
 * package is still its own (`holdsItsOwn`); createStrut reads them again at
 * boot and after every package write, so an uninstall drops them.
 */
import type { OnWriteMark } from "../core.js";
import type { NodeWrite, WriteBy } from "../graph-writes.js";
import type { PackageTrigger } from "./format.js";
import { holdsItsOwn, listInstalledPackages, type InstalledDeps } from "./installed.js";

/** The most runs one chain of `on:` launches holds: the third run's
 *  writes start nothing. */
export const ON_CHAIN_MAX = 3;

/** One entry an installed package ships. */
export interface InstalledTrigger extends PackageTrigger {
  package: string;
}

/** Every entry the installed packages ship. A package the cache cannot
 *  read is `unread`: the caller keeps what it had for it. */
export async function installedTriggers(deps: InstalledDeps): Promise<{ triggers: InstalledTrigger[]; unread: string[] }> {
  const triggers: InstalledTrigger[] = [];
  const unread: string[] = [];
  for (const p of await listInstalledPackages(deps)) {
    if (!holdsItsOwn(p)) continue;
    try {
      const info = await deps.cache.get(p.digest!);
      if (!info) throw new Error(`the package cache holds no ${p.digest}`);
      for (const t of info.on ?? []) triggers.push({ package: p.package, ...t });
    } catch (err) {
      unread.push(p.package);
      console.warn(`[on] ${p.package}: its on: entries are not read —`, err instanceof Error ? err.message : err);
    }
  }
  return { triggers, unread };
}

/** What a send starts: each entry matching a write, with the mark its run
 *  carries — or why nothing starts. */
export function matches(
  triggers: readonly InstalledTrigger[],
  writes: readonly NodeWrite[],
  by: WriteBy,
): { launches: Array<{ trigger: InstalledTrigger; write: NodeWrite; mark: OnWriteMark }>; stopped: Array<{ trigger: InstalledTrigger; write: NodeWrite }> } {
  const launches: Array<{ trigger: InstalledTrigger; write: NodeWrite; mark: OnWriteMark }> = [];
  const stopped: Array<{ trigger: InstalledTrigger; write: NodeWrite }> = [];
  if (!by.actor) return { launches, stopped };
  const depth = (by.mark?.depth ?? 0) + 1;
  for (const write of writes) {
    for (const trigger of triggers) {
      if (trigger.op !== write.op || trigger.type !== write.type) continue;
      if (by.mark && trigger.package === by.mark.package) continue;
      if (depth > ON_CHAIN_MAX) {
        stopped.push({ trigger, write });
        continue;
      }
      launches.push({ trigger, write, mark: { package: trigger.package, op: write.op, type: write.type, ref_id: write.ref_id, by: by.runId, depth } });
    }
  }
  return { launches, stopped };
}
