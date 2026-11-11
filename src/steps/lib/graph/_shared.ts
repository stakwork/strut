import type { FactTrust } from "../../../graph/fact-score.js";
import type { RunStep } from "../../../graph/memory-checks.js";
import { z } from "zod";
import type { AccessedNode, StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import type { GraphBackend } from "../../../graph/backend.js";
import { boundsOf, graphFor, readsNamespace, type Narrowing } from "../../../graph/scope.js";
import { StepFailure, stepFailed } from "../../../public-call.js";

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
 * Neo4j, or the desktop's LadybugDB file, plans/ladybug-backend.md). Both
 * keep their ontology as Schema nodes, so every step, the schema writes
 * included, works the same on either. Without a wired backend the steps
 * open a Neo4j from env, as before:
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
 *
 * The backend is opened once per config and cached process-wide; the first
 * open runs the boot obligations (domain seeding + embedding backfill).
 * Per the lib dependency convention the backend module (and with it
 * neo4j-driver) is imported lazily here, inside `run()`, never at module
 * top level.
 */
/** A call's own `exclude_domains`, as the read steps take it: comma-separated. */
export const excludeDomainsInput = "Comma-separated domains to leave out, e.g. 'strut' to skip strut's own runs, jobs and workflows. It only narrows what this caller may read.";

/** Node types a traversal (graph-neighbors, walk) leaves out: noise, and the
 *  ontology's own `Schema` nodes (read through get-ontology instead). */
/** The time inputs of the reads that show temporal edges (graph-search,
 *  graph-neighbors, walk): current ones by default. A Neo4j graph holds
 *  none, and ignores both. */
export const timeInputs = {
  include_ended: z.boolean().optional().describe("Also show facts (temporal edges) that ended or were replaced. Default: current ones only."),
  as_of: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Show the facts (temporal edges) that were true at this time: an ISO date ('2024', '2024-06', '2024-06-01T12:00:00Z') or epoch ms. Wins over include_ended."),
  include_deleted: z
    .boolean()
    .optional()
    .describe("Also show deleted nodes and facts, each marked `deleted_at`. A delete hides, never erases. Default: hidden. A LadybugDB graph only."),
};

/** `deleted_at` (epoch ms) as ISO, when set: what an `include_deleted` read marks. */
export function deletedOut(v: unknown): { deleted_at?: string } {
  return typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)) ? { deleted_at: new Date(Number(v)).toISOString() } : {};
}

/** A temporal edge's dates, epoch ms on the edge, as ISO; the ones it has. */
export function isoDates(p: Record<string, unknown>): Partial<Record<"valid_at" | "invalid_at" | "expired_at", string>> {
  const out: Partial<Record<"valid_at" | "invalid_at" | "expired_at", string>> = {};
  for (const k of ["valid_at", "invalid_at", "expired_at"] as const) {
    const v = p[k];
    if (typeof v === "number" || typeof v === "bigint" || (typeof v === "string" && /^\d+$/.test(v))) out[k] = new Date(Number(v)).toISOString();
  }
  return out;
}

/** A fact's trust as a step returns it (`FactTrust`), its times as ISO. */
export function trustOut(t: FactTrust | undefined): Record<string, unknown> {
  if (!t) return {};
  const { evidence, ...rest } = t;
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    ...rest,
    evidence: {
      sayers: evidence.sayers,
      ...(evidence.last_confirmed !== undefined ? { last_confirmed: iso(evidence.last_confirmed) } : {}),
      ...(evidence.items ? { items: evidence.items.map((x) => ({ ...x, observed_at: iso(x.observed_at) })) } : {}),
    },
  };
}

/** What a step that scores facts tells the model about the scores, and how to use them (a Ladybug file only). */
/** Runs a memory fact's check step through strut's own runner, as the verify
 *  pass runs a check (`origin: verify`): the fact is the step's config, over
 *  the check's own. Only a read-only `graph/check-*` step runs; any other is
 *  refused. Undefined outside the runner (no registry). */
export function checkRunner(ctx: StepContext<StrutCapabilities>): RunStep | undefined {
  const registry = ctx.registry;
  if (!registry) return undefined;
  return async (step, input, config) => {
    const def = registry[step] as { effect?: string } | undefined;
    if (!/^graph\/check-[a-z0-9-]+$/.test(step) || def?.effect !== "read") return { status: "error" };
    // Lazy: the runner loads the registry's steps.
    const { runSingleStep } = await import("../../../run-step.js");
    const run = await runSingleStep(step, registry, ctx.services, { config: { ...config, ...(input as Record<string, unknown>) }, input, origin: "verify" });
    return { status: run.status, ...(run.output !== undefined ? { output: run.output } : {}) };
  };
}

/** A read by the user's own agent: not a job's, not an app's. Only its reads look again at a fact
 *  (plans/memory-checks.md): a check may search the user's chats on their Mac. */
export const ownAgentRead = (ctx: Pick<StepContext<StrutCapabilities>, "job" | "app">): boolean => !ctx.job && !ctx.app;

export const TRUST_NOTE =
  "Each fact carries how far to trust it now, worked out when it is read. `evidence` is who backed it — `kind` owner is the user, self is the fact's subject, other is someone else, check is a check that found it (in the user's chats, say) — when it was last backed, and each piece for or against. " +
  "`status` is what the evidence says: supported, disputed (another value is close: `rival`), stale (old for that kind of fact), hearsay (only someone else said it), unknown (too little to go on) or refuted (the user said it is false). " +
  "`stance` is what to do with it: `state` it as fact; `cite` it with who said it and when (\"Kate told me in September…\", \"Sam said…\"); or `ask` before relying on it. " +
  "Use them this way: (1) asked about a fact whose stance is ask, answer with what is known, then check (\"Last I heard Porto, but that was two years ago. Still there?\"); never refuse to answer. " +
  "(2) In a general answer, build it from state and cite facts; leave ask facts out or flag them briefly as possibly out of date. " +
  "(3) Before acting on a fact (sending, booking, updating), check any fact that is not state. " +
  "(4) Never hold an answer back waiting on questions, and ask at most one question per reply; the answer is new evidence, so remember it. " +
  "When the user says a fact is wrong, assert it with `refuted`; when it is merely over, with `ended`. " +
  "`planned` is a fact that begins later.";

export const EXCLUDED_NODE_TYPES = ["Hint", "Memory", "Clip", "Turn", "Schema"];

/**
 * The backend a step reads and writes through, held to its caller's reader
 * list (`src/graph/scope.ts`, plans/graph-memory-plan.md step 6) and
 * narrowed by the call's own asks (`exclude_domains`, a walk's namespace). Every `graph/*` step goes
 * through here, so none reads past the list.
 */
export async function graphCtx(ctx?: StepContext<StrutCapabilities>, ask: Narrowing = {}): Promise<GraphBackend> {
  const wired = ctx?.services?.graph;
  if (wired) return graphFor(wired, ctx, ask);
  const secrets = ctx?.services?.secrets;
  // Same resolution as the mcp host's own Neo4j client: `NEO4J_URI`, else
  // `bolt://<NEO4J_HOST>` (default localhost:7687), user/password defaulting
  // to neo4j/testtest. Nothing needs configuring for a local Neo4j, and a
  // deployment that already carries NEO4J_HOST/USER/PASSWORD is picked up
  // as-is (secret store → env, per the secrets capability).
  const uri = (await secrets?.get("NEO4J_URI")) || `bolt://${(await secrets?.get("NEO4J_HOST")) || "localhost:7687"}`;
  const emb = ((await secrets?.get("STRUT_GRAPH_EMBEDDINGS")) ?? "").toLowerCase();
  const { openGraphBackend } = await import("../../../graph/backend.js");
  const opened = await openGraphBackend(
    {
      uri,
      user: (await secrets?.get("NEO4J_USER")) || "neo4j",
      password: (await secrets?.get("NEO4J_PASSWORD")) || "testtest",
      namespace: (await secrets?.get("STRUT_GRAPH_NAMESPACE")) || "default",
      database: (await secrets?.get("NEO4J_DATABASE")) || undefined,
    },
    { embeddings: !["off", "0", "false"].includes(emb) },
  );
  return graphFor(opened, ctx, ask);
}

/** May this caller's reader list read `namespace`? A step that reads through a transaction (which no
 *  list scopes) asks first, so it shows nothing its caller's typed reads would not. */
export function mayRead(b: GraphBackend, namespace: string): boolean {
  const bounds = boundsOf(b);
  return !bounds || readsNamespace(bounds.list, namespace, b.namespace);
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
  /** The caller's actor, stamped as the edge's `created_by` (Ladybug). */
  created_by?: string;
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
    ...(a.created_by ? { created_by: a.created_by } : {}),
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
 *  convention the jarvis/* steps use for HTTP failures) — inside a public
 *  call (src/public-call.ts) thrown instead, so the call is charged as the
 *  failure it is. */
export function errText(step: string, e: unknown): string {
  if (e instanceof StepFailure) throw e;
  const code = graphErrorCode(e);
  const msg = e instanceof Error ? e.message : String(e);
  return stepFailed(code ? `${step} failed — ${code}: ${msg}` : `${step} failed: ${msg}`);
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

/** Names for refs, for a proposal's card: read through the graph the server
 *  WIRED only (never opens one), best effort — a ref it cannot read maps to
 *  nothing, and nothing here throws. */
export async function namesOf(ctx: StepContext<any> | undefined, refs: Array<string | null | undefined>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const b = (ctx as StepContext<StrutCapabilities> | undefined)?.services?.graph;
    if (!b) return out;
    for (const n of await describeNodes(b, refs)) if (n.name) out.set(n.ref_id, n.name);
  } catch {
    /* the card falls back to ids */
  }
  return out;
}

/** The label of one end of a triplet as the input gives it: an inline
 *  node's name (or type), else the ref's name when known, else the ref. */
export function endLabel(type: unknown, data: unknown, ref: unknown, names?: Map<string, string>): string {
  const d = data && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
  if (typeof ref === "string" && ref) return names?.get(ref) ?? ref;
  if (d) return deriveNodeName(undefined, d as Record<string, any>) || (typeof type === "string" ? type : "(new node)");
  return typeof type === "string" ? type : "?";
}

/** `A -TYPE-> B`, for the triplet steps' cards. */
export function tripletLine(t: any, names?: Map<string, string>): string {
  const type = String(t.edge_type ?? "").toUpperCase().replace(/ /g, "_");
  return `${endLabel(t.source_type, t.source_data, t.source_ref_id, names)} -${type}-> ${endLabel(t.target_type, t.target_data, t.target_ref_id, names)}`;
}
