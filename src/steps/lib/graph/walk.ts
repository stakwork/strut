import { z } from "zod";
import { defineStep, type StepContext, withAccessedNodes, type AccessedNode } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import type { NodeEnvelope, EdgeEnvelope, NeighborsParams, SearchParams, SearchResult } from "../../../graph/search.js";
import { modelEvaluate, type Evaluate, type EvalQuestion, type EvalAnswer } from "../../../evaluate.js";
import { addUsage, emptyUsage, type TokenUsage } from "../../../pricing.js";
import { resolveEvaluationModel } from "../../../llm.js";
import { graphCtx, errText, deriveNodeName } from "./_shared.js";

/**
 * `graph/walk` — gather context for a goal by walking the graph.
 *
 * The walk is CODE; a decision model only answers typed questions
 * (`src/evaluate.ts`). Each hop: fetch one node's neighbors (the same call
 * as graph/graph-neighbors), then ONE evaluate call asks, independently,
 *   - `relevant_c<i>` (boolean) per new neighbor: worth keeping as context?
 *   - `next` (choice) over this hop's candidates + the best of the frontier:
 *     which node to expand next, or `none`;
 *   - `sufficient` (boolean): is what's gathered enough to answer the goal?
 * Kept nodes are ordered by relevance; the output is a context bundle for
 * an `llm`/`agent` step to synthesize from. Every hop is a nested run event
 * (`<path>/NNN-hop`, `iteration` = hop): `step.start` carries the subgraph
 * the hop discovered (each candidate with the edge it arrived by, and the
 * frontier under consideration), `step.end` the verdicts (relevance + kept
 * per candidate, next, sufficient). A viewer folding those deltas — from the
 * run's SSE tail live, or from the log afterwards — can light up the walk
 * as it goes. The step's provenance marker lists the expanded + kept nodes.
 *
 * `runWalk` is pure over an injected reader + decider (offline-testable);
 * `run()` wires strut's graph backend and an evaluation model (jev, or an
 * aieo-resolved language model — `resolveEvaluationModel`).
 */

/** Neighbor fetch cap per hop, as in graph/graph-neighbors (importance-sorted first). */
const NEIGHBOR_CAP = 50;
/** Noise types graph/graph-neighbors also leaves out of a traversal. */
const EXCLUDED_NODE_TYPES = ["Hint", "Memory", "Clip", "Turn"];
/** Seeds taken from a `query` search. */
const SEED_LIMIT = 5;
/** Options offered to `next` per hop: this hop's candidates, then the best of the frontier. */
const OPTIONS_CAP = 60;
/** `sufficient` probability at which the walk stops. */
const SUFFICIENT_AT = 0.8;
const SNIPPET_MAX = 240;
/** Long string properties in the output bundle are cut here (a document body is not context, its summary is). */
const PROPERTY_MAX = 2000;
const TEXT_KEYS = ["description", "summary", "text", "content", "body", "docs", "prompt", "message"];
/** Edge attributes shown to the decider are cut here (HAS_SOURCE.context is a JSON blob). */
const EDGE_PROPERTY_MAX = 160;
/** Edge stamps that say nothing about the relationship itself. */
const EDGE_STAMPS = new Set(["date_added_to_graph", "is_muted", "namespace", "importance"]);

/** The slice of `GraphReader` the walk needs (structural, so tests inject a fake). */
export interface WalkReader {
  getNode(ref_id: string): Promise<NodeEnvelope | null>;
  neighbors(ref_id: string, p?: NeighborsParams): Promise<{ nodes: NodeEnvelope[]; edges: EdgeEnvelope[] }>;
  search(p: SearchParams): Promise<SearchResult>;
}

export interface WalkConfig {
  goal: string;
  start?: string[];
  query?: string;
  edge_type?: string[];
  node_type?: string[];
  namespace?: string;
  maxHops: number;
  maxNodes: number;
  threshold: number;
}

export interface WalkDeps {
  reader: WalkReader;
  evaluate: Evaluate;
  ctx?: StepContext;
}

interface Via {
  from: string;
  edge_type: string;
  direction: "forward" | "reverse";
  /** The arriving edge's own attributes (e.g. `EVIDENCED_BY.strength`), minus graph stamps. */
  properties?: Record<string, unknown>;
}

interface Candidate {
  ref_id: string;
  node_type: string;
  name: string;
  snippet: string;
  edges: Record<string, number>;
  properties: Record<string, unknown>;
  hop: number;
  via?: Via;
  relevance?: number;
  /** Evidence only: verdict + claim. Evidence sharing one is shown to the decider once (`mergeEvidence`). */
  evidenceKey?: string;
  /** Evidence folded into this one: same claim, same verdict, other runs. */
  merged?: Candidate[];
}

interface Brief {
  ref_id: string;
  node_type: string;
  name: string;
}

export interface HopRecord {
  hop: number;
  /** The node whose neighbors this hop judged; absent on hop 0 (the seeds). */
  expanded?: Brief;
  candidates: number;
  /** ref_ids kept this hop. */
  kept: string[];
  /** Every candidate this hop judged: its relevance and whether it was kept. */
  verdicts: Array<{ ref_id: string; relevance: number; kept: boolean }>;
  next?: Brief;
  /** ref_id → probability for `next` (plus the `none` option), when the
   *  decider reports one — jev does; a wrapped language model does not. */
  next_probabilities?: Record<string, number>;
  sufficient: number;
}

export interface WalkOutput {
  goal: string;
  nodes: Array<
    Brief & { relevance: number; hop: number; via?: Via; properties: Record<string, unknown>; merged?: Array<{ ref_id: string; name: string }> }
  >;
  hops: HopRecord[];
  stopped: "sufficient" | "hops" | "nodes" | "exhausted";
  usage: TokenUsage;
}

function snippetOf(p: Record<string, unknown>): string {
  for (const k of TEXT_KEYS) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) {
      const t = v.trim().replace(/\s+/g, " ");
      return t.length > SNIPPET_MAX ? t.slice(0, SNIPPET_MAX) + "…" : t;
    }
  }
  return "";
}

function clipStrings(v: unknown): unknown {
  if (typeof v === "string") return v.length > PROPERTY_MAX ? v.slice(0, PROPERTY_MAX) + "…" : v;
  if (Array.isArray(v)) return v.map(clipStrings);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, clipStrings(x)]));
  return v;
}

function candidateOf(n: NodeEnvelope, hop: number, via?: Via): Candidate {
  const properties = (n.properties ?? {}) as Record<string, unknown>;
  return {
    ref_id: n.ref_id,
    node_type: n.node_type ?? "unknown",
    name: deriveNodeName(n, properties),
    snippet: snippetOf(properties),
    edges: n.edges ?? {},
    properties,
    hop,
    ...(via ? { via } : {}),
  };
}

const brief = (c: Candidate): Brief => ({ ref_id: c.ref_id, node_type: c.node_type, name: c.name });
const round = (x: number) => Math.round(x * 100) / 100;
const prob = (a: EvalAnswer | undefined) => (a?.type === "boolean" ? a.probability : 0);
const chosen = (a: EvalAnswer | undefined) => (a?.type === "choice" ? a.choice : undefined);
/** Most relevant first, earlier hop breaks ties, then name. */
function byPriority(a: Candidate, b: Candidate): number {
  return (b.relevance ?? 0) - (a.relevance ?? 0) || a.hop - b.hop || a.name.localeCompare(b.name);
}

/** The arriving edge's attributes worth showing, strings clipped; undefined when none. */
function edgeProperties(p: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p ?? {})) {
    if (EDGE_STAMPS.has(k) || v === null || v === undefined) continue;
    out[k] = typeof v === "string" && v.length > EDGE_PROPERTY_MAX ? v.slice(0, EDGE_PROPERTY_MAX) + "…" : v;
  }
  return Object.keys(out).length ? out : undefined;
}

function viaText(v: Via): string {
  const props = v.properties ? ` ${JSON.stringify(v.properties)}` : "";
  return `${v.edge_type} (${v.direction})${props}`;
}

/**
 * Evidence reads as its RESULT, not its claim. The verifier names every
 * Evidence node after the claim it bears on (verify.ts `writeEvidence`), so
 * a version's twenty evidence nodes would reach the decider under four
 * names. Here the label leads with the verdict (the claim's `EVIDENCED_BY`
 * strength: >0 supports, <0 refutes, absent = a planned slot) and the
 * observed result (`content`); the claim moves to the snippet. Display
 * only — the node and its properties are untouched. A candidate that did
 * not arrive over `EVIDENCED_BY` costs one filtered neighbors call.
 */
async function labelEvidence(reader: WalkReader, cands: Candidate[]): Promise<void> {
  await Promise.all(
    cands
      .filter((c) => c.node_type === "Evidence")
      .map(async (c) => {
        let strength: unknown;
        if (c.via?.edge_type === "EVIDENCED_BY") strength = c.via.properties?.["strength"];
        else {
          const r = await reader.neighbors(c.ref_id, { edge_types: ["EVIDENCED_BY"], limit: 5 });
          strength = r.edges?.find((e) => e.target === c.ref_id)?.properties?.["strength"];
        }
        const n = typeof strength === "number" ? strength : Number.NaN;
        const verdict = n > 0 ? "supports" : n < 0 ? "refutes" : "no verdict";
        const content = typeof c.properties["content"] === "string" ? c.properties["content"].trim().replace(/\s+/g, " ") : "";
        const claim = c.name;
        c.name = `${verdict}${Number.isNaN(n) ? "" : ` (${n})`}: ${content || claim}`.slice(0, SNIPPET_MAX);
        c.snippet = `claim: ${claim}`;
        c.evidenceKey = `${verdict}\u0000${claim}`;
      }),
  );
}

/**
 * One claim checked on many runs leaves near-identical Evidence (same claim,
 * same verdict, a different artifacts path in the result) that would crowd
 * the bundle and cost one judgment each. The first of each verdict + claim
 * stands for the rest: it is judged, kept and expanded; later ones — this
 * hop or any later hop — fold into its `merged` list and are never offered.
 * Returns the candidates left to judge and the folded (member → group) pairs.
 */
function mergeEvidence(cands: Candidate[], groups: Map<string, Candidate>): { cands: Candidate[]; folded: Array<[Candidate, Candidate]> } {
  const out: Candidate[] = [];
  const folded: Array<[Candidate, Candidate]> = [];
  for (const c of cands) {
    const group = c.evidenceKey ? groups.get(c.evidenceKey) : undefined;
    if (group) {
      (group.merged ??= []).push(c);
      folded.push([c, group]);
      continue;
    }
    if (c.evidenceKey) groups.set(c.evidenceKey, c);
    out.push(c);
  }
  return { cands: out, folded };
}

/** "N more like it" for a merged Evidence group, as the decider sees it. */
const similar = (c: Candidate) => (c.merged?.length ? { similar_results: c.merged.length } : {});

async function seedCandidates(cfg: WalkConfig, reader: WalkReader): Promise<Candidate[]> {
  if (cfg.start?.length) {
    const out: Candidate[] = [];
    for (const ref_id of cfg.start) {
      const n = await reader.getNode(ref_id);
      if (n) out.push(candidateOf(n, 0));
    }
    return out;
  }
  if (cfg.query?.trim()) {
    const r = await reader.search({
      q: cfg.query.trim(),
      types: cfg.node_type?.length ? cfg.node_type : undefined,
      namespace: cfg.namespace,
      limit: SEED_LIMIT,
      include_edge_counts: true,
    });
    return r.nodes.map((n) => candidateOf(n, 0));
  }
  throw new Error("needs `start` (ref_ids) or `query`");
}

/** One node's neighbors as candidates — the graph/graph-neighbors shape
 *  (direction, first edge wins on parallel edges, self-loops skipped). */
async function neighborsOf(reader: WalkReader, current: Candidate, filters: NeighborsParams, hop: number): Promise<Candidate[]> {
  const data = await reader.neighbors(current.ref_id, filters);
  const nodes = new Map<string, NodeEnvelope>();
  for (const n of data.nodes ?? []) if (n.ref_id !== current.ref_id) nodes.set(n.ref_id, n);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const e of data.edges ?? []) {
    const direction: Via["direction"] = e.source === current.ref_id ? "forward" : "reverse";
    const ref_id = direction === "forward" ? e.target : e.source;
    if (ref_id === current.ref_id || seen.has(ref_id)) continue;
    const n = nodes.get(ref_id);
    if (!n) continue;
    seen.add(ref_id);
    const properties = edgeProperties(e.properties);
    out.push(candidateOf(n, hop, { from: current.ref_id, edge_type: e.edge_type, direction, ...(properties ? { properties } : {}) }));
    if (out.length >= NEIGHBOR_CAP) break;
  }
  return out;
}

export async function runWalk(cfg: WalkConfig, deps: WalkDeps): Promise<WalkOutput> {
  const { reader, evaluate, ctx } = deps;
  const filters: NeighborsParams = {
    edge_types: cfg.edge_type?.length ? cfg.edge_type : undefined,
    node_types: cfg.node_type?.length ? cfg.node_type : undefined,
    exclude_node_types: EXCLUDED_NODE_TYPES,
    limit: NEIGHBOR_CAP,
    namespace: cfg.namespace,
    include_edge_counts: true,
  };
  // Same cast as the agent step's per-tool emit: the runner stamps ts/runId.
  const emit = ctx?.emit && ctx.path ? (ctx.emit as unknown as (e: Record<string, unknown>) => Promise<void>) : undefined;

  const seen = new Set<string>(); // every node ever discovered — offered once
  const frontier = new Map<string, Candidate>(); // discovered, not yet expanded
  const kept = new Map<string, Candidate>();
  const expanded: Candidate[] = [];
  const hops: HopRecord[] = [];
  const evidenceGroups = new Map<string, Candidate>();
  let usage = emptyUsage();

  /** Label, mark seen, and fold repeated Evidence: what's left is this hop's to judge. */
  const discover = async (found: Candidate[]) => {
    await labelEvidence(reader, found);
    for (const c of found) seen.add(c.ref_id);
    return mergeEvidence(found, evidenceGroups);
  };
  let { cands: candidates, folded } = await discover(await seedCandidates(cfg, reader));
  let current: Candidate | undefined;
  let stopped: WalkOutput["stopped"];

  for (let hop = 0; ; hop++) {
    if (candidates.length === 0 && frontier.size === 0) {
      stopped = "exhausted";
      break;
    }
    await ctx?.control?.checkpoint();
    const path = `${ctx?.path ?? "walk"}/${String(hop + 1).padStart(3, "0")}-hop`;
    const startedAt = Date.now();
    // Options for `next`: this hop's candidates (c<i>), then the frontier's best (f<i>).
    const shown = [...frontier.values()].sort(byPriority).slice(0, Math.max(0, OPTIONS_CAP - candidates.length));
    const options = new Map<string, Candidate>();
    candidates.forEach((c, i) => options.set(`c${i}`, c));
    shown.forEach((f, i) => options.set(`f${i}`, f));
    // The subgraph this hop discovered: nodes + the edge each arrived by, and
    // the frontier being considered. Verdicts follow on step.end.
    await emit?.({
      type: "step.start",
      path,
      stepType: "walk:hop",
      iteration: hop,
      input: {
        hop,
        expanded: current ? brief(current) : null,
        candidates: [
          ...candidates.map((c) => ({ ...brief(c), ...(c.via ? { via: c.via } : {}) })),
          ...folded.map(([m, g]) => ({ ...brief(m), ...(m.via ? { via: m.via } : {}), merged_into: g.ref_id })),
        ],
        frontier: shown.map((f) => ({ ref_id: f.ref_id, relevance: round(f.relevance ?? 0) })),
      },
    });
    try {
      const state = {
        goal: cfg.goal,
        gathered: [...kept.values()].sort(byPriority).map((k) => ({ type: k.node_type, name: k.name, snippet: k.snippet, ...similar(k) })),
        expanded: current ? { type: current.node_type, name: current.name, snippet: current.snippet } : null,
        candidates: candidates.map((c, i) => ({
          id: `c${i}`,
          type: c.node_type,
          name: c.name,
          via: c.via ? viaText(c.via) : "seed",
          connections: c.edges,
          snippet: c.snippet,
          ...similar(c),
        })),
        frontier: shown.map((f, i) => ({ id: `f${i}`, type: f.node_type, name: f.name, relevance: round(f.relevance ?? 0), snippet: f.snippet })),
      };
      const questions: Record<string, EvalQuestion> = {};
      candidates.forEach((c, i) => {
        questions[`relevant_c${i}`] = {
          type: "boolean",
          instructions:
            `Is candidate c${i} (${c.node_type} "${c.name}") relevant context for the goal — worth including in what an assistant reads before answering it? ` +
            "Answer no if it only repeats what is already gathered or what an earlier candidate in this list says: include it only when it adds something new the answer needs.",
        };
      });
      const criteria: Record<string, string> = {};
      for (const [k, c] of options) criteria[k] = `${c.node_type}: ${c.name}${c.via ? ` (via ${c.via.edge_type}, ${c.via.direction}${c.via.properties ? ` ${JSON.stringify(c.via.properties)}` : ""})` : ""}`;
      criteria["none"] = "no option is worth another hop";
      questions["next"] = {
        type: "choice",
        instructions: "Which node is most worth expanding next (fetching ITS neighbors) to gather more context for the goal? Pick none to stop expanding.",
        criteria,
      };
      questions["sufficient"] = {
        type: "boolean",
        instructions: "Counting the relevant candidates as gathered, is the gathered context sufficient to answer the goal well?",
      };

      const r = await evaluate({ state, questions });
      usage = addUsage(usage, r.usage);
      const answers = r.answers as Record<string, EvalAnswer>;

      const keptNow: string[] = [];
      candidates.forEach((c, i) => {
        c.relevance = prob(answers[`relevant_c${i}`]);
        if (c.relevance >= cfg.threshold && kept.size < cfg.maxNodes) {
          kept.set(c.ref_id, c);
          keptNow.push(c.ref_id);
        }
        frontier.set(c.ref_id, c);
      });
      const sufficient = prob(answers["sufficient"]);
      const nextAnswer = answers["next"];
      const choice = chosen(nextAnswer);
      const next = choice && choice !== "none" ? options.get(choice) : undefined;
      // Option keys → ref_ids, so a viewer can heat the whole frontier, not just the winner.
      const nextProbabilities =
        nextAnswer?.type === "choice" && nextAnswer.probabilities
          ? Object.fromEntries(Object.entries(nextAnswer.probabilities).map(([k, p]) => [options.get(k)?.ref_id ?? k, round(p)]))
          : undefined;

      const keptSet = new Set(keptNow);
      const record: HopRecord = {
        hop,
        ...(current ? { expanded: brief(current) } : {}),
        candidates: candidates.length,
        kept: keptNow,
        verdicts: [
          ...candidates.map((c) => ({ ref_id: c.ref_id, relevance: round(c.relevance ?? 0), kept: keptSet.has(c.ref_id) })),
          // A folded member shares its group's verdict (judged this hop or earlier).
          ...folded.map(([m, g]) => ({ ref_id: m.ref_id, relevance: round(g.relevance ?? 0), kept: kept.has(g.ref_id) })),
        ],
        ...(next ? { next: brief(next) } : {}),
        ...(nextProbabilities ? { next_probabilities: nextProbabilities } : {}),
        sufficient: round(sufficient),
      };
      hops.push(record);
      await emit?.({
        type: "step.end",
        path,
        stepType: "walk:hop",
        iteration: hop,
        output: record,
        durationMs: Date.now() - startedAt,
        nodes: [...(current ? [brief(current)] : []), ...candidates.map(brief), ...folded.map(([m]) => brief(m))].map(({ ref_id, node_type }) => ({ ref_id, node_type })),
      });

      if (sufficient >= SUFFICIENT_AT) {
        stopped = "sufficient";
        break;
      }
      if (kept.size >= cfg.maxNodes) {
        stopped = "nodes";
        break;
      }
      if (!next) {
        stopped = "exhausted";
        break;
      }
      if (hop + 1 >= cfg.maxHops) {
        stopped = "hops";
        break;
      }
      frontier.delete(next.ref_id);
      expanded.push(next);
      current = next;
      ({ cands: candidates, folded } = await discover((await neighborsOf(reader, next, filters, hop + 1)).filter((c) => !seen.has(c.ref_id))));
    } catch (e) {
      await emit?.({ type: "step.error", path, stepType: "walk:hop", iteration: hop, error: { message: (e as Error).message } });
      throw e;
    }
  }

  const nodes: WalkOutput["nodes"] = [...kept.values()].sort(byPriority).map((c) => ({
    ...brief(c),
    relevance: round(c.relevance ?? 0),
    hop: c.hop,
    ...(c.via ? { via: c.via } : {}),
    properties: clipStrings(c.properties) as Record<string, unknown>,
    ...(c.merged?.length ? { merged: c.merged.map((m) => ({ ref_id: m.ref_id, name: m.name })) } : {}),
  }));
  const out: WalkOutput = { goal: cfg.goal, nodes, hops, stopped, usage };
  const provenance: AccessedNode[] = [...expanded.map(brief), ...nodes, ...[...kept.values()].flatMap((k) => (k.merged ?? []).map(brief))].map((c) => ({ ref_id: c.ref_id, node_type: c.node_type }));
  return withAccessedNodes(out, provenance);
}

const EXAMPLE = `- id: gather
  type: graph/walk
  config:
    goal: "Why did the nightly deliver workflow start failing last week?"
    query: "nightly deliver"
    maxHops: 8
    maxNodes: 15
    model: jev            # or haiku etc.; omitted = jev when TYPESAFE_AI_API_KEY is set
- id: answer
  type: llm
  config:
    prompt: "Context:\\n{{ gather.nodes }}\\n\\nQuestion: {{ gather.goal }}"`;

export default defineStep({
  type: "graph/walk",
  description:
    "Walk the strut knowledge graph to GATHER CONTEXT for a goal. Seeds from ref_ids (start) or a graph search (query), then hop by hop " +
    "expands one node's neighbors while a small decision model judges each neighbor's relevance (kept or not), which node to expand next, " +
    "and whether enough has been gathered. Traversal is code and the model only answers typed choice/boolean questions, so it is cheap and " +
    "bounded (maxHops decision rounds, maxNodes kept). Output: { goal, nodes: [{ref_id, node_type, name, relevance, hop, via, properties}] " +
    "ordered by relevance, hops (the trace), stopped: sufficient|hops|nodes|exhausted, usage } — hand nodes to an llm or agent step to " +
    "synthesize an answer. Each hop emits a nested run event. Needs the graph backend (NEO4J_*) and the decision model's provider key.\n\n" +
    EXAMPLE,
  input: z.object({
    goal: z.string().describe("what the gathered context is for — the question an LLM should be able to answer from it; every decision is judged against this"),
    start: z.array(z.string()).optional().describe("ref_ids to start from (from graph_graph_search / graph_graph_get); else use `query`"),
    query: z.string().optional().describe("seed the walk with the top hits of a graph search for this text (when `start` is not given)"),
    edge_type: z.array(z.string()).optional().describe('only hop along these edge types, e.g. ["VERSION_OF", "USES_STEP"]'),
    node_type: z.array(z.string()).optional().describe('only visit these node types, e.g. ["StrutStep", "Concept"]'),
    namespace: z.string().optional().describe("data partition for the seed search and edge counts"),
    maxHops: z.number().int().positive().default(12).describe("decision rounds; each round judges one node's neighbors and expands at most one"),
    maxNodes: z.number().int().positive().default(25).describe("stop once this many nodes are kept"),
    threshold: z.number().min(0).max(1).default(0.7).describe("minimum relevance probability for a node to be kept in the bundle"),
    provider: z
      .string()
      .optional()
      .describe("anthropic | openai | google | openrouter | xai — usually omitted (inferred from `model`; not used for jev)"),
    model: z
      .string()
      .optional()
      .meta({
        description:
          "the decision model. 'jev' is TypeSafe's evaluation model (TYPESAFE_AI_API_KEY; fast, calibrated probabilities) and the default " +
          "when that key is set; otherwise any language model as in the llm step — a small fast one is ideal (e.g. 'haiku')",
        suggest: "llm-models",
      }),
  }),
  output: z.any(),
  async run(cfg, ctx?: StepContext<StrutCapabilities>) {
    try {
      if (!cfg.start?.length && !cfg.query?.trim()) return "graph/walk failed: needs `start` (ref_ids) or `query`";
      const b = await graphCtx(ctx);
      // No model named: jev when its key is configured, else the deployment's
      // default language model (STRUT_LLM_*), as the llm step would use.
      const em = await resolveEvaluationModel({
        model: cfg.model,
        provider: cfg.provider,
        secrets: ctx?.services?.secrets,
        fallback: { model: process.env["STRUT_LLM_MODEL"], provider: process.env["STRUT_LLM_PROVIDER"] },
      });
      return await runWalk(cfg, { reader: b.reader, evaluate: modelEvaluate(em.model), ctx });
    } catch (e) {
      return errText("graph/walk", e);
    }
  },
});
