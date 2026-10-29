import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineStep } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { type Handle, memoryExclusive, ownerOnly } from "./_db.js";
import { invalidate } from "./_ontology.js";
import {
  type ApplyReport,
  MAX_DATA_BYTES,
  MAX_UNPACKED_BYTES,
  MB,
  applyDump,
  countsOf,
  dump,
  memoryFolder,
  message,
  openSnapshot,
  writeSnapshot,
} from "./_snapshot.js";

// Loads a memory/export snapshot into an EMPTY memory (no entity, fact or
// episode in the workspace), or with `replace` in place of the memory there:
// no merge of two memories. Only memory's nodes are replaced, never the
// workspace's. The snapshot is checked in full before anything is touched.
// Replacing first writes memory as it is to backups/memory-<time>.tar.gz in
// the memory folder (owner-only; the newest KEEP_BACKUPS are kept), checked
// as an incoming snapshot is, and a failure part-way loads that back. The
// load is bounded (_snapshot.ts `applyDump`): batches of at most BATCH a
// transaction, unchanged nodes skipped, memory's queue held throughout.
const KEEP_BACKUPS = 3;

export type ImportResult = { counts: Record<string, number>; replaced: boolean; backup?: string; applied: ApplyReport } | { error: string };

/** Loads a checked snapshot into the memory `handle` is: the step's work,
 *  run by the caller inside memoryExclusive (home/sync runs it there too).
 *  Returns the step's reply: `{ counts, replaced, backup?, applied }` or `{ error }`. */
export async function importSnapshot(
  handle: Handle,
  snapshot: Awaited<ReturnType<typeof openSnapshot>>,
  replace?: boolean,
  opts: { dataDir?: string; batch?: number } = {},
): Promise<ImportResult> {
  const local = await dump(handle);
  const { Entity: entities = 0, Fact: facts = 0, Episode: episodes = 0 } = countsOf(local);
  const replaced = entities + facts + episodes > 0;
  if (replaced && !replace) {
    return {
      error: `not_empty: memory already holds ${entities} entities, ${facts} facts and ${episodes} episodes; import loads into an empty memory only, or give replace`,
    };
  }
  const backups = join(memoryFolder(handle, opts.dataDir), "backups");
  let backup: { name: string } | undefined;
  if (replaced) {
    try {
      const { gz, name } = await writeSnapshot(handle);
      // Checked as an incoming snapshot is: one that could not be loaded back refuses the replace.
      await openSnapshot(gz);
      // A random suffix after the time: two backups in one millisecond do not collide, and names still sort by time.
      backup = { name: name.replace(/\.tar\.gz$/, `-${randomBytes(3).toString("hex")}.tar.gz`) };
      ownerOnly(backups);
      writeFileSync(join(backups, backup.name), gz, { mode: 0o600, flag: "wx" }); // never overwrites
    } catch (err) {
      return { error: `backup_failed: ${message(err)}; nothing was imported and the memory is as it was` };
    }
    // Keep the newest KEEP_BACKUPS, this one among them, whether or not the import lands.
    const older = readdirSync(backups).filter((n) => n !== backup!.name && /^memory-.*\.tar\.gz$/.test(n)).sort().reverse();
    for (const old of older.slice(KEEP_BACKUPS - 1)) rmSync(join(backups, old), { force: true });
  }
  let applied: ApplyReport;
  try {
    applied = await applyDump(handle, snapshot.dump, local, { batch: opts.batch });
  } catch (err) {
    try {
      // What was here before, loaded back over what landed (empty when there was nothing).
      await applyDump(handle, local, await dump(handle), { batch: opts.batch });
    } catch (cleanup) {
      const what = backup ? `restored (backups/${backup.name} holds it)` : "emptied";
      return { error: `import_failed: ${message(err)}; and the memory could not be ${what} after: ${message(cleanup)}` };
    }
    return { error: `import_failed: ${message(err)}; ${backup ? "the memory is as it was" : "the memory is left empty"}` };
  } finally {
    invalidate(handle.read);
  }
  return { counts: countsOf(await dump(handle)), replaced, ...(backup && { backup: backup.name }), applied };
}

export default defineStep({
  type: "memory/import",
  description:
    "Load a memory/export snapshot (.tar.gz) into this strut's long-term memory, which must be empty unless replace is given. " +
    "Only memory's nodes are replaced, never the rest of the workspace graph. " +
    "With replace, a memory that is not empty is first backed up on this machine, then replaced; the output names the backup. " +
    `Give data (the file as base64, at most ${MAX_DATA_BYTES / MB} MB) or path (a file on this machine).`,
  input: z.object({
    data: z.string().optional().describe(`The snapshot file as base64, at most ${MAX_DATA_BYTES / MB} MB decoded.`),
    path: z.string().optional().describe("The snapshot file's path on this machine."),
    replace: z.boolean().optional().describe("Replace a memory that is not empty, keeping it first as a backup file in the memory folder."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    if (!cfg.data === !cfg.path) return { error: "invalid_input: give exactly one of data or path" };
    let gz: Buffer;
    if (cfg.data) {
      const decoded = Math.floor((cfg.data.length * 3) / 4);
      if (decoded > MAX_DATA_BYTES + 2) {
        return {
          error: `too_large: data is ${Math.round(decoded / MB)} MB; import takes at most ${MAX_DATA_BYTES / MB} MB as data. Copy the file to this machine and pass path`,
        };
      }
      gz = Buffer.from(cfg.data, "base64");
    } else {
      try {
        const size = statSync(cfg.path!).size;
        if (size > MAX_UNPACKED_BYTES) return { error: `too_large: ${cfg.path} is ${Math.round(size / MB)} MB; a memory snapshot is at most ${MAX_UNPACKED_BYTES / MB} MB` };
        gz = readFileSync(cfg.path!);
      } catch (err) {
        return { error: `not_found: cannot read ${cfg.path}: ${message(err)}` };
      }
    }
    let snapshot: Awaited<ReturnType<typeof openSnapshot>>;
    try {
      snapshot = await openSnapshot(gz);
    } catch (err) {
      return { error: message(err) };
    }
    const dataDir = (ctx.services as Partial<StrutCapabilities> | undefined)?.dataDir;
    return memoryExclusive(ctx, (handle) => importSnapshot(handle, snapshot, cfg.replace, { dataDir }));
  },
});
