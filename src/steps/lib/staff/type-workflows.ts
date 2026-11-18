import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, query } from "./_door.js";

/** `staff/type-workflows`: the type editor's "When there is work" picker. */
export default defineStep({
  type: "staff/type-workflows",
  effect: "read",
  description:
    "The workflows that can make tasks of a task type (GET /tasks/workflows?type=): { type, workflows: [{ name, standing }] } — each has a human step of the type at any depth (a round's workflow), and standing says whether its FIRST step is that step (a standing type's workflow). Only strut's own staff app, shown to an admin.",
  input: z.object({ type: z.string().min(1) }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/type-workflows", "GET", `/tasks/workflows${query({ type: cfg.type })}`);
  },
});
