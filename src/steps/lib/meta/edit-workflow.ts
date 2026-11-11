import { z } from "zod";
import { defineStep } from "../../../core.js";
import { editsSchema, requireAuthoring } from "./_shared.js";
import { claimsArgSchema } from "../../../claims-schemas.js";

export default defineStep({
  type: "meta/edit-workflow",
  description:
    "Publish a NEW VERSION of an EXISTING workflow by `edits` — exact-string replacements applied in order to the ACTIVE version's YAML, each matching once — for a small change (one params default, one config value) without resending the whole YAML. Call meta/get-workflow first to read the current source. The result is published exactly as meta/publish-workflow would publish it (same checks, same refusals); identical content is a no-op. To replace the whole YAML, use meta/publish-workflow.",
  input: z.object({
    name: z.string().describe("Existing workflow name to edit"),
    edits: editsSchema,
    description: z.string().optional().describe("one-line summary stored with the workflow"),
    category: z.string().optional().describe("Optional sidebar grouping label. Omit to leave unchanged."),
    claims: claimsArgSchema,
  }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).editWorkflow(cfg.name, cfg.edits, cfg.description, cfg.category, cfg.claims, ctx.actor);
  },
});
