// A run's HEALTH, folded from its event log: what went wrong and what was
// done about it — the steps that failed (the deepest of a chain that failed
// with one message), the ones tried again and how often, the ones an onError
// fallback stood in for, the ones skipped (a `when` gate, or every input
// skipped) and which way each `if` went, what was still open when the run
// ended, the tool calls that failed by tool — and the log's own numbers.
// Hive's run report drew these as "System health" from its own bundle; here
// they come from the log alone. Pure; re-fold as the log grows.

import { spendOf, type TokenUsage } from "./run-overview.js";

export interface HealthEvent {
  type: string;
  path?: string;
  stepType?: string;
  ts?: string;
  output?: unknown;
  error?: unknown;
  iteration?: number;
  modelCalls?: number;
  usage?: TokenUsage;
  cost?: number;
}

export interface HealthStep {
  /** The step's path below the workflow. */
  label: string;
  /** Its whole path (what a flyout or `run/transcript` takes). */
  path: string;
  stepType: string;
}

export interface RunHealth {
  status: "running" | "paused" | "success" | "error" | "cancelled";
  /** Steps that failed, in log order — never an agent's tool call, which the agent goes past. */
  errors: Array<HealthStep & { message: string; at: string | null }>;
  /** Steps tried again: how many attempts, and whether the last one held. */
  retries: Array<HealthStep & { attempts: number; outcome: "success" | "error" | "running" }>;
  /** Steps that failed and whose onError fallback ran in their place. */
  recovered: HealthStep[];
  /** Steps not run: a `when` gate that did not match, or every input skipped. */
  skipped: HealthStep[];
  /** Which way each `if` went. */
  branches: Array<HealthStep & { taken: string }>;
  /** Started and never ended, in a run that is over. */
  unfinished: HealthStep[];
  /** Agents' tool calls, and the ones that failed, by tool (most failures first). */
  tools: { calls: number; failed: number; byTool: Array<{ tool: string; calls: number; failed: number; last?: string }> };
  stats: {
    events: number;
    /** Step executions finished (tool calls not counted). */
    steps: number;
    /** Steps a resume replayed from the journal. */
    replayed: number;
    resumes: number;
    pauses: number;
    modelCalls: number;
    usage: TokenUsage;
    cost: number;
    /** First event to the terminal one, or to the last event while it runs. */
    durationMs: number;
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errorText = (e: unknown) => (isRecord(e) && typeof e.message === "string" ? e.message : typeof e === "string" ? e : e === undefined ? "" : JSON.stringify(e));
const ended = (t: string) => t === "step.end" || t === "step.error" || t === "step.skipped" || t === "step.replayed";

export function foldRunHealth(events: readonly HealthEvent[]): RunHealth {
  const runStart = events.find((e) => e.type === "run.start");
  const root = runStart?.path ?? events.find((e) => e.type.startsWith("run."))?.path ?? "";
  const label = (path: string) => (root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path);
  const step = (path: string, stepType = ""): HealthStep => ({ label: label(path), path, stepType });

  let status: RunHealth["status"] = "running";
  let terminal: string | undefined;
  const open = new Map<string, HealthEvent>();
  const errors: RunHealth["errors"] = [];
  const retried = new Map<string, { stepType: string; attempts: number; outcome: "success" | "error" | "running" }>();
  const recovered = new Map<string, HealthStep>();
  const skipped: HealthStep[] = [];
  const branches: RunHealth["branches"] = [];
  const tools = new Map<string, { tool: string; calls: number; failed: number; last?: string }>();
  let toolCalls = 0;
  let toolFailed = 0;
  const stats = { steps: 0, replayed: 0, resumes: 0, pauses: 0, modelCalls: 0, cost: 0 };
  const usage: TokenUsage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0 };

  for (const e of events) {
    switch (e.type) {
      case "run.end": status = "success"; terminal = e.ts; continue;
      case "run.error": status = "error"; terminal = e.ts; continue;
      case "run.cancelled": status = "cancelled"; terminal = e.ts; continue;
      case "run.paused": status = "paused"; stats.pauses++; continue;
      case "run.resumed": status = "running"; terminal = undefined; stats.resumes++; continue;
    }
    if (!e.path || !e.type.startsWith("step.")) continue;
    const stepType = e.stepType ?? "";
    const tool = stepType.startsWith("tool:") ? stepType.slice(5) : null;

    if (e.type === "step.start") {
      open.set(e.path, e);
      // A step whose fallback runs failed, and was stood in for.
      if (e.path.endsWith("/onError")) {
        const failed = e.path.slice(0, -"/onError".length);
        recovered.set(failed, step(failed, open.get(failed)?.stepType));
        // The fallback's output is the step's: it ends no other way.
        open.delete(failed);
      }
      if (tool) {
        toolCalls++;
        const t = tools.get(tool) ?? { tool, calls: 0, failed: 0 };
        t.calls++;
        tools.set(tool, t);
      }
      continue;
    }
    if (e.type === "step.retry") {
      const r = retried.get(e.path) ?? { stepType, attempts: 1, outcome: "running" as const };
      r.attempts = Math.max(r.attempts, (e.iteration ?? r.attempts) + 1);
      retried.set(e.path, r);
      continue;
    }
    if (!ended(e.type)) continue;
    open.delete(e.path);
    const r = retried.get(e.path);
    if (r && e.type !== "step.skipped") r.outcome = e.type === "step.error" ? "error" : "success";

    if (tool) {
      if (e.type === "step.error") {
        toolFailed++;
        const t = tools.get(tool) ?? { tool, calls: 0, failed: 0 };
        t.failed++;
        t.last = errorText(e.error);
        tools.set(tool, t);
      }
    } else if (e.type === "step.end" || e.type === "step.error") {
      stats.steps++;
    }
    if (e.type === "step.replayed") stats.replayed++;
    if (e.type === "step.skipped") skipped.push(step(e.path, stepType));
    if (e.type === "step.error" && !tool) errors.push({ ...step(e.path, stepType), message: errorText(e.error), at: e.ts ?? null });
    if (e.type === "step.end") {
      if (stepType === "if") branches.push({ ...step(e.path, stepType), taken: e.output === true ? "then" : e.output === false ? "else" : JSON.stringify(e.output) ?? "" });
      const s = spendOf({ ts: e.ts ?? "", type: e.type, path: e.path, stepType, output: e.output, ...(e.cost !== undefined ? { cost: e.cost } : {}), ...(e.modelCalls !== undefined ? { modelCalls: e.modelCalls } : {}), ...(e.usage ? { usage: e.usage } : {}) });
      stats.modelCalls += s.modelCalls;
      stats.cost += s.cost;
      if (s.usage) for (const k of Object.keys(usage) as (keyof TokenUsage)[]) usage[k] += Number(s.usage[k]) || 0;
    }
  }

  // A container fails with its child's message: keep the deepest of each chain.
  const deepest = errors.filter((x) => !errors.some((y) => y !== x && y.message === x.message && y.path.startsWith(`${x.path}/`)));
  const over = status !== "running" && status !== "paused";
  const first = events.find((e) => e.ts)?.ts;
  const last = terminal ?? [...events].reverse().find((e) => e.ts)?.ts;
  return {
    status,
    errors: deepest,
    retries: [...retried].map(([path, r]) => ({ ...step(path, r.stepType), attempts: r.attempts, outcome: r.outcome })),
    recovered: [...recovered.values()],
    skipped,
    branches,
    unfinished: over ? [...open.values()].filter((e) => !e.stepType?.startsWith("tool:") && e.path !== root).map((e) => step(e.path!, e.stepType)) : [],
    tools: { calls: toolCalls, failed: toolFailed, byTool: [...tools.values()].filter((t) => t.failed > 0).sort((a, b) => b.failed - a.failed || b.calls - a.calls) },
    stats: {
      events: events.length,
      ...stats,
      usage,
      durationMs: first && last ? Math.max(0, Date.parse(last) - Date.parse(first)) : 0,
    },
  };
}
