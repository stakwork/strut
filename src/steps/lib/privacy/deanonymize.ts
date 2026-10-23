import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { deanonymizeText } from "../../../privacy/index.js";

export default defineStep({
  type: "privacy/deanonymize",
  description:
    "Put the original values back into a text (typically a model's reply) using the handle from privacy/anonymize. " +
    "WARNING: the output contains real personal data, and run files record step outputs in plaintext. " +
    "Tolerates a model's changes to tokens (case, missing brackets, spaces); a token it does not know is left as written and counted in unknown_pseudonyms, never guessed. " +
    "A memory-vault handle is destroyed after use by default, a file-vault handle is kept until its TTL or privacy/destroy. An unknown or expired handle is an error. " +
    "Output: { text, restored, unknown_pseudonyms, destroyed }.",
  input: z.object({
    text: z.string(),
    handle: z.string().describe("pvm_… or pvf_… from privacy/anonymize"),
    destroy: z.boolean().optional().describe("default true for memory handles, false for file handles"),
  }),
  output: z.object({ text: z.string(), restored: z.number(), unknown_pseudonyms: z.number(), destroyed: z.boolean() }),
  async run(cfg, ctx?: StepContext) {
    return deanonymizeText(cfg.text, cfg.handle, cfg.destroy, ctx ?? {});
  },
});
