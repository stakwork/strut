import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { query, staffCall } from "./_door.js";

/** `staff/payouts` (plans/human-steps.md §8.2): workers' withdrawals and their settings. */
export default defineStep({
  type: "staff/payouts",
  effect: "read",
  description:
    "Workers' withdrawals (GET /tasks/payouts): { settings, today: { day, paidMsat, outMsat, count, serverLeftMsat }, payouts } newest first — each with its worker, address, amount, fee, state, when and a failure's words, and stale when it is still out a day after it was sent. " +
    "state narrows to out, stale, paid or failed; worker to one worker's. Only strut's own staff app, shown to an admin.",
  input: z.object({
    state: z.enum(["out", "stale", "paid", "failed"]).optional(),
    worker: z.string().optional(),
    before: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/payouts", "GET", `/tasks/payouts${query(cfg)}`);
  },
});
