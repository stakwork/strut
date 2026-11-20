import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { requireAdminPage, requireTrials } from "./_shared.js";

export default defineStep({
  type: "knowledge/sample",
  effect: "read",
  description:
    "One sample of a check, opened: the run's input (the case: the message) and its output (the reply), { status, input, output?, error? }. Only a TRIAL's run is read this way, never a person's own. " +
    "A string when the run was no trial. Only strut's own page shown to an admin may call it.",
  input: z.object({
    workflow: z.string().describe("The workflow the sample ran, as knowledge/checks gives it."),
    run: z.string().describe("The sample's run id."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    requireAdminPage(ctx, "knowledge/sample");
    return (await requireTrials(ctx, "knowledge/sample").sample({ workflow: cfg.workflow, run: cfg.run })) ?? `run ${cfg.run} of ${cfg.workflow} was not a trial: only a trial's message and reply are read here`;
  },
});
