// A deliverable in the thread (plans/jamie-app.md §4, §5): a card that
// opens in place to what `strut/views` draws — markdown, text, an HTML page
// from its safe elements, an image, a table, a recording, a Google Sheet —
// and hands the rest to the HOST (`ui/open-link` to `?artifact=` or `?app=`),
// which opens it beside the app, or in its own page. The whole card is the
// click: open (or fold) in place, or hand over. An inline served file also
// opens beside the chat from under it, for a page whose scripts should run.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppWindow, ChevronDown, ChevronRight, ExternalLink, FileText, Image as ImageIcon, Table2 } from "lucide-react";
import { useHost, useStrutClient } from "@strut/kit";
import { ArtifactView, DocumentView, SheetView } from "strut/views";
import { cn } from "@/lib/utils";
import { artifactLink, placeArtifact, servedFile, type ArtifactPlace, type FileRun } from "../lib/artifacts";
import type { ArtifactRef, JobView } from "../lib/types";
import { CaptchaCard } from "./CaptchaCard";
import { PullRequestCard } from "./PullRequestCard";
import { prOf } from "../lib/pr";
import { Notice } from "./bits";

export interface TurnRuns {
  byJob: ReadonlyMap<string, FileRun>;
  byRun: ReadonlyMap<string, FileRun>;
}

/** A job's newest run, for its files (`run/files` reads a job run's files
 *  from the job's directory, whichever run it names). */
export function useJobRun(job: string | undefined, url?: string) {
  const client = useStrutClient();
  return useQuery({
    queryKey: ["assistant", "job", job],
    enabled: !!job,
    staleTime: 10_000,
    queryFn: () => client.run<JobView>("job/get", { job }),
    select: (v): FileRun | undefined => {
      const path = url?.split(/[?#]/, 1)[0];
      const own = path ? v.artifacts?.find((a) => a.url?.split(/[?#]/, 1)[0] === path && a.runId) : undefined;
      const run = own ? v.runs.find((r) => r.runId === own.runId) : v.runs.find((r) => !r.parentRunId);
      return run ? { workflow: run.workflow, runId: run.runId } : undefined;
    },
  });
}

/** `job`: the job it came from, when known (a pull request's Fix asks it). */
export function ArtifactCard({ artifact, runs, conversation, job }: { artifact: ArtifactRef; runs: TurnRuns; conversation?: string; job?: string }) {
  const place = placeArtifact(artifact, runs);
  const host = useHost();
  const served = artifact.url && servedFile(artifact.url) ? artifact.url.split(/[?#]/, 1)[0]! : undefined;
  const [open, setOpen] = useState(place.show === "captcha");
  const pr = prOf(artifact);
  if (pr) return <PullRequestCard pr={pr} title={artifact.title} {...(job ?? artifact.job ? { job: job ?? artifact.job } : {})} {...(conversation ? { conversation } : {})} />;
  if (place.show === "captcha") return <CaptchaCard title={artifact.title} job={place.job} path={place.path} {...(place.run ? { run: place.run } : {})} {...(conversation ? { conversation } : {})} />;
  const inline = place.show === "file" || place.show === "content" || place.show === "sheet";
  const Icon = place.show === "link" && place.what === "app" ? AppWindow : place.show === "sheet" || (place.show === "file" && place.kind === "table") ? Table2 : place.show === "file" && place.kind === "image" ? ImageIcon : FileText;
  // A served file drawn inline also opens beside the chat, where its scripts run.
  const beside = inline && served ? artifactLink(served) : undefined;
  const toggle = inline ? () => setOpen((o) => !o) : place.show === "link" ? () => void host.openLink(place.href) : undefined;
  const head = (
    <>
      <span className="flex items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        {inline && (open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />)}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{artifact.title}</span>
        {place.show === "link" && <span className="shrink-0 text-xs text-muted-foreground">{place.what}</span>}
        {place.show === "link" && place.external && <ExternalLink className="size-3 shrink-0 text-muted-foreground" />}
      </span>
      {artifact.summary && !open && <span className="mt-1 block text-xs text-muted-foreground">{artifact.summary}</span>}
      {place.show === "missing" && <span className="mt-1 block text-xs text-muted-foreground">{place.text}</span>}
    </>
  );
  return (
    <div className="rounded-lg border bg-card text-card-foreground" data-testid="artifact-card" data-show={place.show}>
      {toggle ? (
        <button
          type="button"
          onClick={toggle}
          {...(inline ? { "aria-expanded": open } : {})}
          title={place.show === "link" ? (place.external ? "Open in a new tab" : "Open beside the chat") : undefined}
          className={cn(
            "block w-full cursor-pointer px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            open ? "rounded-t-lg" : "rounded-lg",
          )}
        >
          {head}
        </button>
      ) : (
        <div className="px-3 py-2">{head}</div>
      )}
      {open && inline && (
        <div className="border-t px-3 py-2">
          <Inline place={place} url={artifact.url} />
          {beside && (
            <button
              type="button"
              onClick={() => void host.openLink(beside)}
              className="mt-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ExternalLink className="size-3" />
              Open beside the chat
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Inline({ place, url }: { place: ArtifactPlace; url?: string }) {
  const needsRun = place.show === "file" && !place.run;
  const found = useJobRun(needsRun ? place.job : undefined, url);
  if (place.show === "content") return <DocumentView text={place.text} kind={place.kind} className="max-h-[60vh] overflow-auto text-sm" />;
  if (place.show === "sheet") return <SheetView spreadsheet={place.spreadsheet} maxHeight="60vh" />;
  if (place.show !== "file") return null;
  const run = place.run ?? found.data;
  if (!run) return found.isPending ? <p className="text-xs text-muted-foreground">Reading…</p> : <Notice>This file's job is not on file here.</Notice>;
  if (place.kind === "table") return <SheetView workflow={run.workflow} runId={run.runId} path={place.path} maxHeight="60vh" />;
  return <ArtifactView workflow={run.workflow} runId={run.runId} path={place.path} className="max-h-[70vh] overflow-auto" />;
}
