import { z } from "zod";
import { defineStep, type StepContext, withAccessedNodes } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, errText, describeNodes } from "./_shared.js";
import { stepFailed } from "../../../public-call.js";

export default defineStep({
  type: "graph/restore-node",
  description:
    "Bring back a node graph/delete-node deleted (a LadybugDB graph only, where a delete hides and never erases): the node shows " +
    "again with every edge and fact it had. Find its ref_id with `include_deleted` on graph/graph-search or graph/graph-get. " +
    "A node a merge deleted is refused: undo the merge with graph/unmerge.",
  graphNotes: { ladybugOnly: true },
  input: z.object({
    ref_id: z.string().describe("The ref_id of the deleted node."),
    namespace: z.string().optional().describe("Namespace (data partition) the node lives in. Default: the deployment's."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
      const namespace = await b.reader.resolveNamespace(cfg.namespace);
      const r = await b.nodes.restoreNode(cfg.ref_id, { namespace });
      if (r === null) return stepFailed(`graph/restore-node failed — NOT_FOUND: no node with ref_id ${cfg.ref_id} in namespace ${namespace}`);
      if (r === "live") return stepFailed(`graph/restore-node failed — NOT_DELETED: ${cfg.ref_id} is not deleted`);
      if (typeof r === "object") return stepFailed(`graph/restore-node failed — REFUSED: ${cfg.ref_id} was merged into ${r.merged}; undo the merge with graph/unmerge`);
      const [node] = await describeNodes(b, [cfg.ref_id]);
      return withAccessedNodes({ status: "Success", ref_id: cfg.ref_id, node_type: node?.node_type, name: node?.name ?? "" }, node ? [node] : []);
    } catch (e) {
      return errText("graph/restore-node", e);
    }
  },
});
