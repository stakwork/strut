import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, seg } from "./_door.js";

/** `staff/grant` (plans/human-steps.md §9.3): Grant a worker a task type. */
export default defineStep({
  type: "staff/grant",
  effect: "write",
  description: "Grant a worker a task type (PUT /tasks/workers/:actor/grants/:type); a new worker becomes active. With tests the grant starts qualifying, unless qualify is false. Answers { worker, notice? }. Only strut's own staff app, shown to an admin: the grant's by is that admin.",
  input: z.object({ actor: z.string().min(1), type: z.string().min(1), qualify: z.boolean().optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/grant", "PUT", `/tasks/workers/${seg(cfg.actor)}/grants/${seg(cfg.type)}`, cfg.qualify === undefined ? {} : { qualify: cfg.qualify });
  },
});
