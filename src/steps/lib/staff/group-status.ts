import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { GROUP_STATUSES } from "../../../tasks/task-store.js";
import { staffCall } from "./_door.js";

/** `staff/group-status`: a group of tasks marked done, or open again. */
export default defineStep({
  type: "staff/group-status",
  effect: "write",
  description:
    "Set a group of tasks (task/reply's group, of one type) done, or open again, with why if given (POST /tasks/groups/status): every change is kept with who set it and when. Answers the group as staff/groups lists it. Only strut's own Workers app, shown to an admin.",
  input: z.object({ type: z.string().min(1), group: z.string().min(1), status: z.enum(GROUP_STATUSES), why: z.string().optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/group-status", "POST", "/tasks/groups/status", cfg);
  },
});
