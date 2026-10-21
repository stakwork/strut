import { Ban, CheckCircle2, CircleDashed, Loader2, PauseCircle, XCircle } from "lucide-react";
import { useRun } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const LOOK: Record<string, { icon: typeof CheckCircle2; className: string; spin?: true }> = {
  success: { icon: CheckCircle2, className: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400" },
  error: { icon: XCircle, className: "border-destructive/40 text-destructive" },
  cancelled: { icon: Ban, className: "text-muted-foreground" },
  paused: { icon: PauseCircle, className: "border-amber-500/40 text-amber-700 dark:text-amber-400" },
  running: { icon: Loader2, className: "border-sky-500/40 text-sky-700 dark:text-sky-400", spin: true },
  stale: { icon: CircleDashed, className: "text-muted-foreground" },
};

/** A run's status as a badge: running spins, an error is red. `status` is
 *  any of strut's (`running`, `paused`, `success`, `error`, `cancelled`,
 *  `stale`); give `workflow` + `runId` instead and it reads the run itself,
 *  live while it is in flight (`run/get`, the importing app's grant). */
export function RunStatus(props: { status: string; className?: string } | { workflow: string; runId: string; className?: string }) {
  const remote = "runId" in props;
  const run = useRun(remote ? props.workflow : "", remote ? props.runId : undefined, { live: true, enabled: remote });
  const status = remote ? (run.data?.status ?? (run.isError ? "unknown" : "…")) : props.status;
  const look = LOOK[status] ?? { icon: CircleDashed, className: "text-muted-foreground" };
  const Icon = look.icon;
  return (
    <Badge variant="outline" className={cn("gap-1 font-normal", look.className, props.className)} data-status={status}>
      <Icon className={cn("size-3", look.spin && "animate-spin")} />
      {status}
    </Badge>
  );
}
