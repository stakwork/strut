import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { RUN_EVENTS_MAX } from "../../../runs.js";
import { requireRuns } from "./_shared.js";

export default defineStep({
  type: "run/events",
  description:
    "A run's event log as an array — run.start, every step.start / step.end / step.error (an agent's tool calls nested under its path), run.end or run.error — as GET …/runs/:runId/events serves it: " +
    "an agent transcript is a `transcript` link, never inline; a string field over 64 KB is replaced by its size. " +
    `Capped at ${RUN_EVENTS_MAX} events keeping the head and the last event, so a cut log still ends in its terminal event; \`skip\` leaves out the first N (what you already have).`,
  input: z.object({
    workflow: z.string().describe("The workflow name."),
    runId: z.string().describe("The run id."),
    skip: z.number().int().nonnegative().optional().describe("Leave out the first N events."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    return requireRuns(ctx.services).events(cfg);
  },
});
