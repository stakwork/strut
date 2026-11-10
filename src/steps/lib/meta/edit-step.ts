import { z } from "zod";
import { defineStep } from "../../../core.js";
import { editsSchema, requireAuthoring } from "./_shared.js";
import { claimsArgSchema } from "../../../claims-schemas.js";

export default defineStep({
  type: "meta/edit-step",
  description:
    "Publish a NEW VERSION of an EXISTING agent-authored custom step. Same self-contained source rules as meta/create-step; call meta/get-step (source: true) first to read the current source. Pass EITHER `code` (the full updated source) OR `edits` (exact-string replacements over the active version's source, each matching once — for a small change, so you never resend the file). Identical content is a no-op; a change increments the version (v1 → v2 → …) with prior versions kept for rollback (meta/set-active-version). Only steps the agent surface authored can be edited — built-ins and seeded steps are refused.",
  input: z.object({
    type: z.string().describe("Existing custom step type to edit, e.g. 'candidates/my-fetcher'."),
    code: z.string().optional().describe("Full updated TypeScript source (same self-contained shape as meta/create-step). Omit when passing `edits`."),
    edits: editsSchema.optional(),
    description: z.string().optional().describe("replaces the one-line summary stored with the step"),
    claims: claimsArgSchema,
  }),
  output: z.any(),
  async run(cfg, ctx) {
    if (cfg.code !== undefined && cfg.edits) return { error: "Pass either the full step source or `edits`, not both. Nothing was published." };
    const given = cfg.edits ? { edits: cfg.edits } : cfg.code;
    if (given === undefined) return { error: "Pass the full step source or `edits` (exact-string replacements). Nothing was published." };
    return requireAuthoring(ctx.services).editStep(cfg.type, given, cfg.description, cfg.claims);
  },
});
