// A run's AGENTS as a nested cascade, folded from its event log: every
// `agent` step is a session, an `agent` TOOL call a sub-agent nested under
// the agent that called it, and each session's turns become the rows a
// trace draws — the prompt, pills of tool calls, the graph nodes a call
// named, the sub-agents forking off and merging back, the response.
//
// Ported from hive's Traces view (src/lib/legal-cascade/strut.ts, derive.ts),
// which folded the log into stakgraph's sessions API first and matched a
// fork to its child by prompt text. Here the log is the only source: a
// sub-agent IS its tool call, by path, so nothing is matched.
//
//  - A session's tool calls are the `tool:<name>` events one level below its
//    path (`<agent path>/NNN-<tool>`), with their time, call id and the I/O
//    as the log keeps it (an input whole, an output a 1.5 KB preview).
//  - The nodes a call reported (`step.end.nodes`, the accessed-nodes marker:
//    what the caller NAMED, never a search hit) are what it read, or for a
//    write — `accessOf`, as the run graph classifies — what it wrote. Such a
//    call is drawn as those nodes; the calls between them fold into pills.
//  - Turn 0 is the prompt the step (or the caller's call) handed it; the
//    response is its output.
//  - Reasoning is only in the agent's transcript, which strut records when
//    the agent ends: `transcripts` (by the agent's step path, what
//    `run/transcript` takes) puts each reasoning text before the call it
//    led to (`reasoningByCall`).
//
// Turn orders are fixed slots, so a live chain and its finished form agree:
// the prompt is 0; call k is 3k+2, its result 3k+3, the reasoning before it
// 3k+1; the response 3n+1 for n calls. Pure; re-fold as the log grows.

import { DEFAULT_NODE_TYPE, type AccessedNode } from "./accessed-nodes.js";
import type { TokenUsage } from "./run-overview.js";
import { accessOf } from "./run-graph/project.js";

/** The most of one turn's text the fold keeps. */
export const TRACE_TEXT_MAX = 4_000;
/** The tool name a sub-agent is called by. */
export const SUB_AGENT_TOOL = "agent";

/** An event of the run log, as `run/events` serves it. */
export interface TraceEvent {
  type: string;
  path?: string;
  stepType?: string;
  ts?: string;
  workflow?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  toolCallId?: string;
  nodes?: AccessedNode[];
  modelCalls?: number;
  usage?: Partial<TokenUsage>;
  cost?: number;
  /** An agent's transcript link (the log replaces `messages` with it). */
  transcript?: string;
}

export type TraceStatus = "running" | "success" | "error" | "aborted";
export type TraceTurnKind = "prompt" | "reasoning" | "call" | "result" | "response";

export interface TraceTurn {
  /** Its fixed slot (see the header). */
  order: number;
  kind: TraceTurnKind;
  /** A call's or result's tool, as the model named it (`graph_graph_search`, `bash`, `agent`). */
  tool?: string;
  toolCallId?: string;
  /** A call's or result's step path; a sub-agent's call path is its session's. */
  path?: string;
  text: string;
  /** Epoch ms. */
  at: number | null;
  /** A result the call failed with, or a response the agent failed with. */
  error?: true;
  /** A call: what the tool does to the graph (`accessOf`). */
  access?: "read" | "write";
  /** A call: the nodes it reported when it ended — what it read, or wrote. */
  nodes?: AccessedNode[];
}

export interface TraceSession {
  /** The agent's step path — what `run/transcript` takes. */
  path: string;
  /** The session that called it as a tool; null for an agent step. */
  parent: string | null;
  /** Its path below the workflow (`ingest#0`, `ingest#0/003-agent`). */
  label: string;
  status: TraceStatus;
  startedAt: number | null;
  endedAt: number | null;
  model?: string;
  prompt: string;
  response?: string;
  usage?: TokenUsage;
  cost: number;
  modelCalls: number;
  toolCalls: number;
  /** The transcript link, once the agent ended. */
  transcript?: string;
  /** The reasoning came from its transcript. */
  reasoned: boolean;
  turns: TraceTurn[];
  /** Its sub-agents' paths, in call order. */
  children: string[];
}

export type NodeVerb = "read" | "created" | "edited" | "deleted";

interface RowBase {
  /** The lane: 0 an agent step, +1 per sub-agent nesting. */
  depth: number;
  /** The session the row belongs to; an agent row's is the sub-agent's. */
  session: string;
  at: number | null;
}

export type TraceRow =
  | (RowBase & { kind: "prompt"; text: string })
  | (RowBase & { kind: "response"; text: string; error: boolean; merge: boolean })
  | (RowBase & { kind: "node"; order: number; verb: NodeVerb; node: AccessedNode; tool: string })
  | (RowBase & {
      kind: "pill";
      /** The slot span the pill folds, [from, to]. */
      from: number;
      to: number;
      calls: number;
      reasoning: number;
      /** Calls per tool, most first. */
      mix: Array<{ tool: string; count: number }>;
      durationMs: number | null;
      errors: number;
      turns: TraceTurn[];
      /** The trailing pill of a running session: it grows in place. */
      open: boolean;
    })
  | (RowBase & { kind: "agent"; label: string; prompt: string; status: TraceStatus; hasTrace: boolean });

export interface TraceAgent {
  session: TraceSession;
  /** Its rows, its sub-agents' spliced in at their calls (`depth` the lane). */
  rows: TraceRow[];
  /** It or a sub-agent is still running. */
  live: boolean;
  /** Agents that ran at the same time share a batch (a foreach's iterations, steps in parallel). */
  batch: number;
}

export interface TraceSummary {
  agents: number;
  subAgents: number;
  /** Distinct nodes the rows name. */
  nodes: number;
  toolCalls: number;
  modelCalls: number;
  usage: TokenUsage;
  cost: number;
  running: boolean;
  startedAt: number | null;
}

export interface AgentTraceModel {
  workflow: string;
  /** The run ended: an agent with no end was cut off (`aborted`). */
  finished: boolean;
  /** Every session, in start order. */
  sessions: TraceSession[];
  /** The agent steps, in start order, each with its tree. */
  agents: TraceAgent[];
  summary: TraceSummary;
}

/** An agent's transcript by its step path: the messages, or `run/transcript`'s `{ messages }`. */
export type TraceTranscripts = ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>;

export interface AgentTraceOptions {
  /** The node types a READ shows as a row (default `Concept`); null: every type. A write shows whatever it wrote. */
  readTypes?: readonly string[] | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const ms = (ts: string | undefined): number | null => {
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(t) ? t : null;
};

const cap = (text: string) => (text.length > TRACE_TEXT_MAX ? `${text.slice(0, TRACE_TEXT_MAX)}…` : text);

/** A value as one string: text as it is, anything else as JSON. */
function asText(v: unknown): string {
  if (v === undefined || v === null) return "";
  return cap(typeof v === "string" ? v : JSON.stringify(v));
}

/**
 * A string field of an input or output — an object, or the JSON text the
 * log keeps for a tool's output, whole or cut short at its 1.5 KB preview.
 */
function field(v: unknown, key: string): string | undefined {
  if (isRecord(v)) return typeof v[key] === "string" ? (v[key] as string) : undefined;
  if (typeof v !== "string") return undefined;
  try {
    return field(JSON.parse(v), key);
  } catch {
    // Cut short: read the string up to its closing quote, or to where the cut fell.
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)("?)`).exec(v);
    if (!m) return undefined;
    try {
      return JSON.parse(`"${m[1]!.replace(/\\$/, "")}"`) as string;
    } catch {
      return m[1];
    }
  }
}

function errorText(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return asText(error);
}

/** The agent's answer: its `result`, else its structured `object`, else the output. */
function responseText(output: unknown): string {
  const result = field(output, "result");
  if (result?.trim()) return cap(result);
  const parsed = typeof output === "string" ? safeParse(output) : output;
  if (isRecord(parsed) && parsed.object !== undefined) return asText(parsed.object);
  return asText(output);
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function usageOf(u: Partial<TokenUsage> | undefined): TokenUsage | undefined {
  if (!isRecord(u)) return undefined;
  const n = (k: keyof TokenUsage) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  return { inputTokens: n("inputTokens"), cacheReadTokens: n("cacheReadTokens"), cacheWriteTokens: n("cacheWriteTokens"), outputTokens: n("outputTokens"), totalTokens: n("totalTokens") };
}

const emptyUsage = (): TokenUsage => ({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0 });

/** What a write did, by its tool's name. */
function verbOf(tool: string): NodeVerb {
  const t = tool.toLowerCase();
  if (/(^|[/_-])(delete|remove)([/_-]|$)/.test(t)) return "deleted";
  if (/(^|[/_-])(edit|update|merge|move)([/_-]|$)/.test(t)) return "edited";
  return "created";
}

const reasoningCache = new WeakMap<object, Map<string, string>>();

/**
 * The reasoning before each tool call, from an agent's transcript (AI SDK
 * model messages): the reasoning and text an assistant message holds before
 * a tool call are that call's lead-in.
 */
export function reasoningByCall(messages: unknown): Map<string, string> {
  if (isRecord(messages) && Array.isArray(messages.messages)) return reasoningByCall(messages.messages);
  if (!Array.isArray(messages)) return new Map();
  const known = reasoningCache.get(messages);
  if (known) return known;
  const out = new Map<string, string>();
  let buffer: string[] = [];
  for (const m of messages) {
    if (!isRecord(m) || m.role !== "assistant") continue;
    if (typeof m.content === "string") {
      if (m.content.trim()) buffer.push(m.content.trim());
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (!isRecord(part)) continue;
      if ((part.type === "reasoning" || part.type === "text") && typeof part.text === "string" && part.text.trim()) {
        buffer.push(part.text.trim());
      } else if (part.type === "tool-call" && typeof part.toolCallId === "string") {
        if (buffer.length) out.set(part.toolCallId, cap(buffer.join("\n\n")));
        buffer = [];
      }
    }
  }
  reasoningCache.set(messages, out);
  return out;
}

interface Call {
  start: TraceEvent;
  end: TraceEvent | null;
}

interface Building {
  path: string;
  parent: string | null;
  start: TraceEvent;
  prompt: string;
  model?: string;
  calls: Call[];
  end: TraceEvent | null;
}

function transcriptOf(transcripts: TraceTranscripts | undefined, path: string): unknown {
  if (!transcripts) return undefined;
  return transcripts instanceof Map ? transcripts.get(path) : (transcripts as Record<string, unknown>)[path];
}

function sessionOf(b: Building, root: string, finished: boolean, reasoning: Map<string, string> | undefined): TraceSession {
  const turns: TraceTurn[] = [{ order: 0, kind: "prompt", text: b.prompt, at: ms(b.start.ts) }];
  const children: string[] = [];
  b.calls.forEach(({ start, end }, k) => {
    const tool = (start.stepType ?? "tool:unknown").slice("tool:".length);
    const access = accessOf(tool);
    const id = start.toolCallId;
    if (tool === SUB_AGENT_TOOL && start.path) children.push(start.path);
    const lead = id ? reasoning?.get(id) : undefined;
    if (lead) turns.push({ order: 3 * k + 1, kind: "reasoning", text: lead, at: ms(start.ts) });
    const nodes = end?.type === "step.end" && end.nodes?.length ? end.nodes : undefined;
    turns.push({
      order: 3 * k + 2,
      kind: "call",
      tool,
      ...(id ? { toolCallId: id } : {}),
      ...(start.path ? { path: start.path } : {}),
      text: asText(start.input),
      at: ms(start.ts),
      access,
      ...(nodes ? { nodes } : {}),
    });
    if (!end) return;
    const failed = end.type === "step.error";
    turns.push({
      order: 3 * k + 3,
      kind: "result",
      tool,
      ...(id ? { toolCallId: id } : {}),
      ...(start.path ? { path: start.path } : {}),
      text: failed ? `Error: ${errorText(end.error)}` : asText(end.output),
      at: ms(end.ts),
      ...(failed ? { error: true as const } : {}),
    });
  });
  const end = b.end;
  if (end) {
    const failed = end.type === "step.error";
    turns.push({
      order: 3 * b.calls.length + 1,
      kind: "response",
      text: failed ? `Error: ${errorText(end.error)}` : responseText(end.output),
      at: ms(end.ts),
      ...(failed ? { error: true as const } : {}),
    });
  }
  const status: TraceStatus = end ? (end.type === "step.error" ? "error" : "success") : finished ? "aborted" : "running";
  const usage = usageOf(end?.usage);
  const label = b.path.startsWith(`${root}/`) ? b.path.slice(root.length + 1) : b.path;
  return {
    path: b.path,
    parent: b.parent,
    label,
    status,
    startedAt: ms(b.start.ts),
    endedAt: end ? ms(end.ts) : null,
    ...(b.model ? { model: b.model } : {}),
    prompt: b.prompt,
    ...(end && end.type !== "step.error" ? { response: responseText(end.output) } : {}),
    ...(usage ? { usage } : {}),
    cost: typeof end?.cost === "number" ? end.cost : 0,
    modelCalls: typeof end?.modelCalls === "number" ? end.modelCalls : 0,
    toolCalls: b.calls.length,
    ...(typeof end?.transcript === "string" ? { transcript: end.transcript } : {}),
    reasoned: !!reasoning,
    turns,
    children,
  };
}

/** Fold one session's turns into rows, splicing each sub-agent's rows (recursively) in at its call. */
function rowsOf(s: TraceSession, depth: number, byPath: Map<string, TraceSession>, readable: (n: AccessedNode) => boolean): TraceRow[] {
  const rows: TraceRow[] = [];
  let pending: TraceTurn[] = [];
  const flush = () => {
    if (pending.length) rows.push(pill(pending, s.path, depth));
    pending = [];
  };
  const nodeRows = (t: TraceTurn, verb: NodeVerb, nodes: AccessedNode[]) => {
    flush();
    for (const node of nodes) rows.push({ kind: "node", depth, session: s.path, at: t.at, order: t.order, verb, node, tool: t.tool ?? "" });
  };
  // A call shown as its nodes, or as a sub-agent's lane, is whole there: its
  // result is not a turn of its own (a sub-agent's answer is its response
  // row, where the lane merges back).
  const consumed = new Set(s.children);
  // A write shows whatever it wrote; a read, the types the trace reads.
  const shown = (t: TraceTurn) => (t.access === "write" ? (t.nodes ?? []) : (t.nodes ?? []).filter(readable));

  for (const t of s.turns) {
    if (t.kind === "prompt") {
      // A sub-agent's prompt lives on its agent row.
      if (depth > 0) continue;
      flush();
      rows.push({ kind: "prompt", depth, session: s.path, at: t.at, text: t.text });
    } else if (t.kind === "response") {
      flush();
      rows.push({ kind: "response", depth, session: s.path, at: t.at, text: t.text, error: !!t.error, merge: false });
    } else if (t.kind === "call" && t.tool === SUB_AGENT_TOOL && t.path && byPath.has(t.path)) {
      flush();
      const child = byPath.get(t.path)!;
      rows.push({ kind: "agent", depth: depth + 1, session: child.path, at: child.startedAt, label: child.label, prompt: child.prompt, status: child.status, hasTrace: child.turns.length > 1 || child.status === "running" });
      const inner = rowsOf(child, depth + 1, byPath, readable);
      const last = inner[inner.length - 1];
      if (last?.kind === "response") last.merge = true;
      rows.push(...inner);
    } else if (t.kind === "result" && t.path && consumed.has(t.path)) {
      continue;
    } else if (t.kind === "call" && shown(t).length) {
      nodeRows(t, t.access === "write" ? verbOf(t.tool ?? "") : "read", shown(t));
      if (t.path) consumed.add(t.path);
    } else {
      pending.push(t);
    }
  }
  flush();
  const last = rows[rows.length - 1];
  if (s.status === "running" && last?.kind === "pill") last.open = true;
  return rows;
}

function pill(turns: TraceTurn[], session: string, depth: number): Extract<TraceRow, { kind: "pill" }> {
  const tally = new Map<string, number>();
  let calls = 0;
  let reasoning = 0;
  let errors = 0;
  for (const t of turns) {
    if (t.kind === "call") {
      calls++;
      tally.set(t.tool ?? "unknown", (tally.get(t.tool ?? "unknown") ?? 0) + 1);
    } else if (t.kind === "reasoning") reasoning++;
    else if (t.kind === "result" && t.error) errors++;
  }
  const stamps = turns.map((t) => t.at).filter((x): x is number => x !== null);
  return {
    kind: "pill",
    depth,
    session,
    at: turns[0]!.at,
    from: turns[0]!.order,
    to: turns[turns.length - 1]!.order,
    calls,
    reasoning,
    mix: [...tally].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count),
    durationMs: stamps.length >= 2 ? Math.max(...stamps) - Math.min(...stamps) : null,
    errors,
    turns,
    open: false,
  };
}

const nodeKey = (n: AccessedNode) => (n.peer ? `${n.peer}:${n.ref_id}` : n.ref_id);

/**
 * A run's agents as a cascade: one tree per `agent` step, in start order,
 * grouped into batches that ran at the same time; each sub-agent nested
 * under the call that started it. `transcripts` (an agent's, by its step
 * path) adds its reasoning before the calls it led to; an agent still
 * running has none yet — strut writes the transcript when the agent ends.
 */
export function foldAgentTrace(events: readonly TraceEvent[], transcripts?: TraceTranscripts, opts: AgentTraceOptions = {}): AgentTraceModel {
  let root = "";
  let finished = false;
  const building = new Map<string, Building>();
  const calls = new Map<string, Call>();

  for (const e of events) {
    switch (e.type) {
      case "run.start":
        root ||= e.workflow ?? e.path ?? "";
        continue;
      case "run.end":
      case "run.error":
      case "run.cancelled":
        finished = true;
        continue;
      case "run.resumed":
        finished = false;
        continue;
    }
    if (!e.path || !e.stepType) continue;
    const parent = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "";

    if (e.stepType === "agent") {
      if (e.type === "step.start" || e.type === "step.replayed") {
        // A new attempt starts its session afresh, sub-agents and all.
        for (const p of building.keys()) if (p.startsWith(`${e.path}/`)) building.delete(p);
        const b: Building = { path: e.path, parent: null, start: e, prompt: asText(field(e.input, "prompt")), calls: [], end: e.type === "step.replayed" ? e : null };
        const model = field(e.input, "model");
        if (model) b.model = model;
        building.set(e.path, b);
      } else if (e.type === "step.end" || e.type === "step.error") {
        const b = building.get(e.path);
        if (b) b.end = e;
      }
      continue;
    }

    if (!e.stepType.startsWith("tool:")) continue;
    const owner = building.get(parent);
    if (!owner) continue;
    if (e.type === "step.start") {
      const call: Call = { start: e, end: null };
      owner.calls.push(call);
      calls.set(e.path, call);
      if (e.stepType === `tool:${SUB_AGENT_TOOL}`) {
        for (const p of building.keys()) if (p.startsWith(`${e.path}/`)) building.delete(p);
        const b: Building = { path: e.path, parent: owner.path, start: e, prompt: asText(field(e.input, "prompt")), calls: [], end: null };
        const model = field(e.input, "model") ?? owner.model;
        if (model) b.model = model;
        building.set(e.path, b);
      }
    } else if (e.type === "step.end" || e.type === "step.error") {
      const call = calls.get(e.path);
      if (call) call.end = e;
      const sub = e.stepType === `tool:${SUB_AGENT_TOOL}` ? building.get(e.path) : undefined;
      if (sub) sub.end = e;
    }
  }

  const sessions: TraceSession[] = [];
  for (const b of building.values()) {
    const t = transcriptOf(transcripts, b.path);
    sessions.push(sessionOf(b, root, finished, t === undefined ? undefined : reasoningByCall(t)));
  }
  sessions.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.path.localeCompare(b.path));
  const byPath = new Map(sessions.map((s) => [s.path, s]));

  const types = opts.readTypes === undefined ? [DEFAULT_NODE_TYPE] : opts.readTypes;
  const readable = (n: AccessedNode) => types === null || (!!n.node_type && types.includes(n.node_type));

  const liveUnder = (s: TraceSession): boolean => s.status === "running" || s.children.some((c) => byPath.has(c) && liveUnder(byPath.get(c)!));

  // A batch: agents that ran at the same time — each one started before the
  // batch's first had ended (or while it is still running).
  let batch = -1;
  let batchEnd = -Infinity;
  const agents: TraceAgent[] = sessions
    .filter((s) => s.parent === null)
    .map((session) => {
      const start = session.startedAt ?? 0;
      if (!(start < batchEnd)) {
        batch++;
        batchEnd = session.endedAt ?? Infinity;
      }
      return { session, rows: rowsOf(session, 0, byPath, readable), live: liveUnder(session), batch };
    });

  const named = new Set<string>();
  for (const a of agents) for (const r of a.rows) if (r.kind === "node") named.add(nodeKey(r.node));
  const usage = emptyUsage();
  let cost = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  let startedAt: number | null = null;
  for (const s of sessions) {
    for (const k of Object.keys(usage) as (keyof TokenUsage)[]) usage[k] += s.usage?.[k] ?? 0;
    cost += s.cost;
    modelCalls += s.modelCalls;
    toolCalls += s.toolCalls;
    if (s.startedAt !== null) startedAt = startedAt === null ? s.startedAt : Math.min(startedAt, s.startedAt);
  }

  return {
    workflow: root,
    finished,
    sessions,
    agents,
    summary: {
      agents: agents.length,
      subAgents: sessions.length - agents.length,
      nodes: named.size,
      toolCalls,
      modelCalls,
      usage,
      cost,
      running: agents.some((a) => a.live),
      startedAt,
    },
  };
}
