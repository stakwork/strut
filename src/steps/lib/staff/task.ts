import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, seg } from "./_door.js";

/** `staff/task` (plans/human-steps.md §9.3): One task. */
export default defineStep({
  type: "staff/task",
  effect: "read",
  description: "One task (GET /tasks/:id): what it showed, its files, its leases in order, the answer and who gave it, and its run now (status, what it waits on). Only strut's own staff app, shown to an admin.",
  input: z.object({ id: z.string().min(1) }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/task", "GET", `/tasks/${seg(cfg.id)}`);
  },
});
