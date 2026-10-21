import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { RUN_GET_MAX_WAIT_MS } from "../../../runs.js";
import { requireRuns } from "./_shared.js";

export default defineStep({
  type: "run/get",
  description:
    "One run: its summary with the WHOLE input and output, its error, who ran it (actor, origin, automation, job, app), what it spent (totals), and `artifacts` — its declared deliverables resolved to links. " +
    "A run still in flight comes as the partial summary its log gives so far (partial: true) with a live status. " +
    `\`wait\` holds the call up to that many ms (at most ${RUN_GET_MAX_WAIT_MS}) while the run is in flight, then answers with whatever it is — a long-poll, so a page follows a run without a tight loop.`,
  input: z.object({
    workflow: z.string().describe("The workflow name."),
    runId: z.string().describe("The run id (run/list, run/launch)."),
    wait: z.number().int().nonnegative().max(RUN_GET_MAX_WAIT_MS).optional().describe(`Hold up to this many ms while the run is in flight (max ${RUN_GET_MAX_WAIT_MS}).`),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const run = await requireRuns(ctx.services).get(cfg);
    if (!run) throw new Error(`Run "${cfg.runId}" not found for workflow "${cfg.workflow}"`);
    return run;
  },
});
