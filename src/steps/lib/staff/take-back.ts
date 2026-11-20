import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, seg } from "./_door.js";

/** `staff/take-back` (plans/human-steps.md §9.3): Take back what a task's answers earned. */
export default defineStep({
  type: "staff/take-back",
  effect: "write",
  description: "Take back what a task's answers earned (or one worker's) while it is held (POST /tasks/:id/take-back), with why. Answers { task, earnings }; refused (released) when every earning asked for is past its hold. Only strut's own staff app, shown to an admin.",
  input: z.object({ task: z.string().min(1), worker: z.string().optional(), why: z.string().min(1) }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { task, ...body } = cfg;
    return staffCall(ctx, "staff/take-back", "POST", `/tasks/${seg(task)}/take-back`, body);
  },
});
