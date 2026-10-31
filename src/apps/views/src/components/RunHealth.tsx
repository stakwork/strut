import { useMemo, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleSlash, GitFork, LifeBuoy, RotateCcw, TimerOff, Wrench } from "lucide-react";
import { foldRunHealth, useRunEvents, type HealthEvent, type HealthStep, type RunEvent } from "@strut/kit";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { errorText, fmtCost, fmtDuration, fmtTokens } from "../lib/format";

export interface RunHealthProps {
  /** Read the run's log (`run/events`) — the importing app's grant. */
  workflow?: string;
  runId?: string;
  /** Follow the run while it is in flight. */
  live?: boolean;
  /** Or draw this log. */
  events?: RunEvent[];
  /** A step's row was clicked: its path. */
  onOpenStep?: (path: string) => void;
  className?: string;
}

/**
 * What went wrong in a run and what was done about it (`foldRunHealth`): the
 * steps that failed, the ones tried again, the ones an onError fallback stood
 * in for, the ones skipped and which way each `if` went, what was still open
 * when the run ended, the tool calls that failed by tool — and the log's own
 * numbers. A run where nothing went wrong says so in one line.
 */
export function RunHealth({ workflow, runId, live, events: given, onOpenStep, className }: RunHealthProps) {
  const q = useRunEvents(workflow ?? "", runId, { live, enabled: !given && !!workflow && !!runId });
  const events = (given ?? q.data) as HealthEvent[] | undefined;
  const h = useMemo(() => (events ? foldRunHealth(events) : null), [events]);
  if (!h) {
    if (q.isError) return <p className={cn("text-sm text-destructive", className)}>{errorText(q.error)}</p>;
    return <Skeleton className={cn("h-32 w-full", className)} />;
  }
  const s = h.stats;
  const tokens = s.usage.inputTokens + s.usage.cacheReadTokens + s.usage.cacheWriteTokens + s.usage.outputTokens;
  const clean = !h.errors.length && !h.retries.length && !h.recovered.length && !h.unfinished.length && !h.tools.failed;
  const open = (st: HealthStep) => onOpenStep?.(st.path);
  return (
    <div className={cn("flex flex-col gap-3 text-sm", className)} data-testid="run-health">
      {clean && (
        <p className="flex items-center gap-2 text-muted-foreground">
          <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
          {h.status === "running" || h.status === "paused" ? "Nothing has gone wrong so far." : "Nothing went wrong."}
          {h.skipped.length > 0 && ` ${h.skipped.length} step${h.skipped.length === 1 ? "" : "s"} skipped by design.`}
        </p>
      )}
      {h.errors.length > 0 && (
        <Group icon={AlertTriangle} title="Failed" tone="text-destructive">
          {h.errors.map((e) => (
            <Row key={e.path} step={e} onOpen={open} detail={<span className="text-destructive">{e.message || "failed"}</span>} />
          ))}
        </Group>
      )}
      {h.unfinished.length > 0 && (
        <Group icon={TimerOff} title="Cut off when the run ended">
          {h.unfinished.map((st) => <Row key={st.path} step={st} onOpen={open} />)}
        </Group>
      )}
      {h.retries.length > 0 && (
        <Group icon={RotateCcw} title="Tried again">
          {h.retries.map((r) => (
            <Row key={r.path} step={r} onOpen={open} detail={`${r.attempts} attempts · ${r.outcome === "success" ? "held" : r.outcome === "error" ? "failed every time" : "still trying"}`} />
          ))}
        </Group>
      )}
      {h.recovered.length > 0 && (
        <Group icon={LifeBuoy} title="Failed, a fallback stood in (onError)">
          {h.recovered.map((st) => <Row key={st.path} step={st} onOpen={open} />)}
        </Group>
      )}
      {h.tools.failed > 0 && (
        <Group icon={Wrench} title={`${h.tools.failed} of ${h.tools.calls} tool calls failed (the agents went on)`}>
          {h.tools.byTool.map((t) => (
            <li key={t.tool} className="grid grid-cols-[minmax(0,12rem)_4rem_1fr] items-baseline gap-2 px-1 py-0.5">
              <span className="truncate font-mono text-xs">{t.tool}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{t.failed}/{t.calls}</span>
              <span className="truncate text-xs text-muted-foreground" title={t.last}>{t.last}</span>
            </li>
          ))}
        </Group>
      )}
      {(h.branches.length > 0 || h.skipped.length > 0) && (
        <Group icon={GitFork} title="Branches">
          {h.branches.map((b) => <Row key={b.path} step={b} onOpen={open} detail={`went ${b.taken}`} />)}
          {h.skipped.map((st) => <Row key={st.path} step={st} onOpen={open} detail={<span className="inline-flex items-center gap-1"><CircleSlash className="size-3" />skipped</span>} />)}
        </Group>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border bg-card px-3 py-2 text-xs sm:grid-cols-4" data-testid="run-health-stats">
        <Stat label="events" value={s.events} />
        <Stat label="steps" value={s.steps} />
        <Stat label="tool calls" value={h.tools.calls} />
        <Stat label="model calls" value={s.modelCalls} />
        <Stat label="tokens" value={fmtTokens(tokens)} />
        <Stat label="cost" value={fmtCost(s.cost)} />
        <Stat label="time" value={fmtDuration(s.durationMs)} />
        <Stat label="resumes" value={s.resumes ? `${s.resumes} (${s.replayed} replayed)` : 0} />
      </dl>
    </div>
  );
}

function Group({ icon: Icon, title, tone, children }: { icon: typeof AlertTriangle; title: string; tone?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className={cn("flex items-center gap-1.5 text-xs font-medium", tone ?? "text-muted-foreground")}>
        <Icon className="size-3.5" />
        {title}
      </h4>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

function Row({ step, detail, onOpen }: { step: HealthStep; detail?: ReactNode; onOpen: (s: HealthStep) => void }) {
  const body = (
    <>
      <span className="truncate font-mono text-xs" title={step.path}>{step.label}</span>
      <span className="truncate text-xs text-muted-foreground">{step.stepType}</span>
      <span className="min-w-0 truncate text-xs">{detail}</span>
    </>
  );
  const grid = "grid w-full grid-cols-[minmax(0,12rem)_6rem_1fr] items-baseline gap-2 rounded px-1 py-0.5 text-left";
  return (
    <li>
      <button type="button" className={cn(grid, "hover:bg-muted/60")} onClick={() => onOpen(step)}>
        {body}
      </button>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
