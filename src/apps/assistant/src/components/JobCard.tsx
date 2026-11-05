// A job a turn started (Hive's `JobTurnCard` + `JobLiveStrip`): its title
// and how its turn is going, collapsed; while it runs, the live strip — its
// own line of what it is doing, the newest shot, a tally of the rest
// (`job/updates`); open, its reply, what it made (artifact cards) and its
// claims. What asks something of the person stays visible collapsed: the
// job's question, why it failed, a captcha.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, ChevronRight } from "lucide-react";
import { useJobUpdates, useRun, useStrutClient } from "@strut/kit";
import { Markdown } from "./Markdown";
import { cn } from "@/lib/utils";
import { jobLook, liveStrip } from "../lib/jobs";
import { inFlight } from "../lib/chat";
import type { ArtifactRef, JobView } from "../lib/types";
import { ArtifactCard, type TurnRuns } from "./ArtifactCard";
import { ClaimsPanel } from "./ClaimsPanel";
import { Pill } from "./bits";

export function useJob(job: string, live: boolean) {
  const client = useStrutClient();
  return useQuery({
    queryKey: ["assistant", "job-view", job],
    queryFn: () => client.run<JobView>("job/get", { job }),
    enabled: !!job,
    staleTime: 5_000,
    refetchInterval: live ? 10_000 : false,
  });
}

interface JobOutput {
  text?: unknown;
  ask?: unknown;
}

export function JobCard({ job, runId, workflow, conversation }: { job: string; runId: string; workflow?: string; conversation?: string }) {
  const run = useRun(workflow ?? "job", runId, { live: true });
  const status = run.data?.status ?? "running";
  const running = inFlight(status);
  const view = useJob(job, running);
  const [open, setOpen] = useState(false);
  const out = (run.data?.output ?? {}) as JobOutput;
  const text = typeof out.text === "string" ? out.text : undefined;
  const ask = typeof out.ask === "string" ? out.ask : (out.ask as { message?: string } | undefined)?.message;
  const look = run.isError ? { label: "Unreadable", tone: "muted" as const } : jobLook(status, ask);
  const title = view.data?.title ?? (typeof run.data?.["title"] === "string" ? run.data["title"] : job);
  const artifacts = (run.data?.artifacts ?? []) as ArtifactRef[];
  const runs: TurnRuns = { byJob: new Map([[job, { workflow: run.data?.workflow ?? workflow ?? "job", runId }]]), byRun: new Map([[runId, { workflow: workflow ?? "job", runId }]]) };
  const captchas = artifacts.filter((a) => a.kind === "captcha");
  const error = run.data?.error?.message;
  return (
    <div className="rounded-lg border bg-card text-card-foreground" data-testid="job-card" data-job={job} data-status={status}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <Bot className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {workflow === "builder" && <span className="shrink-0 text-xs text-muted-foreground">build</span>}
        <Pill tone={look.tone} spin={running}>{look.label}</Pill>
      </button>
      {running && <LiveStrip job={job} runId={runId} />}
      {!open && ask && <p className="border-t px-3 py-2 text-sm"><span className="font-medium">Asks: </span>{ask}</p>}
      {!open && error && status === "error" && <p className="border-t px-3 py-2 text-xs text-rose-700 dark:text-rose-300">{error}</p>}
      {!open && captchas.map((a) => (
        <div key={a.id} className="border-t px-3 py-2">
          <ArtifactCard artifact={a} runs={runs} {...(conversation ? { conversation } : {})} />
        </div>
      ))}
      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          {text ? <Markdown text={text} /> : <p className="text-xs text-muted-foreground">{running ? "Working…" : "No reply."}</p>}
          {ask && <p className="rounded-md bg-amber-500/10 px-2 py-1.5 text-sm"><span className="font-medium">Asks: </span>{ask}</p>}
          {error && <p className="text-xs text-rose-700 dark:text-rose-300">{error}</p>}
          {artifacts.map((a) => (
            <ArtifactCard key={a.id} artifact={a} runs={runs} {...(conversation ? { conversation } : {})} />
          ))}
          {view.data?.claims && view.data.claims.length > 0 && <ClaimsPanel job={job} claims={view.data.claims} runId={view.data.runs.find((r) => !r.parentRunId)?.runId ?? runId} />}
        </div>
      )}
    </div>
  );
}

/** What the job is doing while its turn runs: its own line, the newest shot, the rest counted. */
function LiveStrip({ job, runId }: { job: string; runId: string }) {
  const { updates } = useJobUpdates(job);
  const { status, tally } = liveStrip(updates, runId);
  if (!status && tally.length === 0) return null;
  return (
    <div className="space-y-1 border-t px-3 py-2" data-testid="job-live">
      {status && <div className="truncate text-xs text-foreground/80" title={status}>{status}</div>}
      {tally.length > 0 && <div className="truncate text-xs text-muted-foreground">{tally.join(" · ")}</div>}
    </div>
  );
}
