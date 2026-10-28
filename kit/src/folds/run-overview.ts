// The run at a glance — the events panel's right column (RunOverview.tsx):
// what it cost, how long it took, what spent it, and what it started. Folded
// from the run's events, so a live run's numbers move as its log grows.
//
// Spend is each `step.end`'s `modelCalls` / `usage` / `cost` (the
// `withUsage` marker, src/core.ts) — a sub-agent's tool call and a run a
// step waited on (`meta/run-workflow`) included — or, in a log written
// before those fields, an `agent` / `llm` step's own output.
//
// The timeline has one row per top-level step, foreach iterations folded
// into theirs, and under each the work it started that a person wants to
// see: an agent, a sub-agent, an llm call, a child run — anything that
// spent. An agent's other tool calls are the event log's business. Pure;
// tested.

/** A model call's tokens (`withUsage`, src/core.ts). */
export interface TokenUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** The app a run worked for (plans/apps.md §5): a workspace app at a
 *  version. */
export type RunApp = { name: string; version: string };

/** A file the launch attached (`POST …/run { attachments }`), as `run.start`
 *  records it: saved under the run's artifacts at `path`. */
export type RunAttachmentRef = { name: string; mediaType: string; size: number; path: string };

/** A run's app as a badge names it: its name. */
export function runAppLabel(app: RunApp): string {
  return app.name;
}

export interface OverviewEvent {
  ts: string;
  type: string;
  path: string;
  stepType?: string;
  input?: unknown;
  output?: unknown;
  error?: { message: string };
  actor?: string;
  job?: string;
  app?: RunApp;
  attachments?: RunAttachmentRef[];
  modelCalls?: number;
  usage?: TokenUsage;
  cost?: number;
}

export type RowKind = "agent" | "subagent" | "llm" | "subflow" | "loop" | "run" | "peer" | "step";
export type RowStatus = "running" | "success" | "error" | "skipped" | "replayed";

export interface OverviewRow {
  /** The event path with iteration marks removed (`wf/each#2/t` → `wf/each/t`). */
  key: string;
  label: string;
  kind: RowKind;
  stepType: string;
  /** 0: a top-level step. 1: work it started. */
  depth: 0 | 1;
  /** The top-level row's label, on a depth-1 row. */
  parent?: string;
  /** Ms from the run's start. */
  start: number;
  end: number;
  status: RowStatus;
  /** Executions folded into the row (a foreach's iterations). */
  count: number;
  cost: number;
  modelCalls: number;
  toolCalls: number;
  /** A run this step launched: open it (`workflow` known, no `peer`). */
  child?: { runId: string; workflow?: string; peer?: string };
}

export interface RunOverview {
  workflow: string;
  status: "running" | "paused" | "success" | "error" | "cancelled";
  startedAt?: string;
  /** Ms from the first event to the terminal one (or `now`). */
  durationMs: number;
  actor?: string;
  job?: string;
  /** The app the run was launched for (plans/apps.md §11). */
  app?: RunApp;
  /** The files the launch attached, from `run.start`. */
  attachments?: RunAttachmentRef[];
  cost: number;
  modelCalls: number;
  toolCalls: number;
  /** Step executions, tool calls not counted. */
  steps: number;
  usage: TokenUsage;
  rows: OverviewRow[];
  /** Where the run failed: the last step error, else the run's. */
  error?: { path?: string; message: string };
  /** The top-level row that took longest, and its share of the run. */
  longest?: { label: string; share: number };
}

/** Step types that launch a run and say which one (`runId` in the output). */
const LAUNCHERS = new Set(["metarunworkflow", "strutrunworkflow", "jobstart", "jobcontinue"]);
const launcherKey = (stepType: string) => stepType.replace(/^tool:/, "").replace(/[/_-]/g, "");

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const normalize = (path: string) => path.replace(/#\d+/g, "");
const emptyUsage = (): TokenUsage => ({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0 });

/** What one `step.end` spent: its own fields, else (an older log) the
 *  output of an `agent` / `llm` step. */
export function spendOf(e: OverviewEvent): { cost: number; modelCalls: number; usage?: TokenUsage } {
  if (e.cost !== undefined || e.modelCalls !== undefined || e.usage !== undefined) {
    return { cost: e.cost ?? 0, modelCalls: e.modelCalls ?? 0, ...(e.usage ? { usage: e.usage } : {}) };
  }
  if ((e.stepType === "agent" || e.stepType === "llm") && isRecord(e.output) && num(e.output["cost"]) !== undefined) {
    const calls = e.stepType === "llm" ? 1 : num(e.output["steps"]) ?? 0;
    return { cost: num(e.output["cost"])!, modelCalls: calls, ...(isRecord(e.output["usage"]) ? { usage: e.output["usage"] as unknown as TokenUsage } : {}) };
  }
  return { cost: 0, modelCalls: 0 };
}

/** The run a launcher step started, from its output (an object, or a tool
 *  call's cut string) and its input. */
function childOf(stepType: string, start: OverviewEvent | undefined, end: OverviewEvent): OverviewRow["child"] {
  if (!LAUNCHERS.has(launcherKey(stepType))) return undefined;
  const out = end.output;
  const field = (k: string) =>
    isRecord(out) ? str(out[k]) : typeof out === "string" ? new RegExp(`"${k}"\\s*:\\s*"([^"]+)"`).exec(out)?.[1] : undefined;
  const runId = field("runId");
  if (!runId) return undefined;
  const input = isRecord(start?.input) ? start!.input : {};
  const peer = field("peer");
  const workflow =
    field("workflow") ?? str(input["name"]) ?? str(input["workflow"]) ?? (/^job(start|continue)$/.test(launcherKey(stepType)) ? "job" : undefined);
  return { runId, ...(workflow ? { workflow } : {}), ...(peer ? { peer } : {}) };
}

function kindOf(stepType: string, child: OverviewRow["child"]): RowKind {
  if (child) return child.peer ? "peer" : "run";
  if (stepType === "agent") return "agent";
  if (stepType === "tool:agent") return "subagent";
  if (stepType === "llm" || stepType === "tool:llm") return "llm";
  if (stepType === "subflow") return "subflow";
  if (stepType === "foreach" || stepType === "loop") return "loop";
  return "step";
}

/** A row's label: the step id, a tool call's tool (`012-agent` → `agent`),
 *  or the run it launched. */
function labelOf(key: string, child: OverviewRow["child"]): string {
  if (child?.workflow) return child.peer ? `@${child.peer} ${child.workflow}` : child.workflow;
  const leaf = key.slice(key.lastIndexOf("/") + 1);
  return leaf.replace(/^\d{3}-/, "");
}

interface Acc {
  key: string;
  stepType: string;
  /** Raw paths folded here → their last start/terminal event. */
  starts: Map<string, OverviewEvent>;
  ends: Map<string, OverviewEvent>;
  first: number;
  last: number;
  cost: number;
  modelCalls: number;
  toolCalls: number;
  child?: OverviewRow["child"];
}

export function foldRunOverview(events: OverviewEvent[], now = Date.now()): RunOverview {
  const runStart = events.find((e) => e.type === "run.start");
  // The run's own path, the workflow's name — slashes included, so a run
  // event's path, never a step path's first segment unless there is none.
  const root = (runStart ?? events.find((e) => e.type.startsWith("run.")))?.path ?? events[0]?.path.split("/")[0] ?? "";
  const t0 = events.length ? Date.parse(events[0]!.ts) : now;

  let status: RunOverview["status"] = "running";
  let terminalAt: number | undefined;
  let runError: string | undefined;
  // An agent goes on past a failed tool call: only steps' errors count.
  const stepErrors: Array<{ path: string; message: string }> = [];
  let cost = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  let steps = 0;
  let usage = emptyUsage();
  const accs = new Map<string, Acc>();
  const acc = (key: string, stepType: string, at: number) => {
    let a = accs.get(key);
    if (!a) accs.set(key, (a = { key, stepType, starts: new Map(), ends: new Map(), first: at, last: at, cost: 0, modelCalls: 0, toolCalls: 0 }));
    return a;
  };

  for (const e of events) {
    const at = Date.parse(e.ts);
    switch (e.type) {
      case "run.end": status = "success"; terminalAt = at; continue;
      case "run.error": status = "error"; terminalAt = at; runError = e.error?.message; continue;
      case "run.cancelled": status = "cancelled"; terminalAt = at; continue;
      case "run.paused": status = "paused"; continue;
      case "run.resumed": status = "running"; terminalAt = undefined; continue;
    }
    if (!e.type.startsWith("step.") || !e.stepType || e.path === root) continue;
    const key = normalize(e.path);
    const isTool = e.stepType.startsWith("tool:");
    // The row this step folds into: a foreach's iterations (`wf/each#2`)
    // into the foreach's, which keeps the container's own step type.
    const a = acc(key, e.stepType, at);
    if (e.path === key) a.stepType = e.stepType;
    a.first = Math.min(a.first, at);
    a.last = Math.max(a.last, at);
    if (e.type === "step.start") { a.starts.set(e.path, e); continue; }
    if (e.type === "step.retry") continue;
    a.ends.set(e.path, e);
    if (e.type === "step.error" && !isTool) stepErrors.push({ path: e.path, message: e.error?.message ?? "" });
    if (e.type !== "step.end" && e.type !== "step.error") continue;
    if (isTool) {
      toolCalls++;
      const parent = accs.get(key.slice(0, key.lastIndexOf("/")));
      if (parent) parent.toolCalls++;
    } else steps++;
    if (e.type !== "step.end") continue;
    const s = spendOf(e);
    a.cost += s.cost;
    a.modelCalls += s.modelCalls;
    cost += s.cost;
    modelCalls += s.modelCalls;
    if (s.usage) for (const k of Object.keys(usage) as (keyof TokenUsage)[]) usage[k] += Number(s.usage[k]) || 0;
    const child = childOf(e.stepType, a.starts.get(e.path), e);
    if (child) a.child = child;
  }

  const end = terminalAt ?? (status === "running" || status === "paused" ? now : events.length ? Date.parse(events.at(-1)!.ts) : now);
  const total = Math.max(0, end - t0);

  // Rows: every top-level step, and under it what it started that spent or
  // that a person opens (an agent, a sub-agent, an llm call, a child run).
  const prefix = `${root}/`;
  const tops: OverviewRow[] = [];
  const nested = new Map<string, OverviewRow[]>();
  for (const a of accs.values()) {
    if (!a.key.startsWith(prefix)) continue;
    const rest = a.key.slice(prefix.length);
    const depth = rest.includes("/") ? 1 : 0;
    const kind = kindOf(a.stepType, a.child);
    if (depth === 1 && a.cost === 0 && a.modelCalls === 0 && !["agent", "subagent", "llm", "run", "peer"].includes(kind)) continue;
    const open = [...a.starts.keys()].some((p) => !a.ends.has(p));
    const finals = [...a.ends.values()].map((e) => e.type);
    const rowStatus: RowStatus = open && (status === "running" || status === "paused")
      ? "running"
      : finals.includes("step.error") ? "error"
      : finals.length && finals.every((t) => t === "step.replayed") ? "replayed"
      : finals.length && finals.every((t) => t === "step.skipped") ? "skipped"
      : "success";
    const row: OverviewRow = {
      key: a.key,
      label: labelOf(a.key, a.child),
      kind,
      stepType: a.stepType,
      depth,
      start: a.first - t0,
      end: (open && rowStatus === "running" ? end : a.last) - t0,
      status: rowStatus,
      // Iterations are raw paths other than the key (`wf/each#0`, …).
      count: Math.max(1, [...new Set([...a.starts.keys(), ...a.ends.keys()])].filter((p) => p !== a.key).length),
      cost: a.cost,
      modelCalls: a.modelCalls,
      toolCalls: a.toolCalls,
      ...(a.child ? { child: a.child } : {}),
    };
    if (depth === 0) tops.push(row);
    else {
      const top = `${prefix}${rest.slice(0, rest.indexOf("/"))}`;
      nested.set(top, [...(nested.get(top) ?? []), row]);
    }
  }
  tops.sort((x, y) => x.start - y.start);
  const rows: OverviewRow[] = [];
  for (const t of tops) {
    rows.push(t);
    for (const r of (nested.get(t.key) ?? []).sort((x, y) => x.start - y.start)) rows.push({ ...r, parent: t.label });
  }

  // The deepest step error carrying the failure's message: a subflow's
  // child fails first, then each container above it with the same message.
  const lastError = stepErrors.at(-1);
  const failedAt = lastError
    ? stepErrors.filter((x) => x.message === lastError.message).reduce((m, x) => (x.path.length > m.path.length ? x : m))
    : undefined;

  const longestRow = tops.reduce<OverviewRow | undefined>((m, r) => (!m || r.end - r.start > m.end - m.start ? r : m), undefined);
  return {
    workflow: root,
    status,
    ...(runStart ? { startedAt: runStart.ts } : events[0] ? { startedAt: events[0].ts } : {}),
    durationMs: total,
    ...(runStart?.actor ? { actor: runStart.actor } : {}),
    ...(runStart?.job ? { job: runStart.job } : {}),
    ...(runStart?.app ? { app: runStart.app } : {}),
    ...(runStart?.attachments?.length ? { attachments: runStart.attachments } : {}),
    cost,
    modelCalls,
    toolCalls,
    steps,
    usage,
    rows,
    ...(status === "error" ? { error: failedAt ?? { message: runError ?? "" } } : {}),
    ...(longestRow && total > 0 ? { longest: { label: longestRow.label, share: (longestRow.end - longestRow.start) / total } } : {}),
  };
}
