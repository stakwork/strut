import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { errText } from "../graph/_shared.js";
import { claimGraph } from "./_graph.js";

export default defineStep({
  type: "dream/tree",
  effect: "read",
  description:
    "A tree of Concept pages as it stands (plans/dream.md): { root, pages: [{ ref_id, name, description?, docs?, parent?, depth }] }, the root first, " +
    "each page once under its first parent, siblings by name. `parent` is the ref_id of the page it hangs under. A long page's `docs` is cut. " +
    "The dream keeps one before it works and one after: what it added, changed or moved is the difference between the two.",
  input: z.object({ root: z.string().optional().default("Personal").describe("The tree: its root Concept's name.") }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    try {
      const { g, namespace, readable } = await claimGraph(ctx);
      if (!readable) return { root: cfg.root, pages: [] };
      const { treePages } = await import("../../../graph/concept-claims.js");
      return { root: cfg.root, pages: await treePages(g, namespace, cfg.root) };
    } catch (e) {
      return errText("dream/tree", e);
    }
  },
});
