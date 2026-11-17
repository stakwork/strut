// Support (plans/support-chat.md §3): the staff's chat with workers over the
// treasury's Sphinx DMs, laid out as strut/jamie is — the conversations on
// the left, the thread on the right, the worker beside it on a wide screen.
// On a phone the list opens a thread and Back returns to it. The list and
// the thread are read again every few seconds (ruling 16). Every reply is
// from "Support" (ruling 4); a worker's photo shows inline, a voice note
// plays, any other file downloads; a deleted message is a line (ruling 12);
// a task's id is a link to it. Settings holds the welcome alone (§5).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowUp, Check, Clock, Download, Loader2, Reply, Search, Settings, X } from "lucide-react";
import { useStrutClient } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { balanceCells, earlierEnd, fmtBytes, fmtWhen, initialsOf, liveTypesText, messageLine, paymentLine, supportName, textPieces, type Place, type Shown } from "../lib/view";
import type { SupportConversation, SupportFile, SupportMessage, SupportSettings, SupportThread, Worker, WorkerActivity } from "../lib/types";
import { Back, ErrorLine, Field, Loading, Note } from "./bits";

/** How often the list and the open thread are read again (ruling 16). */
const POLL_MS = 3_000;
/** Narrower than this, the list and the thread take turns. */
const NARROW = 768;

interface Props {
  go: (p: Place) => void;
  place: Place;
  shown: Shown;
  workers?: Worker[];
}

function useNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < NARROW);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < NARROW);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return narrow;
}

export function Support(props: Props) {
  const narrow = useNarrow();
  const [settings, setSettings] = useState(false);
  const active = props.place.worker;
  const workerOf = useMemo(() => new Map((props.workers ?? []).map((w) => [w.actor, w])), [props.workers]);
  const open = (worker: string) => {
    setSettings(false);
    props.go({ tab: "support", worker });
  };
  const back = () => {
    setSettings(false);
    props.go({ tab: "support" });
  };
  const showList = !narrow || (!active && !settings);
  const showMain = !narrow || !!active || settings;

  return (
    <div className="flex h-[calc(100dvh-11rem)] min-h-[26rem] overflow-hidden rounded-lg border" data-testid="support">
      {showList && (
        <aside className={cn("flex min-h-0 flex-col border-r", narrow ? "w-full border-r-0" : "w-72 shrink-0")}>
          <ConversationList active={settings ? undefined : active} workerOf={workerOf} onOpen={open} onSettings={() => setSettings(true)} />
        </aside>
      )}
      {showMain && (
        <main className="flex min-w-0 flex-1">
          {settings ? (
            <SettingsPanel onBack={back} narrow={narrow} />
          ) : active ? (
            <>
              <Thread key={active} worker={active} workerRecord={workerOf.get(active)} go={props.go} narrow={narrow} onBack={back} />
              {!narrow && <WorkerPanel actor={active} known={workerOf.has(active)} go={props.go} shown={props.shown} />}
            </>
          ) : (
            <div className="m-auto max-w-sm p-6 text-center text-sm text-muted-foreground">
              Workers write to “Support” from Peel. Pick a conversation to read it and answer; every answer goes from Support.
            </div>
          )}
        </main>
      )}
    </div>
  );
}

// ── the conversations ───────────────────────────────────────────────────────

function ConversationList(props: { active?: string; workerOf: Map<string, Worker>; onOpen: (worker: string) => void; onSettings: () => void }) {
  const client = useStrutClient();
  const [q, setQ] = useState("");
  const list = useQuery({
    queryKey: ["staff", "support", "list", q.trim()],
    queryFn: () => client.run<{ conversations: SupportConversation[] }>("staff/support-list", q.trim() ? { q: q.trim() } : {}),
    refetchInterval: POLL_MS,
  });
  const rows = list.data?.conversations ?? [];
  return (
    <section aria-label="Conversations" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b pr-1 pl-3">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search names and messages"
          aria-label="Search conversations"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {q && (
          <Button variant="ghost" size="icon-sm" title="Clear" onClick={() => setQ("")}>
            <X />
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" title="Support settings" onClick={props.onSettings}>
          <Settings />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.error ? <ErrorLine error={list.error} className="m-2" /> : null}
        {!list.data && !list.error && <div className="p-3"><Loading /></div>}
        {list.data && rows.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">{q.trim() ? "No conversation matches." : "No worker has written to Support yet."}</p>
        )}
        {rows.map((c) => {
          const worker = props.workerOf.get(c.worker);
          const name = supportName(c, worker);
          return (
            <button
              key={c.worker}
              type="button"
              onClick={() => props.onOpen(c.worker)}
              aria-current={c.worker === props.active ? "true" : undefined}
              className={cn("flex w-full items-start gap-2.5 border-b px-3 py-2.5 text-left hover:bg-muted/60", c.worker === props.active && "bg-muted")}
            >
              <Initials name={name} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <span className={cn("min-w-0 flex-1 truncate text-sm", c.unread > 0 ? "font-semibold" : "font-medium")}>{name}</span>
                  {c.last && <span className="shrink-0 text-xs text-muted-foreground">{fmtWhen(c.last.at)}</span>}
                </span>
                <span className="flex items-center gap-2">
                  <span className={cn("min-w-0 flex-1 truncate text-xs", c.unread > 0 ? "text-foreground" : "text-muted-foreground")}>{c.last ? messageLine(c.last) : ""}</span>
                  {c.unread > 0 && <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">{c.unread}</span>}
                </span>
                {!worker && <span className="text-[11px] text-muted-foreground">Not a worker here</span>}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Initials(props: { name: string; className?: string }) {
  return (
    <span aria-hidden className={cn("grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground", props.className)}>
      {initialsOf(props.name)}
    </span>
  );
}

// ── the thread ──────────────────────────────────────────────────────────────

function Thread(props: { worker: string; workerRecord?: Worker; go: (p: Place) => void; narrow: boolean; onBack: () => void }) {
  const client = useStrutClient();
  const qc = useQueryClient();
  const thread = useQuery({
    queryKey: ["staff", "support", "thread", props.worker],
    queryFn: () => client.run<SupportThread>("staff/support-thread", { worker: props.worker }),
    refetchInterval: POLL_MS,
  });
  const [replyTo, setReplyTo] = useState<SupportMessage | null>(null);
  const [sendError, setSendError] = useState<unknown>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const data = thread.data;
  const messages = data?.messages ?? [];
  const byId = useMemo(() => new Map(messages.filter((m) => m.id).map((m) => [m.id!, m])), [messages]);
  const earlier = earlierEnd(messages);
  const name = data ? supportName(data.conversation, props.workerRecord) : "";
  const refresh = () => void qc.invalidateQueries({ queryKey: ["staff", "support"] });

  // Read while open: marked seen for every admin.
  const unread = data?.conversation.unread ?? 0;
  useEffect(() => {
    if (unread > 0 && !document.hidden) void client.run("staff/support-seen", { worker: props.worker }).then(refresh, () => {});
  }, [unread, props.worker]);
  // Follow the newest unless the person scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, messages[messages.length - 1]?.status]);

  const send = async (body: { text: string; replyTo?: string } | { retry: number }) => {
    setSendError(null);
    try {
      await client.run("staff/support-send", { worker: props.worker, ...body });
      pinned.current = true;
      refresh();
      return true;
    } catch (err) {
      setSendError(err);
      return false;
    }
  };

  const header = (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
      {props.narrow && (
        <Button variant="ghost" size="icon-sm" title="Conversations" onClick={props.onBack}>
          <span className="sr-only">Back</span>
          <ArrowUp className="-rotate-90" />
        </Button>
      )}
      {data && <Initials name={name} className="size-7 text-[10px]" />}
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{name}</span>
      {data?.conversation.seenAt !== undefined && <span className="hidden text-xs text-muted-foreground sm:inline">Seen {fmtWhen(data.conversation.seenAt)}</span>}
      {props.narrow && (
        <Button variant="ghost" size="sm" onClick={() => props.go({ tab: "workers", worker: props.worker })}>
          Their page
        </Button>
      )}
    </div>
  );

  if (thread.error) {
    const none = /no_conversation/.test(thread.error instanceof Error ? thread.error.message : String(thread.error));
    return (
      <section className="flex min-w-0 flex-1 flex-col">
        {props.narrow && <div className="p-2"><Back onClick={props.onBack}>Conversations</Back></div>}
        <div className="p-4">
          {none ? (
            <Note className="text-sm">
              This worker has no conversation with Support yet. Support can write only to someone who has it as a contact — an invite gives them one — and their
              conversation starts when they join or write.
            </Note>
          ) : (
            <ErrorLine error={thread.error} />
          )}
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Conversation" className="flex min-w-0 flex-1 flex-col">
      {header}
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!data && <Loading />}
        <div className="flex flex-col gap-1.5">
          {messages.map((m, i) => (
            <div key={m.key} className="contents">
              {i === 0 || new Date(messages[i - 1]!.at).toDateString() !== new Date(m.at).toDateString() ? (
                <div className="my-2 text-center text-[11px] text-muted-foreground">{new Date(m.at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</div>
              ) : null}
              <Line m={m} worker={props.worker} quoted={m.replyTo ? byId.get(m.replyTo) : undefined} replyTo={m.replyTo} go={props.go} onReply={() => setReplyTo(m)} onRetry={() => void send({ retry: m.key })} />
              {i === earlier && (
                <div className="my-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="h-px flex-1 bg-border" /> Above: written before Support was set up <span className="h-px flex-1 bg-border" />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <Composer key={props.worker} replyTo={replyTo} onClearReply={() => setReplyTo(null)} error={sendError} onSend={(text) => send({ text, ...(replyTo?.id ? { replyTo: replyTo.id } : {}) }).then((ok) => (ok && setReplyTo(null), ok))} />
    </section>
  );
}

/** One message: a bubble, or a line (a contact, sats, a deletion). */
function Line(props: { m: SupportMessage; worker: string; quoted?: SupportMessage; replyTo?: string; go: (p: Place) => void; onReply: () => void; onRetry: () => void }) {
  const { m } = props;
  if (m.kind === "contact" || m.kind === "payment") {
    return <div className="my-1 text-center text-xs text-muted-foreground">{m.kind === "contact" ? "Added Support as a contact" : paymentLine(m)} · {fmtWhen(m.at)}</div>;
  }
  const mine = m.fromMe;
  return (
    <div className={cn("group flex items-end gap-1", mine ? "flex-row-reverse" : "flex-row")}>
      <div className={cn("flex max-w-[78%] min-w-0 flex-col gap-1 rounded-2xl px-3 py-2 text-sm", mine ? "rounded-br-sm bg-primary text-primary-foreground" : "rounded-bl-sm bg-muted", m.deleted && "bg-transparent text-muted-foreground italic ring-1 ring-border")}>
        {props.replyTo && !m.deleted && (
          <div className={cn("truncate border-l-2 pl-2 text-xs opacity-80", mine ? "border-primary-foreground/60" : "border-foreground/30")}>
            {props.quoted ? `${props.quoted.fromMe ? "Support" : "They"}: ${messageLine(props.quoted).replace(/^Support: /, "")}` : "An earlier message"}
          </div>
        )}
        {m.deleted ? (
          <span>Message deleted</span>
        ) : (
          <>
            {m.file && <FileView worker={props.worker} m={m} />}
            {m.text ? <Text text={m.text} go={props.go} mine={mine} /> : null}
          </>
        )}
        <span className={cn("flex items-center gap-1 self-end text-[10px]", mine ? "text-primary-foreground/70" : "text-muted-foreground")}>
          {m.welcome && "Welcome · "}
          {fmtWhen(m.at)}
          {mine && m.status === "sending" && <Clock className="size-3" aria-label="Sending" />}
          {mine && m.status === "sent" && <Check className="size-3" aria-label="Sent" />}
        </span>
      </div>
      {mine && m.status === "failed" && (
        <span className="flex shrink-0 items-center gap-1 text-xs text-destructive" title={m.error}>
          <AlertCircle className="size-4" aria-label="Not sent" />
          <Button size="xs" variant="outline" onClick={props.onRetry}>
            Retry
          </Button>
        </span>
      )}
      {m.id && !m.deleted && (
        <Button size="icon-sm" variant="ghost" className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100" title="Reply" onClick={props.onReply}>
          <Reply />
        </Button>
      )}
    </div>
  );
}

/** A message's words, each task id a link to the task (§3). */
function Text(props: { text: string; go: (p: Place) => void; mine: boolean }) {
  return (
    <span className="break-words whitespace-pre-wrap">
      {textPieces(props.text).map((p, i) =>
        "task" in p ? (
          <button key={i} type="button" className={cn("font-mono underline underline-offset-2", props.mine ? "" : "text-primary")} onClick={() => props.go({ tab: "tasks", task: p.task })}>
            {p.task}
          </button>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </span>
  );
}

/** A worker's file (§3): a photo inline (tap for full size), a voice note
 *  to play, anything else to download; read through `staff/support-file`. */
function FileView(props: { worker: string; m: SupportMessage }) {
  const client = useStrutClient();
  const f = props.m.file!;
  const kind = f.mediaType?.startsWith("image/") ? "image" : f.mediaType?.startsWith("audio/") ? "audio" : f.mediaType?.startsWith("video/") ? "video" : "other";
  const [want, setWant] = useState(kind !== "other");
  const [full, setFull] = useState(false);
  const q = useQuery({
    queryKey: ["staff", "support", "file", props.worker, props.m.id],
    queryFn: () => client.run<SupportFile>("staff/support-file", { worker: props.worker, id: props.m.id! }),
    enabled: want && f.state === "kept" && !!props.m.id,
    staleTime: Infinity,
  });
  const label = `${f.name ?? "File"}${f.size !== undefined ? ` · ${fmtBytes(f.size)}` : ""}`;
  if (f.state === "fetching") return <span className="flex items-center gap-1.5 text-xs opacity-80"><Loader2 className="size-3 animate-spin" /> Fetching {f.name ?? "the file"}…</span>;
  if (f.state === "too_large") return <span className="text-xs opacity-80">{f.name ?? "A file"} was too large to keep (over 25 MB).</span>;
  if (f.state === "failed") return <span className="text-xs opacity-80" title={f.error}>{f.name ?? "A file"} could not be fetched.</span>;
  const url = q.data ? `data:${q.data.mediaType};base64,${q.data.base64}` : undefined;
  if (q.error) return <ErrorLine error={q.error} />;
  if (kind === "image") {
    return url ? (
      <>
        <button type="button" onClick={() => setFull(true)} title="Full size">
          <img alt={f.name ?? "Photo"} src={url} className="max-h-64 max-w-full rounded-lg" />
        </button>
        {full && (
          <button type="button" className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4" onClick={() => setFull(false)} aria-label="Close">
            <img alt={f.name ?? "Photo"} src={url} className="max-h-full max-w-full" />
          </button>
        )}
      </>
    ) : (
      <span className="flex items-center gap-1.5 text-xs opacity-80"><Loader2 className="size-3 animate-spin" /> {label}</span>
    );
  }
  if (kind === "audio" && url) return <audio controls src={url} className="max-w-full" />;
  if (kind === "video" && url) return <video controls src={url} className="max-h-64 max-w-full rounded-lg" />;
  return url ? (
    <a className="flex items-center gap-1.5 underline underline-offset-2" download={f.name ?? "file"} href={url}>
      <Download className="size-3.5" /> {label}
    </a>
  ) : (
    <button type="button" className="flex items-center gap-1.5 text-left underline underline-offset-2" onClick={() => setWant(true)}>
      {q.isFetching ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} {label}
    </button>
  );
}

/** Enter sends, Shift+Enter adds a line; a quoted reply above (§3). */
function Composer(props: { replyTo: SupportMessage | null; onClearReply: () => void; onSend: (text: string) => Promise<boolean>; error: unknown }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (props.replyTo) area.current?.focus();
  }, [props.replyTo]);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await props.onSend(text);
    setBusy(false);
    if (ok) setText("");
    area.current?.focus();
  };
  return (
    <div className="shrink-0 border-t p-2">
      {props.error ? <ErrorLine error={props.error} className="mb-2" /> : null}
      {props.replyTo && (
        <div className="mb-2 flex items-center gap-2 rounded-md border-l-2 border-primary bg-muted px-2 py-1 text-xs">
          <Reply className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{messageLine(props.replyTo)}</span>
          <Button variant="ghost" size="icon-xs" title="No reply" onClick={props.onClearReply}>
            <X />
          </Button>
        </div>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          ref={area}
          rows={1}
          value={text}
          placeholder="Write as Support"
          aria-label="Message"
          className="max-h-40 min-h-9 flex-1 resize-none"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
            if (e.key === "Escape" && props.replyTo) props.onClearReply();
          }}
        />
        <Button size="icon" disabled={!text.trim() || busy} title="Send (Enter)" onClick={() => void submit()}>
          {busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}
        </Button>
      </div>
    </div>
  );
}

// ── the worker beside the thread ────────────────────────────────────────────

function WorkerPanel(props: { actor: string; known: boolean; go: (p: Place) => void; shown: Shown }) {
  const client = useStrutClient();
  const q = useQuery({
    queryKey: ["staff", "worker", props.actor],
    queryFn: () => client.run<{ worker: Worker } & WorkerActivity>("staff/worker", { actor: props.actor }),
    enabled: props.known,
  });
  const body = (): ReactNode => {
    if (!props.known) return <Note>Not a worker here: they have Support as a contact and have not signed in to a worker app.</Note>;
    if (q.error) return <ErrorLine error={q.error} />;
    if (!q.data) return <Loading />;
    const { worker: w, holding, week } = q.data;
    const answered = Object.values(week ?? {}).reduce((n, d) => n + d.answered, 0);
    const [earned, held, free] = balanceCells(w.balance);
    return (
      <>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={w.status === "active" ? "secondary" : w.status === "new" ? "outline" : "destructive"}>{w.status}</Badge>
        </div>
        <Fact label="Types">{liveTypesText(w) || "none"}</Fact>
        <Fact label="Now">
          {holding ? (
            <button type="button" className="text-left underline underline-offset-2" onClick={() => props.go({ tab: "tasks", task: holding.task })}>
              a {holding.type} task, until {fmtWhen(holding.expires)}
            </button>
          ) : (
            "no task"
          )}
        </Fact>
        <Fact label="This week">{`${answered} answered`}</Fact>
        {props.shown.earnings && <Fact label="Owed">{`${earned} (${held} held, ${free} withdrawable)`}</Fact>}
        {w.note && <Fact label="Note"><span className="whitespace-pre-wrap">{w.note}</span></Fact>}
        <div className="flex flex-col items-start gap-1">
          <Button size="sm" variant="ghost" className="-ml-2" onClick={() => props.go({ tab: "workers", worker: props.actor })}>
            Their page
          </Button>
          <Button size="sm" variant="ghost" className="-ml-2" onClick={() => props.go({ tab: "tasks", by: props.actor })}>
            Their answers
          </Button>
          {props.shown.payouts && (
            <Button size="sm" variant="ghost" className="-ml-2" onClick={() => props.go({ tab: "payouts", worker: props.actor })}>
              Their payouts
            </Button>
          )}
        </div>
      </>
    );
  };
  return <aside aria-label="The worker" className="hidden w-60 shrink-0 flex-col gap-3 overflow-y-auto border-l p-3 text-sm lg:flex">{body()}</aside>;
}

function Fact(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{props.label}</span>
      <span>{props.children}</span>
    </div>
  );
}

// ── settings: the welcome (§5) ──────────────────────────────────────────────

function SettingsPanel(props: { onBack: () => void; narrow: boolean }) {
  const client = useStrutClient();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["staff", "support", "settings"], queryFn: () => client.run<{ settings: SupportSettings }>("staff/support-settings", {}) });
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const s = q.data?.settings;
  const text = draft ?? s?.welcome ?? "";
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.run("staff/support-save-settings", { welcome: text });
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ["staff", "support", "settings"] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Support settings" className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <Back onClick={props.onBack}>{props.narrow ? "Conversations" : "Close"}</Back>
      <h2 className="text-base font-semibold">Support settings</h2>
      {q.error ? <ErrorLine error={q.error} /> : !s ? <Loading /> : (
        <>
          <Field
            label="Welcome"
            htmlFor="support-welcome"
            hint={
              s.welcome && s.since !== undefined
                ? `Sent automatically, from Support, to each worker who adds Support as a contact — since ${fmtWhen(s.since)}, once each. Clear it to stop.`
                : "Empty: no welcome is sent. Once saved, it goes automatically to each worker who adds Support as a contact from then on, once each; those who joined before get none."
            }
          >
            <Textarea
              id="support-welcome"
              rows={4}
              maxLength={2000}
              value={text}
              placeholder="Welcome! This is Support. Ask us anything about your tasks or pay here."
              onChange={(e) => setDraft(e.target.value)}
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={busy || draft === null || draft === s.welcome} onClick={() => void save()}>
              {busy && <Loader2 className="animate-spin" />} Save
            </Button>
            {s.savedAt !== undefined && <Note>Last saved {fmtWhen(s.savedAt)}</Note>}
          </div>
          <ErrorLine error={error} />
        </>
      )}
    </section>
  );
}
