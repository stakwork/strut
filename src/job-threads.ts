/**
 * A job's THREADS (plans/jobs-sidebar.md §1): every agent execution found
 * in the job's runs' logs, grouped by session, each turn pointing at its
 * run and step path with its usage, cost, context, tool-call count and the
 * artifacts the run declared — and under each turn, what it caused:
 * sub-agents (an `agent` granted as a tool), child runs (`parentRunId`),
 * peer runs (`strut/run-workflow`). The operator's timeline of a job, read
 * by `GET /jobs/:id` (`threads`) and rendered by the web UI.
 *
 * Generic by construction (ruling 2): nothing here names a workflow or a
 * step id. An execution is a `step.end` carrying `messages` — the marker
 * the runner and `wrapToolsWithEmit` lift (`withMessages`, src/core.ts) —
 * or an attempt by the one core step strut itself runs a model with
 * (`agent`), which a failed or cancelled turn leaves without messages (a
 * failed turn commits nothing, plans/agent-sessions.md). A thread is that
 * execution's `output.session.id` when it continued one, else the
 * execution alone. A run with no execution at all is one turn at its root,
 * so a plain workflow's artifacts still show. Pure: a function of events,
 * summaries and the session turn lines; the index reads the stores.
 */
import type { AccessedNode, RunEvent, RunSummary } from "./core.js";
import type { ArtifactRef } from "./artifact-refs.js";
import type { SessionTurn } from "./session-store.js";
import { addUsage, coerceUsage, emptyUsage, type TokenUsage } from "./pricing.js";

export type TurnStatus = "success" | "error" | "cancelled" | "running";

/** One agent execution — or a peer run, or a run with no agent at all. */
export interface JobTurn {
  runId: string;
  workflow: string;
  /** The step path (`job/work`, a sub-agent's `job/work/004-agent`); the
   *  run's root path for a run with no execution. */
  path: string;
  /** `agent`, `tool:agent`, a marked lib step's type, `strut/run-workflow`
   *  for a peer run, `run` for a run with no execution. */
  stepType: string;
  /** The path's leaf without a tool counter (`work`, `agent`), the
   *  workflow for a run-root turn, `@<peer> <workflow>` for a peer run. */
  label: string;
  at: string;
  durationMs?: number;
  status: TurnStatus;
  /** The session turn, when the execution continued a thread, and where
   *  it starts in the thread's messages (the transcript's turn mark). */
  turn?: number;
  offset?: number;
  session?: string;
  usage?: TokenUsage;
  cost?: number;
  /** The thread's context after this turn (from the turn line). */
  context?: { used: number; limit: number };
  /** Tool calls the execution made itself (its direct children). */
  toolCalls: number;
  /** `/workflows/…/transcripts/<path>` (+ `?full=1` for a session turn);
   *  absent when the log holds no messages. */
  transcript?: string;
  /** The RUN's declared deliverables, on its last top-level turn. */
  artifacts?: ArtifactRef[];
  /** Distinct graph nodes touched at or under the path. */
  nodeCount: number;
  /** The nodes themselves, when asked for. */
  nodes?: AccessedNode[];
  /** Threads this turn caused: sub-agents under its path, child runs it
   *  launched, peer runs — chronological. */
  spawned: JobThread[];
  /** A `strut/run-workflow` execution: the peer's run, drillable nowhere here. */
  peer?: { id: string; workflow: string; runId: string; status: string };
}

export interface JobTotals {
  turns: number;
  usage: TokenUsage;
  cost: number;
  toolCalls: number;
  context?: { used: number; limit: number };
}

/** A thread: one session's turns, or one cold execution. */
export interface JobThread {
  /** The session id, else `<runId>/<path>`. */
  id: string;
  session: boolean;
  label: string;
  startedAt: string;
  updatedAt: string;
  /** Chronological (by session turn, then time). */
  turns: JobTurn[];
  /** Own turns only; `jobTotals` rolls a tree up. */
  totals: JobTotals;
}

/** One run of the job as the fold reads it: its summary (none while it
 *  runs), its log, and its declared deliverables already resolved. */
export interface ThreadRun {
  workflow: string;
  runId: string;
  at: string;
  parentRunId?: string;
  summary?: RunSummary | null;
  events: RunEvent[];
  artifacts?: ArtifactRef[];
}

/** Where one agent session of a run is served (`GET …/transcripts/<path>`);
 *  each path segment encoded (`#` in foreach paths). */
export function transcriptUrl(workflow: string, runId: string, stepPath: string): string {
  return (
    `/workflows/${encodeURIComponent(workflow)}/runs/${encodeURIComponent(runId)}/transcripts/` +
    stepPath.split("/").map(encodeURIComponent).join("/")
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const baseType = (stepType: string | undefined) => (stepType ?? "").replace(/^tool:/, "");
/** The core step that runs a model: an attempt of it is a turn even when it
 *  failed and recorded no messages. */
const MODEL_STEP = "agent";
/** Strut's own dispatch-through step: its execution is a peer run. */
const PEER_STEP = "strut/run-workflow";

/** Is `child` directly under `parent` (one segment, `/`-separated)? */
function directChild(parent: string, child: string): boolean {
  return child.startsWith(`${parent}/`) && !child.slice(parent.length + 1).includes("/");
}
function under(parent: string, path: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}
function leafLabel(path: string): string {
  const leaf = path.slice(path.lastIndexOf("/") + 1);
  return leaf.replace(/^\d+-/, "");
}

/** Distinct nodes touched at or under `path`, the latest report of each winning. */
function nodesUnder(events: RunEvent[], path: string): AccessedNode[] {
  const byRef = new Map<string, AccessedNode>();
  for (const e of events) {
    if (e.type !== "step.end" || !Array.isArray(e.nodes) || !under(path, e.path)) continue;
    for (const n of e.nodes) {
      if (!n || typeof n.ref_id !== "string" || !n.ref_id) continue;
      const prev = byRef.get(n.ref_id) ?? { ref_id: n.ref_id };
      byRef.set(n.ref_id, {
        ...prev,
        ...(n.node_type ? { node_type: n.node_type } : {}),
        ...(n.name ? { name: n.name } : {}),
        ...(n.peer ? { peer: n.peer } : {}),
      });
    }
  }
  return [...byRef.values()];
}

interface PathEvents {
  start?: RunEvent;
  last?: RunEvent; // the last terminal event: step.end / step.error / step.replayed
  stepType?: string;
  messages: boolean;
}

function byPath(events: RunEvent[]): Map<string, PathEvents> {
  const m = new Map<string, PathEvents>();
  for (const e of events) {
    if (!e.path || !e.type.startsWith("step.")) continue;
    let p = m.get(e.path);
    if (!p) m.set(e.path, (p = { messages: false }));
    if (e.stepType) p.stepType = e.stepType;
    if (e.type === "step.start") p.start ??= e;
    else if (e.type === "step.end" || e.type === "step.error" || e.type === "step.replayed") {
      p.last = e;
      if (e.type === "step.end" && Array.isArray(e.messages)) p.messages = true;
    }
  }
  return m;
}

function statusOf(p: PathEvents, summary: RunSummary | null | undefined): TurnStatus {
  if (p.last?.type === "step.error") return "error";
  if (p.last) return "success";
  if (!summary) return "running";
  return summary.status === "cancelled" ? "cancelled" : "error";
}

function totalsOf(turns: JobTurn[]): JobTotals {
  let usage = emptyUsage();
  let cost = 0;
  let toolCalls = 0;
  let context: JobTotals["context"];
  for (const t of turns) {
    if (t.usage) usage = addUsage(usage, coerceUsage(t.usage));
    if (typeof t.cost === "number") cost += t.cost;
    toolCalls += t.toolCalls;
    if (t.context) context = t.context;
  }
  return { turns: turns.length, usage, cost, toolCalls, ...(context ? { context } : {}) };
}

/** Everything under `threads`, spawned ones included (each counted once,
 *  where it hangs). */
export function jobTotals(threads: JobThread[]): JobTotals {
  const all: JobTurn[] = [];
  const walk = (ts: JobThread[]) => {
    for (const th of ts) for (const t of th.turns) { all.push(t); walk(t.spawned); }
  };
  walk(threads);
  const totals = totalsOf(all);
  // `context` means nothing summed across threads.
  const { context: _, ...rest } = totals;
  return rest;
}

const byTime = (a: { startedAt: string }, b: { startedAt: string }) => a.startedAt.localeCompare(b.startedAt);

/**
 * Fold a job's runs into its thread tree. `runs` in any order; `turnLines`
 * are the job's sessions' turn logs (for `context`); `nodes` includes the
 * touched nodes per turn.
 */
export function foldJobThreads(runs: ThreadRun[], turnLines: SessionTurn[] = [], opts: { nodes?: boolean } = {}): JobThread[] {
  const contextAt = new Map<string, SessionTurn["context"]>();
  for (const l of turnLines) if (l.context) contextAt.set(`${l.runId}\n${l.path}`, l.context);

  // ── per run: its turns, and who spawned what inside it ─────────────────
  interface RunFold {
    run: ThreadRun;
    /** Every turn of the run, by path. */
    turns: Map<string, JobTurn>;
    /** A turn's nearest enclosing execution, by path. */
    parentOf: Map<string, string>;
    /** Top-level turns, chronological. */
    top: JobTurn[];
  }
  const folds = new Map<string, RunFold>();
  for (const run of [...runs].sort((a, b) => a.at.localeCompare(b.at))) {
    const paths = byPath(run.events);
    const execPaths: string[] = [];
    const peerPaths: string[] = [];
    for (const [path, p] of paths) {
      const t = baseType(p.stepType);
      if (p.messages || t === MODEL_STEP) execPaths.push(path);
      else if (t === PEER_STEP && p.last?.type === "step.end" && isRecord(p.last.output) && typeof p.last.output["runId"] === "string") peerPaths.push(path);
    }
    execPaths.sort((a, b) => a.length - b.length);
    const nearestExec = (path: string) =>
      execPaths.filter((e) => e !== path && under(e, path)).sort((a, b) => b.length - a.length)[0];

    const turns = new Map<string, JobTurn>();
    const parentOf = new Map<string, string>();
    const mk = (path: string, p: PathEvents): JobTurn => {
      const out = p.last?.type !== "step.error" && isRecord(p.last?.output) ? p.last!.output : undefined;
      const session = isRecord(out?.["session"]) ? out!["session"] : undefined;
      const sessionId = typeof session?.["id"] === "string" ? session["id"] : undefined;
      const turnNo = typeof session?.["turn"] === "number" ? session["turn"] : undefined;
      const offset = typeof session?.["offset"] === "number" ? session["offset"] : undefined;
      let toolCalls = 0;
      for (const [cp, cpe] of paths) if (directChild(path, cp) && (cpe.stepType ?? "").startsWith("tool:")) toolCalls++;
      const nodes = nodesUnder(run.events, path);
      const context = contextAt.get(`${run.runId}\n${path}`);
      return {
        runId: run.runId,
        workflow: run.workflow,
        path,
        stepType: p.stepType ?? "",
        label: leafLabel(path),
        at: p.start?.ts ?? p.last?.ts ?? run.at,
        ...(p.last?.durationMs != null ? { durationMs: p.last.durationMs } : {}),
        status: statusOf(p, run.summary),
        ...(turnNo !== undefined ? { turn: turnNo } : {}),
        ...(offset !== undefined ? { offset } : {}),
        ...(sessionId ? { session: sessionId } : {}),
        ...(out?.["usage"] !== undefined ? { usage: coerceUsage(out["usage"]) } : {}),
        ...(typeof out?.["cost"] === "number" ? { cost: out["cost"] } : {}),
        ...(context ? { context } : {}),
        toolCalls,
        ...(p.messages ? { transcript: transcriptUrl(run.workflow, run.runId, path) + (sessionId ? "?full=1" : "") } : {}),
        nodeCount: nodes.length,
        ...(opts.nodes ? { nodes } : {}),
        spawned: [],
      };
    };
    for (const path of execPaths) {
      turns.set(path, mk(path, paths.get(path)!));
      const parent = nearestExec(path);
      if (parent) parentOf.set(path, parent);
    }
    for (const path of peerPaths) {
      const p = paths.get(path)!;
      const out = p.last!.output as Record<string, unknown>;
      const peer = String(out["peer"] ?? "");
      const inner = isRecord(out["output"]) ? out["output"] : undefined;
      const t = mk(path, p);
      turns.set(path, {
        ...t,
        label: `@${peer} ${String(out["workflow"] ?? "")}`.trim(),
        ...(typeof inner?.["cost"] === "number" ? { cost: inner["cost"] } : {}),
        peer: { id: peer, workflow: String(out["workflow"] ?? ""), runId: String(out["runId"]), status: String(out["status"] ?? "") },
      });
      const parent = nearestExec(path);
      if (parent) parentOf.set(path, parent);
    }
    if (turns.size === 0) {
      // No agent anywhere: the run itself is the turn.
      const root = run.events[0]?.path.split("/")[0] ?? run.workflow;
      const s = run.summary;
      turns.set(root, {
        runId: run.runId,
        workflow: run.workflow,
        path: root,
        stepType: "run",
        label: run.workflow,
        at: s?.startedAt ?? run.events[0]?.ts ?? run.at,
        ...(s?.durationMs != null ? { durationMs: s.durationMs } : {}),
        status: !s ? "running" : s.status === "cancelled" ? "cancelled" : s.status === "error" ? "error" : "success",
        toolCalls: 0,
        nodeCount: nodesUnder(run.events, root).length,
        ...(opts.nodes ? { nodes: nodesUnder(run.events, root) } : {}),
        spawned: [],
      });
    }
    const top = [...turns.values()].filter((t) => !parentOf.has(t.path)).sort((a, b) => a.at.localeCompare(b.at));
    // The run's deliverables ride on its last top-level turn.
    if (run.artifacts?.length && top.length) top[top.length - 1]!.artifacts = run.artifacts;
    folds.set(run.runId, { run, turns, parentOf, top });
  }

  // ── threads: group turns by session ─────────────────────────────────────
  const threads = new Map<string, JobThread>();
  const threadOf = new Map<JobTurn, JobThread>();
  for (const f of folds.values()) {
    for (const t of f.turns.values()) {
      const id = t.session ?? `${t.runId}/${t.path}`;
      let th = threads.get(id);
      if (!th) {
        threads.set(id, (th = { id, session: !!t.session, label: t.label, startedAt: t.at, updatedAt: t.at, turns: [], totals: totalsOf([]) }));
      }
      th.turns.push(t);
      threadOf.set(t, th);
    }
  }
  for (const th of threads.values()) {
    th.turns.sort((a, b) => (a.turn ?? Infinity) - (b.turn ?? Infinity) || a.at.localeCompare(b.at));
    th.startedAt = th.turns[0]!.at;
    th.updatedAt = th.turns.reduce((m, t) => (t.at > m ? t.at : m), th.turns[0]!.at);
    th.label = th.turns[0]!.label;
    th.totals = totalsOf(th.turns);
  }

  // ── where each thread hangs ─────────────────────────────────────────────
  // By its FIRST turn: under the execution enclosing it in its run, or
  // under the turn of the parent run that launched the run; else top-level.
  const launcher = (f: RunFold): JobTurn | undefined => {
    const parent = f.run.parentRunId && folds.get(f.run.parentRunId);
    if (!parent) return undefined;
    for (const e of parent.run.events) {
      if (e.type !== "step.end" || !isRecord(e.output) || e.output["runId"] !== f.run.runId) continue;
      const exec = [...parent.turns.keys()].filter((p) => under(p, e.path)).sort((a, b) => b.length - a.length)[0];
      if (exec) return parent.turns.get(exec);
    }
    return parent.top[parent.top.length - 1];
  };
  const top: JobThread[] = [];
  for (const th of threads.values()) {
    const first = th.turns[0]!;
    const f = folds.get(first.runId)!;
    const enclosing = f.parentOf.get(first.path);
    const host = enclosing ? f.turns.get(enclosing) : launcher(f);
    if (host && threadOf.get(host) !== th) host.spawned.push(th);
    else top.push(th);
  }
  for (const th of threads.values()) for (const t of th.turns) t.spawned.sort(byTime);
  return top.sort(byTime);
}
