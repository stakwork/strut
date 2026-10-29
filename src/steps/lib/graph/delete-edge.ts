import { z } from "zod";
import { defineStep, type StepContext, withAccessedNodes } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, errText, describeNodes } from "./_shared.js";

const EXAMPLE = `- id: unlink
  type: graph/delete-edge
  config:
    source_ref_id: "{{ input.parent }}"
    edge_type: PARENT_OF
    target_ref_id: "{{ input.concept }}"`;

export default defineStep({
  type: "graph/delete-edge",
  description:
    "Delete ONE edge from the strut knowledge graph (writes live to the graph; the edge is removed for good, never " +
    "hidden — both nodes stay). Locate it by `edge_ref_id` (from create-triplet's output) OR by the triple " +
    "`source_ref_id` + `edge_type` + `target_ref_id`, as graph/edit-edge does. Several edges of that type between " +
    "the two nodes is refused — pass the edge ref_id. To re-home a node under a different parent use graph/move-node " +
    "instead, which deletes and re-creates the placing edge in one transaction.\n\n" +
    EXAMPLE,
  input: z.object({
    edge_ref_id: z.string().optional().describe("ref_id of the edge (create-triplet returns it as edge_ref_id). Preferred when you have it."),
    source_ref_id: z.string().optional().describe("With edge_type + target_ref_id: locate the edge by its endpoints instead of edge_ref_id."),
    edge_type: z.string().optional().describe("The relationship type, e.g. 'PARENT_OF' (uppercased). Required when locating by endpoints."),
    target_ref_id: z.string().optional().describe("Target node ref_id, when locating by endpoints."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const byRef = Boolean(cfg.edge_ref_id);
    const byTriple = Boolean(cfg.source_ref_id || cfg.edge_type || cfg.target_ref_id);
    if (!byRef && !byTriple) return "graph/delete-edge invalid input — pass edge_ref_id, or source_ref_id + edge_type + target_ref_id";
    if (byRef && byTriple) return "graph/delete-edge invalid input — pass EITHER edge_ref_id OR the source_ref_id/edge_type/target_ref_id triple, not both";
    if (byTriple && !(cfg.source_ref_id && cfg.edge_type && cfg.target_ref_id)) {
      return "graph/delete-edge invalid input — locating by endpoints needs all of source_ref_id, edge_type and target_ref_id";
    }
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
      const r = await b.edges.delete(
        byRef ? { ref_id: cfg.edge_ref_id! } : { edge: cfg.edge_type!, source_ref_id: cfg.source_ref_id!, target_ref_id: cfg.target_ref_id! },
      );
      if (!r) return `graph/delete-edge failed — NOT_FOUND: no edge with ref_id ${cfg.edge_ref_id}`;
      return withAccessedNodes(
        {
          status: "Success",
          edge_ref_id: r.ref_id,
          edge_type: r.edge,
          source_ref_id: r.source_ref_id,
          target_ref_id: r.target_ref_id,
        },
        // Provenance: both endpoints (the edge itself is not a node, and is gone).
        await describeNodes(b, [r.source_ref_id, r.target_ref_id]),
      );
    } catch (e) {
      return errText("graph/delete-edge", e, ctx);
    }
  },
});
