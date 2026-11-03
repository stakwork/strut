import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import type { EdgeLink } from "../../../graph/search.js";
import { graphCtx, errText, deriveNodeName } from "./_shared.js";

/** The most nodes one call names, and the most it may draw edges to. */
export const EDGES_MAX_IDS = 1000;
export const EDGES_MAX_AMONG = 5000;
/** How far up the lineage a call climbs. */
export const EDGES_MAX_DEPTH = 10;

/**
 * The edges among nodes a view already has, in one call (a run graph's
 * edges and lineage): what one `graph/graph-neighbors` per node, and
 * another per ancestor, used to read — 240 calls for a large run — as one
 * query for the edges and one per level of lineage.
 */
export default defineStep({
  type: "graph/graph-edges",
  effect: "read",
  description:
    "The edges among a set of nodes, in one call: every live edge between two of `ref_ids` — or one of them and one of `among` — " +
    "with its type and direction; and with `lineage` (an edge type, e.g. \"PARENT_OF\") the nodes above them along it, climbed up to " +
    "`depth` levels (default 10), each with its type and name, and the edges that lead to them. " +
    "For drawing the graph around nodes you already hold (a run's, a search's); to explore out from one node use graph/graph-neighbors.",
  input: z.object({
    ref_ids: z.array(z.string()).min(1).max(EDGES_MAX_IDS).describe(`The nodes whose edges to read, up to ${EDGES_MAX_IDS}.`),
    among: z
      .array(z.string())
      .max(EDGES_MAX_AMONG)
      .optional()
      .describe(`Other nodes an edge may lead to, besides \`ref_ids\` (up to ${EDGES_MAX_AMONG}): what the view already shows.`),
    lineage: z.string().optional().describe('An edge type to climb from `ref_ids` to the nodes above them, e.g. "PARENT_OF".'),
    depth: z.number().int().min(1).max(EDGES_MAX_DEPTH).optional().describe(`How many levels of lineage to climb (default ${EDGES_MAX_DEPTH}).`),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
      const among = cfg.among ?? [];
      const { edges, truncated } = await b.reader.edgesAmong(cfg.ref_ids, among);
      const ancestors: Array<{ ref_id: string; node_type: string; name: string }> = [];
      const lineage: EdgeLink[] = [];
      if (cfg.lineage) {
        // Level by level: each level's parents in one query, a node met before never climbed again.
        const known = new Set([...cfg.ref_ids, ...among]);
        let level = cfg.ref_ids;
        for (let d = 0; d < (cfg.depth ?? EDGES_MAX_DEPTH) && level.length; d++) {
          const next: string[] = [];
          for (const { target, node } of await b.reader.incoming(level, cfg.lineage)) {
            lineage.push({ source: node.ref_id, target, edge_type: cfg.lineage });
            if (known.has(node.ref_id)) continue;
            known.add(node.ref_id);
            ancestors.push({ ref_id: node.ref_id, node_type: node.node_type ?? "unknown", name: deriveNodeName(node, (node.properties ?? {}) as Record<string, any>) });
            next.push(node.ref_id);
          }
          level = next;
        }
      }
      const seen = new Set<string>();
      const all: EdgeLink[] = [];
      for (const e of [...edges, ...lineage]) {
        const key = `${e.source}|${e.edge_type}|${e.target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(e);
      }
      return { edges: all, ancestors, truncated };
    } catch (e) {
      return errText("graph/graph-edges", e);
    }
  },
});
