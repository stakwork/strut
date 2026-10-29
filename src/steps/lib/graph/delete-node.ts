import { z } from "zod";
import { defineStep, type StepContext, withAccessedNodes } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, errText, describeNodes } from "./_shared.js";

const EXAMPLE = `- id: retire
  type: graph/delete-node
  config:
    ref_id: "{{ input.concept }}"`;

export default defineStep({
  type: "graph/delete-node",
  description:
    "Delete a node from the strut knowledge graph (writes live to the graph). Any node type. The node is soft-deleted " +
    "— hidden from every read, restored in place by a later create of the same identity — and EVERY edge it had in " +
    "the namespace is deleted for good, so whatever hung under it is cut loose (its children stay, parentless). " +
    "Read the node first (graph/graph-get with its `edges` counts, graph/graph-neighbors) and be sure: a delete is " +
    "the write with the least room for a mistake. To detach one link keep the node and use graph/delete-edge; to " +
    "re-home it use graph/move-node.\n\n" +
    EXAMPLE,
  input: z.object({
    ref_id: z.string().describe("The ref_id of the node to delete (from graph_graph_search/graph_graph_get)."),
    namespace: z
      .string()
      .optional()
      .describe("Namespace (data partition) the node lives in — must be registered. Not an access-control boundary."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
      // Described BEFORE the delete: a deleted node is hidden from every read.
      const [node] = await describeNodes(b, [cfg.ref_id]);
      if (!node?.node_type) return `graph/delete-node failed — NOT_FOUND: no live node with ref_id ${cfg.ref_id}`;
      const namespace = await b.reader.resolveNamespace(cfg.namespace);
      const r = await b.nodes.deleteNode(cfg.ref_id, { namespace });
      if (!r) return `graph/delete-node failed — NOT_FOUND: no node with ref_id ${cfg.ref_id} in namespace ${namespace}`;
      return withAccessedNodes(
        {
          status: "Success",
          ref_id: cfg.ref_id,
          node_type: node.node_type,
          name: node.name ?? "",
          deleted_edges: r.edges,
        },
        // Provenance: the node the caller named, as it was.
        [node],
      );
    } catch (e) {
      return errText("graph/delete-node", e, ctx);
    }
  },
});
