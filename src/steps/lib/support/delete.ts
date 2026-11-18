import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { messageRow, sphinxOf, supportDb } from "./_shared.js";

/**
 * `support/delete` (plans/people-and-hosts.md §5): one of Support's own
 * messages deleted for both sides (`POST /dm/:id/delete`). A failed send
 * never went (the daemon deletes none): it is deleted here alone.
 */
export default defineStep({
  type: "support/delete",
  effect: "write",
  description: "Delete one of Support's own messages for both sides: { key }. Answers { message }, deleted. A failed send is deleted here alone; one still sending answers not_yet.",
  input: z.object({ key: z.number().int().describe("The message's key.") }),
  output: z.object({ message: z.record(z.string(), z.any()) }),
  async run(cfg, ctx?: StepContext<StrutCapabilities>) {
    const sphinx = sphinxOf(ctx, "support/delete");
    const db = await supportDb(ctx, "support/delete");
    const m = db.prepare("SELECT id, status, deleted FROM messages WHERE key = ? AND from_me = 1 AND kind IN ('message', 'file')").get(cfg.key) as { id: string | null; status: string | null; deleted: number } | undefined;
    if (!m) throw new Error(`unknown_message: no message ${cfg.key} of Support's: Support deletes only its own`);
    if (!m.deleted && m.status !== "failed") {
      if (!m.id) throw new Error("not_yet: still sending: try again in a moment");
      try {
        await sphinx.delete(m.id);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        // A send the daemon has not settled yet (after its restart).
        if (why.startsWith("not_deletable")) throw new Error(`not_yet: the daemon cannot delete it yet: try again in a moment (${why})`);
        throw new Error(`daemon_error: the daemon did not delete it: ${why}`);
      }
    }
    db.prepare("UPDATE messages SET deleted = 1 WHERE key = ?").run(cfg.key);
    return { message: messageRow(db, cfg.key) };
  },
});
