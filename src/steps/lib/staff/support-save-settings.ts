import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall } from "./_door.js";

/** `staff/support-save-settings` (plans/support-chat.md §5, §6): the welcome and payout lines saved. */
export default defineStep({
  type: "staff/support-save-settings",
  effect: "write",
  description:
    "Save Support's settings (PUT /support/settings), either or both: welcome, the text sent automatically, from Support, to each worker who adds Support as a contact after it was first saved (once each) — \"\" turns it off, and the next save starts again from then; payoutLines, whether Support writes \"Paid you 1,200 sats\" to a worker when their payout settles (on by default). Answers { settings }. Only strut's own staff app, shown to an admin.",
  input: z.object({ welcome: z.string().max(2000).optional(), payoutLines: z.boolean().optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/support-save-settings", "PUT", "/support/settings", cfg);
  },
});
