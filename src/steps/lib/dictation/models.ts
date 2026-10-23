import { z } from "zod";
import { defineStep } from "../../../core.js";
import { ModelList, dictationModels } from "./_models.js";

export default defineStep({
  type: "dictation/models",
  description:
    "Lists the models dictation can use: speech models (what turns audio into text in /audio/transcribe) and fixer " +
    "models (a small local model that puts the vocabulary into a transcript), each with its download size, whether it is " +
    "available, downloading (with progress) or installed, and whether it is the user's pick. Pick with dictation/use.",
  effect: "read",
  input: z.object({}),
  output: ModelList,
  async run(_cfg, ctx) {
    return { models: await dictationModels(ctx).list() };
  },
});
