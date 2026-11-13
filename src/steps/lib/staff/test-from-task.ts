import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, seg } from "./_door.js";

/** `staff/test-from-task` (plans/human-steps.md §9.3): Make a test from a real task. */
export default defineStep({
  type: "staff/test-from-task",
  effect: "write",
  // The expected answer never reaches a run's events (§7.9).
  redact: ["expected"],
  description: "Make a test from a real task (POST /tasks/:id/test): its show, its files copied, and its accepted answer as expected unless one is given (a disputed or expired task needs one). The workers who answered it are never served it. Answers { test }. Only strut's own staff app, shown to an admin; never kept as a run, and expected is redacted from any event.",
  input: z.object({ task: z.string().min(1), expected: z.any().optional(), grade: z.any().optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { task, ...body } = cfg;
    return staffCall(ctx, "staff/test-from-task", "POST", `/tasks/${seg(task)}/test`, body);
  },
});
