import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { query, staffCall } from "./_door.js";

/** `staff/support-list` (plans/support-chat.md §3): Support's conversations. */
export default defineStep({
  type: "staff/support-list",
  effect: "read",
  description:
    "Support's conversations with workers (GET /support): { conversations }, unread first, then the newest — each { worker, pubkey, alias?, unread, last?, seenAt?, welcomedAt?, status, assigned? } (status open or done; assigned me or other); q searches names, actors and text; filter is all (the default), open, mine (open, taken by you), unassigned (open) or done. not_available without the Sphinx daemon's message token. Only strut's own staff app, shown to an admin.",
  input: z.object({ q: z.string().optional(), filter: z.enum(["all", "open", "mine", "unassigned", "done"]).optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/support-list", "GET", `/support${query(cfg)}`);
  },
});
