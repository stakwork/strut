import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, seg } from "./_door.js";

/** `staff/test` (plans/human-steps.md §9.3): One test. */
export default defineStep({
  type: "staff/test",
  effect: "read",
  description: "One test (GET /tasks/tests/:id) and each instance served: who, how it closed, the answer, the grade and what the grader said. Only strut's own staff app, shown to an admin; a read, never kept as a run.",
  input: z.object({ id: z.string().min(1) }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/test", "GET", `/tasks/tests/${seg(cfg.id)}`);
  },
});
