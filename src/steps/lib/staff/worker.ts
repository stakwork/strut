import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, seg } from "./_door.js";

/** `staff/worker` (plans/human-steps.md §9.3): One worker. */
export default defineStep({
  type: "staff/worker",
  effect: "read",
  description: "One worker (GET /tasks/workers/:actor): the worker with balance and standing, their live lease, the last 7 days by type and their newest 50 leases. Only strut's own staff app, shown to an admin.",
  input: z.object({ actor: z.string().min(1) }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/worker", "GET", `/tasks/workers/${seg(cfg.actor)}`);
  },
});
