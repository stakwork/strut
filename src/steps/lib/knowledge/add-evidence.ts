import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { requireKnowledge } from "./_shared.js";

export default defineStep({
  type: "knowledge/add-evidence",
  effect: "write",
  // The tender's, like knowledge/add-claim.
  sealed: true,
  description:
    "Record what a PERSON said about a run's work as their word on a claim about a Concept: against it when they corrected the work (`supports: false`, the default), for it when they confirmed it. " +
    "`workflow` and `run` name the run whose WORK they were talking about, as the transcript's headers give them: the turn that produced the reply they corrected, or the job run behind it — not the turn they spoke in. " +
    "It is evidence only when that run opened the Concept's page: about a run that never opened it there is nothing to record, and this says so. " +
    "`said` is their own words, copied. Returns { ok, evidence, concept } or { error }.",
  input: z.object({
    claim: z.string().describe("The claim's id, from knowledge_page or knowledge_add_claim."),
    workflow: z.string().describe("The workflow of the run whose work was corrected or confirmed, as its header gives it."),
    run: z.string().describe("That run's id."),
    supports: z.boolean().optional().default(false).describe("true only when the person confirmed the work did as the claim says."),
    said: z.string().describe("The person's own words, copied verbatim."),
    by: z.string().optional().describe("Who said it, when the transcript names them."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return requireKnowledge(ctx, "knowledge/add-evidence").addEvidence({
      claim: cfg.claim,
      workflow: cfg.workflow,
      runId: cfg.run,
      supports: cfg.supports,
      said: cfg.said,
      ...(cfg.by ? { by: cfg.by } : {}),
    });
  },
});
