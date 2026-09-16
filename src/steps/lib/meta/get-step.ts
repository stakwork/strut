import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";

export default defineStep({
  type: "meta/get-step",
  description:
    "Read a step type's docs: description (with a YAML example), input (JSON Schema of its config) and output (JSON Schema of its result; absent when untyped). Pass source: true to also get a lib/custom step's TypeScript source — only needed to edit or mirror it, not to wire it into a workflow.",
  input: z.object({
    type: z.string().describe("Step type, e.g. 'http' or 'github/fetch-pr'"),
    source: z
      .boolean()
      .default(false)
      .describe("also return the step's TypeScript source (lib/custom steps only)"),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).getStep(cfg.type, { source: cfg.source });
  },
});
