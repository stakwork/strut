import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, seg } from "./_door.js";

/** `staff/delete-type` (plans/human-steps.md §9.3): Delete a task type no task is open of. */
export default defineStep({
  type: "staff/delete-type",
  effect: "write",
  description: "Delete a task type no task is open of (DELETE /tasks/types/:name); its live grants are revoked and its tests retired. Refused (in_use) while a task of it is open. Answers { name, revoked }. Only strut's own staff app, shown to an admin.",
  input: z.object({ name: z.string().min(1) }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/delete-type", "DELETE", `/tasks/types/${seg(cfg.name)}`);
  },
});
