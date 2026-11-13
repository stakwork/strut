import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, seg } from "./_door.js";

/** `staff/save-type` (plans/human-steps.md §9.3): Save a task type whole. */
export default defineStep({
  type: "staff/save-type",
  effect: "write",
  description: "Save a task type whole (PUT /tasks/types/:name): what is left out is the default (unpaid, a 72-hour hold, no tests, no copies). Answers { type }. Only strut's own staff app, shown to an admin: the type's changedBy is that admin.",
  input: z.object({
    name: z.string().min(1),
    app: z.string().min(1),
    answer: z.any(),
    leaseSeconds: z.number().optional(),
    withinHours: z.number().optional(),
    enabled: z.boolean().optional(),
    paySats: z.number().optional(),
    holdHours: z.number().optional(),
    tests: z.record(z.string(), z.any()).nullable().optional(),
    copies: z.record(z.string(), z.any()).nullable().optional(),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { name, ...type } = cfg;
    return staffCall(ctx, "staff/save-type", "PUT", `/tasks/types/${seg(name)}`, type);
  },
});
