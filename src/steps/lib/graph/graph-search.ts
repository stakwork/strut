import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { getStrutSchema } from "../../../graph/strut-schemas.js";
import { graphCtx, errText } from "./_shared.js";
const splitList = (s?: string) => s?.split(",").map((x) => x.trim()).filter(Boolean);

/** A node's human label: the Strut schema's title_key when it is a Strut type,
 *  else the same candidate chain the jarvis/* step uses. */
function nameOf(nodeType: string | undefined, p: Record<string, any>): string | undefined {
  const strut = nodeType ? getStrutSchema(nodeType) : undefined;
  if (strut && typeof p[strut.title_key] === "string") return p[strut.title_key];
  return p.name ?? p.workflow_name ?? p.episode_title ?? p.entity;
}

function descriptionOf(nodeType: string | undefined, p: Record<string, any>): string {
  const strut = nodeType ? getStrutSchema(nodeType) : undefined;
  if (strut && typeof p[strut.description_key] === "string" && strut.description_key !== strut.title_key) return p[strut.description_key];
  return p.description ?? p.summary ?? p.text ?? "";
}

export default defineStep({
  type: "graph/graph-search",
  description:
    "Search the knowledge graph for nodes of any type it holds — what this deployment ingested (on a swarm: the code parsed from its repositories — File, Function, Endpoint, … with written descriptions — plus documents, concepts, tasks, …) and strut's own workflows, steps, runs and chats. " +
    "Narrow with `type` to find one kind (e.g. 'Function,File,Endpoint' for code). " +
    "Leave test or mock code out by path with `exclude`. " +
    "Keep only results tied to a kind of node by an edge with `linked`. " +
    "Provide at least one of `q`, `input_q`, `output_q` — they can be combined, each acting as its own " +
    "retriever fused into one ranked result set. " +
    "Each result includes an `edges` map ({EDGE_TYPE: count}) showing how connected the node is and " +
    "which relationship types you can traverse next with graph_graph_neighbors. " +
    "A code result also carries where it lives — `file`, and its lines `start` and `end`, counted from 0 as the parser counts them (add 1 for the line number an editor shows) — so you can open it. " +
    "Call graph_get_ontology first to discover valid values for the `type` parameter.",
  input: z.object({
    q: z
      .string()
      .optional()
      .describe(
        "General hybrid (keyword + semantic) search query over node names, descriptions, summaries, and schemas. " +
          "Ask in plain words to search by meaning; put an exact string (an error message, a header name, a config key) in double quotes to match it as written.",
      ),
    input_q: z
      .string()
      .optional()
      .describe(
        "Semantic search scoped to node INPUT schemas — find nodes by what they take as input, " +
        "e.g. 'a video file url'. Applies to node types with input embeddings (StrutWorkflowVersion, StrutStep).",
      ),
    output_q: z
      .string()
      .optional()
      .describe(
        "Semantic search scoped to node OUTPUT schemas — find nodes by what they produce, " +
        "e.g. 'transcript with word-level timestamps'. Applies to node types with output embeddings (StrutWorkflowVersion, StrutStep).",
      ),
    type: z
      .string()
      .optional()
      .describe("Comma-separated node type filter, e.g. 'StrutWorkflow' or 'StrutRun,StrutChat'. Call graph_get_ontology to see all valid values."),
    exclude: z
      .string()
      .optional()
      .describe(
        "Path parts to leave out, comma-separated: a directory name (`__tests__`, `test`, `mock`) or several (`src/app/api/mock`) matches whole segments of a result's `file`; " +
          "a pattern with `*` (`*.test.ts`, `*_test.go`) matches the file name. " +
          "For a question about how the code works, leaving test code out is usually right — `__tests__,test,tests,spec,*.test.*,*.spec.*` — " +
          "and add a repository's own mock or fixture directories once you see them in results. Results with no `file` are never left out.",
      ),
    linked: z
      .string()
      .optional()
      .describe(
        "Keep only results with an edge of a type to a node of a type: `EDGE>Type` for an edge from the result (`MODIFIES>File` — a Concept that summarizes code files), " +
          "`EDGE<Type` for one into it (`TOUCHES<PullRequest`). Comma-separated: a result passes with any of them. " +
          "Each result's `edges` map shows the edge types a node has.",
      ),
    limit: z.number().optional().default(10).describe("Maximum number of results to return"),
    domains: z
      .string()
      .optional()
      .describe("Comma-separated domain filter, e.g. 'strut' or 'strut,entity'. Not required. Call graph_get_ontology to see valid domains."),
    namespace: z
      .string()
      .optional()
      .describe("Scope the search to a namespace (data partition). Not an access-control boundary."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    if (!cfg.q && !cfg.input_q && !cfg.output_q) {
      return "graph/graph-search requires at least one of: q, input_q, output_q";
    }
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
      const res = await b.reader.search({
        q: cfg.q,
        input_q: cfg.input_q,
        output_q: cfg.output_q,
        types: splitList(cfg.type),
        domains: splitList(cfg.domains),
        exclude: splitList(cfg.exclude),
        linked: splitList(cfg.linked),
        namespace: cfg.namespace,
        limit: cfg.limit ?? 10,
        // Per-node {EDGE_TYPE: count} map inline, so connectivity + hop
        // targets come back in one call.
        include_edge_counts: true,
      });
      const hits = res.nodes.map((n) => {
        const p = (n.properties ?? {}) as Record<string, any>;
        return {
          ref_id: n.ref_id,
          name: nameOf(n.node_type, p),
          node_type: n.node_type,
          description: descriptionOf(n.node_type, p),
          // {EDGE_TYPE: count} map of this node's relationships.
          edges: (n.edges ?? {}) as Record<string, number>,
          // Where a code node lives, as the graph holds it (graph-get returns
          // the same; stakgraph's lines count from 0): a hit named `GET` is
          // something a caller can open.
          ...(p.file !== undefined ? { file: p.file } : {}),
          ...(p.start !== undefined ? { start: p.start } : {}),
          ...(p.end !== undefined ? { end: p.end } : {}),
          ...(p.workflow_id !== undefined ? { workflow_id: p.workflow_id } : {}),
          ...(p.skill_id !== undefined ? { skill_id: p.skill_id } : {}),
        };
      });
      // No provenance marker: a hit is a node the caller was SHOWN, not one
      // it chose to read (`withAccessedNodes`).
      return hits;
    } catch (e) {
      return errText("graph/graph-search", e, ctx);
    }
  },
});
