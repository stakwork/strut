import { z } from "zod";
import { defineStep } from "../../../core.js";
import forget from "../memory/forget.js";
import { readLexicon } from "./_shared.js";

export default defineStep({
  type: "dictation/remove",
  description:
    "Removes from dictation's vocabulary: a mishearing (a `heard` ref_id from memory/lexicon), or a word of memory/lexicon's " +
    "`lingo_type` (its ref_id) with all its mishearings. A word of that type that has nothing else known of it goes with its " +
    "last mishearing, so no hidden word keeps changing what is typed. Anything else the memory knows (a person, a company) is not removed: " +
    "turn it off for dictation with memory/attributes { ref_id, set: { dictation: \"off\" } }.",
  effect: "write",
  input: z.object({ ref_id: z.string().min(1) }),
  output: z.object({ forgotten: z.string() }),
  async run(cfg, ctx) {
    const lexicon = await readLexicon(ctx);
    const lingo = (type: string) => !!lexicon.lingoType && type === lexicon.lingoType;
    const word = lexicon.entries.find((e) => e.refId === cfg.ref_id);
    const owner = lexicon.entries.find((e) => e.heard.some((h) => h.refId === cfg.ref_id));
    let id: string;
    if (word) {
      if (!lingo(word.type)) throw new Error(`dictation/remove: ${word.name} is a ${word.type}, not a word of dictation's own; turn it off for dictation instead`);
      id = word.refId;
    } else if (owner) {
      // The word goes with its last mishearing only when nothing else is known of it.
      id = lingo(owner.type) && owner.heard.length === 1 && owner.facts <= 1 ? owner.refId : cfg.ref_id;
    } else {
      throw new Error(`dictation/remove: no word or mishearing ${cfg.ref_id} in dictation's vocabulary`);
    }
    const out = await forget.run({ ref_id: id, reason: "removed" }, ctx);
    if (out?.error) throw new Error(`dictation/remove: ${out.error}`);
    return { forgotten: id };
  },
});
