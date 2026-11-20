import { z } from "zod";
import { caseSchema } from "../../../claims-schemas.js";
import { defineStep, type StepContext } from "../../../core.js";
import { requireAdminPage, requireTrials } from "./_shared.js";

export default defineStep({
  type: "knowledge/cases",
  effect: "write",
  description:
    "Set the CASES of a check on a Concept, replaced whole: each a workflow and one input to it ({ workflow: \"orchestrator\", input: { prompt: \"Can you use bash?\" } }) — what knowledge/trial and knowledge/test run to test the check. " +
    "Only strut's own page shown to an admin may call it. Returns { ok, cases }.",
  input: z.object({
    claim: z.string().describe("The check, by its claim id (knowledge/checks lists them)."),
    cases: z.array(caseSchema).describe("Every case the check keeps, in order."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    requireAdminPage(ctx, "knowledge/cases");
    const r = await requireTrials(ctx, "knowledge/cases").setCases({ claim: cfg.claim, cases: cfg.cases });
    if (!("ok" in r)) throw new Error(r.error);
    return r;
  },
});
