import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { seg, staffCall } from "./_door.js";

/** `staff/support-send` (plans/support-chat.md §3): a reply from Support. */
export default defineStep({
  type: "staff/support-send",
  effect: "write",
  description:
    "Send a worker a message from \"Support\" (POST /support/:worker): text, replyTo the Sphinx id of a message quoted; or retry, the key of a failed message, sent again under the same id. Answers { message }, kept before it went: status sending, sent or failed with error. Every reply is from Support; who sent it is kept and never shown. Only strut's own staff app, shown to an admin.",
  input: z.object({ worker: z.string().min(1), text: z.string().optional(), replyTo: z.string().min(1).optional(), retry: z.number().int().positive().optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { worker, ...body } = cfg;
    return staffCall(ctx, "staff/support-send", "POST", `/support/${seg(worker)}`, body);
  },
});
