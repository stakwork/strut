import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { requireRuns } from "./_shared.js";

export default defineStep({
  type: "run/workflow",
  description:
    "A workflow's contract, for a launch form: { name, description?, category?, activeVersion?, input? (its `input:` block — each field's type, required, default, description), params? (the params defaults), peer? }. Not the YAML.",
  input: z.object({
    workflow: z.string().describe("The workflow name."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    return requireRuns(ctx.services).workflow(cfg);
  },
});
