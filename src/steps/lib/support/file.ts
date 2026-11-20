import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { FILE_PIECE_BYTES, supportDb } from "./_shared.js";

/**
 * `support/file` (plans/people-and-hosts.md §5): a file of the thread — a
 * worker's, or one Support sent — in 3 MB pieces, since a step's result is
 * capped at 5 MB. `next` is where the next piece starts; the pieces' base64
 * joins as one. A deleted message's file is not handed out (ruling 12).
 */
export default defineStep({
  type: "support/file",
  effect: "read",
  description: "A file of a Support thread by its message's key, 3 MB of it from `offset`: { key, name?, mediaType, bytes, offset, base64, next? }. Ask again from `next` until it is absent.",
  input: z.object({
    key: z.number().int().describe("The message's key."),
    offset: z.number().int().min(0).optional().describe("Where the piece starts: 0, or a `next`."),
  }),
  output: z.object({ key: z.number(), name: z.string().optional(), mediaType: z.string(), bytes: z.number(), offset: z.number(), base64: z.string(), next: z.number().optional() }),
  async run(cfg, ctx?: StepContext<StrutCapabilities>) {
    const db = await supportDb(ctx, "support/file");
    const offset = cfg.offset ?? 0;
    if (offset % FILE_PIECE_BYTES !== 0) throw new Error(`bad_request: offset is a multiple of ${FILE_PIECE_BYTES}: where a piece starts`);
    const r = db
      .prepare("SELECT m.media_type, m.file_name, m.deleted, length(f.bytes) AS size, substr(f.bytes, ?, ?) AS piece FROM messages m JOIN files f ON f.key = m.key WHERE m.key = ?")
      .get(offset + 1, FILE_PIECE_BYTES, cfg.key) as { media_type: string | null; file_name: string | null; deleted: number; size: number; piece: Uint8Array | null } | undefined;
    if (!r) throw new Error(`no_file: message ${cfg.key} has no file kept here`);
    if (r.deleted) throw new Error("no_file: its sender deleted it");
    const piece = r.piece ? Buffer.from(r.piece) : Buffer.alloc(0);
    const next = offset + piece.byteLength;
    return {
      key: cfg.key,
      ...(r.file_name ? { name: r.file_name } : {}),
      mediaType: r.media_type ?? "application/octet-stream",
      bytes: Number(r.size),
      offset,
      base64: piece.toString("base64"),
      ...(next < Number(r.size) ? { next } : {}),
    };
  },
});
