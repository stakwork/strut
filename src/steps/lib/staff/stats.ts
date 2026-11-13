import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, query } from "./_door.js";

/** `staff/stats` (plans/human-steps.md §9.3): The queue. */
export default defineStep({
  type: "staff/stats",
  effect: "read",
  description: "The queue (GET /tasks/stats): per task type waiting, being worked, the oldest waiting, due within a day, workers granted, holding and asking, what is wrong with its app; per hour, day and week what was answered, expired, cancelled, disputed, skipped and lost, with time to answer and work time (p50, p90); across types the workers by status. Only strut's own staff app, shown to an admin.",
  input: z.object({ type: z.string().optional().describe("One task type alone.") }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/stats", "GET", `/tasks/stats${query({ type: cfg.type })}`);
  },
});
