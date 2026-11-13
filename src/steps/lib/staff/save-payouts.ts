import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall } from "./_door.js";

/** `staff/save-payouts` (plans/human-steps.md §8.2): the payout switch and caps. */
export default defineStep({
  type: "staff/save-payouts",
  effect: "write",
  description:
    "Save the payout settings whole (PUT /tasks/payouts/settings): on — workers may withdraw what passed its hold to their own Sphinx address with nobody's yes per payment — minSats, the least one withdrawal may ask, and workerDaySats and serverDaySats, the most one worker's and all workers' payouts may come to in a UTC day (each at least minSats). " +
    "Answers { settings } with changedBy and changedAt. Turning it off stops new withdrawals; those on their way finish. Only strut's own staff app, shown to an admin.",
  input: z.object({ on: z.boolean(), minSats: z.number().int().positive(), workerDaySats: z.number().int().positive(), serverDaySats: z.number().int().positive() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/save-payouts", "PUT", "/tasks/payouts/settings", cfg);
  },
});
