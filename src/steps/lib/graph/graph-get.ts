import { z } from "zod";
import { defineStep, type StepContext, withAccessedNodes } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, errText, deriveNodeName } from "./_shared.js";

/** Collapse connection-count rows into a compact {EDGE_TYPE: total} map. */
function collapseConnectionCounts(
  counts: Array<{ edge_type: string; target_type?: string; count: number }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of counts ?? []) {
    if (!c?.edge_type) continue;
    out[c.edge_type] = (out[c.edge_type] ?? 0) + Number(c.count ?? 0);
  }
  return out;
}

export default defineStep({
  type: "graph/graph-get",
  description:
    "Resolve a single node in the strut knowledge graph to its full content by ref_id. " +
    "Use the ref_id from graph_graph_search or graph_graph_neighbors results. " +
    "When you know a node's NAME instead, pass node_type + name (e.g. node_type \"Concept\", " +
    "name \"Janitor\"): an exact lookup by the node's key, never a search — for types keyed by name. " +
    "Returns the node's ref_id, node_type, derived name, properties, and an " +
    "`edges` map ({EDGE_TYPE: count}) showing how connected the node is and " +
    "which relationship types you can traverse next with graph_graph_neighbors. " +
    "To resolve several ref_ids at once, use graph_graph_get_batched instead.",
  input: z.object({
    ref_id: z.string().optional().describe("The ref_id of the node to resolve. Omit to look the node up by node_type + name."),
    node_type: z.string().optional().describe('With `name`: the node\'s type, e.g. "Concept".'),
    name: z.string().optional().describe("With `node_type`: the node's exact name (case, spaces and punctuation are ignored, as in its key)."),
    namespace: z
      .string()
      .optional()
      .describe(
        "Scope edge-count computation to a namespace (data partition). With node_type + name it is also where the node is looked up (default: the deployment's).",
      ),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
      let raw;
      if (cfg.ref_id) {
        raw = await b.reader.getNode(cfg.ref_id);
        if (!raw) return `node not found: ${cfg.ref_id}`;
      } else {
        if (!cfg.node_type || !cfg.name) return "graph/graph-get failed: pass ref_id, or node_type + name";
        const schema = await b.schemas.schema(cfg.node_type);
        if (!schema) return `graph/graph-get failed: unknown node type "${cfg.node_type}"`;
        const keyed = schema.node_key.split("-").slice(1);
        if (keyed.length !== 1 || keyed[0]!.toLowerCase() !== "name") {
          return `graph/graph-get failed: ${schema.type} is keyed by ${keyed.join(" + ") || "nothing"}, not name — pass its ref_id (graph_graph_search finds it)`;
        }
        const { composeNodeKey } = await import("../../../graph/node-writer.js");
        raw = await b.reader.getNodeByKey(schema.type, composeNodeKey(schema, { name: cfg.name }), cfg.namespace);
        if (!raw) return `node not found: ${schema.type} "${cfg.name}"`;
      }
      const properties = (raw.properties ?? {}) as Record<string, any>;
      // Edge-type connectivity. Best effort — never fail the whole call.
      let edges: Record<string, number> = {};
      try {
        edges = collapseConnectionCounts(await b.reader.connectionCounts(raw.ref_id, cfg.namespace));
      } catch {
        // edges stays {}
      }
      return withAccessedNodes(
        {
          ref_id: raw.ref_id,
          node_type: raw.node_type,
          name: deriveNodeName(raw, properties),
          properties: raw.properties,
          edges,
        },
        [{ ref_id: raw.ref_id, node_type: raw.node_type }],
      );
    } catch (e) {
      return errText("graph/graph-get", e);
    }
  },
});
