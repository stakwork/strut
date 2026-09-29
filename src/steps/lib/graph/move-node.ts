import { z } from "zod";
import { defineStep, type StepContext, withAccessedNodes } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, errText } from "./_shared.js";

const EXAMPLE = `- id: rehome
  type: graph/move-node
  config:
    ref_id: "{{ input.concept }}"
    edge_type: PARENT_OF
    direction: reverse          # (parent)-[PARENT_OF]->(concept)
    to_ref_id: "{{ input.new_parent }}"`;

export default defineStep({
  type: "graph/move-node",
  description:
    "Move a node in the strut knowledge graph to hang under a different node (writes live to the graph): the ONE edge " +
    "that ties it to where it is now is re-pointed at `to_ref_id`. Any edge type, either direction — pass the current " +
    "link as graph/graph-neighbors reports it from the moved node's side: `edge_type`, and `direction` 'reverse' when the " +
    "edge points AT the node ((parent)-[PARENT_OF]->(node), (folder)-[CONTAINS]->(node)) or 'forward' when it points OUT " +
    "of it ((node)-[CHILD_OF]->(parent)). `from_ref_id` (the current one) is needed only when the node has several live " +
    "edges of that type that way. The old edge is muted (kept as history, no longer read) and a new one is written the " +
    "same way round, carrying the old edge's properties — the new triple must be valid like any graph/create-triplet. " +
    "Everything hanging under the node moves with it; no other edge changes. Refused when `to_ref_id` hangs under the " +
    "node along that edge (a cycle). Status 'Warning' when it already hangs there (nothing written).\n\n" +
    EXAMPLE,
  input: z.object({
    ref_id: z.string().describe("The ref_id of the node to move (from graph_graph_search/graph_graph_get)."),
    edge_type: z.string().describe("The edge that places it, e.g. 'PARENT_OF', 'CONTAINS', 'CHILD_OF' (uppercased)."),
    direction: z
      .enum(["forward", "reverse"])
      .describe(
        "Which way that edge points, from the moved node's side (graph_graph_neighbors' `direction`): " +
          "'reverse' = (from)-[EDGE]->(node), 'forward' = (node)-[EDGE]->(from).",
      ),
    from_ref_id: z
      .string()
      .optional()
      .describe("Where it hangs now. Needed only when it has more than one live edge of this type in this direction."),
    to_ref_id: z.string().describe("Where it should hang instead."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
      const r = await b.edges.move({
        ref_id: cfg.ref_id,
        edge: cfg.edge_type,
        direction: cfg.direction,
        from_ref_id: cfg.from_ref_id,
        to_ref_id: cfg.to_ref_id,
      });
      return withAccessedNodes(
        {
          status: r.moved ? "Success" : "Warning",
          ref_id: r.ref_id,
          edge_type: cfg.edge_type.toUpperCase().replace(/ /g, "_"),
          direction: cfg.direction,
          from_ref_id: r.from_ref_id,
          to_ref_id: r.to_ref_id,
          edge_ref_id: r.edge_ref_id,
          ...(r.moved ? { previous_edge_ref_id: r.previous_edge_ref_id } : { messages: ["Already hangs there — nothing moved"] }),
        },
        // Provenance: the node and both places.
        [{ ref_id: r.ref_id }, { ref_id: r.from_ref_id }, ...(r.moved ? [{ ref_id: r.to_ref_id }] : [])],
      );
    } catch (e) {
      return errText("graph/move-node", e);
    }
  },
});
