import { workflowOf, type AccessedNode, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import type { GraphBackend } from "../../../graph/backend.js";
import { ManagedReadFilter, rawGraphOf } from "../../../graph/managed.js";

export type { GraphBackend };

/**
 * The `graph/*` steps are thin plumbing over strut's own graph backend
 * (`src/graph/*`, plans/jarvis-graph-compat.md) — the strut-native twins of
 * the lab's `jarvis/*` steps: same step names, input schemas, and output
 * shapes, so a workflow swaps backends by step type
 * (`jarvis/graph-search` ↔ `graph/graph-search`). No jarvis in the loop;
 * everything written follows jarvis's conventions so a jarvis mounted on
 * the same database later treats the `Strut` domain as native.
 *
 * The backend the SERVER wired comes first: `ctx.services.graph`
 * (`createStrut` puts the one behind its graph-backed workspace there — a
 * Neo4j, or the desktop's LadybugDB file, plans/ladybug-backend.md). On a
 * Ladybug file the Concept reads work as they do on Neo4j; a step that
 * registers a type or writes one outside the closed registry fails there
 * with the closed-registry error. Without a wired backend the steps open
 * a Neo4j from env, as before:
 *
 * Config (all via `ctx.services.secrets`, secret store → env fallback; the
 * same names + defaults as the mcp host's own Neo4j client, so a local
 * Neo4j needs nothing and a deployment's existing vars just work):
 *   - `NEO4J_URI`             — bolt:// URI; else `bolt://<NEO4J_HOST>`
 *     (`NEO4J_HOST` default `localhost:7687`).
 *   - `NEO4J_USER` / `NEO4J_PASSWORD` — credentials (default neo4j / testtest).
 *   - `NEO4J_DATABASE`        — optional database name.
 *   - `STRUT_GRAPH_NAMESPACE`  — default jarvis namespace (default "default").
 *   - `STRUT_GRAPH_EMBEDDINGS` — "off" disables the local MiniLM embedder
 *     (writes leave vectors NULL; search is fulltext-only).
 *   - `STRUT_GRAPH_SEED_ONTOLOGY` — "1" also seeds the bundled jarvis
 *     ontology on first open (add-only), so a STANDALONE Neo4j can host
 *     jarvis-typed data (Document, EvalSet, …) with no jarvis process.
 *
 * The backend is opened once per config and cached process-wide; the first
 * open runs the boot obligations (domain seeding + embedding backfill).
 * Per the lib dependency convention the backend module (and with it
 * neo4j-driver) is imported lazily here, inside `run()`, never at module
 * top level.
 */
export async function graphCtx(ctx?: StepContext<StrutCapabilities>): Promise<GraphBackend> {
  const b = await openCtx(ctx);
  // Nothing managed (every graph before memory moves in): the backend as wired.
  return (await hiddenManaged(b, ctx)).size ? { ...b, reader: new ManagedReadFilter(b.reader, b.schemas) } : b;
}

/**
 * May this step read the managed types (memory's; plans/memory-in-workspace-graph.md
 * decision 8)? Only as an agent's tool call where the host lists, in
 * `memoryReaders` (`StrutOptions.memoryReaders`), both the run's workflow
 * and the frame's own (`ctx.frame`), so a subflow of the person's assistant
 * reads nothing it is not listed for; that frame is `sealed: true`, so the
 * meta surface cannot republish it with another agent; and the frame is
 * not the AI's (`ctx.aiAuthored`). A workflow's own steps, every other
 * workflow's agents (jobs, the builder, apps) and a call with no run do
 * not. The writers refuse the managed types to every `graph/*` step
 * whatever this says.
 */
export function readsManaged(ctx?: StepContext<StrutCapabilities>): boolean {
  const readers = ctx?.services?.memoryReaders;
  if (!ctx?.agentTool || ctx.aiAuthored || !readers?.length || !ctx.frame?.sealed) return false;
  return readers.includes(workflowOf(ctx)) && readers.includes(ctx.frame.workflow);
}

/** The managed types this step may not read, type → manager (empty when it may). */
export async function hiddenManaged(b: GraphBackend, ctx?: StepContext<StrutCapabilities>): Promise<ReadonlyMap<string, string>> {
  return readsManaged(ctx) ? new Map() : ((await b.schemas?.managedTypes?.()) ?? new Map());
}

async function openCtx(ctx?: StepContext<StrutCapabilities>): Promise<GraphBackend> {
  // The view steps are handed (`graphView`) leaves memory out; these steps
  // filter by caller themselves, on the backend behind it.
  const wired = ctx?.services?.graph;
  if (wired) return rawGraphOf(wired) ?? (wired as GraphBackend);
  const secrets = ctx?.services?.secrets;
  // Same resolution as the mcp host's own Neo4j client: `NEO4J_URI`, else
  // `bolt://<NEO4J_HOST>` (default localhost:7687), user/password defaulting
  // to neo4j/testtest. Nothing needs configuring for a local Neo4j, and a
  // deployment that already carries NEO4J_HOST/USER/PASSWORD is picked up
  // as-is (secret store → env, per the secrets capability).
  const uri = (await secrets?.get("NEO4J_URI")) || `bolt://${(await secrets?.get("NEO4J_HOST")) || "localhost:7687"}`;
  const emb = ((await secrets?.get("STRUT_GRAPH_EMBEDDINGS")) ?? "").toLowerCase();
  const ont = ((await secrets?.get("STRUT_GRAPH_SEED_ONTOLOGY")) ?? "").toLowerCase();
  const { openGraphBackend } = await import("../../../graph/backend.js");
  return openGraphBackend(
    {
      uri,
      user: (await secrets?.get("NEO4J_USER")) || "neo4j",
      password: (await secrets?.get("NEO4J_PASSWORD")) || "testtest",
      namespace: (await secrets?.get("STRUT_GRAPH_NAMESPACE")) || "default",
      database: (await secrets?.get("NEO4J_DATABASE")) || undefined,
    },
    { embeddings: !["off", "0", "false"].includes(emb), seedOntology: ["1", "true", "on"].includes(ont) },
  );
}

export interface EdgeWriteArgs {
  edge_type: string;
  source_ref_id: string;
  target_ref_id: string;
  edge_data?: Record<string, unknown>;
  weight?: number;
  /** jarvis `create_schema_if_missing`: when the (source type, edge, target
   *  type) triple has no edge schema, register one between the endpoint
   *  types and retry once. */
  create_schema_if_missing?: boolean;
}

/** Write one edge through the backend, honouring `create_schema_if_missing`
 *  the way jarvis's edge endpoint does. Throws the writer's error otherwise. */
export async function writeEdge(b: GraphBackend, a: EdgeWriteArgs) {
  const edge = a.edge_type.toUpperCase().replace(/ /g, "_");
  const input = {
    edge,
    source_ref_id: a.source_ref_id,
    target_ref_id: a.target_ref_id,
    ...(a.edge_data ? { properties: a.edge_data } : {}),
    ...(a.weight !== undefined ? { weight: a.weight } : {}),
  };
  try {
    return await b.edges.write(input);
  } catch (e) {
    if (!a.create_schema_if_missing || graphErrorCode(e) !== "WRONG_TYPE") throw e;
    const [s, t] = await Promise.all([b.reader.getNode(a.source_ref_id), b.reader.getNode(a.target_ref_id)]);
    if (!s?.node_type || !t?.node_type) throw e;
    await b.schemas.createEdgeSchema(s.node_type, edge, t.node_type);
    return await b.edges.write(input);
  }
}

/** The `code` of a `GraphValidationError` / `GraphReadError`, else undefined.
 *  Duck-typed on `name` so this module never imports the graph classes. */
export function graphErrorCode(e: unknown): string | undefined {
  const n = (e as { name?: unknown } | null)?.name;
  if (n === "GraphValidationError" || n === "GraphReadError") return String((e as { code: unknown }).code);
  return undefined;
}

/** Render a graph error as a plain string the agent can read (the same
 *  convention the jarvis/* steps use for HTTP failures). With the step's
 *  `ctx`, a managed-type refusal reads as not found to a caller that may
 *  not read those types (`readsManaged`). */
export function errText(step: string, e: unknown, ctx?: StepContext<unknown>): string {
  const code = graphErrorCode(e);
  return code ? `${step} failed — ${errDetail(e, ctx)}` : `${step} failed: ${errDetail(e, ctx)}`;
}

/** `CODE: message` for a graph error (the message alone for any other):
 *  `errText` without the step. A MANAGED refusal to a caller that may not
 *  read the managed types is `NOT_FOUND`, naming neither type nor manager. */
export function errDetail(e: unknown, ctx?: StepContext<unknown>): string {
  const code = graphErrorCode(e);
  if (code === "MANAGED" && !readsManaged(ctx as StepContext<StrutCapabilities> | undefined)) return "NOT_FOUND: no such node";
  const msg = e instanceof Error ? e.message : String(e);
  return code ? `${code}: ${msg}` : msg;
}

const LABEL_MAX = 160;

/** Provenance entries for nodes a step NAMED but did not read (an edit, a
 *  move, an edge's endpoints): each ref with its type and name as the graph
 *  holds them now. Best effort — a ref that cannot be read is reported bare,
 *  never dropped. */
export async function describeNodes(b: GraphBackend, refs: Array<string | null | undefined>): Promise<AccessedNode[]> {
  const unique = [...new Set(refs.filter((r): r is string => typeof r === "string" && r.length > 0))];
  const out: AccessedNode[] = [];
  for (let i = 0; i < unique.length; i += DESCRIBE_CONCURRENCY) {
    out.push(
      ...(await Promise.all(
        unique.slice(i, i + DESCRIBE_CONCURRENCY).map(async (ref_id): Promise<AccessedNode> => {
          try {
            const n = await b.reader.getNode(ref_id);
            if (!n) return { ref_id };
            return { ref_id, node_type: n.node_type, name: deriveNodeName(n, (n.properties ?? {}) as Record<string, any>) };
          } catch {
            return { ref_id };
          }
        }),
      )),
    );
  }
  return out;
}
const DESCRIBE_CONCURRENCY = 8;

/** Nodes keep their human label under different keys depending on node
 *  type — try a generous ordered candidate list (same as jarvis/graph-get).
 *  Shared by graph-get, graph-get-batched, graph-neighbors and walk. */
export function deriveNodeName(node: any, p: Record<string, any>): string {
  const candidates = [
    node?.name, p.name, p.title, p.label, p.display_name, p.displayName,
    p.identifier, p.file_name, p.fileName, p.file, p.path, p.symbol,
    p.function_name, p.class_name, p.method_name, p.operation_id, p.endpoint,
    p.route, p.url, p.entity, p.key, p.slug, p.episode_title, p.show_title,
    p.username, p.email, p.summary, p.description, p.text, p.content, p.body, p.docs,
    p.workflow_name, p.step_type, p.run_id, p.tool_name, p.chat_id,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) {
      const t = c.trim();
      return t.length > LABEL_MAX ? t.slice(0, LABEL_MAX) : t;
    }
  }
  return "";
}

/** Connection counts → the `edges` map graph-get shows the model:
 *  `{ PARENT_OF: 2, "<-PARENT_OF": 1 }` — outgoing edges by type, incoming
 *  ones marked `<-`. One undirected count read as "2 children" + a parent =
 *  "3 children", and an agent re-fetched the node hunting the missing one. */
export function edgeCountMap(counts: Array<{ edge_type: string; direction?: "out" | "in"; count: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of counts ?? []) {
    if (!c?.edge_type) continue;
    const key = c.direction === "in" ? `<-${c.edge_type}` : c.edge_type;
    out[key] = (out[key] ?? 0) + Number(c.count ?? 0);
  }
  return out;
}
