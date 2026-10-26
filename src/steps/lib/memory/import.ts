import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { defineStep } from "../../../core.js";
import { type Handle, type Query, ensureSchema, memoryExclusive, ownerOnly } from "./_db.js";
import { invalidate } from "./_ontology.js";
import {
  MAX_DATA_BYTES,
  MAX_UNPACKED_BYTES,
  MB,
  countRows,
  dropAll,
  literal,
  message,
  openSnapshot,
  removeWork,
  snapshotDirs,
  writeSnapshot,
} from "./_snapshot.js";

// Loads a memory/export snapshot into an EMPTY graph (no Entity, Fact or
// Episode rows), or with `replace` in place of the graph there: no merge of
// two graphs. The snapshot is checked in full before the graph is touched.
// Replacing first writes the graph as it is to backups/memory-<time>.tar.gz
// in the memory folder (owner-only; the newest KEEP_BACKUPS are kept), checked
// as an incoming snapshot is, and a failure part-way loads that back. IMPORT DATABASE needs
// no tables there, so every table is dropped first (the seeded Ontology rows
// go with them), and the schema, migrations and seed run again after: an older
// snapshot comes up to date. A failure part-way with no graph before leaves it empty.
// The unpacked files sit in snapshots/import under the memory folder until the step returns.
const KEEP_BACKUPS = 3;

/** Replaces the graph with `graph` (a snapshot's graph/ files), unpacked into `work`. */
async function load(query: Query, work: string, graph: Map<string, Buffer>): Promise<void> {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { mode: 0o700 });
  for (const [name, bytes] of graph) writeFileSync(join(work, name), bytes, { mode: 0o600 });
  await dropAll(query);
  await query(`IMPORT DATABASE ${literal(work)}`);
  await ensureSchema(query);
  await query("CHECKPOINT");
}

/** Loads a checked snapshot into the memory `handle` is: the step's work,
 *  run by the caller inside memoryExclusive (home/sync runs it there too).
 *  Returns the step's reply: `{ counts, replaced, backup? }` or `{ error }`. */
export async function importSnapshot(
  handle: Handle,
  snapshot: Awaited<ReturnType<typeof openSnapshot>>,
  replace?: boolean,
): Promise<{ counts: Record<string, number>; replaced: boolean; backup?: string } | { error: string }> {
  const { Entity: entities = 0, Fact: facts = 0, Episode: episodes = 0 } = await countRows(handle.write);
  const replaced = entities + facts + episodes > 0;
  if (replaced && !replace) {
    return {
      error: `not_empty: memory already holds ${entities} entities, ${facts} facts and ${episodes} episodes; import loads into an empty memory only, or give replace`,
    };
  }
  const backups = join(dirname(handle.path), "backups");
  // What a restore needs: the backup's file name and its checked graph/ files.
  let backup: { name: string; graph: Map<string, Buffer> } | undefined;
  if (replaced) {
    try {
      const { gz, name } = await writeSnapshot(handle, snapshotDirs(handle.path, "backup").work);
      // Checked as an incoming snapshot is: one that could not be loaded back refuses the replace.
      const { graph } = await openSnapshot(gz);
      // A random suffix after the time: two backups in one millisecond do not collide, and names still sort by time.
      backup = { name: name.replace(/\.tar\.gz$/, `-${randomBytes(3).toString("hex")}.tar.gz`), graph };
      ownerOnly(backups);
      writeFileSync(join(backups, backup.name), gz, { mode: 0o600, flag: "wx" }); // never overwrites
    } catch (err) {
      return { error: `backup_failed: ${message(err)}; nothing was imported and the memory is as it was` };
    }
    // Keep the newest KEEP_BACKUPS, this one among them, whether or not the import lands.
    const older = readdirSync(backups).filter((n) => n !== backup!.name && /^memory-.*\.tar\.gz$/.test(n)).sort().reverse();
    for (const old of older.slice(KEEP_BACKUPS - 1)) rmSync(join(backups, old), { force: true });
  }
  const { work } = snapshotDirs(handle.path, "import");
  try {
    await load(handle.write, work, snapshot.graph);
  } catch (err) {
    try {
      // The backup is this graph as it was; with none, it was empty.
      if (backup) await load(handle.write, work, backup.graph);
      else {
        await dropAll(handle.write);
        await ensureSchema(handle.write);
      }
    } catch (cleanup) {
      const what = backup ? `restored from backups/${backup.name}` : "emptied";
      return { error: `import_failed: ${message(err)}; and the memory could not be ${what} after: ${message(cleanup)}` };
    }
    return { error: `import_failed: ${message(err)}; ${backup ? "the memory is as it was" : "the memory is left empty"}` };
  } finally {
    invalidate(handle.read);
    removeWork(work);
  }
  return { counts: await countRows(handle.write), replaced, ...(backup && { backup: backup.name }) };
}

export default defineStep({
  type: "memory/import",
  description:
    "Load a memory/export snapshot (.tar.gz) into this strut's long-term memory, which must be empty unless replace is given. " +
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

    return memoryExclusive(ctx, (handle) => importSnapshot(handle, snapshot, cfg.replace));
  },
});
