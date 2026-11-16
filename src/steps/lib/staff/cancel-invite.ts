import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { seg, staffCall } from "./_door.js";

/** `staff/cancel-invite` (plans/human-steps.md §5.7). */
export default defineStep({
  type: "staff/cancel-invite",
  effect: "write",
  description: "Cancel a worker invite not used yet (POST /tasks/invites/:code/cancel): { code, status }. Only strut's own staff app, shown to an admin.",
  input: z.object({ code: z.string().min(1) }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/cancel-invite", "POST", `/tasks/invites/${seg(cfg.code)}/cancel`);
  },
});
