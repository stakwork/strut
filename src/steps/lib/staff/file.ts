import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, seg, pathSegs } from "./_door.js";

/** `staff/file` (plans/human-steps.md §9.3): One of a task's files. */
export default defineStep({
  type: "staff/file",
  effect: "read",
  description: "One of a task's files (GET /tasks/:id/files/<path>), as run/files answers one: text, or base64 for anything else. Only a path on the task's list. Only strut's own staff app, shown to an admin.",
  input: z.object({ task: z.string().min(1), path: z.string().min(1) }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/file", "GET", `/tasks/${seg(cfg.task)}/files/${pathSegs(cfg.path)}`);
  },
});
