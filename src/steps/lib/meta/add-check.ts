import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";
import { checkSpecSchema } from "../../../claims-schemas.js";

export default defineStep({
  type: "meta/add-check",
  description:
    "Add another instrument to an existing claim — e.g. a free `exec` on every run beside an `llm` judge on change. Each check keeps its own policy, cost and evidence stream; a refutation from ANY check on the active version makes the claim refuted. Publisher-scoped like the rest of meta/*: it acts only on claims and checks stamped 'ai' and on subjects this surface published, and a check may never reach a harness-only step (gaia/*, harvey/*, eval/*, meta/*) — by name, inside a subflow, or granted to an agent.",
  input: z.object({ claim: z.string().describe("Claim id"), check: checkSpecSchema }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).addCheck(cfg.claim, cfg.check);
  },
});
