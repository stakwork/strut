// A pull request a job made (Hive's `pullRequest.tsx` panel and row): its
// state, branches and checks as GitHub has them now (`github/pr-status`, read
// with the viewer's own token, again every 30 s while it is open), its
// description folded, and two buttons — Merge (`github/merge-pr`, a person's
// click, at the head they saw) and Fix, when checks failed: the job's next
// turn, told which, naming this conversation so its end wakes it. When
// GitHub cannot be read, the card says so over what the job reported.
import { createContext, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, CircleCheck, CircleDashed, CircleMinus, CircleX, GitMerge, GitPullRequest, Wrench } from "lucide-react";
import { useHost, useStrutClient } from "@strut/kit";
import { cn } from "@/lib/utils";
import { canMerge, checksLine, fixPrompt, prLive, prPill, type PrRef, type PrStatus } from "../lib/pr";
import { sendRefusal } from "../lib/chat";
import type { JobView } from "../lib/types";
import { Markdown } from "./Markdown";
import { Notice, Pill, errorText } from "./bits";

/** The pull requests the thread shows itself, by `prKey`, each with the
 *  turn that shows it (its newest mention): one card per pull request. */
export const ThreadPrs = createContext<ReadonlyMap<string, string>>(new Map());

/** How often an open pull request is read again (Hive's). */
const LIVE_MS = 30_000;

export function usePullRequest(pr: PrRef) {
  const client = useStrutClient();
  return useQuery({
    queryKey: ["jamie", "pr", pr.repo, pr.number],
    queryFn: () => client.run<PrStatus>("github/pr-status", { repo: pr.repo, number: pr.number }),
    staleTime: 15_000,
    retry: false,
    refetchInterval: (q) => (q.state.error || !prLive(q.state.data?.state) ? false : LIVE_MS),
  });
}

/** A step's refusal as a person reads it: its code left out. */
const said = (err: unknown) => errorText(err).replace(/^[a-z_]+: /, "");

const CHECK_ICON = {
  failed: <CircleX className="size-3.5 shrink-0 text-rose-600" />,
  running: <CircleDashed className="size-3.5 shrink-0 animate-spin text-amber-600 [animation-duration:3s]" />,
  passed: <CircleCheck className="size-3.5 shrink-0 text-emerald-600" />,
  skipped: <CircleMinus className="size-3.5 shrink-0 text-muted-foreground" />,
};

export function PullRequestCard({ pr, title, job, conversation }: { pr: PrRef; title?: string; job?: string; conversation?: string }) {
  const host = useHost();
  const client = useStrutClient();
  const qc = useQueryClient();
  const status = usePullRequest(pr);
  const s = status.data;
  const [described, setDescribed] = useState(false);
  const [fixSent, setFixSent] = useState(false);
  const jobView = useQuery({
    queryKey: ["assistant", "job-view", job],
    enabled: !!job,
    staleTime: 10_000,
    queryFn: () => client.run<JobView>("job/get", { job }),
  });
  const merge = useMutation({
    mutationFn: () => client.run("github/merge-pr", { repo: pr.repo, number: pr.number, ...(s?.headSha ? { sha: s.headSha } : {}) }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["jamie", "pr", pr.repo, pr.number] }),
  });
  const fix = useMutation({
    mutationFn: () =>
      client.run("run/launch", {
        workflow: jobView.data?.workflow ?? "job",
        job,
        input: { prompt: fixPrompt(s!) },
        // Its end wakes this conversation (plans/jamie-app.md §2.2).
        ...(conversation ? { conversation } : {}),
      }),
    onSuccess: () => setFixSent(true),
  });
  const pill = prPill(s?.state);
  const failed = s?.checks.filter((c) => c.status === "failed") ?? [];
  const line = s ? checksLine(s.counts) : "";

  return (
    <div className="rounded-lg border bg-card text-card-foreground" data-testid="pr-card" data-pr={`${pr.repo}#${pr.number}`} data-state={s?.state ?? ""}>
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <GitPullRequest className={cn("size-3.5 shrink-0", s?.state === "merged" ? "text-violet-600" : s?.state === "closed" ? "text-rose-600" : "text-emerald-600")} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={s?.title ?? title}>
          {s?.title ?? title ?? "Pull request"}
        </span>
        <button type="button" onClick={() => void host.openLink(pr.url)} className="shrink-0 text-xs text-muted-foreground hover:text-foreground hover:underline" title="Open on GitHub">
          #{pr.number}
        </button>
        {s && <Pill tone={pill.tone}>{pill.label}</Pill>}
      </div>
      <div className="truncate px-3 pb-2 pt-0.5 text-xs text-muted-foreground">
        {pr.repo}
        {s?.author && ` · ${s.author}`}
        {s && ` · ${s.head} → ${s.base}`}
      </div>

      {status.isPending && <p className="border-t px-3 py-2 text-xs text-muted-foreground">Reading it on GitHub…</p>}
      {status.isError && <div className="border-t px-3 py-2"><Notice>Can't read it on GitHub: {said(status.error)}</Notice></div>}

      {s && s.checks.length > 0 && (
        <div className="border-t px-3 py-2" data-testid="pr-checks">
          <div className={cn("mb-1 text-xs", s.counts.failed ? "text-rose-700 dark:text-rose-300" : "text-muted-foreground")}>{line}</div>
          <ul className="space-y-0.5">
            {s.checks.map((c) => (
              <li key={c.name} className="flex items-center gap-1.5 text-xs">
                {CHECK_ICON[c.status]}
                {c.url ? (
                  <button type="button" onClick={() => void host.openLink(c.url!)} className="min-w-0 truncate text-left hover:underline">
                    {c.name}
                  </button>
                ) : (
                  <span className="min-w-0 truncate">{c.name}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {s?.body && (
        <div className="border-t px-3 py-1.5">
          <button type="button" onClick={() => setDescribed((d) => !d)} aria-expanded={described} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            {described ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            Description
          </button>
          {described && <div className="pt-1 text-sm"><Markdown text={s.body} /></div>}
        </div>
      )}

      {s && (canMerge(s) || (failed.length > 0 && job && s.state === "open")) && (
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
          {canMerge(s) && (
            <button
              type="button"
              disabled={merge.isPending}
              onClick={() => merge.mutate()}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <GitMerge className="size-3.5" />
              {merge.isPending ? "Merging…" : "Merge"}
            </button>
          )}
          {failed.length > 0 && job && s.state === "open" && (
            <button
              type="button"
              disabled={fix.isPending || fixSent}
              onClick={() => fix.mutate()}
              className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
              title="Ask the job to fix the failed checks"
            >
              <Wrench className="size-3.5" />
              {fixSent ? "Asked the job to fix it" : fix.isPending ? "Asking…" : "Fix"}
            </button>
          )}
          {s.mergeable === null && s.state === "open" && <span className="text-xs text-muted-foreground">GitHub is still checking it merges cleanly.</span>}
        </div>
      )}
      {s?.state === "open" && s.mergeable === false && <p className="border-t px-3 py-2 text-xs text-amber-700 dark:text-amber-300">It has conflicts with {s.base}.</p>}
      {merge.isError && <div className="border-t px-3 py-2"><Notice tone="error">{said(merge.error)}</Notice></div>}
      {fix.isError && (
        <div className="border-t px-3 py-2">
          <Notice tone="error">{sendRefusal(errorText(fix.error)).kind === "busy" ? "The job is still working — try again in a minute." : said(fix.error)}</Notice>
        </div>
      )}
    </div>
  );
}
