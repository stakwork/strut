import { runAppLabel, useRuns, type RunApp, type RunSummary } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { displayActor, errorText, fmtDuration, fmtTime } from "../lib/format";
import { RunStatus } from "./RunStatus";

export interface RunListProps {
  /** The workflow whose runs to list (`run/list`, newest first, live while one is in flight). */
  workflow: string;
  /** Draw these summaries instead of reading them. */
  runs?: RunSummary[];
  limit?: number;
  /** Only runs with this status. */
  status?: string;
  /** Only the runs of this job. */
  job?: string;
  selected?: string | null;
  onSelect?: (run: RunSummary) => void;
  className?: string;
}

/** A workflow's runs, newest first: status, when, how long, who — and where
 *  one came from (an app, a schedule, a job, a peer). A row is a button when
 *  `onSelect` is given. */
export function RunList({ workflow, runs: given, limit = 20, status, job, selected, onSelect, className }: RunListProps) {
  const q = useRuns(workflow, { limit, status, job, live: true, enabled: !given });
  const runs = given ?? q.data;
  if (!runs) {
    if (q.isError) return <p className={cn("text-sm text-destructive", className)}>{errorText(q.error)}</p>;
    return (
      <div className={cn("flex flex-col gap-2", className)}>
        {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}
      </div>
    );
  }
  if (!runs.length) return <p className={cn("text-sm text-muted-foreground", className)}>No runs of {workflow} yet.</p>;
  return (
    <ul className={cn("flex flex-col divide-y rounded-md border text-sm", className)} data-testid="run-list">
      {runs.map((r) => {
        const row = (
          <>
            <RunStatus status={r.status} />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{r.runId}</span>
            {r.app && typeof r.app === "object" && <Badge variant="secondary" className="font-normal">app · {runAppLabel(r.app as RunApp)}</Badge>}
            {r.origin === "schedule" && <Badge variant="secondary" className="font-normal">scheduled</Badge>}
            {r.origin === "peer" && <Badge variant="secondary" className="font-normal">peer</Badge>}
            {r.job && <Badge variant="outline" className="max-w-32 truncate font-normal">{r.job}</Badge>}
            {r.actor && <span className="hidden text-xs text-muted-foreground sm:inline">{displayActor(r.actor)}</span>}
            <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">{r.durationMs !== undefined ? fmtDuration(r.durationMs) : ""}</span>
            <span className="w-24 text-right text-xs text-muted-foreground">{fmtTime(r.startedAt)}</span>
          </>
        );
        return (
          <li key={r.runId}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(r)}
                className={cn("flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/60", selected === r.runId && "bg-muted")}
              >
                {row}
              </button>
            ) : (
              <div className="flex items-center gap-2 px-3 py-2">{row}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
