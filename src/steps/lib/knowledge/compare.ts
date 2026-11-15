import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { requireKnowledge } from "./_shared.js";

export default defineStep({
  type: "knowledge/compare",
  effect: "read",
  description:
    "Main against a Concept BRANCH over the same claims (plans/concept-evals.md item d): did the candidate tree do better on the measure? " +
    "For one page (`concept`), a tree (`tree`: its root's name, the root and every page under it on main) or every page that carries claims: " +
    "{ branch, claims: [{ concept, id, text, changed, main, branch, outcome }], totals }. Each side is { version, status, supports, refutes, works }: the claim's status there, " +
    "the verdicts on that side's CURRENT page (one per check per work run there), and the works judged there, newest first. " +
    "`changed`: the branch's page reads otherwise than main's. `outcome`: better | worse | same by the share of supporting verdicts on each side's current page, `unmeasured` while a side has none. " +
    "`totals` counts the outcomes and each side's verdicts.",
  input: z.object({
    branch: z.string().describe("The Concept branch, by name (GET /branches lists them)."),
    concept: z.string().optional().describe("One Concept, by its exact name."),
    tree: z.string().optional().describe("A tree, by its root's exact name."),
    works: z.number().int().min(1).max(50).optional().describe("The most works listed on each side of a claim (default 10)."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const knowledge = requireKnowledge(ctx, "knowledge/compare");
    if (!knowledge.compare) throw new Error("knowledge/compare: this server's Knowledge door has no compare read");
    return knowledge.compare({
      branch: cfg.branch,
      ...(cfg.concept ? { concept: cfg.concept } : {}),
      ...(cfg.tree ? { tree: cfg.tree } : {}),
      ...(cfg.works ? { works: cfg.works } : {}),
    });
  },
});
