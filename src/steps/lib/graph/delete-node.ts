import { z } from "zod";
import type { CardField } from "../../../core.js";
import { defineStep, type StepContext, withAccessedNodes } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, errText, describeNodes, namesOf } from "./_shared.js";

const EXAMPLE = `- id: retire
  type: graph/delete-node
  config:
    ref_id: "{{ input.concept }}"`;

export default defineStep({
  type: "graph/delete-node",
  description:
    "Delete a node from the knowledge graph (writes live to the graph). Any node type. The node is soft-deleted " +
    "— hidden from every read, restored in place by a later create of the same identity — and EVERY edge it had in " +
    "the namespace is deleted for good, so whatever hung under it is cut loose (its children stay, parentless). " +
    "Read the node first (graph/graph-get with its `edges` counts, graph/graph-neighbors) and be sure: a delete is " +
    "the write with the least room for a mistake. To detach one link keep the node and use graph/delete-edge; to " +
    "re-home it use graph/move-node. The user (the Person marked is_owner) is never deleted: delete or end their edges instead. " +
    "To record that a fact stopped being true, end it with graph/assert (`ended` or `invalid_at`) instead of deleting anything.\n\n" +
    EXAMPLE,
  input: z.object({
    ref_id: z.string().describe("The ref_id of the node to delete (from graph_graph_search/graph_graph_get)."),
    namespace: z
      .string()
      .optional()
      .describe("Namespace (data partition) the node lives in — must be registered. Not an access-control boundary."),
    reason: z.string().optional().describe("Why, in a few words ('the user asked', 'wrong person'): kept on the deleted node."),
  }),
  output: z.any(),
  async describe(cfg, ctx) {
    const name = (await namesOf(ctx, [cfg.ref_id])).get(cfg.ref_id) ?? cfg.ref_id;
    return {
      title: `Delete node ${name}`,
      fields: [{ label: "Node", value: name, kind: "ref", danger: true }, { label: "Edges", value: "Every edge it has is deleted too", danger: true }],
      actions: { accept: "Delete", reject: "Keep" },
    };
  },
  async run(cfg, ctx) {
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
      // Described BEFORE the delete: a deleted node is hidden from every read.
      const [node] = await describeNodes(b, [cfg.ref_id]);
      if (!node?.node_type) return `graph/delete-node failed — NOT_FOUND: no live node with ref_id ${cfg.ref_id}`;
      if ((await b.reader.getNode(cfg.ref_id))?.properties["is_owner"] === true) {
        return "graph/delete-node failed — REFUSED: this is the user (is_owner), who is never deleted; delete or end their edges instead";
      }
      const namespace = await b.reader.resolveNamespace(cfg.namespace);
      const r = await b.nodes.deleteNode(cfg.ref_id, { namespace, ...(cfg.reason ? { reason: cfg.reason } : {}) });
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
      return errText("graph/delete-node", e);
    }
  },
});
