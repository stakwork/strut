// Support (plans/support-chat.md §3; plans/people-and-hosts.md §5): the
// staff's chat with workers over the treasury's Sphinx DMs, laid out as
// strut/jamie is — the conversations on the left, the thread on the right,
// the worker beside it on a wide screen. On a phone the list opens a thread
// and Back returns to it. Every reply is from "Support" (ruling 4); a photo
// shows inline, a voice note plays, any other file downloads; a deleted
// message is a line (ruling 12); a task's id is a link to it. Staff attach,
// paste or drop a photo (shrunk here to 1,600 px) or a file (up to 2.5 MB);
// Delete takes one of Support's messages back on both sides; a conversation
// is taken and marked done, and the list filters by mine and unassigned.
// Settings holds Support's picture, payout lines and the welcome.
//
// Support's tables are this app's own SQLite (db/001-support.sql): every
// read here is SQL (`useSql`), and so is what the page writes to its own
// columns — seen, done, taken, settings (`useSqlMutation`). A reply, a
// deletion, a file and the picture go through the `support/*` tools. The
// daemon hands strut each DM; the app's channel says so (App.tsx reads
// again on it), and every read is also read again every 30 s.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowUp, Check, CheckCheck, Clock, Download, FileText, Loader2, Paperclip, Reply, RotateCcw, Search, Settings, Trash2, UserCheck, UserPlus, X } from "lucide-react";
import { useNames, useSql, useSqlMutation, useStrutClient } from "@strut/kit";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  attachProblem,
  AUTO_LABELS,
  balanceCells,
  fmtBytes,
  fmtWhen,
  initialsOf,
  jpgName,
  liveTypesText,
  messageLine,
  paymentLine,
  shrinkable,
  SUPPORT_AVATAR_SIDE,
  SUPPORT_FILTERS,
  SUPPORT_PHOTO_SIDE,
  supportName,
  textPieces,
  type Place,
  type Shown,
} from "../lib/view";
import { base64Of, shrinkImage } from "../lib/shrink";
import type { SupportFile, SupportFilter, SupportMessage, Worker, WorkerActivity } from "../lib/types";
import {
  CONVERSATION_SQL,
  conversationOf,
  LET_GO_SQL,
  likeOf,
  LIST_SQL,
  messageOf,
  PAYOUT_LINES_SQL,
  searchHit,
  SEEN_SQL,
  SETTINGS_SQL,
  settingsOf,
  STATUS_SQL,
  SUPPORT_REFETCH_MS,
  TAKE_SQL,
  TEXT_MATCH_SQL,
  THREAD_PAGE,
  THREAD_SQL,
  WELCOME_SQL,
  type ConversationRow,
  type MessageRow,
  type SettingsRow,
} from "../lib/support";
import { Back, ErrorLine, Field, Loading, Note, Picture } from "./bits";

/** A send still `sending` this long with no word may be tried again
 *  (`support/send`'s `SEND_STALE_MS`): the daemon sends one id once. */
const STUCK_MS = 60_000;
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
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<SupportFilter>("open");
  // Searched once the typing pauses, not per key.
  const [asked, setAsked] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setAsked(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const list = useSql<ConversationRow>(LIST_SQL, { filter }, { refetchInterval: SUPPORT_REFETCH_MS });
  // Their own names (plans/people-and-hosts.md §1), asked once for the list.
  const names = useNames(list.data?.rows.map((r) => r.actor)).data;
  // A search reads the messages that say it; names and notes are matched here.
  const said = useSql<{ pubkey: string }>(asked ? TEXT_MATCH_SQL : undefined, { like: likeOf(asked) });
  const hits = useMemo(() => new Set((said.data?.rows ?? []).map((r) => r.pubkey)), [said.data]);
  const rows = useMemo(
    () =>
      (list.data?.rows ?? [])
        .map((r) => conversationOf(r, names?.[r.actor]))
        .filter((c) => !asked || searchHit(asked, c, [props.workerOf.get(c.worker)?.note ?? "", c.alias ?? ""], hits)),
    [list.data, names, asked, hits, props.workerOf],
  );
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
      <div className="flex shrink-0 gap-1 border-b px-2 py-1.5" role="tablist" aria-label="Which conversations">
        {SUPPORT_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn("rounded-full px-2.5 py-0.5 text-xs", filter === f.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.error ? <ErrorLine error={list.error} className="m-2" /> : null}
        {!list.data && !list.error && <div className="p-3"><Loading /></div>}
        {list.data && rows.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            {asked ? "No conversation matches." : filter === "open" ? "No open conversation: every worker who wrote has an answer, or none has written yet." : filter === "mine" ? "None is yours: take one from its thread." : filter === "done" ? "None is done yet." : "Every open conversation is taken."}
          </p>
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
                {(!worker || c.assigned || c.status === "done") && (
                  <span className="text-[11px] text-muted-foreground">{[!worker && "Not a worker here", c.assigned === "me" ? "Yours" : c.assigned === "other" ? "Taken" : "", c.status === "done" && "Done"].filter(Boolean).join(" · ")}</span>
                )}
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
    <Avatar aria-hidden className={cn("size-9 shrink-0", props.className)}>
      <AvatarFallback className="text-xs font-semibold">{initialsOf(props.name)}</AvatarFallback>
    </Avatar>
  );
}

// ── the thread ──────────────────────────────────────────────────────────────

/** A file ready to go: shrunk when it is a photo, as base64. */
interface Attached {
  name: string;
  type: string;
  size: number;
  base64: string;
  /** A photo's own bytes as a data URL, to show before it goes. */
  preview?: string;
}

function Thread(props: { worker: string; workerRecord?: Worker; go: (p: Place) => void; narrow: boolean; onBack: () => void }) {
  const client = useStrutClient();
  const qc = useQueryClient();
  const sql = useSqlMutation();
  const conv = useSql<ConversationRow>(CONVERSATION_SQL, { worker: props.worker }, { refetchInterval: SUPPORT_REFETCH_MS });
  const row = conv.data?.rows[0];
  const names = useNames(row ? [row.actor] : undefined).data;
  const c = row ? conversationOf(row, names?.[row.actor]) : undefined;
  // The newest page, and as many more as Show earlier asked for: one more
  // than shown says there are earlier ones.
  const [limit, setLimit] = useState(THREAD_PAGE);
  const thread = useSql<MessageRow>(c ? THREAD_SQL : undefined, { pubkey: c?.pubkey ?? "", limit: limit + 1 }, { refetchInterval: SUPPORT_REFETCH_MS, maxRows: limit + 1 });
  const [replyTo, setReplyTo] = useState<SupportMessage | null>(null);
  const [sendError, setSendError] = useState<unknown>(null);
  const [attached, setAttached] = useState<Attached | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [dragging, setDragging] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const rows = thread.data?.rows;
  const messages = useMemo(() => (rows ?? []).slice(0, limit).reverse().map(messageOf), [rows, limit]);
  const more = (rows?.length ?? 0) > limit;
  const byId = useMemo(() => new Map(messages.filter((m) => m.id).map((m) => [m.id!, m])), [messages]);
  const name = c ? supportName(c, props.workerRecord) : "";
  const refresh = () => void qc.invalidateQueries({ queryKey: ["strut", "sqlite"] });

  // Read while open: marked seen for every admin — only when there is
  // something unread, so a write (kept as a run) is one per batch read.
  const unread = c?.unread ?? 0;
  useEffect(() => {
    if (c && unread > 0 && !document.hidden) void sql.exec(SEEN_SQL, { pubkey: c.pubkey }).catch(() => {});
  }, [unread, c?.pubkey]);
  // Follow the newest unless the person scrolled up — as messages come and
  // as photos load, which grow the thread after it was drawn.
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !content.current) return;
    const follow = () => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    };
    follow();
    const seen = new ResizeObserver(follow);
    seen.observe(content.current);
    return () => seen.disconnect();
  }, [!!rows]);

  /** A file attached, picked, pasted or dropped: a photo shrunk to 1,600 px
   *  (sent as it is when this browser cannot read it), anything else up to
   *  2.5 MB. */
  const attach = async (file: File) => {
    setSendError(null);
    setAttaching(true);
    try {
      let blob: Blob = file;
      let type = file.type || "application/octet-stream";
      let name = file.name || "file";
      if (shrinkable(type)) {
        try {
          blob = await shrinkImage(file, SUPPORT_PHOTO_SIDE);
          type = "image/jpeg";
          name = jpgName(name);
        } catch {
          // Not readable here: sent as it is, if it fits.
        }
      }
      const problem = attachProblem({ size: blob.size });
      if (problem) throw new Error(problem);
      const base64 = await base64Of(blob);
      setAttached({ name, type, size: blob.size, base64, ...(type.startsWith("image/") ? { preview: `data:${type};base64,${base64}` } : {}) });
    } catch (err) {
      setSendError(err);
    } finally {
      setAttaching(false);
    }
  };

  const send = async (body: { text?: string; replyTo?: string; file?: { base64: string; type: string; name: string } } | { retry: number }) => {
    setSendError(null);
    try {
      await client.run("support/send", { worker: props.worker, ...body });
      pinned.current = true;
      refresh();
      return true;
    } catch (err) {
      setSendError(err);
      return false;
    }
  };
  /** A write about the conversation or a message; its refusal shown above the composer. */
  const act = async (fn: () => Promise<unknown>) => {
    setSendError(null);
    try {
      await fn();
      refresh();
    } catch (err) {
      setSendError(err);
    }
  };
  /** A button's words: beside its icon, or for a screen reader alone on a phone. */
  const words = (text: string) => (props.narrow ? <span className="sr-only">{text}</span> : text);

  const header = (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
      {props.narrow && (
        <Button variant="ghost" size="icon-sm" title="Conversations" onClick={props.onBack}>
          <span className="sr-only">Back</span>
          <ArrowUp className="-rotate-90" />
        </Button>
      )}
      {c && <Initials name={name} className="size-7 text-[10px]" />}
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{name}</span>
      {c?.seenAt !== undefined && <span className="hidden text-xs text-muted-foreground xl:inline">Seen {fmtWhen(c.seenAt)}</span>}
      {c && (
        <>
          {c.assigned === "me" ? (
            <Button variant="secondary" size={props.narrow ? "icon-sm" : "xs"} title="Yours: let it go" onClick={() => void act(() => sql.exec(LET_GO_SQL, { pubkey: c.pubkey }))}>
              <UserCheck /> {words("Yours · Let go")}
            </Button>
          ) : (
            <Button variant="ghost" size={props.narrow ? "icon-sm" : "xs"} title={c.assigned === "other" ? "Another admin took it: take it yourself" : "Make it yours"} onClick={() => void act(() => sql.exec(TAKE_SQL, { pubkey: c.pubkey }))}>
              <UserPlus /> {words(c.assigned === "other" ? "Taken · Take it" : "Take it")}
            </Button>
          )}
          {c.status === "done" ? (
            <Button variant="outline" size={props.narrow ? "icon-sm" : "xs"} title="Open it again" onClick={() => void act(() => sql.exec(STATUS_SQL, { pubkey: c.pubkey, status: "open" }))}>
              <RotateCcw /> {words("Reopen")}
            </Button>
          ) : (
            <Button variant="outline" size={props.narrow ? "icon-sm" : "xs"} title="Answered: off the open list until they write again" onClick={() => void act(() => sql.exec(STATUS_SQL, { pubkey: c.pubkey, status: "done" }))}>
              <CheckCheck /> {words("Done")}
            </Button>
          )}
        </>
      )}
      {props.narrow && (
        <Button variant="ghost" size="sm" onClick={() => props.go({ tab: "workers", worker: props.worker })}>
          Their page
        </Button>
      )}
    </div>
  );

  if (conv.error || (conv.data && !row)) {
    return (
      <section className="flex min-w-0 flex-1 flex-col">
        {props.narrow && <div className="p-2"><Back onClick={props.onBack}>Conversations</Back></div>}
        <div className="p-4">
          {conv.error ? (
            <ErrorLine error={conv.error} />
          ) : (
            <Note className="text-sm">
              This worker has no conversation with Support yet. Support can write only to someone who has it as a contact — an invite gives them one — and their
              conversation starts when they join or write.
            </Note>
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Conversation"
      className={cn("relative flex min-w-0 flex-1 flex-col", dragging && "ring-2 ring-primary ring-inset")}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        void attach(e.dataTransfer.files[0]!);
      }}
    >
      {header}
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!rows && !thread.error && <Loading />}
        {thread.error ? <ErrorLine error={thread.error} /> : null}
        {more && (
          <div className="mb-2 flex justify-center">
            <Button
              size="xs"
              variant="outline"
              disabled={thread.isFetching}
              onClick={() => {
                pinned.current = false;
                setLimit((n) => n + THREAD_PAGE);
              }}
            >
              {thread.isFetching && <Loader2 className="animate-spin" />} Show earlier messages
            </Button>
          </div>
        )}
        <div ref={content} className="flex flex-col gap-1.5">
          {messages.map((m, i) => (
            <div key={m.key} className="contents">
              {i === 0 || new Date(messages[i - 1]!.at).toDateString() !== new Date(m.at).toDateString() ? (
                <div className="my-2 text-center text-[11px] text-muted-foreground">{new Date(m.at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</div>
              ) : null}
              <Line
                m={m}
                quoted={m.replyTo ? byId.get(m.replyTo) : undefined}
                go={props.go}
                onReply={() => setReplyTo(m)}
                onRetry={() => void send({ retry: m.key })}
                onDelete={() => act(() => client.run("support/delete", { key: m.key }))}
              />
            </div>
          ))}
        </div>
      </div>
      {dragging && <div className="pointer-events-none absolute inset-0 grid place-items-center bg-background/70 text-sm font-medium">Drop to attach</div>}
      <Composer
        key={props.worker}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        error={sendError}
        attached={attached}
        attaching={attaching}
        onAttach={(f) => void attach(f)}
        onClearAttached={() => setAttached(null)}
        onSend={async (text) => {
          const ok = await send({
            ...(text.trim() ? { text } : {}),
            ...(replyTo?.id ? { replyTo: replyTo.id } : {}),
            ...(attached ? { file: { base64: attached.base64, type: attached.type, name: attached.name } } : {}),
          });
          if (ok) {
            setReplyTo(null);
            setAttached(null);
          }
          return ok;
        }}
      />
    </section>
  );
}

/** One message: a bubble, or a line (a contact, sats, a deletion). Support's
 *  own may be deleted for both sides, asked first in place (an app frame
 *  has no modals). */
function Line(props: { m: SupportMessage; quoted?: SupportMessage; go: (p: Place) => void; onReply: () => void; onRetry: () => void; onDelete: () => Promise<void> }) {
  const { m } = props;
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  if (m.kind === "contact" || m.kind === "payment") {
    return <div className="my-1 text-center text-xs text-muted-foreground">{m.kind === "contact" ? "Added Support as a contact" : paymentLine(m)} · {fmtWhen(m.at)}</div>;
  }
  const mine = m.fromMe;
  const deletable = mine && !m.deleted && (!!m.id || m.status === "failed");
  // Still sending a minute on, with no word from the daemon (a restart cut
  // it off): sent again under the same id, which the daemon sends once.
  const stuck = mine && !m.deleted && m.status === "sending" && !m.id && Date.now() - m.at > STUCK_MS;
  return (
    <div className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}>
      <div className={cn("group flex w-full items-end gap-1", mine ? "flex-row-reverse" : "flex-row")}>
        <div className={cn("flex max-w-[78%] min-w-0 flex-col gap-1 rounded-2xl px-3 py-2 text-sm", mine ? "rounded-br-sm bg-primary text-primary-foreground" : "rounded-bl-sm bg-muted", m.deleted && "bg-transparent text-muted-foreground italic ring-1 ring-border")}>
          {m.replyTo && !m.deleted && (
            <div className={cn("truncate border-l-2 pl-2 text-xs opacity-80", mine ? "border-primary-foreground/60" : "border-foreground/30")}>
              {props.quoted ? `${props.quoted.fromMe ? "Support" : "They"}: ${messageLine(props.quoted).replace(/^Support: /, "")}` : "An earlier message"}
            </div>
          )}
          {m.deleted ? (
            <span>Message deleted</span>
          ) : (
            <>
              {m.file && <FileView m={m} />}
              {m.text ? <Text text={m.text} go={props.go} mine={mine} /> : null}
            </>
          )}
          <span className={cn("flex items-center gap-1 self-end text-[10px]", mine && !m.deleted ? "text-primary-foreground/70" : "text-muted-foreground")}>
            {m.auto && `${AUTO_LABELS[m.auto]} · `}
            {fmtWhen(m.at)}
            {mine && !m.deleted && m.status === "sending" && <Clock className="size-3" aria-label="Sending" />}
            {mine && !m.deleted && m.status === "sent" && <Check className="size-3" aria-label="Sent" />}
          </span>
        </div>
        {mine && !m.deleted && (m.status === "failed" || stuck) && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-destructive" title={m.error ?? "No word from the daemon yet"}>
            <AlertCircle className="size-4" aria-label={stuck ? "Not confirmed" : "Not sent"} />
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
        {deletable && !asking && (
          <Button size="icon-sm" variant="ghost" className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100" title="Delete for both sides" onClick={() => setAsking(true)}>
            <Trash2 />
          </Button>
        )}
      </div>
      {asking && (
        <div className="flex items-center gap-1 text-xs" role="alertdialog" aria-label="Delete this message">
          <span className="text-muted-foreground">{m.id ? "Delete it for both sides? Their Peel shows “Message deleted”." : "Delete it? It never went."}</span>
          <Button
            size="xs"
            variant="destructive"
            disabled={deleting}
            onClick={async () => {
              setDeleting(true);
              await props.onDelete();
              setDeleting(false);
              setAsking(false);
            }}
          >
            {deleting && <Loader2 className="animate-spin" />} Delete
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setAsking(false)}>
            Cancel
          </Button>
        </div>
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

/** A file of the thread (§3): a photo inline (tap for full size), a voice
 *  note to play, anything else to download; read through `support/file`. */
function FileView(props: { m: SupportMessage }) {
  const client = useStrutClient();
  const f = props.m.file!;
  const kind = f.mediaType?.startsWith("image/") ? "image" : f.mediaType?.startsWith("audio/") ? "audio" : f.mediaType?.startsWith("video/") ? "video" : "other";
  const [want, setWant] = useState(kind !== "other");
  // Read once, in pieces (a step's result is capped at 5 MB), and kept: its
  // key is outside ["strut", "sqlite"], so the page's reads again never read it again.
  const q = useQuery({
    queryKey: ["support-file", props.m.key],
    queryFn: async (): Promise<SupportFile> => {
      let piece = await client.run<SupportFile>("support/file", { key: props.m.key });
      let base64 = piece.base64;
      while (piece.next !== undefined) {
        piece = await client.run<SupportFile>("support/file", { key: props.m.key, offset: piece.next });
        base64 += piece.base64;
      }
      return { ...piece, base64 };
    },
    enabled: want && f.state === "kept",
    staleTime: Infinity,
  });
  const label = `${f.name ?? "File"}${f.size !== undefined ? ` · ${fmtBytes(f.size)}` : ""}`;
  // Support's own, sent from elsewhere: not kept here, its name alone.
  if (!f.state) return <span className="flex items-center gap-1.5 text-xs"><FileText className="size-3.5" /> {label}</span>;
  if (f.state === "too_large") return <span className="text-xs opacity-80">{f.name ?? "A file"} was too large to keep (over 25 MB).</span>;
  if (f.state === "failed") return <span className="text-xs opacity-80" title={f.error}>{f.name ?? "A file"} could not be kept.</span>;
  const url = q.data ? `data:${q.data.mediaType};base64,${q.data.base64}` : undefined;
  if (q.error) return <ErrorLine error={q.error} />;
  if (kind === "image") {
    return url ? (
      <Picture alt={f.name ?? "Photo"} src={url} className="max-h-64 max-w-full rounded-lg" />
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

/** Enter sends, Shift+Enter adds a line; a quoted reply above (§3); a file
 *  attached, pasted or dropped above that, its text then a caption. */
function Composer(props: {
  replyTo: SupportMessage | null;
  onClearReply: () => void;
  onSend: (text: string) => Promise<boolean>;
  error: unknown;
  attached: Attached | null;
  attaching: boolean;
  onAttach: (file: File) => void;
  onClearAttached: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (props.replyTo) area.current?.focus();
  }, [props.replyTo]);
  const ready = (!!text.trim() || !!props.attached) && !props.attaching;
  const submit = async () => {
    if (!ready || busy) return;
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
      {(props.attached || props.attaching) && (
        <div className="mb-2 flex items-center gap-2 rounded-md border bg-muted/50 p-1.5 text-xs" aria-label="Attached">
          {props.attaching ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : props.attached?.preview ? (
            <img src={props.attached.preview} alt="" className="size-10 rounded object-cover" />
          ) : (
            <FileText className="size-5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">{props.attaching ? "Getting it ready…" : `${props.attached!.name} · ${fmtBytes(props.attached!.size)}`}</span>
          {props.attached && (
            <Button variant="ghost" size="icon-xs" title="Remove" onClick={props.onClearAttached}>
              <X />
            </Button>
          )}
        </div>
      )}
      <div className="flex items-end gap-2">
        <Button variant="ghost" size="icon" title="Attach a photo or file (or paste, or drop it here)" disabled={busy || props.attaching} onClick={() => picker.current?.click()}>
          <Paperclip />
        </Button>
        <input
          ref={picker}
          type="file"
          className="hidden"
          aria-label="Attach a file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) props.onAttach(f);
            e.target.value = "";
          }}
        />
        <Textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={props.attached ? "Add a caption (optional)" : "Write as Support"}
          aria-label="Message"
          className="max-h-40 min-h-9 flex-1 resize-none"
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const f = e.clipboardData.files[0];
            if (f) {
              e.preventDefault();
              props.onAttach(f);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
            if (e.key === "Escape" && props.replyTo) props.onClearReply();
          }}
        />
        <Button size="icon" disabled={!ready || busy} title="Send (Enter)" onClick={() => void submit()}>
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

// ── settings: Support's picture, payout lines, the welcome (§3, §5, §6) ─────

function SettingsPanel(props: { onBack: () => void; narrow: boolean }) {
  const client = useStrutClient();
  const qc = useQueryClient();
  const sql = useSqlMutation();
  const q = useSql<SettingsRow>(SETTINGS_SQL);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<"welcome" | "lines" | "photo" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const picker = useRef<HTMLInputElement>(null);
  const s = q.data?.rows[0] ? settingsOf(q.data.rows[0]) : undefined;
  const text = draft ?? s?.welcome ?? "";
  const save = async (what: "welcome" | "lines" | "photo", fn: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["strut", "sqlite"] });
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setBusy(null);
    }
  };
  /** Support's picture: shrunk here to 512 px, then through the daemon. */
  const pick = (file: File) =>
    save("photo", async () => {
      const blob = await shrinkImage(file, SUPPORT_AVATAR_SIDE);
      await client.run("support/set-photo", { photo: { base64: await base64Of(blob), type: "image/jpeg" } });
    });
  return (
    <section aria-label="Support settings" className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
      <Back onClick={props.onBack}>{props.narrow ? "Conversations" : "Close"}</Back>
      <h2 className="text-base font-semibold">Support settings</h2>
      {q.error ? <ErrorLine error={q.error} /> : !s ? <Loading /> : (
        <>
          <Field label="Picture" hint="Workers see it on every message from Support, in Peel: it tells this Support from another Stadeum's.">
            <div className="flex flex-wrap items-center gap-3">
              <Avatar className="size-16">
                {s.photo?.base64 && <AvatarImage src={`data:${s.photo.mediaType};base64,${s.photo.base64}`} alt="Support's picture" className="object-cover" />}
                <AvatarFallback className="text-sm font-semibold">SU</AvatarFallback>
              </Avatar>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => picker.current?.click()}>
                {busy === "photo" && <Loader2 className="animate-spin" />} {s.photo ? "Change" : "Choose a picture"}
              </Button>
              {s.photo && (
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void save("photo", () => client.run("support/set-photo", { photo: null }))}>
                  Remove
                </Button>
              )}
              <input
                ref={picker}
                type="file"
                accept="image/*"
                className="hidden"
                aria-label="Support's picture"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void pick(f);
                  e.target.value = "";
                }}
              />
            </div>
          </Field>
          <div className="flex items-start gap-3">
            <Switch
              id="support-payout-lines"
              className="mt-0.5"
              checked={s.payoutLines}
              disabled={busy !== null}
              onCheckedChange={(c) => void save("lines", () => sql.exec(PAYOUT_LINES_SQL, { on: c }))}
            />
            <label htmlFor="support-payout-lines" className="grid gap-0.5">
              <span className="text-sm font-medium">Payout lines</span>
              <span className="text-xs text-muted-foreground">When a worker's payout settles, Support writes to them: “Paid you 1,200 sats”.</span>
            </label>
          </div>
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
            <Button
              size="sm"
              disabled={busy !== null || draft === null || draft === s.welcome}
              onClick={() => void save("welcome", () => sql.exec(WELCOME_SQL, { welcome: text.trim() ? text : "" })).then((ok) => ok && setDraft(null))}
            >
              {busy === "welcome" && <Loader2 className="animate-spin" />} Save
            </Button>
            {s.savedAt !== undefined && <Note>Last saved {fmtWhen(s.savedAt)}</Note>}
          </div>
          <ErrorLine error={error} />
        </>
      )}
    </section>
  );
}
