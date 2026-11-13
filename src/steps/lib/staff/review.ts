import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, seg } from "./_door.js";

/** `staff/review` (plans/human-steps.md §9.6): a person's verdict on one answer. */
export default defineStep({
  type: "staff/review",
  effect: "write",
  description:
    "Mark one answer to a task ok or rejected, with why (PUT /tasks/:id/review); a rejection says why. worker only when the task has several answers. A mark: the run is not touched. A rejection counts against the worker's standing as a failed test does. Changeable until the answer's hold ends, then refused (final). Answers { task, worker, lease, review, earning? }. Only strut's own staff app, shown to an admin.",
  input: z.object({ task: z.string().min(1), worker: z.string().optional(), verdict: z.enum(["ok", "rejected"]), why: z.string().optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { task, ...body } = cfg;
    return staffCall(ctx, "staff/review", "PUT", `/tasks/${seg(task)}/review`, body);
  },
});
