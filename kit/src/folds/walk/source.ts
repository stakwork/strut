/**
 * The walks in a run, as ONE event shape: the per-hop events `graph/walk`
 * emits (strut src/steps/lib/graph/walk.ts, plans/graph-walk.md). Pure.
 *
 * A walk comes from one of two places:
 *
 *  - A `graph/walk` step — in the workflow, or an agent's tool call — emits
 *    two events per hop at `<its path>/NNN-hop`, `stepType: "walk:hop"`,
 *    `iteration` the hop: `step.start` with what the hop discovered
 *    (`input: { hop, expanded, candidates[{ ref_id, node_type, name, via,
 *    merged_into? }] }`) and `step.end` with the decider's verdicts
 *    (`output: { verdicts[{ ref_id, relevance, kept }], next, sufficient }`).
 *    They are taken as they are.
 *  - An agent that walks by hand — `graph_graph_get` with `children`,
 *    `graph_graph_neighbors`, `graph_graph_search`, then reading one of what
 *    came back — leaves the same choices in its tool calls. A call that
 *    LISTED nodes (children, neighbours, hits) opens a hop with them as the
 *    candidates; the next call that reads nodes (by `ref_id`, or type and
 *    name; one, or several at once with `graph_get_batched`) closes it, the
 *    nodes it read the ones chosen. A node read that no open choice listed
 *    is a hop of its own from the node the walk was on (a jump), or one of
 *    the walk's seeds when it was on none. The listed nodes
 *    are in the call's output, which the log keeps as a 1.5 KB preview: what
 *    the preview cut is read back from the agent's transcript once it has
 *    ended (`toolResultsByCall`), so a live agent's hop may show fewer
 *    candidates than its finished form.
 *
 * Both become `WalkHopEvent[]`, which the trail (./trail.ts) and the graph
 * (./graph.ts) fold.
 */

import { accessOf, isSearch } from "../run-graph/project.js";

/** A node as a walk names it. */
export interface WalkBrief {
  ref_id: string;
  node_type: string;
  name: string;
}

/** The edge a candidate arrived by. */
export interface WalkVia {
  from: string;
  edge_type: string;
  direction: "forward" | "reverse";
  properties?: Record<string, unknown>;
}

export interface WalkCandidateRef extends WalkBrief {
  via?: WalkVia;
  /** Evidence folded into an earlier candidate (same claim, same verdict). */
  merged_into?: string;
}

export interface WalkVerdict {
  ref_id: string;
  /** The decider's relevance; none for an agent's own choice. */
  relevance?: number;
  kept: boolean;
}

/** One hop event, as `graph/walk` emits it (an agent's are built to match). */
export interface WalkHopEvent {
  type: "step.start" | "step.end" | "step.error";
  iteration: number;
  ts?: string;
  input?: { hop: number; expanded: WalkBrief | null; candidates: WalkCandidateRef[] };
  /** `next`: the node the hop went to; `chosen`: every one of them, when it went to several at once (an agent reading several nodes in one call). */
  output?: { verdicts: WalkVerdict[]; next?: WalkBrief; chosen?: WalkBrief[]; sufficient?: number };
  error?: { message: string };
}

export type WalkSourceKind = "walk" | "agent";
export type WalkStatus = "running" | "done" | "error";

/** A walk found in a run's log. */
export interface WalkSource {
  /** The `graph/walk` step's path (or its tool call's), or the agent's. */
  path: string;
  kind: WalkSourceKind;
  /** Its step id or tool, as a person reads it: `gather`, `explore`. */
  label: string;
  goal?: string;
  status: WalkStatus;
  /** Why a `graph/walk` stopped: sufficient | plateau | hops | nodes | exhausted. */
  stopped?: string;
  error?: string;
  /** When it started (the log's `ts`). */
  startedAt?: string;
  hops: WalkHopEvent[];
}

/** An event of the run log, as `run/events` serves it. */
export interface WalkLogEvent {
  type: string;
  path?: string;
  stepType?: string;
  ts?: string;
  iteration?: number;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  toolCallId?: string;
  nodes?: unknown;
}

export interface FindWalksOptions {
  /** A tool call's whole result by its `toolCallId`, read from the agent's
   *  transcript (`toolResultsByCall`): what the log's preview cut. */
  results?: ReadonlyMap<string, unknown>;
}

const HOP_TYPE = "walk:hop";
const HOP_RE = /^(.*)\/\d{3,}-hop$/;
const TOOL_PREFIX = "tool:";
const TERMINAL = new Set(["run.end", "run.error", "run.cancelled"]);
/** The steps that run a workflow of their own: the nodes they report are the child run's. */
const LAUNCHERS = /(^|_)(meta|strut)_run_workflow$/;
const WALK_STEP = /(^|[/_])graph[/_]walk$|^graph_graph_walk$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** `research/explore/004-graph_graph_walk` → `graph_graph_walk`; `research/gather` → `gather`. */
export function walkLabel(path: string): string {
  const last = path.split("/").pop() ?? path;
  return last.replace(/^\d{3,}-/, "");
}

/** An input or output as the log keeps it: an object, or JSON text (whole, or cut short). */
function parsed(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

/** The fields of a brief that the preview's JSON spells in this order. */
const BRIEF_RE = /\{"ref_id":"((?:[^"\\]|\\.)*)","(node_type|name)":"((?:[^"\\]|\\.)*)","(node_type|name)":"((?:[^"\\]|\\.)*)"(?:,"edge_type":"((?:[^"\\]|\\.)*)","direction":"(forward|reverse)")?/g;

const unescape = (s: string): string => {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
};

interface Listed extends WalkBrief {
  edge_type?: string;
  direction?: "forward" | "reverse";
}

function listedOf(item: unknown): Listed | null {
  if (!isRecord(item)) return null;
  const ref_id = str(item.ref_id);
  if (!ref_id) return null;
  const dir = item.direction === "forward" || item.direction === "reverse" ? item.direction : undefined;
  return {
    ref_id,
    node_type: str(item.node_type) ?? "Node",
    name: str(item.name) ?? "",
    ...(str(item.edge_type) ? { edge_type: item.edge_type as string } : {}),
    ...(dir ? { direction: dir } : {}),
  };
}

/**
 * The nodes a call's output LISTS: a node's `children` (graph-get), the
 * neighbours (graph-neighbors), the hits (graph-search) — whole, or as many
 * as a cut preview still spells out.
 */
export function listedNodes(output: unknown): Listed[] {
  const v = parsed(output);
  const list = Array.isArray(v) ? v : isRecord(v) ? (Array.isArray(v.children) ? v.children : Array.isArray(v.nodes) ? v.nodes : Array.isArray(v.hits) ? v.hits : null) : null;
  if (list) return list.map(listedOf).filter((n): n is Listed => !!n);
  if (typeof v !== "string") return [];
  // A preview cut mid-JSON: every complete brief in it. A graph-get's own
  // node leads its object and is left out by the caller.
  const out: Listed[] = [];
  for (const m of v.matchAll(BRIEF_RE)) {
    const fields: Record<string, string> = { [m[2]!]: unescape(m[3]!), [m[4]!]: unescape(m[5]!) };
    out.push({
      ref_id: unescape(m[1]!),
      node_type: fields.node_type || "Node",
      name: fields.name ?? "",
      ...(m[6] ? { edge_type: unescape(m[6]) } : {}),
      ...(m[7] ? { direction: m[7] as "forward" | "reverse" } : {}),
    });
  }
  return out;
}

/**
 * Each tool call's whole result in an agent's transcript (AI SDK model
 * messages, as `run/transcript` serves them), by `toolCallId`: a stored
 * `{ type: "json" | "text" | "content", value }`, its value; text parsed
 * when it is JSON.
 */
export function toolResultsByCall(messages: unknown): Map<string, unknown> {
  if (isRecord(messages) && Array.isArray(messages.messages)) return toolResultsByCall(messages.messages);
  const out = new Map<string, unknown>();
  if (!Array.isArray(messages)) return out;
  for (const m of messages) {
    if (!isRecord(m) || m.role !== "tool" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (!isRecord(part) || part.type !== "tool-result" || typeof part.toolCallId !== "string") continue;
      const o = "output" in part ? part.output : part.result;
      let value: unknown = o;
      if (isRecord(o) && typeof o.type === "string" && "value" in o) {
        value = o.value;
        if (o.type === "content" && Array.isArray(value)) {
          const text = value.find((p) => isRecord(p) && p.type === "text" && typeof p.text === "string") as { text: string } | undefined;
          value = text?.text;
        }
      }
      out.set(part.toolCallId, parsed(value));
    }
  }
  return out;
}

/** The nodes a call reported reading (`withAccessedNodes`): one, or several read at once (`graph_get_batched`). */
function reportedNodes(nodes: unknown): WalkBrief[] {
  if (!Array.isArray(nodes)) return [];
  const out: WalkBrief[] = [];
  for (const item of nodes) {
    const n = listedOf(item);
    if (n && !out.some((o) => o.ref_id === n.ref_id)) out.push(brief(n));
  }
  return out;
}

const brief = (n: WalkBrief): WalkBrief => ({ ref_id: n.ref_id, node_type: n.node_type, name: n.name });

/** A hop's choice as its `step.end` says it: `next` the node it went to, `chosen` all of them when it went to several. */
const choiceOf = (went: readonly WalkBrief[]): Pick<NonNullable<WalkHopEvent["output"]>, "next" | "chosen"> =>
  went.length > 1 ? { next: went[0]!, chosen: [...went] } : went.length === 1 ? { next: went[0]! } : {};

/** An agent's tool call that may move it through the graph: a read. */
export interface WalkToolCall {
  tool: string;
  start: WalkLogEvent;
  /** Its `step.end` (or `step.error`), once it has ended. */
  end: WalkLogEvent | null;
}

/**
 * An agent's graph tool calls as hop events (the header's second source),
 * given in the order the calls ENDED. A call that read nodes (it reported
 * them, `withAccessedNodes`) is a move — one node, or several read at once:
 * it closes the choice open with every one of them among its candidates as
 * chosen, and the ones no choice listed are a hop of their own, from the
 * node the walk was on (the walk's seeds when it was on none). Reading again
 * a node the walk is on is no hop. A call whose output lists nodes opens the
 * next choice, with them as its candidates. `ended` (the agent's end) closes
 * a choice it left open.
 */
export function agentWalkHops(calls: readonly WalkToolCall[], ended: { ts?: string } | null, opts: FindWalksOptions = {}): WalkHopEvent[] {
  const hops: WalkHopEvent[] = [];
  /** Every node any call listed, with the edge it came by: a jump's via. */
  const seen = new Map<string, WalkCandidateRef>();
  let open: { iteration: number; candidates: WalkCandidateRef[] } | null = null;
  /** The node the walk is on (the last one read), and every node its last move went to. */
  let from: WalkBrief | null = null;
  let on = new Set<string>();
  let hop = 0;

  const close = (ts: string | undefined, went: readonly WalkBrief[] = []) => {
    if (!open) return;
    const picked = new Set(went.map((n) => n.ref_id));
    hops.push({
      type: "step.end",
      iteration: open.iteration,
      ...(ts ? { ts } : {}),
      output: { verdicts: open.candidates.map((c) => ({ ref_id: c.ref_id, kept: picked.has(c.ref_id) })), ...choiceOf(went) },
    });
    open = null;
  };

  for (const call of calls) {
    if (call.end?.type !== "step.end") continue;
    const e = call.end!;
    const ts = e.ts;
    const reads = isSearch(call.tool) ? [] : reportedNodes(e.nodes);
    if (reads.length) {
      const offered = new Set(((open as { candidates: WalkCandidateRef[] } | null)?.candidates ?? []).map((c) => c.ref_id));
      const chosen = reads.filter((n) => offered.has(n.ref_id));
      // Not among the open choice's candidates, nor where the walk already
      // is: a hop of its own — a seed, or a jump.
      const elsewhere = reads.filter((n) => !offered.has(n.ref_id) && !on.has(n.ref_id));
      if (chosen.length || elsewhere.length) close(ts, chosen);
      if (elsewhere.length) {
        const targets: WalkCandidateRef[] = elsewhere.map((n) => ({ ...(seen.get(n.ref_id) ?? {}), ...n }));
        const iteration = hop++;
        hops.push({ type: "step.start", iteration, ...(ts ? { ts } : {}), input: { hop: iteration, expanded: from, candidates: targets } });
        hops.push({ type: "step.end", iteration, ...(ts ? { ts } : {}), output: { verdicts: elsewhere.map((n) => ({ ref_id: n.ref_id, kept: true })), ...choiceOf(elsewhere) } });
      }
      from = reads.at(-1)!;
      on = new Set(reads.map((n) => n.ref_id));
    }
    const toolCallId = call.start.toolCallId ?? e.toolCallId;
    const result = toolCallId ? opts.results?.get(toolCallId) : undefined;
    const readIds = new Set(reads.map((n) => n.ref_id));
    const listed = listedNodes(result ?? e.output).filter((n) => !readIds.has(n.ref_id));
    if (!listed.length) continue;
    // What a call lists hangs off the one node it read.
    const read = reads.length === 1 ? reads[0]! : null;
    const input = parsed(call.start.input);
    const childEdge = isRecord(input) ? str(input.children) : undefined;
    const candidates: WalkCandidateRef[] = [];
    const unique = new Set<string>();
    for (const n of listed) {
      if (unique.has(n.ref_id)) continue;
      unique.add(n.ref_id);
      const edge = n.edge_type ?? (childEdge ? childEdge.trim().toUpperCase().replace(/ /g, "_") : undefined);
      const c: WalkCandidateRef = { ...brief(n), ...(read && edge ? { via: { from: read.ref_id, edge_type: edge, direction: n.direction ?? "forward" } } : {}) };
      candidates.push(c);
      if (!seen.has(c.ref_id)) seen.set(c.ref_id, c);
    }
    close(ts);
    const iteration = hop++;
    hops.push({ type: "step.start", iteration, ...(ts ? { ts } : {}), input: { hop: iteration, expanded: read, candidates } });
    open = { iteration, candidates };
  }
  if (ended) close(ended.ts);
  return hops;
}

/** A `graph/walk` step's hop events, as the log keeps them. */
function walkHopOf(e: WalkLogEvent): WalkHopEvent | null {
  if (e.type !== "step.start" && e.type !== "step.end" && e.type !== "step.error") return null;
  const iteration = typeof e.iteration === "number" ? e.iteration : Number((e.path ?? "").match(/(\d{3,})-hop$/)?.[1] ?? 1) - 1;
  const hop: WalkHopEvent = { type: e.type, iteration, ...(e.ts ? { ts: e.ts } : {}) };
  if (e.type === "step.start" && isRecord(e.input)) hop.input = e.input as unknown as WalkHopEvent["input"];
  if (e.type === "step.end" && isRecord(e.output)) hop.output = e.output as unknown as WalkHopEvent["output"];
  if (e.type === "step.error") hop.error = { message: isRecord(e.error) && typeof e.error.message === "string" ? e.error.message : "walk failed" };
  return hop;
}

/** A string output that a step returned in place of its result (`graph/walk failed: …`). */
function failedText(v: unknown): string | undefined {
  return typeof v === "string" && /^[\w/-]+ failed:/.test(v.trim()) ? v.trim() : undefined;
}

/** `"stopped":"plateau"` in an object or a cut preview. */
function stoppedOf(v: unknown): string | undefined {
  const p = parsed(v);
  if (isRecord(p)) return str(p.stopped);
  return typeof v === "string" ? v.match(/"stopped":"(\w+)"/)?.[1] : undefined;
}

/** The most of a goal (or an agent's prompt) a walk keeps. */
export const WALK_GOAL_MAX = 240;

/** What the walk was for: a `graph/walk`'s `goal`, an agent's prompt, cut short. */
function goalOf(v: unknown): string | undefined {
  const p = parsed(v);
  const goal = isRecord(p) ? (str(p.goal) ?? str(p.prompt)) : typeof v === "string" ? v.match(/"goal":"((?:[^"\\]|\\.)*)"/)?.[1] : undefined;
  if (!goal) return undefined;
  const t = goal.trim().replace(/\s+/g, " ");
  return t.length > WALK_GOAL_MAX ? `${t.slice(0, WALK_GOAL_MAX - 1)}…` : t;
}

/**
 * Every walk in a run's log, in the order they started: each `graph/walk`
 * (a step, or an agent's tool call) and each agent whose own tool calls
 * read the graph one node at a time. Re-fold as the log grows.
 */
export function findWalks(events: readonly WalkLogEvent[], opts: FindWalksOptions = {}): WalkSource[] {
  const settled = events.some((e) => TERMINAL.has(e.type));
  const steps = new Map<string, { start: WalkLogEvent | null; end: WalkLogEvent | null; stepType?: string }>();
  const walkHops = new Map<string, WalkLogEvent[]>();
  /** Each agent's read calls, in the order they ended. */
  const agentCalls = new Map<string, WalkToolCall[]>();
  const open = new Map<string, WalkToolCall>();

  for (const e of events) {
    const path = e.path;
    if (!path) continue;
    if (e.stepType === HOP_TYPE) {
      const parent = path.match(HOP_RE)?.[1];
      if (!parent) continue;
      const list = walkHops.get(parent) ?? [];
      list.push(e);
      walkHops.set(parent, list);
      continue;
    }
    if (e.type === "step.start" || e.type === "step.end" || e.type === "step.error") {
      const s = steps.get(path) ?? { start: null, end: null };
      if (e.type === "step.start") {
        s.start = e;
        s.end = null; // a retry starts over
        s.stepType = e.stepType;
      } else s.end = e;
      steps.set(path, s);
    }
    // A tool call one level under an agent.
    if (e.stepType?.startsWith(TOOL_PREFIX)) {
      const tool = e.stepType.slice(TOOL_PREFIX.length);
      const slash = path.lastIndexOf("/");
      const parent = slash > 0 ? path.slice(0, slash) : "";
      if (!parent || tool === "agent" || LAUNCHERS.test(tool) || WALK_STEP.test(tool) || accessOf(tool) !== "read") continue;
      if (e.type === "step.start") open.set(path, { start: e, end: null, tool });
      else if (e.type === "step.end" || e.type === "step.error") {
        const call = open.get(path);
        if (!call) continue;
        open.delete(path);
        call.end = e;
        const list = agentCalls.get(parent) ?? [];
        list.push(call);
        agentCalls.set(parent, list);
      }
    }
  }

  const status = (s: { start: WalkLogEvent | null; end: WalkLogEvent | null } | undefined): { status: WalkStatus; error?: string } => {
    if (s?.end) {
      if (s.end.type === "step.error") return { status: "error", error: isRecord(s.end.error) && typeof s.end.error.message === "string" ? s.end.error.message : "failed" };
      const failed = failedText(s.end.output);
      return failed ? { status: "error", error: failed } : { status: "done" };
    }
    return settled ? { status: "error", error: "the run ended before it did" } : { status: "running" };
  };

  const out: WalkSource[] = [];
  const walkPaths = new Set<string>(walkHops.keys());
  for (const [path, s] of steps) if (s.stepType && WALK_STEP.test(s.stepType.replace(TOOL_PREFIX, ""))) walkPaths.add(path);
  for (const path of walkPaths) {
    const s = steps.get(path);
    const hops = (walkHops.get(path) ?? []).map(walkHopOf).filter((h): h is WalkHopEvent => !!h);
    const st = status(s);
    const hopError = hops.find((h) => h.type === "step.error")?.error?.message;
    const goal = goalOf(s?.start?.input);
    const stopped = s?.end ? stoppedOf(s.end.output) : undefined;
    out.push({
      path,
      kind: "walk",
      label: walkLabel(path),
      ...(goal ? { goal } : {}),
      status: hopError ? "error" : st.status,
      ...(stopped ? { stopped } : {}),
      ...(hopError || st.error ? { error: hopError ?? st.error } : {}),
      ...(s?.start?.ts ?? hops[0]?.ts ? { startedAt: s?.start?.ts ?? hops[0]?.ts } : {}),
      hops,
    });
  }
  for (const [path, calls] of agentCalls) {
    const s = steps.get(path);
    const st = status(s);
    const hops = agentWalkHops(calls, s?.end ?? (settled ? {} : null), opts);
    // A walk is at least one node read: a search alone, or a bash, is not one.
    if (!hops.some((h) => h.type === "step.end" && h.output?.next)) continue;
    const goal = goalOf(s?.start?.input);
    out.push({
      path,
      kind: "agent",
      label: walkLabel(path),
      ...(goal ? { goal } : {}),
      status: st.status,
      ...(st.error ? { error: st.error } : {}),
      ...(s?.start?.ts ?? calls[0]?.start.ts ? { startedAt: s?.start?.ts ?? calls[0]?.start.ts } : {}),
      hops,
    });
  }
  const first = new Map<string, number>();
  events.forEach((e, i) => {
    if (e.path && !first.has(e.path)) first.set(e.path, i);
  });
  const at = (w: WalkSource) => first.get(w.path) ?? first.get(`${w.path}/001-hop`) ?? Number.MAX_SAFE_INTEGER;
  return out.sort((a, b) => at(a) - at(b));
}

/** The walk to show by default: the one that started last. */
export function latestWalk(walks: readonly WalkSource[]): WalkSource | undefined {
  return walks[walks.length - 1];
}
