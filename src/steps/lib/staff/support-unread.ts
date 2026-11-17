import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall } from "./_door.js";

/** `staff/support-unread` (plans/support-chat.md §3): the Support tab's count. */
export default defineStep({
  type: "staff/support-unread",
  effect: "read",
  description:
    "How many workers' messages no one has marked seen (GET /support/unread): { unread, conversations }. not_available without the Sphinx daemon's message token. Only strut's own staff app, shown to an admin.",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/support-unread", "GET", "/support/unread");
  },
});
