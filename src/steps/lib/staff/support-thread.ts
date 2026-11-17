import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { query, seg, staffCall } from "./_door.js";

/** `staff/support-thread` (plans/support-chat.md §3): one worker's conversation. */
export default defineStep({
  type: "staff/support-thread",
  effect: "read",
  description:
    "One worker's conversation with Support (GET /support/:worker): { conversation, messages, more } — the newest 200 messages (limit, at most 500) before the key `before`, oldest first. no_conversation when the worker never added Support as a contact. Only strut's own staff app, shown to an admin.",
  input: z.object({ worker: z.string().min(1), before: z.number().int().positive().optional(), limit: z.number().int().positive().optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { worker, ...q } = cfg;
    return staffCall(ctx, "staff/support-thread", "GET", `/support/${seg(worker)}${query(q)}`);
  },
});
