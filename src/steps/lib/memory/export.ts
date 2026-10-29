import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineStep } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { memoryExclusive, ownerOnly } from "./_db.js";
import { MAX_DATA_BYTES, MB, currentHash, memoryFolder, sha256, writeSnapshot } from "./_snapshot.js";

// The snapshot is plaintext, kept in the memory folder (owner-only) as
// snapshots/memory-<time>.tar.gz until the next export deletes it; the caller
// deletes it once it has sealed or sent it. An unchanged memory exports the
// same content_hash: a backup can skip a snapshot whose hash it has already sent.
//
// `inline` is for another machine taking the memory over HTTP (a home server
// handing it back): the snapshot comes back as base64 `data` and no file is
// kept, so no `path`. Capped as memory/import's `data` is. `if_changed` is
// for one that keeps a copy (POST /home/pull): given the content_hash it holds,
// an unchanged memory returns `{ unchanged: true, content_hash }` and nothing
// else.
export default defineStep({
  type: "memory/export",
  description:
    "Write long-term memory (its nodes, the edges between them and its vocabulary; nothing else of the workspace graph) to " +
    "one snapshot file (.tar.gz: manifest.json + graph/) in the memory folder, for memory/import on another strut. Returns its " +
    "path, sha256, size and counts. The file stays until the next export. With inline, the snapshot comes back as base64 data " +
    "and no file is kept. With if_changed (a content_hash), an unchanged memory returns { unchanged: true, content_hash } and no snapshot.",
  input: z.object({
    inline: z.boolean().optional().describe(`Return the snapshot as base64 \`data\` (at most ${MAX_DATA_BYTES / MB} MB) and keep no file.`),
    if_changed: z.string().optional().describe("The content_hash of the copy the caller holds: when memory still exports it, return { unchanged: true, content_hash } and no snapshot."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    return memoryExclusive(ctx, async (handle) => {
      if (cfg.if_changed) {
        const content_hash = await currentHash(handle);
        if (cfg.if_changed === content_hash) return { unchanged: true, content_hash };
      }
      const { gz, counts, manifest, name } = await writeSnapshot(handle);
      const { content_hash } = manifest;
      const hash = sha256(gz);
      if (cfg.inline) {
        if (gz.length > MAX_DATA_BYTES) {
          return {
            error: `too_large: the snapshot is ${Math.round(gz.length / MB)} MB; inline export returns at most ${MAX_DATA_BYTES / MB} MB. Export without inline on that machine and copy the file`,
          };
        }
        return { sha256: hash, content_hash, bytes: gz.length, counts, manifest, data: gz.toString("base64") };
      }
      const folder = join(memoryFolder(handle, (ctx.services as Partial<StrutCapabilities> | undefined)?.dataDir), "snapshots");
      ownerOnly(folder);
      const path = join(folder, name);
      writeFileSync(path, gz, { mode: 0o600 });
      // Only once the new one is written: a failed write keeps the snapshot before it.
      for (const old of readdirSync(folder)) if (old !== name && /^memory-.*\.tar\.gz$/.test(old)) rmSync(join(folder, old), { force: true });
      return { path, sha256: hash, content_hash, bytes: gz.length, counts, manifest };
    });
  },
});
