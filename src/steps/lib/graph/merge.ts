import { z } from "zod";
import { defineStep, type StepContext, withAccessedNodes } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, errText, describeNodes } from "./_shared.js";

export default defineStep({
  type: "graph/merge",
  description:
    "Merge two nodes that are the SAME thing (writes live to the graph; a LadybugDB graph only). The duplicate's edges move to the node kept, " +
    "its name and alt_names become the kept node's alt_names, and its ref_id keeps leading to the kept node. A fact both held is re-confirmed; " +
    "on a one-value edge type (e.g. LIVES_IN) the newest value stays current and the rest are superseded. Nothing is deleted, and " +
    "graph/unmerge undoes it with the returned `merge` id. Both nodes must be of one type, in one namespace. The user is never the duplicate: " +
    "merge another Person into the user, not the other way. Read both with graph/graph-get before merging; two people can share a name.",
  input: z.object({
    keep: z.string().min(1).describe("The ref_id of the node to keep."),
    duplicate: z.string().min(1).describe("The ref_id of the node that is the same thing."),
    created_by: z.string().optional().describe("Who is merging; stamped by the runner on an agent's call."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
      const { mergeNodes } = await import("../../../graph/merge.js");
      const by = cfg.created_by ?? ctx?.actor;
      const r = await mergeNodes(b, { keep: cfg.keep, duplicate: cfg.duplicate, ...(by ? { by } : {}) });
      return withAccessedNodes(
        {
          status: "Success",
          merge: r.merge,
          kept: r.kept,
          merged: r.merged,
          moved: r.moved.length,
          ...(r.reconfirmed.length ? { reconfirmed: r.reconfirmed.length } : {}),
          ...(r.superseded.length ? { superseded: r.superseded } : {}),
          ...(r.skipped.length ? { skipped: r.skipped } : {}),
          alt_names: r.alt_names,
          ...(r.notes ? { notes: r.notes } : {}),
        },
        await describeNodes(b, [cfg.keep]),
      );
    } catch (e) {
      return errText("graph/merge", e);
    }
  },
});
