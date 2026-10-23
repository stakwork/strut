// What dictation/models, use and remove-model share: the picker over
// ctx.services.stt (src/audio/dictation-models.ts) and its reply. Leading
// underscore: imported by siblings, skipped by registry discovery.
import { z } from "zod";
import type { StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import type { DictationModels } from "../../../audio/dictation-models.js";

export const ModelList = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["speech", "fixer"]),
      name: z.string().describe("Display name, e.g. 'Kroko', 'Qwen3 1.7B'."),
      summary: z.string().describe("One line for the user."),
      recommended: z.boolean().describe("The model to suggest (the 1.7B fixer)."),
      bytes: z.number().describe("Download size."),
      description: z.string(),
      state: z.enum(["available", "downloading", "installed"]),
      progress: z.number().optional().describe("0..1 while downloading."),
      downloaded: z.number().optional().describe("Bytes received so far, while downloading."),
      selected: z.boolean().describe("The user's pick for its kind; a pick is used once it is installed."),
      active: z.boolean().describe("What strut uses now: the installed speech pick (else the default speech model) and the installed fixer pick. Differs from `selected` while a pick downloads."),
      removable: z.boolean().describe("False for the active model and the default speech model; dictation/remove-model refuses them."),
      error: z.string().optional().describe("Why the last download failed."),
    }),
  ),
});

export function dictationModels(ctx: StepContext<unknown>): DictationModels {
  const stt = (ctx.services as StrutCapabilities | undefined)?.stt;
  if (!stt) throw new Error("dictation: this strut has no speech-to-text service");
  return stt.dictation;
}
