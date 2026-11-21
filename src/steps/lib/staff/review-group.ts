import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall } from "./_door.js";

/** `staff/review-group` (plans/human-steps.md §9.6): one verdict on a group's unreviewed answers. */
export default defineStep({
  type: "staff/review-group",
  effect: "write",
  description:
    "Mark every answer in a group (task/reply's group; of one type when given) that has no verdict yet ok, or rejected with why (POST /tasks/groups/review): one review each, as staff/review gives it; a verdict already given stays. At most 1000 tasks a call: more says there may be others. Answers { reviewed, more }. Only strut's own staff app, shown to an admin.",
  input: z.object({ group: z.string().min(1), type: z.string().optional(), verdict: z.enum(["ok", "rejected"]), why: z.string().optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/review-group", "POST", "/tasks/groups/review", cfg);
  },
});
