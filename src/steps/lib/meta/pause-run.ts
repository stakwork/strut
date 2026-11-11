import { z } from "zod";
import { defineStep } from "../../../core.js";
import { ownRunRefusal, requireAuthoring } from "./_shared.js";

export default defineStep({
  type: "meta/pause-run",
  description:
    "Pause a run that is LIVE in this process at its next step boundary (steps in flight finish; no new ones start), and the runs it launched with it — so you can read it with meta/get-run before deciding to meta/resume-run or meta/cancel-run it. Only live runs can be paused. Refused for a SEALED workflow, a run billed to someone other than this run's principal, and this run itself.",
  input: z.object({
    name: z.string().describe("Workflow name"),
    runId: z.string().describe("Run id (from meta/list-runs or a meta/run-workflow result)"),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const own = ownRunRefusal(ctx.control, cfg.runId, "pause");
    if (own) return { error: own };
    return requireAuthoring(ctx.services).controlRun(cfg.name, cfg.runId, "pause", {
      ...(ctx.principal ? { principal: ctx.principal } : {}),
    });
  },
});
