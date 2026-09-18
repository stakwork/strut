import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";
import { subjectSchema } from "../../../claims-schemas.js";

export default defineStep({
  type: "meta/list-claims",
  description:
    "A subject's active claims, each with its checks and its status COMPUTED from evidence: supported | refuted | stale (evidence is about an older version) | unknown (never checked). `assertedOnly` = nothing observed, only a model's or person's word; `unverified` = active checks with no evidence about the active version; `openSlot` = an external check is waiting on someone. Reads ANY subject — a contract is meant to be seen by the agent that has to meet it.",
  input: z.object({ subject: subjectSchema }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).listClaims(cfg.subject);
  },
});
