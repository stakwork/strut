import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";
import { checkSpecSchema, subjectSchema } from "../../../claims-schemas.js";

export default defineStep({
  type: "meta/add-claim",
  description:
    "State how a step or workflow SHOULD behave, with the check(s) that test it — for a subject you are NOT republishing (when you are, pass `claims` to meta/create-step / meta/edit-step / meta/publish-workflow instead). The regression move: a failure you fixed becomes a claim with a check, so it cannot come back silently. One claim may be about several subjects. Every claim needs at least one check; evidence comes from verifying runs, never from this call. Returns { id, checks: [ids] }. Publisher-scoped like the rest of meta/*: it acts only on claims and checks stamped 'ai' and on subjects this surface published, and a check may never reach a harness-only step (gaia/*, harvey/*, eval/*, meta/*) — by name, inside a subflow, or granted to an agent.",
  input: z.object({
    subjects: z.array(subjectSchema).min(1),
    text: z.string().describe("ONE plain sentence: behavior, not mechanism; never the output schema restated."),
    checks: z.array(checkSpecSchema).min(1),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).addClaim({ subjects: cfg.subjects, text: cfg.text, checks: cfg.checks });
  },
});
