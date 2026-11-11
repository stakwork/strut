import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { errText } from "../graph/_shared.js";
import { claimGraph } from "./_graph.js";

export default defineStep({
  type: "dream/claims",
  effect: "read",
  description:
    "The claims about a tree of Concepts (plans/dream.md), the most corrected first: " +
    "{ claims: [{ id, title, text, since, about, concept, parent?, children?, corrected, kept, last, evidence: [{ source, session, turn, said_by?, excerpt, why?, outcome, denies, at, dream? }] }] }. " +
    "`about` and `concept` are the Concept it belongs on. `corrected` counts the times the assistant got it wrong and `kept` the times it got it right: counted on read, never stored. " +
    "A claim with `children` is a group: it has no evidence of its own, and its counts are its children's. " +
    "A claim corrected again after its Concept was changed is one whose fix did not hold: look at that evidence's `outcome` for why.",
  input: z.object({
    root: z.string().optional().describe("Only the claims about this tree: the root Concept's name (\"Personal\"). Default: every claim about a Concept."),
    evidence: z.number().int().nonnegative().max(200).optional().default(5).describe("Most pieces of evidence per claim, newest first (default 5)."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    try {
      const { g, namespace, readable } = await claimGraph(ctx);
      if (!readable) return { claims: [] };
      const { listClaims } = await import("../../../graph/concept-claims.js");
      const claims = await listClaims(g, namespace, cfg.root);
      return { claims: claims.map((c) => ({ ...c, evidence: c.evidence.slice(0, cfg.evidence) })) };
    } catch (e) {
      return errText("dream/claims", e);
    }
  },
});
