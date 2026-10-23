import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { destroyHandle } from "../../../privacy/index.js";

export default defineStep({
  type: "privacy/destroy",
  description: "Delete a vault now (after an error, or when a file vault's work is done), so the mapping behind a handle no longer exists. Output: { destroyed } — false when nothing was there.",
  input: z.object({ handle: z.string().describe("pvm_… or pvf_… from privacy/anonymize") }),
  output: z.object({ destroyed: z.boolean() }),
  async run(cfg, ctx?: StepContext) {
    return { destroyed: await destroyHandle(cfg.handle, ctx ?? {}) };
  },
});
