import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, query } from "./_door.js";

/** `staff/tasks` (plans/human-steps.md §9.3): Tasks newest first, a page at a time. */
export default defineStep({
  type: "staff/tasks",
  effect: "read",
  description: "Tasks newest first, a page at a time (GET /tasks): by type, status, workflow, run, who answered (by), an answer's verdict (review: none, ok, rejected — the review queue), test instances or real tasks (test), before a seq. Each with its leases, an answer's earning and verdict, a copies task's answers. Only strut's own staff app, shown to an admin.",
  input: z.object({
    type: z.string().optional(),
    status: z.enum(["open", "settled", "expired", "cancelled", "disputed"]).optional(),
    workflow: z.string().optional(),
    runId: z.string().optional(),
    by: z.string().optional(),
    review: z.enum(["none", "ok", "rejected"]).optional(),
    test: z.boolean().optional(),
    before: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(1000).optional(),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/tasks", "GET", `/tasks${query(cfg)}`);
  },
});
