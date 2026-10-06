import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";

export default defineStep({
  type: "meta/list-runs",
  description:
    "List past runs of a workflow (newest first) with status, duration, and timestamps — across ALL sessions, so earlier generations' candidate runs are inspectable. Then call meta/get-run for a specific run's detail. The run history of a SEALED workflow (a grading harness) is refused: its log records what graders were handed.",
  input: z.object({
    name: z.string().describe("Workflow name whose runs to list (a sealed workflow is refused)"),
    limit: z.number().int().positive().default(20).describe("Max number of recent runs to return (default 20)."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).listRuns(cfg.name, cfg.limit);
  },
});
