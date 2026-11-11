import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";
import { claimsArgSchema } from "../../../claims-schemas.js";

export default defineStep({
  type: "meta/publish-workflow",
  description:
    "Publish a workflow from YAML — an explicit UPSERT: a new name creates v1, an existing name (yours, a person's or a seeded one) gets the next version (identical content is a no-op; prior versions are kept for rollback). Everything published here is stamped publisher 'ai'. Over a SEEDED workflow the result carries a `note`: the next boot puts the seeded version back, so say so to the person. A SEALED workflow (a grading harness) is never published over; a workflow whose closure reaches anything sealed — a grader step by type, a sealed workflow through a subflow, a grader in an agentTools grant — is refused; and a candidate may not declare `sealed: true` itself, nor `peer:` (only a person opens a workflow to other struts).",
  input: z.object({
    name: z.string().describe("Workflow name (kebab-case)"),
    yaml: z.string().describe("Full workflow YAML"),
    description: z.string().optional().describe("one-line summary stored with the workflow"),
    category: z
      .string()
      .optional()
      .describe("Optional sidebar grouping label (e.g. an experiment name). Omit to leave unchanged."),
    claims: claimsArgSchema,
  }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).publishWorkflow(
      cfg.name,
      cfg.yaml,
      cfg.description,
      cfg.category,
      cfg.claims,
      ctx.actor,
    );
  },
});
