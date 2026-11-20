import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { requireKnowledge } from "./_shared.js";

export default defineStep({
  type: "knowledge/page",
  effect: "read",
  description:
    "One Concept as whoever TENDS the tree reads it, by its exact name: { ref_id, name, description, docs, parents, children: [{ name, description, has_claims }], " +
    "claims: [{ id, text, status, speaker, latest }] }. `description` is the one line an agent sees BEFORE it opens the page, in its parent's list; `docs` is what it reads once it has. " +
    "`claims` are the sentences this page's readers must hold to, each with what the evidence says: supported, refuted, stale (the page changed since it was last checked) or unknown. " +
    "Reading a page this way is not opening it: work that follows a page opens it with graph_graph_get, and is checked against its claims. " +
    "A string when there is no Concept of that name. `text: true` adds the same page as one block of text, for a prompt.",
  input: z.object({
    name: z.string().describe('The Concept\'s exact name, e.g. "Personal".'),
    text: z.boolean().optional().default(false).describe("Also return the page as one block of text (`text`), for a workflow that puts it in a prompt."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const page = await requireKnowledge(ctx, "knowledge/page").page(cfg.name);
    if (!page) return `no Concept named "${cfg.name}": names are exact, as a parent's page lists them`;
    if (!cfg.text) return page;
    const { renderKnowledgePage } = await import("../../../knowledge.js");
    return { ...page, text: renderKnowledgePage(page) };
  },
});
