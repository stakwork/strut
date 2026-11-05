// The thread (Hive's `SidebarChat` + `SidebarChatMessage` +
// `OrchestratorTurnCard`): each turn oldest first — the person's words with
// their files, or a wake (a job it started ended); the working card while
// the turn runs; then the reply, its question, the jobs it started, the
// changes it proposes and what it made. The composer under it; Send is Stop
// while a turn runs. A conversation is followed live
// (`conversation/get { wait }`) and marked read while it is open.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, MessageCircle, PanelLeftOpen, Square, Zap } from "lucide-react";
import { useHost } from "@strut/kit";
import { Markdown } from "./Markdown";
import { cn } from "@/lib/utils";
import { TITLE } from "../deployment";
import { inFlight, sendRefusal, silentReply, turnContext, type SendRefusal } from "../lib/chat";
import type { ConversationTurn, WakeMark } from "../lib/types";
import { useConversation, useSend, useStop, useUpdateConversation } from "../hooks";
import { ArtifactCard, type TurnRuns } from "./ArtifactCard";
import { Composer } from "./Composer";
import { JobCard, useJob } from "./JobCard";
import { ProposalCard } from "./ProposalCard";
import { IconButton, Notice, errorText } from "./bits";

export interface ThreadProps {
  /** The conversation, or a new one's id before its first turn (`draft`). */
  session: string | null;
  draft: boolean;
  /** The draft's first turn was sent: it is a conversation now. */
  onStarted: (id: string) => void;
  onShowList?: () => void;
}

export function Thread({ session, draft, onStarted, onShowList }: ThreadProps) {
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
  const newest = conv.view?.turns[0];
  const running = newest && inFlight(newest.status) ? newest : undefined;
  const unread = conv.view?.conversation.unread;

  // Read while open: the reply that landed is seen.
  useEffect(() => {
    if (session && !draft && unread && !document.hidden) update.mutate({ session, seen: true });
  }, [session, draft, unread, conv.view?.rev]);

  // Follow the bottom unless the person scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [turns.length, newest?.status, pinned]);

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
        <span className="shrink-0 text-xs text-muted-foreground">{TITLE}</span>
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
          {turns.map((t) => (
            <Turn key={t.runId} turn={t} conversation={session!} />
          ))}
        </div>
      </div>
      <div className="shrink-0 px-4 pb-4">
        <div className="mx-auto w-full max-w-3xl space-y-2">
          {refusal && <Notice tone={refusal.kind === "error" ? "error" : "warn"}>{refusal.text}</Notice>}
          <Composer
            placeholder={`Message ${TITLE}`}
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

/** The runs a turn knows, for its files: its own, the jobs it started, the job run a wake woke on. */
function turnRuns(turn: ConversationTurn): TurnRuns {
  const byJob = new Map<string, { workflow: string; runId: string }>();
  const byRun = new Map<string, { workflow: string; runId: string }>([[turn.runId, { workflow: turn.workflow, runId: turn.runId }]]);
  for (const j of turn.jobs) {
    const r = { workflow: j.workflow ?? "job", runId: j.runId };
    byJob.set(j.job, r);
    byRun.set(j.runId, r);
  }
  return { byJob, byRun };
}

function Turn({ turn, conversation }: { turn: ConversationTurn; conversation: string }) {
  const working = inFlight(turn.status);
  const runs = useMemo(() => turnRuns(turn), [turn]);
  const silent = silentReply(turn.text);
  return (
    <div className="flex flex-col gap-2" data-testid="turn" data-run-id={turn.runId} data-status={turn.status}>
      {turn.wake ? (
        <WakeLine wake={turn.wake} />
      ) : (
        <div className="flex flex-col items-end gap-1.5">
          {turn.prompt && (
            <div data-chat-bubble="you" className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground shadow-sm">
              {turn.prompt}
            </div>
          )}
          {turn.attachments?.length ? (
            <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
              {turn.attachments.map((a) => (
                <span key={a.name} className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground">
                  <FileText className="size-3" />
                  {a.name}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      )}
      {working && (
        <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2.5" data-testid="working-card">
          <Loader2 className="size-3.5 animate-spin text-sky-600" />
          <span className="text-sm font-medium">{TITLE} is working on it</span>
        </div>
      )}
      {!working && turn.text && !silent && (
        <div data-chat-bubble="assistant" className="rounded-2xl bg-muted/40 px-3 py-2 shadow-sm">
          <Markdown text={turn.text} />
        </div>
      )}
      {!working && turn.ask && <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">{turn.ask}</div>}
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
      {(turn.artifacts ?? []).map((a) => (
        <ArtifactCard key={a.id} artifact={a} runs={runs} conversation={conversation} />
      ))}
    </div>
  );
}

/** A wake: a job this conversation started ended, and the assistant says what came of it. */
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
