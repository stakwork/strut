import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { query, staffCall } from "./_door.js";

/** `staff/numbers`: each task type's spend against its limits, and what each
 *  worker did of it lately (GET /tasks/numbers) — the staff's numbers. */
export default defineStep({
  type: "staff/numbers",
  effect: "read",
  description:
    "Each task type's (one with `type`) spend against its limits, and per worker in the last `days` (7 by default) answered, minutes, per hour and sats earned (GET /tasks/numbers). Answers { types }. Only strut's own staff app, shown to an admin.",
  input: z.object({ type: z.string().optional(), days: z.number().int().min(1).max(90).optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/numbers", "GET", `/tasks/numbers${query({ type: cfg.type, days: cfg.days })}`);
  },
});
