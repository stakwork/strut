import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";
import { subjectSchema } from "../../../claims-schemas.js";

export default defineStep({
  type: "meta/add-evidence",
  description:
    "Record an observation about a claim on a specific run — sourced to that run and the version it executed; `content` says what was observed and how. How much it is worth depends on WHO calls it: a step of a seeded harness workflow (a grader reporting its verdict — content must carry verdicts, never gold answers) records OBSERVED evidence; an agent calling this as a tool, or any agent-authored workflow, records ASSERTED evidence whatever it claims — a candidate whose only support is its own author's word shows as `assertedOnly`. If an external check is waiting on this run (an open slot), this answers it.",
  input: z.object({
    claim: z.string().describe("Claim id (from meta/list-claims)"),
    name: z.string().describe("The run's workflow name, or `step:<type>` for a kept single-step run"),
    runId: z.string(),
    supports: z.boolean().describe("true: the observation supports the claim; false: it refutes it"),
    content: z.string().describe("What was observed, and how — one bounded statement"),
    subject: subjectSchema.optional().describe("Only when the run executed several of the claim's subjects"),
    slot: z.string().optional().describe("Evidence id of the open slot to fill; found automatically for this run when omitted"),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).addEvidence(
      { claim: cfg.claim, name: cfg.name, runId: cfg.runId, supports: cfg.supports, content: cfg.content, subject: cfg.subject, slot: cfg.slot },
      // Who is asking: the run's top-level workflow, and whether a model chose to.
      { workflow: ctx.path.split("/")[0], runId: ctx.runId, agentTool: ctx.agentTool === true },
    );
  },
});
