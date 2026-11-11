import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";

export default defineStep({
  type: "meta/set-workflow-category",
  description:
    "Set or clear an existing workflow's sidebar category (the grouping label in the UI). Metadata only: no version is published and the YAML is untouched. meta/list-workflows shows the categories in use — reuse one where it fits.",
  input: z.object({
    name: z.string().describe("Existing workflow name"),
    category: z.string().nullable().describe("New category label, or null to clear it"),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).setWorkflowCategory(cfg.name, cfg.category);
  },
});
