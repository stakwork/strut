import { z } from "zod";
import { defineStep } from "../../../core.js";
import { ModelList, dictationModels } from "./_models.js";

export default defineStep({
  type: "dictation/remove-model",
  description:
    "Deletes a dictation model's files. If it was the user's pick, the speech pick goes back to the default model and the " +
    "fixer pick to none. A model still downloading cannot be removed. Returns the list as dictation/models does.",
  effect: "write",
  input: z.object({ id: z.string().describe("A model id from dictation/models.") }),
  output: ModelList,
  async run(cfg, ctx) {
    return { models: await dictationModels(ctx).remove(cfg.id) };
  },
});
