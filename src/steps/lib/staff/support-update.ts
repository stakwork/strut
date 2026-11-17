import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { seg, staffCall } from "./_door.js";

/** `staff/support-update` (plans/support-chat.md §3, item 2): a conversation done, or taken. */
export default defineStep({
  type: "staff/support-update",
  effect: "write",
  description:
    "Mark a worker's conversation with Support done or open, or take it (PUT /support/:worker): status open or done (a worker writing again reopens it); assignee \"me\" takes it, null lets it go. Answers { conversation }. Only strut's own staff app, shown to an admin.",
  input: z.object({ worker: z.string().min(1), status: z.enum(["open", "done"]).optional(), assignee: z.literal("me").nullable().optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { worker, ...body } = cfg;
    return staffCall(ctx, "staff/support-update", "PUT", `/support/${seg(worker)}`, body);
  },
});
