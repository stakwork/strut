import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { seg, staffCall } from "./_door.js";

/** `staff/support-delete` (plans/support-chat.md §3, item 2): one of Support's messages deleted. */
export default defineStep({
  type: "staff/support-delete",
  effect: "write",
  description:
    "Delete one of Support's messages for both sides (POST /support/:worker/delete): key, the message's. The worker's Peel shows it deleted; strut keeps its row, flagged. Answers { message }. Only strut's own staff app, shown to an admin.",
  input: z.object({ worker: z.string().min(1), key: z.number().int().positive() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/support-delete", "POST", `/support/${seg(cfg.worker)}/delete`, { key: cfg.key });
  },
});
