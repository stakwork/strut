import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";
import { checkSpecSchema } from "../../../claims-schemas.js";

export default defineStep({
  type: "meta/edit-check",
  description:
    "Change a check — pass only the fields to change. Checks are immutable: this creates a SUCCESSOR and returns its id; the old check's evidence stops counting (a changed instrument has measured nothing yet), so the claim reads `unknown` until it runs again. Publisher-scoped like the rest of meta/*: it acts only on claims and checks stamped 'ai' and on subjects this surface published, and a check may never reach a harness-only step (gaia/*, harvey/*, eval/*, meta/*) — by name, inside a subflow, or granted to an agent.",
  input: z.object({ id: z.string().describe("Check id (from meta/list-claims)"), patch: checkSpecSchema }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).editCheck(cfg.id, cfg.patch);
  },
});
