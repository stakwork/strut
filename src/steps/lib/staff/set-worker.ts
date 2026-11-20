import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, seg } from "./_door.js";

/** `staff/set-worker` (plans/human-steps.md §9.3): Change a worker's status or note. */
export default defineStep({
  type: "staff/set-worker",
  effect: "write",
  description: "Change a worker's status or note (PUT /tasks/workers/:actor). Suspended or banned ends a lease they hold now. Answers { worker }. Only strut's own staff app, shown to an admin.",
  input: z.object({ actor: z.string().min(1), status: z.enum(["new", "active", "suspended", "banned"]).optional(), note: z.string().nullable().optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { actor, ...change } = cfg;
    return staffCall(ctx, "staff/set-worker", "PUT", `/tasks/workers/${seg(actor)}`, change);
  },
});
