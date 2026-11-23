// A job a turn started (Hive's `JobTurnCard` + `JobLiveStrip`): its title
// and how its turn is going, collapsed; while it runs, the live strip — its
// own line of what it is doing, its checklist, the newest shot, a tally of
// the rest (`job/updates`); open, its reply, what it made (artifact cards) and its
// claims. What asks something of the person stays visible collapsed: the
// job's question (with a password box when it asks for a secret), why it
// failed, a captcha. So does what the job holds at an address (a pod's
// app, `urls` in `job/get`): a row that opens it beside the chat, or in a tab.
import { useContext, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, ChevronRight, Circle, CircleCheck, ExternalLink, LoaderCircle, Monitor } from "lucide-react";
import { useHost, useJobUpdates, useRun, useRunFile, useRunFileUrl, useStrutClient } from "@strut/kit";
import { Markdown } from "./Markdown";
import { cn } from "@/lib/utils";
import { answeredSince, askedSecret, holdLinks, jobLook, jobRunWorkflow, livePicture, liveStrip, type HoldLink, type LiveItem, type LiveUpdate } from "../lib/jobs";
import { inFlight } from "../lib/chat";
import { artifactLink, openable } from "../lib/artifacts";
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
  // Once more when the turn ends: what it made in its last seconds (a pod's link).
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) void view.refetch();
    wasRunning.current = running;
  }, [running]);
  const holds = holdLinks(job, view.data?.urls);
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
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <Bot className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {workflow === "builder" && <span className="shrink-0 text-xs text-muted-foreground">build</span>}
        <Pill tone={look.tone} spin={running}>{look.label}</Pill>
      </button>
      {running && <LiveStrip job={job} runId={runId} {...(workflow ? { workflow } : {})} />}
      {holds.map((h) => <HoldRow key={h.kind} link={h} />)}
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

/** What the job holds at an address: beside the chat (the host reads the
 *  address from the job), or in a tab — the way that always works. */
function HoldRow({ link }: { link: HoldLink }) {
  const host = useHost();
  return (
    <div className="flex items-center gap-1 border-t px-3 py-1.5" data-testid="job-hold" data-kind={link.kind}>
      <button type="button" onClick={() => void host.openLink(link.beside)} title="Open beside the chat" className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded text-left text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Monitor className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{link.label}</span>
      </button>
      <button type="button" onClick={() => void host.openLink(link.url)} title="Open in a new tab" aria-label={`${link.label} in a new tab`} className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
        <ExternalLink className="size-3" />
        Tab
      </button>
    </div>
  );
}

/** What the job is doing while its turn runs: its own line, its checklist, the newest shot, the rest counted. */
function LiveStrip({ job, runId, workflow }: { job: string; runId: string; workflow?: string }) {
  const { updates } = useJobUpdates(job);
  const { status, items, tally, shot } = liveStrip(updates, runId);
  if (!status && tally.length === 0) return null;
  return (
    <div className="space-y-1 border-t px-3 py-2" data-testid="job-live">
      {status && <div className="truncate text-xs text-foreground/80" title={status}>{status}</div>}
      {items.length > 0 && <Checklist items={items} />}
      {shot && workflow && <LiveShot shot={shot} job={job} workflow={workflow} runId={runId} />}
      {tally.length > 0 && <div className="truncate text-xs text-muted-foreground">{tally.join(" · ")}</div>}
    </div>
  );
}

/** The turn's steps as the job set them out (`job/status`'s `items`): done, the one under way, to do. */
function Checklist({ items }: { items: LiveItem[] }) {
  return (
    <ul className="space-y-0.5 py-0.5" data-testid="job-checklist">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-1.5 text-xs" data-state={item.state}>
          {item.state === "done" ? (
            <CircleCheck className="mt-px size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="Done" />
          ) : item.state === "doing" ? (
            <LoaderCircle className="mt-px size-3.5 shrink-0 animate-spin text-amber-600 dark:text-amber-400" aria-label="Under way" />
          ) : (
            <Circle className="mt-px size-3.5 shrink-0 text-muted-foreground/60" aria-label="To do" />
          )}
          <span className={cn("min-w-0", item.state === "done" ? "text-muted-foreground line-through" : item.state === "doing" ? "font-medium text-foreground" : "text-muted-foreground")}>
            {item.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The newest picture the job took, small: a shot, or a recording's newest
 *  frame. Read through the turn's run: a job run's files are the job's
 *  directory. A click opens it beside the chat. */
function LiveShot({ shot, job, workflow, runId }: { shot: LiveUpdate; job: string; workflow: string; runId: string }) {
  const host = useHost();
  const first = livePicture(shot, job);
  // A recording's manifest grows frame by frame: read again at each of its updates.
  const manifest = useRunFile(workflow, runId, first?.manifest);
  const { refetch } = manifest;
  const read = useRef(shot.at);
  useEffect(() => {
    if (read.current === shot.at) return;
    read.current = shot.at;
    if (first?.manifest) void refetch();
  }, [shot.at, first?.manifest]);
  const where = first?.manifest ? livePicture(shot, job, manifest.data?.text) : first;
  const image = useRunFileUrl(workflow, runId, where?.picture);
  if (!where || !image.url) return null;
  const caption = where.caption;
  return (
    <button
      type="button"
      onClick={() => void host.openLink(artifactLink(where.open))}
      title="Open beside the chat"
      className="block cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="job-live-shot"
    >
      <img src={image.url} alt={caption ?? "The newest screenshot"} className="max-h-32 max-w-full rounded-md border bg-muted/40 object-contain" />
      {caption && <span className="mt-0.5 block truncate text-left text-xs text-muted-foreground">{caption}</span>}
    </button>
  );
}
