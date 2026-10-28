import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx } from "./_shared.js";

const EXAMPLE = `- id: hosts
  type: graph/query
  config:
    cypher: >
      MATCH (h:Host {namespace: $ns})-[:RUNS]->(p:Package)
      RETURN h.name AS host, collect(p.name) AS packages
      ORDER BY host SKIP $skip LIMIT 500
    params: { ns: default, skip: 0 }
    maxRows: 500`;

/**
 * Read-only raw Cypher in a workflow (src/graph/query.ts, the chat's
 * `graph_query` as a step). A workflow that needs a query the typed reads
 * cannot express has this door instead of a custom step that opens the
 * deployment's graph itself. Throws on a refused or failed query: a
 * workflow should stop there, and an agent reads the error as the tool's.
 */
export default defineStep({
  type: "graph/query",
  effect: "read",
  description:
    "Run ONE read-only Cypher query against the workspace's graph and get the rows: for what the typed reads cannot say — " +
    "counts and grouping, exact properties across many nodes, a join across types, edge fan-out. " +
    "Writes (CREATE, MERGE, SET, DELETE, apoc.*, LOAD, COPY, …) are refused and the graph's read-only mode enforces it: " +
    "write with graph/create-node, graph/create-triplet, graph/edit-node. Pass values as `params` ($name), not spliced into the text. " +
    "Returns `{ columns, rows, rowCount, truncated, elapsedMs }`, one object per row keyed by column; at most `maxRows` rows " +
    "(1–1000, default 100) — `truncated: true` means there were more: page with ORDER BY … SKIP $skip LIMIT n, or aggregate. " +
    "Embedding vectors come back as a placeholder. A refused or failed query fails the step. " +
    "The layout depends on the backend: on Neo4j a node carries its type as a label plus {ref_id, node_key, namespace} — filter on " +
    "the namespace ($ns, the workspace's is usually \"default\") — and edge types are UPPER_SNAKE; on a LadybugDB file every node is a " +
    "row of the one Node table, `MATCH (n:Node {node_type: 'Concept'})`, live when n.deleted_at IS NULL, and each edge type is a rel " +
    "table of its name. A query written for one does not run on the other. " +
    "For one node use graph/graph-get, for words or meaning graph/graph-search, for the nodes of one type by their properties graph/find.\n\n" +
    EXAMPLE,
  input: z.object({
    cypher: z.string().min(1).describe("One read-only Cypher query, e.g. \"MATCH (n:Concept {namespace: $ns}) RETURN count(n) AS n\"."),
    params: z.record(z.string(), z.any()).optional().describe("Values the query names as $name."),
    maxRows: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Row cap, 1–1000 (default 100). Past it, `truncated: true` — page or aggregate rather than raise it."),
    timeoutMs: z.number().int().min(1).max(60_000).optional().describe("How long the query may run, in ms (default 15000, at most 60000)."),
  }),
  output: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.record(z.string(), z.any())),
    rowCount: z.number(),
    truncated: z.boolean(),
    elapsedMs: z.number(),
  }),
  async run(cfg, ctx) {
    const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
    const { readQuery } = await import("../../../graph/query.js");
    // Strings whole: unlike a chat turn, a workflow reads the rows as data.
    // No provenance marker: rows are not what the caller named.
    return readQuery(b, cfg.cypher, {
      ...(cfg.params ? { params: cfg.params } : {}),
      ...(cfg.maxRows ? { maxRows: cfg.maxRows } : {}),
      ...(cfg.timeoutMs ? { timeoutMs: cfg.timeoutMs } : {}),
      maxStringLength: Infinity,
    });
  },
});
