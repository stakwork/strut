import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { OUTCOMES } from "../../../graph/concept-claims.js";
import { errText } from "../graph/_shared.js";
import { claimGraph, writerOf } from "./_graph.js";

export default defineStep({
  type: "dream/claim",
  effect: "write",
  description:
    "Record what somebody said that bears on a CLAIM about a Concept page (plans/dream.md): one sentence the page should say, with their words as evidence. " +
    "A claim is a sentence that should hold, said so it can be checked later (\"Summaries are three lines or fewer\", \"Build only what was asked\"). " +
    "Read dream/claims first. When a claim already covers what was said, pass its id as `claim`: the words are added to it, and a correction after a fix is the sign the fix did not hold. " +
    "Only when none does, make one with `text` and `about` (the ref_id of the Concept it belongs on: the page that says it, or should; the tree's root when no page fits yet), " +
    "and `parent` when it is one of a kind an existing group names. " +
    "`outcome` is what the assistant did there: `missing` no page said it; `not_opened` a page said it and the assistant did not open that page; " +
    "`not_followed` it opened the page and still got it wrong; `contradicted` a page said the opposite; `followed` it did as the claim says, or the person confirmed it. " +
    "`denies: true` only when the person says the claim itself is wrong (\"no, I never wanted that\"); a correction of the assistant is NOT a denial. " +
    "The same words recorded twice write nothing. It changes no page and no fact: only the claim and its evidence.",
  input: z.object({
    claim: z.string().optional().describe("An existing claim's id (from dream/claims). Leave out to make a new one from `text` and `about`."),
    text: z.string().optional().describe("A new claim: one sentence that should hold."),
    title: z.string().optional().describe("A short name for a new claim (a few words). Default: the sentence."),
    about: z.string().optional().describe("A new claim's Concept: the ref_id of the page it belongs on."),
    parent: z.string().optional().describe("A new claim's group: the id of the parent claim it is one kind of."),
    source: z.string().optional().default("conversation").describe("The kind of source it was said in (default conversation)."),
    session: z.string().describe("The conversation it was said in."),
    turn: z.number().int().nonnegative().describe("The turn number."),
    at: z.string().optional().describe("When it was said (ISO), as the transcript gives it."),
    run: z.string().optional().describe("The turn's run id."),
    said_by: z.string().optional().describe("Who said it, as the transcript names them. Leave out for the graph's owner."),
    excerpt: z.string().describe("Their words that show it, verbatim."),
    why: z.string().optional().describe("One line: what the assistant did and what was wanted."),
    outcome: z.enum(OUTCOMES).describe("What the assistant did there."),
    denies: z.boolean().optional().describe("The person says the claim itself is wrong. Default false."),
    lasting: z.boolean().optional().describe("They said it is to last (\"always\", \"never\", \"from now on\", \"remember\")."),
    created_by: z.string().optional(),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    try {
      const { g, namespace, readable } = await claimGraph(ctx);
      if (!readable) return "dream/claim failed — REFUSED: this caller may not read the namespace claims are kept in";
      const at = cfg.at ? Date.parse(cfg.at) : NaN;
      const by = writerOf(ctx, cfg.created_by);
      const { recordSaid } = await import("../../../graph/concept-claims.js");
      return await recordSaid(g, {
        ...(cfg.claim ? { claim: cfg.claim } : {}),
        ...(cfg.text ? { text: cfg.text } : {}),
        ...(cfg.title ? { title: cfg.title } : {}),
        ...(cfg.about ? { about: cfg.about } : {}),
        ...(cfg.parent ? { parent: cfg.parent } : {}),
        source: cfg.source,
        session: cfg.session,
        turn: cfg.turn,
        ...(cfg.run ? { run: cfg.run } : {}),
        ...(cfg.said_by ? { said_by: cfg.said_by } : {}),
        excerpt: cfg.excerpt,
        ...(cfg.why ? { why: cfg.why } : {}),
        ...(cfg.denies ? { denies: true } : {}),
        ...(cfg.lasting ? { lasting: true } : {}),
        outcome: cfg.outcome,
        observed_at: Number.isFinite(at) ? at : Date.now(),
        // The run that found it: with the claim's Concept, what finds the history commit that fixed it.
        ...(ctx?.runId ? { dream: ctx.runId } : {}),
        namespace,
        ...(by ? { created_by: by } : {}),
      });
    } catch (e) {
      return errText("dream/claim", e);
    }
  },
});
