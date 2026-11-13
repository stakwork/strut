import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall } from "./_door.js";

/** `staff/types` (plans/human-steps.md §9.3): The task types. */
export default defineStep({
  type: "staff/types",
  effect: "read",
  description: "The task types (GET /tasks/types): each with its app, answer shape, lease, expiry, on or off, pay and hold, tests and copies. Only strut's own staff app, shown to an admin.",
  input: z.object({}),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/types", "GET", "/tasks/types");
  },
});
