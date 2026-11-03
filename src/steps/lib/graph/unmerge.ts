import { z } from "zod";
import { defineStep, type StepContext, withAccessedNodes } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, errText, describeNodes } from "./_shared.js";

export default defineStep({
  type: "graph/unmerge",
  description:
    "Undo a graph/merge by its `merge` id (a LadybugDB graph only): the duplicate is back with its own edges, and the kept node loses what " +
    "the merge gave it. Refused, saying why, when something written since would be lost: an edge the merge moved or changed was edited or " +
    "superseded, the kept node's alt_names changed, or a later merge took the kept node in (undo that one first).",
  input: z.object({
    merge: z.string().min(1).describe("The `merge` id graph/merge returned."),
    created_by: z.string().optional().describe("Who is undoing it; stamped by the runner on an agent's call."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
      const { unmergeNodes } = await import("../../../graph/merge.js");
      const by = cfg.created_by ?? ctx?.actor;
      const r = await unmergeNodes(b, { merge: cfg.merge, ...(by ? { by } : {}) });
      return withAccessedNodes({ status: "Success", ...r, removed: r.removed.length }, await describeNodes(b, [r.kept, r.restored]));
    } catch (e) {
      return errText("graph/unmerge", e);
    }
  },
});
