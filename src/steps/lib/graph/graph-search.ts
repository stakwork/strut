import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { getStrutSchema } from "../../../graph/strut-schemas.js";
import { nodeTitle } from "../../../graph/title.js";
import type { FactEnvelope } from "../../../graph/search.js";
import { graphCtx, errText, excludeDomainsInput, isoDates, timeInputs } from "./_shared.js";
const splitList = (s?: string) => s?.split(",").map((x) => x.trim()).filter(Boolean);

/** A node's human label: its title (the Strut schema's title_key when it is
 *  a Strut type, else `name`, else the stored one), else the same candidate chain the
 *  jarvis/* step uses. */
function nameOf(nodeType: string | undefined, p: Record<string, any>): string | undefined {
  const strut = nodeType ? getStrutSchema(nodeType) : undefined;
  return nodeTitle(p, strut?.title_key) || (p.name ?? p.workflow_name ?? p.episode_title ?? p.entity);
}

function descriptionOf(nodeType: string | undefined, p: Record<string, any>): string {
  const strut = nodeType ? getStrutSchema(nodeType) : undefined;
  if (strut && typeof p[strut.description_key] === "string" && strut.description_key !== strut.title_key) return p[strut.description_key];
  return p.description ?? p.summary ?? p.text ?? "";
}

/** A fact as the caller reads it: its dates as ISO. */
function factOut(f: FactEnvelope) {
  return {
    ref_id: f.ref_id,
    edge_type: f.edge_type,
    text: f.text,
    source: f.source,
    target: f.target,
    ...isoDates({ ...f }),
    ...(f.superseded_by ? { superseded_by: f.superseded_by } : {}),
    sources: f.sources,
    ...(f.namespace ? { namespace: f.namespace } : {}),
    score: f.score,
  };
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
    "Call graph_get_ontology first to discover valid values for the `type` parameter. " +
    "Pass `facts: true` when you are looking for what is true about someone or something (where a person works, lives, who they know): " +
    "the search then also finds facts — sentences on edges, \"Tom works at Stakwork\" — and returns `{ nodes, facts }`, each fact with its sentence, both ends and its dates. " +
    "Only current facts are returned unless `include_ended` (history too) or `as_of` (what was true then) says otherwise. A search with `type`, `domains` or `linked` finds no facts. " +
    "Without `facts: true` the result is the list of nodes alone.",
  graphNotes: { ladybug: "`include_ended` is what used to be true. A fact's `sources` say where it came from and who said it: a node there that is not the user is someone else's word." },
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
      .describe("Scope the search to one namespace (who the data is for: `private`, `shared`). Default: every namespace this caller may read."),
    exclude_domains: z.string().optional().describe(excludeDomainsInput),
    facts: z
      .boolean()
      .optional()
      .describe("Also find facts (sentences on edges) and return `{ nodes, facts }` instead of the list of nodes. Use it to find what is true about someone or something."),
    ...timeInputs,
  }),
  output: z.any(),
  async run(cfg, ctx) {
    if (!cfg.q && !cfg.input_q && !cfg.output_q) {
      return "graph/graph-search requires at least one of: q, input_q, output_q";
    }
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>, { exclude_domains: splitList(cfg.exclude_domains) });
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
        facts: Boolean(cfg.facts),
        include_ended: cfg.include_ended,
        as_of: cfg.as_of,
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
          // On a Ladybug file the two lists share a scale: a node's score
          // compares with a fact's, so the caller can read them as one list.
          ...(cfg.facts && b.kind === "ladybug" ? { score: n.score } : {}),
        };
      });
      // No provenance marker: a hit is a node the caller was SHOWN, not one
      // it chose to read (`withAccessedNodes`). Facts only when asked, so the
      // shape never depends on the data; a graph holding none (Neo4j) has `[]`.
      return cfg.facts ? { nodes: hits, facts: (res.facts ?? []).map(factOut) } : hits;
    } catch (e) {
      return errText("graph/graph-search", e);
    }
  },
});
