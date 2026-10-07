import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";

export default defineStep({
  type: "meta/list-workflows",
  description:
    "List published workflows — each one's name, description, category, active version and publisher stamp — up to `limit` (default 100); the result carries `total` and a `hint` when the list was cut, so pass `query` then (keywords; every word must hit the name, category or description). Use to discover what exists before authoring — only workflows stamped publisher 'ai' can be republished through the meta surface; any workflow can be run and its runs read except a SEALED one (a grading harness). meta/get-workflow for a workflow's YAML and versions.",
  input: z.object({
    query: z
      .string()
      .optional()
      .describe("Keywords to filter by — every word must hit the name, category or description. Omit to list everything (up to limit)."),
    limit: z.number().int().positive().optional().describe("Max workflows to return (default 100)."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).listWorkflows(cfg.query, cfg.limit);
  },
});
