import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";
import { subjectSchema } from "../../../claims-schemas.js";

export default defineStep({
  type: "meta/attach-claim",
  description:
    "Attach an EXISTING claim — anyone's — to a subject this surface published: how a contract is shared across a lineage (its checks come along), never by copying it. Each subject gets its own status. Idempotent: an existing attachment is a no-op.",
  input: z.object({ id: z.string().describe("Claim id"), subject: subjectSchema }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).attachClaim(cfg.id, cfg.subject);
  },
});
