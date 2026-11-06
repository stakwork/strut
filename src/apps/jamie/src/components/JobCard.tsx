// A job a turn started (Hive's `JobTurnCard` + `JobLiveStrip`): its title
// and how its turn is going, collapsed; while it runs, the live strip — its
// own line of what it is doing, the newest shot, a tally of the rest
// (`job/updates`); open, its reply, what it made (artifact cards) and its
// claims. What asks something of the person stays visible collapsed: the
// job's question (with a password box when it asks for a secret), why it
// failed, a captcha.
import { useContext, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, ChevronRight } from "lucide-react";
import { useJobUpdates, useRun, useStrutClient } from "@strut/kit";
import { Markdown } from "./Markdown";
import { cn } from "@/lib/utils";
import { answeredSince, askedSecret, jobLook, jobRunWorkflow, liveStrip } from "../lib/jobs";
import { inFlight } from "../lib/chat";
import { openable } from "../lib/artifacts";
import type { ArtifactRef, JobView } from "../lib/types";
import { ArtifactCard, type TurnRuns } from "./ArtifactCard";
import { ClaimsPanel } from "./ClaimsPanel";
import { ThreadPrs } from "./PullRequestCard";
import { prKey, prOf } from "../lib/pr";
import { Pill } from "./bits";
import { SecretBox } from "./SecretBox";
import { useViewer } from "../viewer";

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
  /** A build that ran on another strut (builder.yaml's `remote`): its secrets are that strut's. */
  peer?: unknown;
}

interface JobCardProps {
  job: string;
  runId: string;
  /** The workflow the run is, as the turn recorded it. */
  workflow?: string;
  conversation?: string;
}

/** A turn that names no workflow for its job run (saved before
 *  job/continue returned one) reads it from the job's record first. */
export function JobCard(props: JobCardProps) {
  const record = useJob(props.workflow ? "" : props.job, false);
  const workflow = jobRunWorkflow(props.runId, props.workflow, record.isError ? null : record.data);
  return <JobRunCard {...props} {...(workflow ? { workflow } : {})} />;
}

function JobRunCard({ job, runId, workflow, conversation }: JobCardProps) {
  const run = useRun(workflow ?? "", runId, { live: true });
  const status = run.data?.status ?? (run.isError ? "unreadable" : "running");
  const running = inFlight(status);
  const view = useJob(job, running);
  const [open, setOpen] = useState(false);
  const out = (run.data?.output ?? {}) as JobOutput;
  const text = typeof out.text === "string" ? out.text : undefined;
  const ask = typeof out.ask === "string" ? out.ask : (out.ask as { message?: string } | undefined)?.message;
  const look = run.isError ? { label: "Unreadable", tone: "muted" as const } : jobLook(status, ask);
  const title = view.data?.title ?? (typeof run.data?.["title"] === "string" ? run.data["title"] : job);
  const artifacts = ((run.data?.artifacts ?? []) as ArtifactRef[]).filter(openable);
  const file = workflow ? { workflow, runId } : undefined;
  const runs: TurnRuns = { byJob: new Map(file ? [[job, file]] : []), byRun: new Map(file ? [[runId, file]] : []) };
  const captchas = artifacts.filter((a) => a.kind === "captcha");
  // Its pull requests stay in sight collapsed, unless the thread shows them.
  const threadPrs = useContext(ThreadPrs);
  const prs = artifacts.filter((a) => {
    const pr = prOf(a);
    return pr && !threadPrs.has(prKey(pr));
  });
  const error = run.data?.error?.message;
  // A secret the build asks for (`ask.secret`): a box under the question,
  // for the person who started the job, until the job takes another turn —
  // never for a build that ran on another strut, whose secret is there.
  const viewer = useViewer();
  const actors = view.data?.actors;
  const secret = status === "success" && !out.peer ? askedSecret(out.ask) : null;
  const secretBox =
    secret && (!actors || (!!viewer && actors.includes(viewer))) && !answeredSince(view.data?.runs, runId) ? (
      <SecretBox name={secret} job={job} workflow={view.data?.workflow ?? workflow ?? "job"} {...(conversation ? { conversation } : {})} />
    ) : null;
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
      {!open && secretBox && <div className="px-3 pb-2">{secretBox}</div>}
      {!open && error && status === "error" && <p className="border-t px-3 py-2 text-xs text-rose-700 dark:text-rose-300">{error}</p>}
      {!open && [...prs, ...captchas].map((a) => (
        <div key={a.id} className="border-t px-3 py-2">
          <ArtifactCard artifact={a} runs={runs} job={job} {...(conversation ? { conversation } : {})} />
        </div>
      ))}
      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          {text ? <Markdown text={text} /> : <p className="text-xs text-muted-foreground">{running ? "Working…" : "No reply."}</p>}
          {ask && <p className="rounded-md bg-amber-500/10 px-2 py-1.5 text-sm"><span className="font-medium">Asks: </span>{ask}</p>}
          {secretBox}
          {error && <p className="text-xs text-rose-700 dark:text-rose-300">{error}</p>}
          {artifacts.map((a) => (
            <ArtifactCard key={a.id} artifact={a} runs={runs} job={job} {...(conversation ? { conversation } : {})} />
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
