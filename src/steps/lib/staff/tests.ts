import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, query } from "./_door.js";

/** `staff/tests` (plans/human-steps.md §9.3): The tests. */
export default defineStep({
  type: "staff/tests",
  effect: "read",
  description: "The tests (GET /tasks/tests), each with its expected answer and how often it was served, passed, failed and graded error: one type's with type, retired or not with retired. Only strut's own staff app, shown to an admin; a read, never kept as a run.",
  input: z.object({ type: z.string().optional(), retired: z.boolean().optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/tests", "GET", `/tasks/tests${query(cfg)}`);
  },
});
