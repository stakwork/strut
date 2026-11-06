// The thread (Hive's `SidebarChat` + `SidebarChatMessage` +
// `OrchestratorTurnCard`): each turn oldest first — the person's words with
// their files, or a wake (a job it started ended); the working card while
// the turn runs; then the reply, its question, on a wake what the job
// delivered, the jobs it started, the changes it proposes and what it made. The composer under it; Send is Stop
// while a turn runs. A conversation is followed live
// (`conversation/get { wait }`) and marked read while it is open.
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, MessageCircle, PanelLeftOpen, Square, Zap } from "lucide-react";
import { useHost } from "@strut/kit";
import { Markdown } from "./Markdown";
import { cn } from "@/lib/utils";
import { inFlight, sendRefusal, silentReply, turnContext, type SendRefusal } from "../lib/chat";
import { turnDeliverables, type Shown } from "../lib/artifacts";
import type { ConversationTurn, WakeMark } from "../lib/types";
import { useConversation, useSend, useStop, useUpdateConversation } from "../hooks";
import { ArtifactCard, type TurnRuns } from "./ArtifactCard";
import { ThreadPrs } from "./PullRequestCard";
import { prKey, prOf } from "../lib/pr";
import { Composer } from "./Composer";
import { JobCard, useJob } from "./JobCard";
import { ProposalCard } from "./ProposalCard";
import { CopyButton, IconButton, Notice, errorText } from "./bits";
import { TurnAttachments } from "./Attachments";

export interface ThreadProps {
  /** The conversation, or a new one's id before its first turn (`draft`). */
  session: string | null;
  draft: boolean;
  /** The draft's first turn was sent: it is a conversation now. */
  onStarted: (id: string) => void;
  onShowList?: () => void;
  /** Show this job's newest card (a click on it in the list). */
  focusJob?: { job: string; at: number };
}

export function Thread({ session, draft, onStarted, onShowList, focusJob }: ThreadProps) {
  const host = useHost();
  const qc = useQueryClient();
  const conv = useConversation(draft ? null : session);
  const send = useSend();
  const stop = useStop();
  const update = useUpdateConversation();
  const [refusal, setRefusal] = useState<SendRefusal | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  useEffect(() => setRefusal(null), [session]);

  // Oldest first, as a thread reads.
  const turns = useMemo(() => [...conv.turns].reverse(), [conv.turns]);
  // One card per pull request: the newest turn that names it shows it.
  const threadPrs = useMemo(() => {
    const owner = new Map<string, string>();
    for (const t of turns) {
      const { delivered, own } = turnDeliverables(t);
      for (const { artifact } of [...delivered, ...own]) {
        const pr = prOf(artifact);
        if (pr) owner.set(prKey(pr), t.runId);
      }
    }
    return owner;
  }, [turns]);
  // The jobs whose cards the thread shows: a wake on one of them needs no line.
  const carded = useMemo(() => new Set(turns.flatMap((t) => t.jobs.map((j) => j.job))), [turns]);
  const newest = conv.view?.turns[0];
  const running = newest && inFlight(newest.status) ? newest : undefined;
  const unread = conv.view?.conversation.unread;

  // Read while open: the reply that landed is seen.
  useEffect(() => {
    if (session && !draft && unread && !document.hidden) update.mutate({ session, seen: true });
  }, [session, draft, unread, conv.view?.rev]);

  /** The `focusJob` last shown. */
  const shown = useRef<number | null>(null);
  // Follow the bottom unless the person scrolled up (or a job asked for
  // from the list is yet to be shown).
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned && !(focusJob && shown.current !== focusJob.at)) el.scrollTop = el.scrollHeight;
  }, [turns.length, newest?.status, pinned]);

  // A job asked for from the list: its newest card, once the turns are in.
  useEffect(() => {
    if (!focusJob || shown.current === focusJob.at || !scroller.current) return;
    const cards = scroller.current.querySelectorAll<HTMLElement>(`[data-testid="job-card"][data-job="${CSS.escape(focusJob.job)}"]`);
    const card = cards[cards.length - 1];
    if (!card) return;
    shown.current = focusJob.at;
    setPinned(false);
    card.scrollIntoView({ block: "center" });
    card.animate([{ boxShadow: "0 0 0 2px var(--ring)" }, { boxShadow: "0 0 0 0 transparent" }], { duration: 1600 });
  }, [focusJob, turns]);

  const onSend = async (text: string, files: File[], model: string): Promise<boolean> => {
    if (!session) return false;
    setRefusal(null);
    try {
      await send.mutateAsync({
        session,
        prompt: text || (files.length ? "See the attached files." : ""),
        context: turnContext(new Date(), host.timeZone),
        ...(model ? { model } : {}),
        files,
      });
      if (draft) onStarted(session);
      conv.refresh();
      void qc.invalidateQueries({ queryKey: ["assistant", "list"] });
      setPinned(true);
      return true;
    } catch (err) {
      setRefusal(sendRefusal(errorText(err)));
      return false;
    }
  };

  const title = draft ? "New chat" : (conv.view?.conversation.title || (conv.view ? "Untitled" : ""));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        {onShowList && (
          <IconButton label="Show chats" onClick={onShowList}>
            <PanelLeftOpen />
          </IconButton>
        )}
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium" title={title}>{title}</h1>
        {conv.view?.conversation.shared && <span className="shrink-0 text-xs text-muted-foreground">Shared</span>}
        <span className="shrink-0 text-xs text-muted-foreground">Jamie</span>
      </header>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        data-testid="thread"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          {!session && <Empty />}
          {session && draft && <Empty />}
          {conv.error && !conv.view && <Notice tone="error">{errorText(conv.error)}</Notice>}
          {session && !draft && !conv.view && !conv.error && <p className="text-sm text-muted-foreground">Loading…</p>}
          {conv.hasOlder && (
            <button type="button" onClick={() => void conv.loadOlder()} className="self-center text-xs text-muted-foreground hover:text-foreground">
              Earlier turns
            </button>
          )}
          <ThreadPrs.Provider value={threadPrs}>
            {turns.map((t) => (
              <Turn key={t.runId} turn={t} conversation={session!} carded={carded} />
            ))}
          </ThreadPrs.Provider>
        </div>
      </div>
      <div className="shrink-0 px-4 pb-4">
        <div className="mx-auto w-full max-w-3xl space-y-2">
          {refusal && <Notice tone={refusal.kind === "error" ? "error" : "warn"}>{refusal.text}</Notice>}
          <Composer
            placeholder="Message Jamie"
            disabled={!session}
            sending={send.isPending}
            onSend={onSend}
            running={running ? { stopping: stop.isPending, onStop: () => stop.mutate({ workflow: running.workflow, runId: running.runId }) } : null}
          />
        </div>
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-24 text-center">
      <span className="flex size-9 items-center justify-center rounded-full bg-sky-500/10 text-sky-500">
        <MessageCircle className="size-4" />
      </span>
      <p className="text-sm font-medium">What should we work on?</p>
    </div>
  );
}

/** The runs a turn knows, for its files: its own, the job runs a wake woke
 *  on, the jobs it started or continued. A job run whose workflow the turn
 *  does not know is left out: its card finds the run (`job/get`). */
function turnRuns(turn: ConversationTurn): TurnRuns {
  const byJob = new Map<string, { workflow: string; runId: string }>();
  const byRun = new Map<string, { workflow: string; runId: string }>([[turn.runId, { workflow: turn.workflow, runId: turn.runId }]]);
  for (const j of [...(turn.delivered ?? []), ...turn.jobs]) {
    if (!j.workflow) continue;
    const r = { workflow: j.workflow, runId: j.runId };
    byJob.set(j.job, r);
    byRun.set(j.runId, r);
  }
  return { byJob, byRun };
}

function Turn({ turn, conversation, carded }: { turn: ConversationTurn; conversation: string; carded: ReadonlySet<string> }) {
  const working = inFlight(turn.status);
  const runs = useMemo(() => turnRuns(turn), [turn]);
  const silent = silentReply(turn.text);
  const threadPrs = useContext(ThreadPrs);
  // The job a pull request in the reply came from: the one a wake woke on,
  // or the only one the turn started.
  const prJob = turn.wake && turn.wake !== true ? turn.wake.job : turn.jobs.length === 1 ? turn.jobs[0]!.job : undefined;
  const { delivered, own } = useMemo(() => turnDeliverables(turn), [turn]);
  // A pull request shows once in the thread, in the newest turn naming it.
  const card = ({ artifact, job }: Shown) => {
    const pr = prOf(artifact);
    if (pr && threadPrs.get(prKey(pr)) !== turn.runId) return null;
    const from = job ?? prJob;
    return <ArtifactCard key={`${job ?? ""}:${artifact.id}`} artifact={artifact} runs={runs} conversation={conversation} {...(from ? { job: from } : {})} />;
  };
  return (
    <div className="flex flex-col gap-2" data-testid="turn" data-run-id={turn.runId} data-status={turn.status}>
      {turn.wake ? (
        !wakeCarded(turn.wake, carded) && <WakeLine wake={turn.wake} />
      ) : (
        <div className="flex flex-col items-end gap-1.5">
          {turn.prompt && (
            <div data-chat-bubble="you" className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground shadow-sm">
              {turn.prompt}
            </div>
          )}
          {turn.attachments?.length ? <TurnAttachments files={turn.attachments} workflow={turn.workflow} runId={turn.runId} /> : null}
        </div>
      )}
      {working && (
        <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2.5" data-testid="working-card">
          <Loader2 className="size-3.5 animate-spin text-sky-600" />
          <span className="text-sm font-medium">Jamie is working on it</span>
        </div>
      )}
      {!working && turn.text && !silent && (
        <div data-chat-bubble="assistant" className="group/reply relative rounded-2xl bg-muted/40 py-2 pl-3 pr-8 shadow-sm">
          <Markdown text={turn.text} />
          <CopyButton text={turn.text} label="Copy reply" className="absolute right-1 top-1 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/reply:opacity-100" />
        </div>
      )}
      {!working && turn.ask && <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">{turn.ask}</div>}
      {!working && delivered.map(card)}
      {turn.status === "error" && <Notice tone="error">{turn.error ?? "This turn failed."}</Notice>}
      {turn.status === "cancelled" && (
        <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <Square className="size-2.5 fill-current" />
          Stopped
        </div>
      )}
      {turn.status === "stale" && <Notice>This turn was cut off when the server restarted.</Notice>}
      {turn.jobs.map((j) => (
        <JobCard key={`${j.job}:${j.runId}`} job={j.job} runId={j.runId} {...(j.workflow ? { workflow: j.workflow } : {})} conversation={conversation} />
      ))}
      {turn.proposals.map((p) => (
        <ProposalCard key={p.id} brief={p} />
      ))}
      {own.map(card)}
    </div>
  );
}

/** Every job a wake woke on has its card in the thread, whose pill already
 *  says it ended. */
function wakeCarded(wake: WakeMark | true, carded: ReadonlySet<string>): boolean {
  return wake !== true && [wake, ...(wake.also ?? [])].every((j) => carded.has(j.job));
}

/** A wake on a job the thread has no card for (a host's, another strut's):
 *  it ended, and the assistant says what came of it. */
function WakeLine({ wake }: { wake: WakeMark | true }) {
  const first = wake === true ? undefined : wake;
  const job = useJob(first?.job ?? "", false);
  const more = first?.also?.length ?? 0;
  const name = first ? (job.data?.title ?? first.job) : "A job";
  return (
    <div className={cn("flex items-center gap-1.5 px-1 text-xs text-muted-foreground")} data-testid="wake-line">
      <Zap className="size-3 text-amber-500" />
      <span className="truncate">
        {name}
        {more ? ` and ${more} more` : ""}
        {first?.peer ? ` on @${first.peer}` : ""} finished
      </span>
    </div>
  );
}
