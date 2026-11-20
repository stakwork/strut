import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, query } from "./_door.js";

/** `staff/workers` (plans/human-steps.md §9.3): The workers. */
export default defineStep({
  type: "staff/workers",
  effect: "read",
  description: "The workers (GET /tasks/workers), newest first: status, first seen, note, grants (revoked ones with when, who and why), balance and standing per type. Only strut's own staff app, shown to an admin.",
  input: z.object({ status: z.enum(["new", "active", "suspended", "banned"]).optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/workers", "GET", `/tasks/workers${query({ status: cfg.status })}`);
  },
});
