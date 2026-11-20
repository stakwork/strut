import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { requireKnowledge } from "./_shared.js";

export default defineStep({
  type: "knowledge/add-claim",
  effect: "write",
  // Keeping the claims about Concepts is the work of the workflow that tends
  // the tree, never of ordinary work: the meta surface can neither run this
  // nor publish a workflow that reaches it (src/sealed.ts).
  sealed: true,
  description:
    "State ONE sentence that the work of every run that opens a Concept's page must hold to, from now on (\"A plan ends with a rollout section\", \"Messages to a tribe are short\"). " +
    "Written at once, with its check: strut has a model judge each later run that opened the page against the sentence, once per version of the page, and a run the sentence is not about is left unjudged. " +
    "Write the rule itself, as narrow as what was said, never the event (\"the person said…\"). " +
    "A claim that a page GETS OPENED when it applies belongs on the page that LISTS it (its parent): a run that skipped a page is never checked against that page's claims. " +
    "The same sentence already on the page returns that claim (`existing: true`). Returns { ok, id } or { error }. Changing the Concept itself is a separate call.",
  input: z.object({
    concept: z.string().describe("The Concept the claim is about, by its exact name."),
    text: z.string().describe("ONE plain sentence that should hold from now on, saying where it applies when it is not general."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return requireKnowledge(ctx, "knowledge/add-claim").addClaim({ concept: cfg.concept, text: cfg.text }, ctx?.runId ? { runId: ctx.runId } : {});
  },
});
