import { z } from "zod";
import { defineStep } from "../../../core.js";
import { ModelList, dictationModels } from "./_models.js";

export default defineStep({
  type: "dictation/use",
  description:
    "Picks dictation's speech model and/or fixer model (fixer null: none). A pick that is not installed starts downloading " +
    "in the background and is used once installed; until then dictation keeps to what it had. Returns the list as " +
    "dictation/models does.",
  effect: "write",
  input: z.object({
    speech: z.string().optional().describe("A speech model id from dictation/models."),
    fixer: z.string().nullable().optional().describe("A fixer model id from dictation/models, or null for none."),
  }),
  output: ModelList,
  async run(cfg, ctx) {
    return { models: await dictationModels(ctx).use(cfg) };
  },
});
