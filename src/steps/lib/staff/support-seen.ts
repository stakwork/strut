import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { seg, staffCall } from "./_door.js";

/** `staff/support-seen` (plans/support-chat.md §3): a conversation read. */
export default defineStep({
  type: "staff/support-seen",
  effect: "write",
  description:
    "Mark a worker's conversation seen up to its newest message, for every admin (POST /support/:worker/seen): { conversation }. Only strut's own staff app, shown to an admin.",
  input: z.object({ worker: z.string().min(1) }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/support-seen", "POST", `/support/${seg(cfg.worker)}/seen`, {});
  },
});
