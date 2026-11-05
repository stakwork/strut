import { z } from "zod";
import { defineStep } from "../../../core.js";
import { graphLexicon } from "../dictation/_graph.js";

// Dictation's vocabulary, read in one call from the workspace graph. The
// one memory/* step left: Peel's Vocabulary window reads it by this name.
export default defineStep({
  type: "memory/lexicon",
  description:
    "Dictation's vocabulary in one read, from the workspace graph: every entity with its type, name, `written` forms (its name, " +
    "then its alt_names), `heard` (how dictation mishears it: { ref_id, value, form, created_at }, form null meaning the name), " +
    "`dictation_off` (set with dictation/enable), and for ranking `facts` (its current facts and mishearings), `updated_at` and " +
    "`known_by_user` (a current fact links it to the user). `undone` lists the mishearings dictation/undo took back, so they are " +
    "not learned again. `lingo_type` is the type a new word is made as, `person_type` the type a full name dictation learns is " +
    "made as, and `mishearing` the record type a mishearing is kept as. A LadybugDB graph only.",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx) {
    return graphLexicon(ctx);
  },
});
