import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { deliver, keepOwn, newClientId, sphinxOf, supportDb, tx, welcomeOf } from "./_shared.js";

/**
 * `support/send-due` (plans/people-and-hosts.md §5): the one step of
 * `support-outbox`. Sends each welcome that is due (plans/support-chat.md
 * §5): claimed and kept as Support's message in one transaction, so each
 * worker gets it at most once, then sent. A welcome cleared since is due no
 * more. Reads again until none is due, so one that came due while it sent
 * goes in the same run.
 */
export default defineStep({
  type: "support/send-due",
  effect: "write",
  description: "Send each welcome that is due, once per worker (support-outbox's one step). Answers { sent }: how many it sent (or tried; a failed one shows with Retry).",
  input: z.object({}),
  output: z.object({ sent: z.number() }),
  async run(_cfg, ctx?: StepContext<StrutCapabilities>) {
    const sphinx = sphinxOf(ctx, "support/send-due");
    const db = await supportDb(ctx, "support/send-due");
    let sent = 0;
    for (;;) {
      const key = tx(db, () => {
        const due = db.prepare("SELECT pubkey FROM conversations WHERE welcome_due = 1 AND welcomed_at IS NULL ORDER BY first_at LIMIT 1").get() as { pubkey: string } | undefined;
        if (!due) return null;
        const text = welcomeOf(db).text;
        if (!text.trim()) {
          db.prepare("UPDATE conversations SET welcome_due = 0 WHERE welcome_due = 1").run();
          return null;
        }
        db.prepare("UPDATE conversations SET welcomed_at = ?, welcome_due = 0 WHERE pubkey = ?").run(Date.now(), due.pubkey);
        return keepOwn(db, { pubkey: due.pubkey, text, by: "welcome" }, newClientId());
      });
      if (key === null) return { sent };
      await deliver(db, sphinx, key);
      sent++;
    }
  },
});
