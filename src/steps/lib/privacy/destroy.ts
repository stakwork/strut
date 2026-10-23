import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { destroyHandle } from "../../../privacy/index.js";

export default defineStep({
  type: "privacy/destroy",
  description:
    "Delete a vault now (after an error, or when a file vault's work is done), so the mapping behind a handle no longer exists. " +
    "With `rethrow` it then fails with that message: an onError handler passes `{{ $error.message }}`, so the run still fails with the error of the step that failed. " +
    "Output: { destroyed } — false when nothing was there.",
  input: z.object({
    handle: z.string().describe("pvm_… or pvf_… from privacy/anonymize"),
    rethrow: z.string().optional().describe("an error message to fail with after destroying — an onError handler passes `{{ $error.message }}`"),
  }),
  output: z.object({ destroyed: z.boolean() }),
  async run(cfg, ctx?: StepContext) {
    const destroyed = await destroyHandle(cfg.handle, ctx ?? {});
    if (cfg.rethrow !== undefined) throw new Error(cfg.rethrow);
    return { destroyed };
  },
});
