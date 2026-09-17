import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";

export default defineStep({
  type: "meta/retire-check",
  description:
    "Retire a check. Refused when it is the claim's LAST active check — add the replacement first (meta/add-check), or retire the claim. Publisher-scoped like the rest of meta/*: it acts only on claims and checks stamped 'ai' and on subjects this surface published, and a check may never reach a harness-only step (gaia/*, harvey/*, eval/*, meta/*) — by name, inside a subflow, or granted to an agent.",
  input: z.object({ id: z.string() }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).retireCheck(cfg.id);
  },
});
