import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { requireRuns } from "./_shared.js";

export default defineStep({
  type: "run/cancel",
  description:
    "Cancel a run that is LIVE in this process (POST …/runs/:runId/cancel): cooperative — it stops at its next step boundary and finalizes as cancelled. Returns { ok: true, runId, state }; a run that already finished, or is not live, is an error naming its status.",
  input: z.object({
    workflow: z.string().describe("The workflow name."),
    runId: z.string().describe("The run id."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const r = await requireRuns(ctx.services).cancel(cfg);
    if (!r.ok) throw new Error(r.error);
    return r;
  },
});
