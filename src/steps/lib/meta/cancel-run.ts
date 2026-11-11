import { z } from "zod";
import { defineStep } from "../../../core.js";
import { ownRunRefusal, requireAuthoring } from "./_shared.js";

export default defineStep({
  type: "meta/cancel-run",
  description:
    "Cancel a run that is LIVE in this process — one launched with the wrong input, one you resumed with meta/resume-run and want to stop, or one you want to stop after seeing partial output in meta/get-run. Cancellation is cooperative: the run stops at its next step boundary and finalizes as cancelled, and so do the runs it launched. A run that already finished reports its terminal status instead. If a run stays `cancelling` because a step is stuck and never returns, call again with force: true to abandon that step and finalize the run now. Refused for a SEALED workflow, a run billed to someone other than this run's principal, and this run itself.",
  input: z.object({
    name: z.string().describe("Workflow name"),
    runId: z.string().describe("Run id (from meta/list-runs or a meta/run-workflow result)"),
    force: z
      .boolean()
      .optional()
      .describe("Also abandon any step still executing — for a run stuck `cancelling` because a step never returns. The step's code is not killed. Default false."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const own = ownRunRefusal(ctx.control, cfg.runId, "cancel");
    if (own) return { error: own };
    return requireAuthoring(ctx.services).controlRun(cfg.name, cfg.runId, "cancel", {
      ...(ctx.principal ? { principal: ctx.principal } : {}),
      ...(cfg.force ? { force: true } : {}),
    });
  },
});
