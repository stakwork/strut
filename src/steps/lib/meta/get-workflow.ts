import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";

export default defineStep({
  type: "meta/get-workflow",
  description:
    "Get a published workflow's full YAML source plus version metadata; `versionHistory` lists every version newest first with its `source`, `actor` (who published it, absent for seeds/installs) and `createdAt` (ISO UTC). Defaults to the active version; pass `version` for a specific one. Read before republishing a candidate with meta/publish-workflow.",
  input: z.object({
    name: z.string().describe("Workflow name"),
    version: z.string().optional().describe("Optional specific version. Defaults to the active version."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).getWorkflow(cfg.name, cfg.version);
  },
});
