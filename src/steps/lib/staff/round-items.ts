import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, seg } from "./_door.js";

/** `staff/round-items`: what Send a round lists for a round type. */
export default defineStep({
  type: "staff/round-items",
  effect: "read",
  description:
    "What a round of a ROUND type (one saved with round: { workflow }) sends (GET /tasks/types/:name/round): { type, workflow, input?, items: [{ label, value }], last?: { runId, at, tasks } } — " +
    "the items are the workflow's first json input whose default is a list (input is that input's name), each labelled by its text fields (\"Bean There – 412 Main St\"); last is the newest round: its run, when, and how many tasks it made. " +
    "Only strut's own staff app, shown to an admin.",
  input: z.object({ type: z.string().min(1) }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/round-items", "GET", `/tasks/types/${seg(cfg.type)}/round`);
  },
});
