import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";
import { subjectSchema } from "../../../claims-schemas.js";

export default defineStep({
  type: "meta/detach-claim",
  description:
    "Detach a claim from ONE subject (it stays on its others). A claim's last subject cannot be detached — retire the claim instead. Publisher-scoped like the rest of meta/*: it acts only on claims and checks stamped 'ai' and on subjects this surface published, and a check may never reach a harness-only step (gaia/*, harvey/*, eval/*, meta/*) — by name, inside a subflow, or granted to an agent.",
  input: z.object({ id: z.string(), subject: subjectSchema }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).detachClaim(cfg.id, cfg.subject);
  },
});
