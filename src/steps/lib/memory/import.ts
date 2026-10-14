import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineStep } from "../../../core.js";
import { ensureSchema, memoryExclusive } from "./_db.js";
import { invalidate } from "./_ontology.js";
import { MAX_DATA_BYTES, MAX_UNPACKED_BYTES, MB, countRows, dropAll, literal, message, openSnapshot, removeWork, snapshotDirs } from "./_snapshot.js";

// Loads a memory/export snapshot into an EMPTY graph only (no Entity, Fact or
// Episode rows): no merge of two graphs. IMPORT DATABASE needs no tables there,
// so every table is dropped first (the seeded Ontology rows go with them), and
// the schema, migrations and seed run again after: an older snapshot comes up
// to date. A failure part-way drops what was loaded and leaves the graph empty.
// The unpacked files sit in snapshots/import under the memory folder until the step returns.
export default defineStep({
  type: "memory/import",
  description:
    "Load a memory/export snapshot (.tar.gz) into this strut's long-term memory, which must be empty. " +
    `Give data (the file as base64, at most ${MAX_DATA_BYTES / MB} MB) or path (a file on this machine).`,
  input: z.object({
    data: z.string().optional().describe(`The snapshot file as base64, at most ${MAX_DATA_BYTES / MB} MB decoded.`),
    path: z.string().optional().describe("The snapshot file's path on this machine."),
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

    return memoryExclusive(ctx, async (handle) => {
      const { Entity: entities = 0, Fact: facts = 0, Episode: episodes = 0 } = await countRows(handle.write);
      if (entities + facts + episodes) {
        return {
          error: `not_empty: memory already holds ${entities} entities, ${facts} facts and ${episodes} episodes; import loads into an empty memory only`,
        };
      }
      const { work } = snapshotDirs(handle.path, "import");
      mkdirSync(work, { mode: 0o700 });
      try {
        for (const [name, bytes] of snapshot.graph) writeFileSync(join(work, name), bytes, { mode: 0o600 });
        await dropAll(handle.write);
        await handle.write(`IMPORT DATABASE ${literal(work)}`);
        await ensureSchema(handle.write);
        await handle.write("CHECKPOINT");
        return { counts: await countRows(handle.write) };
      } catch (err) {
        try {
          await dropAll(handle.write);
          await ensureSchema(handle.write);
        } catch (cleanup) {
          return { error: `import_failed: ${message(err)}; and the memory could not be emptied after: ${message(cleanup)}` };
        }
        return { error: `import_failed: ${message(err)}; the memory is left empty` };
      } finally {
        invalidate(handle.read);
        removeWork(work);
      }
    });
  },
});
