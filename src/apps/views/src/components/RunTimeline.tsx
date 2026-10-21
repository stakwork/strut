import { useEffect, useMemo, useState } from "react";
import { Bot, Brain, GitBranch, Repeat, Sparkles, SquareArrowOutUpRight, Workflow } from "lucide-react";
import { foldRunOverview, runAppLabel, useRunEvents, type OverviewEvent, type OverviewRow, type RowKind, type RunEvent } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { displayActor, errorText, fmtCost, fmtDuration, fmtTime, fmtTokens } from "../lib/format";
import { RunStatus } from "./RunStatus";

const KIND: Record<RowKind, { icon: typeof Bot; label: string; bar: string }> = {
  agent: { icon: Bot, label: "agent", bar: "bg-violet-500" },
  subagent: { icon: Bot, label: "sub-agent", bar: "bg-violet-400" },
  llm: { icon: Sparkles, label: "llm", bar: "bg-fuchsia-500" },
  subflow: { icon: Workflow, label: "subflow", bar: "bg-sky-500" },
  loop: { icon: Repeat, label: "loop", bar: "bg-amber-500" },
  run: { icon: SquareArrowOutUpRight, label: "child run", bar: "bg-emerald-500" },
  peer: { icon: GitBranch, label: "peer run", bar: "bg-teal-500" },
  step: { icon: Brain, label: "step", bar: "bg-slate-400 dark:bg-slate-500" },
};

/** `m:ss` from the run's start. */
const clock = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export interface RunTimelineProps {
  /** Read the run's log (`run/events`, live until it settles) — the importing app's grant. */
  workflow?: string;
  runId?: string;
  /** Or draw this log. */
  events?: RunEvent[];
  /** A top-level step's row was clicked: its path. */
  onOpenStep?: (path: string) => void;
  /** A row for a run the step launched was clicked (`meta/run-workflow`, `job/start`). */
  onOpenRun?: (workflow: string, runId: string) => void;
  className?: string;
}

/**
 * The run at a glance, folded from its events (`foldRunOverview`): status,
 * cost, model calls, how long — and a timeline with a row per top-level step,
 * a foreach's iterations folded into theirs (×N), and under each the work it
 * started: an agent, a sub-agent, an llm call, a child run. A live run moves
 * as its log grows. strut's own run overview (web/) draws the same fold.
 */
export function RunTimeline({ workflow, runId, events: given, onOpenStep, onOpenRun, className }: RunTimelineProps) {
  const q = useRunEvents(workflow ?? "", runId, { live: true, enabled: !given && !!workflow && !!runId });
  const events = (given ?? q.data) as OverviewEvent[] | undefined;
  const [now, setNow] = useState(() => Date.now());
  const o = useMemo(() => (events?.length ? foldRunOverview(events, now) : null), [events, now]);
  const ticking = o?.status === "running";
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  if (!o) {
    if (q.isError) return <p className={cn("text-sm text-destructive", className)}>{errorText(q.error)}</p>;
    if (events && !events.length) return <p className={cn("text-sm text-muted-foreground", className)}>The run has no events yet.</p>;
    return <Skeleton className={cn("h-40 w-full", className)} />;
  }
  const total = Math.max(1, o.durationMs);
  const tokens = o.usage.inputTokens + o.usage.cacheReadTokens + o.usage.cacheWriteTokens + o.usage.outputTokens;
  const open = (r: OverviewRow) => {
    if (r.child?.workflow && !r.child.peer && onOpenRun) return onOpenRun(r.child.workflow, r.child.runId);
    onOpenStep?.(r.key);
  };
  const clickable = (r: OverviewRow) => !!((r.child?.workflow && !r.child.peer && onOpenRun) || (onOpenStep && r.depth === 0));

  return (
    <div className={cn("flex flex-col gap-3 text-sm", className)} data-testid="run-timeline">
      <div className="flex flex-wrap items-center gap-2">
        <RunStatus status={o.status} />
        <span className="font-medium">{o.workflow}</span>
        {o.app && <Badge variant="secondary" className="font-normal">app · {runAppLabel(o.app)}</Badge>}
        {o.job && <Badge variant="outline" className="font-normal">{o.job}</Badge>}
        <span className="text-xs text-muted-foreground">
          {o.actor && <>by {displayActor(o.actor)} · </>}
          {fmtTime(o.startedAt)}
        </span>
      </div>
      {o.error && (
        <button
          type="button"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-left text-xs text-destructive"
          onClick={() => o.error?.path && onOpenStep?.(o.error.path)}
        >
          {o.error.message || "failed"}
        </button>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Time" value={fmtDuration(o.durationMs)} sub={o.longest && o.rows.length > 1 && o.longest.share >= 0.3 ? `${Math.round(o.longest.share * 100)}% in ${o.longest.label}` : `${o.steps} step${o.steps === 1 ? "" : "s"}`} />
        <Tile label="Cost" value={fmtCost(o.cost)} sub={tokens ? `${fmtTokens(tokens)} tokens` : "no model calls"} />
        <Tile label="Model calls" value={String(o.modelCalls)} sub={`${o.toolCalls} tool call${o.toolCalls === 1 ? "" : "s"}`} />
        <Tile label="Steps" value={String(o.rows.filter((r) => r.depth === 0).length)} sub={`${o.rows.filter((r) => r.depth === 1).length} started under them`} />
      </div>
      <ol className="flex flex-col gap-0.5" data-testid="run-timeline-rows">
        {o.rows.map((r) => {
          const k = KIND[r.kind];
          const Icon = k.icon;
          const left = (r.start / total) * 100;
          const width = Math.max(0.6, ((r.end - r.start) / total) * 100);
          const body = (
            <>
              <span className={cn("flex min-w-0 items-center gap-1.5", r.depth === 1 && "pl-4 text-muted-foreground")}>
                <Icon className="size-3.5 shrink-0" aria-label={k.label} />
                <span className="truncate">{r.label}</span>
                {r.count > 1 && <span className="shrink-0 text-xs text-muted-foreground">×{r.count}</span>}
              </span>
              <span className="relative h-3 rounded-sm bg-muted/60">
                <span
                  className={cn(
                    "absolute inset-y-0 rounded-sm",
                    r.status === "error" ? "bg-destructive" : r.status === "skipped" ? "bg-muted-foreground/30" : k.bar,
                    r.status === "running" && "animate-pulse",
                    r.status === "replayed" && "opacity-40",
                  )}
                  style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                />
              </span>
              <span className="text-right text-xs tabular-nums text-muted-foreground">{r.cost > 0 ? fmtCost(r.cost) : ""}</span>
            </>
          );
          const title = `${r.label} · ${k.label}${r.stepType ? ` (${r.stepType})` : ""} · ${clock(r.start)}–${clock(r.end)} · ${r.status}${r.modelCalls ? ` · ${r.modelCalls} model calls` : ""}${r.toolCalls ? ` · ${r.toolCalls} tool calls` : ""}`;
          const grid = "grid grid-cols-[minmax(0,13rem)_1fr_4rem] items-center gap-2 rounded px-1 py-1";
          return (
            <li key={`${r.key}|${r.depth}`} data-kind={r.kind} data-status={r.status}>
              {clickable(r) ? (
                <button type="button" title={title} onClick={() => open(r)} className={cn(grid, "w-full text-left hover:bg-muted/60")}>
                  {body}
                </button>
              ) : (
                <div title={title} className={grid}>
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border bg-card px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
