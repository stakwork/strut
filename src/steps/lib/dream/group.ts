import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { errText } from "../graph/_shared.js";
import { claimGraph, writerOf } from "./_graph.js";

export default defineStep({
  type: "dream/group",
  effect: "write",
  description:
    "Put claims of one kind under a PARENT claim (plans/dream.md): \"Add nothing unrequested\" and \"One example is not a template\" under \"Build only what was asked\". " +
    "`text` is the sentence they have in common (or `parent`, an existing group's id, to add to one), and `about` the ref_id of the Concept a new group belongs on (default: its first claim's). The parent is made the first time and holds no evidence: " +
    "its counts in dream/claims are its children's. One level only: a claim is in one group, and a group is not grouped. " +
    "Group when two or more claims say the same thing about different cases, so the page gets one general line and not a line for each. It changes no page.",
  input: z.object({
    text: z.string().optional().describe("A new group: one sentence its claims have in common."),
    parent: z.string().optional().describe("An existing group's id to put the claims under, in place of `text`."),
    title: z.string().optional().describe("A short name for it (a few words). Default: the sentence."),
    about: z.string().optional().describe("The ref_id of the Concept a new group belongs on. Default: its first claim's."),
    claims: z.array(z.string()).min(1).describe("The ids of the claims to put under it."),
    created_by: z.string().optional(),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    try {
      const { g, namespace, readable } = await claimGraph(ctx);
      if (!readable) return "dream/group failed — REFUSED: this caller may not read the namespace claims are kept in";
      const by = writerOf(ctx, cfg.created_by);
      const { groupClaims } = await import("../../../graph/concept-claims.js");
      return await groupClaims(g, {
        ...(cfg.text ? { text: cfg.text } : {}), ...(cfg.parent ? { parent: cfg.parent } : {}), ...(cfg.title ? { title: cfg.title } : {}), ...(cfg.about ? { about: cfg.about } : {}),
        claims: cfg.claims, at: Date.now(), namespace, ...(by ? { created_by: by } : {}),
      });
    } catch (e) {
      return errText("dream/group", e);
    }
  },
});
