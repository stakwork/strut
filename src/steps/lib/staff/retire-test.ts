import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, seg } from "./_door.js";

/** `staff/retire-test` (plans/human-steps.md §9.3): Retire a test. */
export default defineStep({
  type: "staff/retire-test",
  effect: "write",
  description: "Retire a test (DELETE /tasks/tests/:id): never served again, kept for the grades that name it. Answers { test }. Only strut's own staff app, shown to an admin.",
  input: z.object({ id: z.string().min(1) }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/retire-test", "DELETE", `/tasks/tests/${seg(cfg.id)}`);
  },
});
