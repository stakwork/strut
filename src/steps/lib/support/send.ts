import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { bytesOf, deliver, messageRow, SEND_FILE_MAX_BYTES, SEND_STALE_MS, sendOwn, sphinxOf, supportDb, tooLong, tx } from "./_shared.js";

/**
 * `support/send` (plans/people-and-hosts.md §5): a message from Support to a
 * worker — kept as `sending`, sent through the `sphinx` capability, kept as
 * `sent` or `failed`. `by` is the caller (the admin), kept and never shown
 * (plans/support-chat.md ruling 4). `retry` sends one of Support's failed
 * messages again under the id it first went with (the daemon sends one id
 * once), or one still `sending` a minute on.
 */
export default defineStep({
  type: "support/send",
  effect: "write",
  description:
    "Send a message from Support to a worker who has Support as a contact: { worker (their actor), text?, replyTo? (the Sphinx id quoted), file?: { base64, type, name } (at most 2.5 MiB; text is then its caption) }, " +
    "or { worker, retry: <key> } to send a failed one again. Answers { message }: its row, status sending, sent or failed (with error).",
  input: z.object({
    worker: z.string().min(1).describe("The worker's actor (secp:…): the conversation."),
    text: z.string().optional(),
    replyTo: z.string().min(1).optional(),
    file: z.object({ base64: z.string(), type: z.string(), name: z.string().optional() }).optional(),
    retry: z.number().int().optional().describe("A failed message's key: sent again, as it was."),
  }),
  output: z.object({ message: z.record(z.string(), z.any()) }),
  async run(cfg, ctx?: StepContext<StrutCapabilities>) {
    const sphinx = sphinxOf(ctx, "support/send");
    const db = await supportDb(ctx, "support/send");
    const c = db.prepare("SELECT pubkey FROM conversations WHERE actor = ?").get(cfg.worker) as { pubkey: string } | undefined;
    if (!c) throw new Error(`no_conversation: ${cfg.worker} has no conversation with Support: Support writes only to someone who has it as a contact (an invite gives one)`);
    if (cfg.retry !== undefined) {
      // Claimed once, however many ask: only a failed one, or one stuck.
      const claimed = tx(db, () =>
        Number(
          db
            .prepare("UPDATE messages SET status = 'sending', error = NULL WHERE key = ? AND pubkey = ? AND from_me = 1 AND client_id IS NOT NULL AND deleted = 0 AND (status = 'failed' OR (status = 'sending' AND id IS NULL AND at < ?))")
            .run(cfg.retry!, c.pubkey, Date.now() - SEND_STALE_MS).changes,
        ),
      );
      if (!claimed) {
        const had = db.prepare("SELECT key FROM messages WHERE key = ? AND pubkey = ? AND from_me = 1").get(cfg.retry, c.pubkey);
        if (!had) throw new Error(`unknown_message: no message ${cfg.retry} of Support's in ${cfg.worker}'s conversation`);
      }
      return { message: claimed ? await deliver(db, sphinx, cfg.retry) : messageRow(db, cfg.retry) };
    }
    const text = cfg.text?.trim() ? cfg.text : undefined;
    let file: { bytes: Buffer; type: string; name: string } | undefined;
    if (cfg.file) {
      const type = cfg.file.type.trim().toLowerCase();
      if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)) throw new Error("bad_request: file.type is its media type, such as image/jpeg or application/pdf");
      const name = (cfg.file.name ?? "").replace(/[\\/\x00-\x1f\x7f]/g, "_").trim().slice(0, 200) || "file";
      file = { bytes: bytesOf(cfg.file.base64, SEND_FILE_MAX_BYTES, "the file"), type, name };
    }
    if (!text && !file) throw new Error("bad_request: text is the message (or a file's caption)");
    const long = tooLong({ ...(text ? { text } : {}), ...(cfg.replyTo ? { replyTo: cfg.replyTo } : {}), file });
    if (long) throw new Error(`bad_request: ${long}`);
    const message = await sendOwn(db, sphinx, { pubkey: c.pubkey, ...(text ? { text } : {}), ...(cfg.replyTo ? { replyTo: cfg.replyTo } : {}), ...(ctx?.actor ? { by: ctx.actor } : {}), ...(file ? { file } : {}) });
    return { message: message! };
  },
});
