import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";

export default defineStep({
  type: "meta/set-active-version",
  description:
    "ROLLBACK: make a prior version of a workflow or custom step the ACTIVE one — the version runs use (and, for a step, the one loaded in the registry). No new version is published and history is kept; later versions can be made active again. Use this when a newer version turns out worse (\"go back to v2\") instead of republishing old source as yet another version. meta/get-workflow lists a workflow's versions; for a step, an unknown version reports the ones it has. A version is refused when publishing it would be: it reaches anything sealed, or opens the workflow to other struts when the active version does not.",
  input: z.object({
    kind: z.enum(["workflow", "step"]).describe("What to roll back: a published workflow or a custom step."),
    name: z.string().describe("Workflow name, or custom step type (e.g. 'concepts/decide')."),
    version: z.string().describe("Version label to activate, e.g. 'v2'."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).setActiveVersion(cfg.kind, cfg.name, cfg.version);
  },
});
