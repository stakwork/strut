import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { z } from "zod";
import { defineStep } from "../../../core.js";
import { MIGRATION_COUNT, memoryExclusive } from "./_db.js";
import { FORMAT, MAX_DATA_BYTES, MB, type Manifest, contentHash, countRows, literal, ontologyVersion, removeWork, sha256, snapshotDirs, strutVersion, tar } from "./_snapshot.js";

// The snapshot is plaintext, kept in the memory folder (owner-only) as
// snapshots/memory-<time>.tar.gz until the next export deletes it; the caller
// deletes it once it has sealed or sent it. The folder EXPORT DATABASE writes
// is removed before the step returns. It is always the same path, so an
// unchanged graph exports the same content_hash (schema.cypher names it):
// a backup can skip a snapshot whose hash it has already sent.
//
// `inline` is for another machine taking the memory over HTTP (a home server
// handing it back): the snapshot comes back as base64 `data` and no file is
// kept, so no `path`. Capped as memory/import's `data` is.
export default defineStep({
  type: "memory/export",
  description:
    "Write the whole long-term memory graph to one snapshot file (.tar.gz: manifest.json + Ladybug's EXPORT DATABASE) " +
    "in the memory folder, for memory/import on another strut. Returns its path, sha256, size and rows per table. " +
    "The file stays until the next export. With inline, the snapshot comes back as base64 data and no file is kept.",
  input: z.object({
    inline: z.boolean().optional().describe(`Return the snapshot as base64 \`data\` (at most ${MAX_DATA_BYTES / MB} MB) and keep no file.`),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    return memoryExclusive(ctx, async (handle) => {
      const { folder, work } = snapshotDirs(handle.path, "export");
      try {
        // EXPORT DATABASE makes `work` itself, and refuses one that is there.
        await handle.write("CHECKPOINT");
        // One thread: with more, a rel table's Parquet comes out in a different
        // order from one export to the next, and the content hash with it.
        const [{ threads }] = await handle.write("CALL current_setting('threads') RETURN *");
        await handle.write("CALL threads=1");
        try {
          await handle.write(`EXPORT DATABASE ${literal(work)}`);
        } finally {
          await handle.write(`CALL threads=${Number(threads)}`);
        }
        const graph = new Map(readdirSync(work).map((name) => [name, readFileSync(join(work, name))]));
        const counts = await countRows(handle.write);
        const created = new Date();
        const manifest: Manifest = {
          format: FORMAT,
          created_at: created.toISOString(),
          strut: strutVersion(),
          ladybug: handle.ladybug,
          migrations: MIGRATION_COUNT,
          ontology: ontologyVersion(),
          counts,
          content_hash: contentHash(graph),
        };
        const files = [...graph.keys()].sort().map((name): [string, Buffer] => [`graph/${name}`, graph.get(name)!]);
        const gz = await promisify(gzip)(tar([["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))], ...files]));
        const hash = sha256(gz);
        if (cfg.inline) {
          if (gz.length > MAX_DATA_BYTES) {
            return {
              error: `too_large: the snapshot is ${Math.round(gz.length / MB)} MB; inline export returns at most ${MAX_DATA_BYTES / MB} MB. Export without inline on that machine and copy the file`,
            };
          }
          return { sha256: hash, bytes: gz.length, counts, manifest, data: gz.toString("base64") };
        }
        const name = `memory-${created.toISOString().replace(/[:.]/g, "-")}.tar.gz`;
        const path = join(folder, name);
        writeFileSync(path, gz, { mode: 0o600 });
        // Only once the new one is written: a failed write keeps the snapshot before it.
        for (const old of readdirSync(folder)) if (old !== name && /^memory-.*\.tar\.gz$/.test(old)) rmSync(join(folder, old), { force: true });
        return { path, sha256: hash, bytes: gz.length, counts, manifest };
      } finally {
        removeWork(work); // and the folder, when an inline export left nothing in it
      }
    });
  },
});
