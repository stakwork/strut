import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, seg, query } from "./_door.js";

/** `staff/revoke` (plans/human-steps.md §9.3): Revoke a worker's grant of a task type. */
export default defineStep({
  type: "staff/revoke",
  effect: "write",
  description: "Revoke a worker's grant of a task type (DELETE /tasks/workers/:actor/grants/:type), with why; a lease of it they hold ends now. Answers { worker }. Only strut's own staff app, shown to an admin.",
  input: z.object({ actor: z.string().min(1), type: z.string().min(1), why: z.string().optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/revoke", "DELETE", `/tasks/workers/${seg(cfg.actor)}/grants/${seg(cfg.type)}${query({ why: cfg.why })}`);
  },
});
