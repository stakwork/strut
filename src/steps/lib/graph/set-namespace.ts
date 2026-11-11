import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, errText } from "./_shared.js";
import { stepFailed } from "../../../public-call.js";

/**
 * Move a node or an edge to another namespace — `shared`, so every reader
 * listed for it sees it, or back to `private` (plans/graph-memory-plan.md
 * step 6). It is the person's act: it runs only as a proposal a person
 * accepted (`ctx.proposal`), never as a direct tool call, a DAG step,
 * `meta/run-step` or a subflow. A host that wants the assistant to offer it
 * lists it in that agent's `approve:`. Moving a node doesn't move its edges.
 */
export default defineStep({
  type: "graph/set-namespace",
  description:
    "Move one node (or edge) to another namespace: `shared` to let every reader of shared data see it, `private` to take it back. " +
    "Moving a node does not move its edges. It runs only on the person's yes: where this strut server gates it, the call becomes a proposal " +
    "applied when they accept it; where it does not, it is refused and you tell the person to move it themselves. " +
    "To create something straight into `shared`, pass `namespace: shared` to the create step instead. Returns { kind, ref_id, from, namespace, moved }.",
  input: z.object({
    ref_id: z.string().min(1).describe("The node's (or edge's) ref_id."),
    namespace: z.string().min(1).describe("Where it goes, e.g. 'shared' or 'private'."),
    kind: z.enum(["node", "edge"]).optional().default("node").describe("node (default) or edge."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    if (!ctx.proposal) {
      throw new Error(
        "graph/set-namespace runs only as a proposal a person accepted, and this strut server grants it ungated. " +
          "A host that wants the assistant to offer it lists it in that agent's approve:.",
      );
    }
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
      // The proposer's reader must see what it moves: a hidden node is not there.
      const seen = cfg.kind === "node" ? await b.reader.getNode(cfg.ref_id) : true;
      if (!seen) return stepFailed(`graph/set-namespace failed — NOT_FOUND: no node ${cfg.ref_id}`);
      const { setNamespace } = await import("../../../graph/set-namespace.js");
      return await setNamespace(b, { kind: cfg.kind ?? "node", ref_id: cfg.ref_id, namespace: cfg.namespace });
    } catch (e) {
      return errText("graph/set-namespace", e);
    }
  },
});
