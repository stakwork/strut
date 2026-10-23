import { z } from "zod";
import { defineStep } from "../../../core.js";
import attributes from "../memory/attributes.js";

export default defineStep({
  type: "dictation/enable",
  description:
    "Turns dictation on or off for one entity of the memory (a ref_id from memory/lexicon). Off, dictation leaves it out: " +
    "its mishearings are not applied, its forms are not looked for in a transcript and nothing is learned for it; the " +
    "entity and what is known of it stay. memory/lexicon reports it as `dictation_off`. `ref_id` in the reply is the " +
    "entity changed (the one a merged-away ref_id was merged into).",
  effect: "write",
  input: z.object({
    ref_id: z.string().min(1),
    on: z.boolean().describe("false: keep it out of dictation; true: let dictation use it again."),
  }),
  output: z.object({ ref_id: z.string(), on: z.boolean() }),
  async run(cfg, ctx) {
    // The attribute memory/lexicon reads; only this step writes it for a client.
    const out = await attributes.run({ ref_id: cfg.ref_id, set: { dictation: cfg.on ? null : "off" } }, ctx);
    if (out?.error) throw new Error(`dictation/enable: ${out.error}`);
    return { ref_id: out.ref_id as string, on: cfg.on };
  },
});
