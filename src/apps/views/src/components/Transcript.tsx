import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bell, CheckCircle2, ChevronRight, CircleDashed, Loader2, Paperclip, XCircle } from "lucide-react";
import { groupStatus, STATUS_TITLE, transcriptToEntries, type ChatEntry, type ToolGroup, type TranscriptMark } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface TranscriptProps {
  /** An agent's session as strut stores it: AI SDK model messages (`system`,
   *  `user`, `assistant`, `tool`). The run log hands a transcript out as a
   *  link a page cannot fetch, so pass what you have — a run's output (an
   *  agent step with `returnMessages: true`), or a session read elsewhere. */
  messages: Array<{ role: string; content: unknown }>;
  /** Turn boundaries to draw, before the message at each index. */
  marks?: TranscriptMark[];
  /** A tool call without a result yet is pending, not unanswered. */
  live?: boolean;
  className?: string;
}

/** An agent's transcript, folded (`transcriptToEntries`): the person's
 *  messages, the model's text as markdown, its tool calls grouped with their
 *  results (open one to read it), the server's notices folded to a line, and
 *  the turn marks. The text renders through react-markdown, never as HTML. */
export function Transcript({ messages, marks, live = false, className }: TranscriptProps) {
  const entries = useMemo(() => transcriptToEntries(messages, marks), [messages, marks]);
  if (!entries.length) return <p className={cn("text-sm text-muted-foreground", className)}>Nothing said yet.</p>;
  return (
    <div className={cn("flex flex-col gap-3 text-sm", className)} data-testid="transcript">
      {entries.map((e, i) => (
        <Entry key={i} entry={e} live={live && i === entries.length - 1} />
      ))}
    </div>
  );
}

function Entry({ entry, live }: { entry: ChatEntry; live: boolean }) {
  switch (entry.kind) {
    case "user":
      return (
        <div className="ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 whitespace-pre-wrap" data-kind="user">
          {entry.content}
          {entry.attachments && entry.attachments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {entry.attachments.map((a) => (
                <Badge key={a.name} variant="outline" className="gap-1 font-normal">
                  <Paperclip className="size-3" />
                  {a.name}
                </Badge>
              ))}
            </div>
          )}
        </div>
      );
    case "notice":
      return <Notice content={entry.content} />;
    case "text":
      return (
        <div className="leading-relaxed [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_li]:ml-4 [&_ol]:list-decimal [&_p]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_ul]:list-disc" data-kind="text">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.content}</ReactMarkdown>
        </div>
      );
    case "tool":
      return (
        <div className="flex flex-wrap gap-1.5" data-kind="tool">
          {entry.groups.map((g, i) => (
            <ToolChip key={i} group={g} live={live} />
          ))}
        </div>
      );
    case "mark":
      return (
        <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground" data-kind="mark">
          <span className="h-px flex-1 bg-border" />
          <span className="font-medium">{entry.label}</span>
          {entry.detail && <span>{entry.detail}</span>}
          <span className="h-px flex-1 bg-border" />
        </div>
      );
  }
}

function Notice({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const [head, ...rest] = content.split("\n");
  return (
    <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground" data-kind="notice">
      <button type="button" className="flex w-full items-center gap-1.5 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Bell className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{head}</span>
        {rest.length > 0 && <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />}
      </button>
      {open && rest.length > 0 && <pre className="mt-2 whitespace-pre-wrap font-mono">{rest.join("\n")}</pre>}
    </div>
  );
}

const STATUS_ICON = {
  pending: { icon: Loader2, className: "animate-spin text-sky-600" },
  ok: { icon: CheckCircle2, className: "text-emerald-600" },
  error: { icon: XCircle, className: "text-destructive" },
  unknown: { icon: CircleDashed, className: "text-muted-foreground" },
} as const;

const json = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

function ToolChip({ group, live }: { group: ToolGroup; live: boolean }) {
  const [open, setOpen] = useState(false);
  const status = groupStatus(group, live);
  const s = STATUS_ICON[status];
  const Icon = s.icon;
  return (
    <div className={cn("rounded-md border bg-card text-xs", open && "w-full")}>
      <button type="button" className="flex items-center gap-1.5 px-2 py-1" onClick={() => setOpen((o) => !o)} title={STATUS_TITLE[status]} aria-expanded={open}>
        <Icon className={cn("size-3", s.className)} />
        <span className="font-mono">{group.name}</span>
        {group.calls.length > 1 && <span className="text-muted-foreground">×{group.calls.length}</span>}
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t p-2">
          {group.calls.map((c, i) => (
            <div key={c.toolCallId ?? i} className="grid gap-1">
              <pre className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap">{json(c.input)}</pre>
              {c.result && (
                <pre className={cn("max-h-64 overflow-auto rounded p-2 font-mono whitespace-pre-wrap", c.result.isError ? "bg-destructive/10 text-destructive" : "bg-muted/50")}>
                  {json(c.result.output)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
