import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineStep } from "../../../core.js";
import { memoryExclusive, ownerOnly } from "./_db.js";
import { MAX_DATA_BYTES, MB, sha256, snapshotDirs, writeSnapshot } from "./_snapshot.js";

// The snapshot is plaintext, kept in the memory folder (owner-only) as
// snapshots/memory-<time>.tar.gz until the next export deletes it; the caller
// deletes it once it has sealed or sent it. The folder EXPORT DATABASE writes
// is removed before the step returns. It is always the same path, so an
// unchanged graph exports the same content_hash (schema.cypher names it):
// a backup can skip a snapshot whose hash it has already sent.
//
// `inline` is for another machine taking the memory over HTTP (a home server
// handing it back): the snapshot comes back as base64 `data` and no file is
// kept, so no `path`. Capped as memory/import's `data` is. `if_changed` is
// for one that keeps a copy (home-pull): given the content_hash it holds,
// an unchanged graph returns `{ unchanged: true, content_hash }` and nothing
// else.
export default defineStep({
  type: "memory/export",
  description:
    "Write the whole long-term memory graph to one snapshot file (.tar.gz: manifest.json + Ladybug's EXPORT DATABASE) " +
    "in the memory folder, for memory/import on another strut. Returns its path, sha256, size and rows per table. " +
    "The file stays until the next export. With inline, the snapshot comes back as base64 data and no file is kept. " +
    "With if_changed (a content_hash), an unchanged graph returns { unchanged: true, content_hash } and no snapshot.",
  input: z.object({
    inline: z.boolean().optional().describe(`Return the snapshot as base64 \`data\` (at most ${MAX_DATA_BYTES / MB} MB) and keep no file.`),
    if_changed: z.string().optional().describe("The content_hash of the copy the caller holds: when the graph still exports it, return { unchanged: true, content_hash } and no snapshot."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    return memoryExclusive(ctx, async (handle) => {
      const { folder, work } = snapshotDirs(handle.path, "export");
      const { gz, counts, manifest, name } = await writeSnapshot(handle, work);
      const { content_hash } = manifest;
      if (cfg.if_changed && cfg.if_changed === content_hash) return { unchanged: true, content_hash };
      const hash = sha256(gz);
      if (cfg.inline) {
        if (gz.length > MAX_DATA_BYTES) {
          return {
            error: `too_large: the snapshot is ${Math.round(gz.length / MB)} MB; inline export returns at most ${MAX_DATA_BYTES / MB} MB. Export without inline on that machine and copy the file`,
          };
        }
        return { sha256: hash, content_hash, bytes: gz.length, counts, manifest, data: gz.toString("base64") };
      }
      ownerOnly(folder); // writeSnapshot took the empty folder away with its work
      const path = join(folder, name);
      writeFileSync(path, gz, { mode: 0o600 });
      // Only once the new one is written: a failed write keeps the snapshot before it.
      for (const old of readdirSync(folder)) if (old !== name && /^memory-.*\.tar\.gz$/.test(old)) rmSync(join(folder, old), { force: true });
      return { path, sha256: hash, content_hash, bytes: gz.length, counts, manifest };
    });
  },
});
