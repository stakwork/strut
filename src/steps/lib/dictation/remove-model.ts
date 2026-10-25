import { z } from "zod";
import { defineStep } from "../../../core.js";
import { ModelList, dictationModels } from "./_models.js";

export default defineStep({
  type: "dictation/remove-model",
  description:
    "Deletes a dictation model's files. Refused for a model not `removable` (the active one, or the default speech " +
    "model: pick another first, or fixer null) and for one still downloading. A pick that was not installed goes back " +
    "to the default speech model or no fixer. Returns the list as dictation/models does.",
  effect: "write",
  input: z.object({ id: z.string().describe("A model id from dictation/models.") }),
  output: ModelList,
  async run(cfg, ctx) {
    return { models: await dictationModels(ctx).remove(cfg.id) };
  },
});
