// Groups: the tasks a workflow put together with `task/reply`'s `group` — a
// book's pages, a batch's photos — read and reviewed as one. The list: each
// group's type, who answered, its tasks and answers, and how they were
// reviewed, the one with the newest task first. A group's page: its tasks
// oldest first, each with its picture (the reply's first, else the
// answer's) as it comes into view and its verdict (Mark ok, Reject with
// why); Mark the rest ok gives every answer with no verdict the same one.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useStrutClient } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { answerFiles, fmtWhen, isPicture, reviewable, shortActor, whoOf, type Place } from "../lib/view";
import type { SentFile, Task, TaskFile, TaskGroup, TaskType, Worker } from "../lib/types";
import { Back, Empty, ErrorLine, Figure, Loading, Note, Picture, Section, useAct } from "./bits";
import { ReviewLine, useSeen } from "./Tasks";

/** A group's tasks read at once: the routes' page at its largest. */
const GROUP_TASKS = 1000;

interface Props {
  go: (p: Place) => void;
  place: Place;
  types?: TaskType[];
  workers?: Worker[];
}

export function Groups(props: Props) {
  if (props.place.group) return <GroupPage {...props} group={props.place.group} />;
  return <GroupList {...props} />;
}

/** A worker's name here, from the list read. */
function useWho(workers: Worker[] | undefined) {
  const byActor = useMemo(() => new Map((workers ?? []).map((w) => [w.actor, w])), [workers]);
  return (actor: string) => {
    const w = byActor.get(actor);
    return w ? whoOf(w) : shortActor(actor);
  };
}

/** `2 ok, 1 rejected, 3 to review`; "" with no answer. */
function verdictsText(n: { ok: number; rejected: number; unreviewed: number }): string {
  return [n.ok && `${n.ok} ok`, n.rejected && `${n.rejected} rejected`, n.unreviewed && `${n.unreviewed} to review`].filter(Boolean).join(", ");
}

function GroupList(props: Props) {
  const client = useStrutClient();
  const [type, setType] = useState(props.place.type ?? "");
  const q = useQuery({
    queryKey: ["staff", "groups", type],
    queryFn: () => client.run<{ groups: TaskGroup[] }>("staff/groups", { ...(type ? { type } : {}), limit: 500 }),
  });
  const who = useWho(props.workers);
  const groups = q.data?.groups ?? [];
  return (
    <Section title="Groups" aside={<Note>Newest first</Note>}>
      <Note>What a workflow put together with its task/reply step's group (a book's pages, a batch's photos): read and reviewed as one.</Note>
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect aria-label="Type" value={type} onChange={(e) => setType(e.target.value)}>
          <NativeSelectOption value="">Every type</NativeSelectOption>
          {(props.types ?? []).map((t) => (
            <NativeSelectOption key={t.name} value={t.name}>
              {t.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {q.error ? (
        <ErrorLine error={q.error} />
      ) : !q.data ? (
        <Loading>Reading groups…</Loading>
      ) : groups.length === 0 ? (
        <Empty>No group yet. A workflow names one with its task/reply step's group.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Group</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Answered by</TableHead>
                <TableHead className="text-right">Tasks</TableHead>
                <TableHead>Review</TableHead>
                <TableHead>Last answer</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((g) => (
                <TableRow key={`${g.type}\0${g.group}`} className="cursor-pointer" onClick={() => props.go({ tab: "groups", group: g.group, type: g.type })}>
                  <TableCell className="max-w-72 font-medium break-words">{g.group}</TableCell>
                  <TableCell>{g.type}</TableCell>
                  <TableCell>{g.workers.length ? g.workers.slice(0, 3).map(who).join(", ") + (g.workers.length > 3 ? ` +${g.workers.length - 3}` : "") : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{g.tasks}</TableCell>
                  <TableCell className={g.rejected ? "text-destructive" : g.unreviewed ? undefined : "text-muted-foreground"}>{verdictsText(g) || "—"}</TableCell>
                  <TableCell className="whitespace-nowrap">{fmtWhen(g.last)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Section>
  );
}

type Show = "all" | "none" | "rejected" | "ok";

function GroupPage(props: Props & { group: string }) {
  const client = useStrutClient();
  const { act, busy, error } = useAct();
  const [show, setShow] = useState<Show>("all");
  const type = props.place.type;
  const q = useQuery({
    queryKey: ["staff", "group", props.group, type ?? ""],
    queryFn: () => client.run<{ tasks: Task[] }>("staff/tasks", { group: props.group, ...(type ? { type } : {}), limit: GROUP_TASKS }),
  });
  const who = useWho(props.workers);
  const back = <Back onClick={() => props.go({ tab: "groups", ...(type ? { type } : {}) })}>Groups</Back>;
  if (q.error) return (<div className="flex flex-col gap-3">{back}<ErrorLine error={q.error} /></div>);
  if (!q.data) return <Loading>Reading the group…</Loading>;
  // Oldest first: the order they were answered in.
  const tasks = [...q.data.tasks].sort((a, b) => a.seq - b.seq);
  const answers = tasks.flatMap((t) => reviewable(t));
  const n = { ok: 0, rejected: 0, unreviewed: 0 };
  for (const l of answers) n[l.review?.verdict ?? "unreviewed"]++;
  const workers = [...new Set(answers.map((l) => l.worker))];
  const shown = tasks.filter((t) => {
    if (show === "all") return true;
    const ls = reviewable(t);
    return show === "none" ? ls.some((l) => !l.review) : ls.some((l) => l.review?.verdict === show);
  });

  return (
    <div className="flex flex-col gap-5">
      {back}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold break-words">{props.group}</h2>
        {type && <Badge variant="outline">{type}</Badge>}
      </div>
      <Note>
        {workers.length ? `Answered by ${workers.map(who).join(", ")}` : "No answer yet"}
        {tasks.length ? ` · ${fmtWhen(tasks[0]!.created)} to ${fmtWhen(Math.max(...tasks.map((t) => t.settledAt ?? t.created)))}` : ""}
      </Note>
      <div className="flex flex-wrap gap-6">
        <Figure label="Tasks" value={tasks.length} />
        <Figure label="Answers" value={answers.length} />
        <Figure label="Ok" value={n.ok} />
        <Figure label="Rejected" value={n.rejected} className={n.rejected ? "text-destructive" : undefined} />
        <Figure label="To review" value={n.unreviewed} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {n.unreviewed > 0 && (
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => void act("group-ok", () => client.run("staff/review-group", { group: props.group, ...(type ? { type } : {}), verdict: "ok" }))}
          >
            Mark the rest ok ({n.unreviewed})
          </Button>
        )}
        <NativeSelect aria-label="Show" value={show} onChange={(e) => setShow(e.target.value as Show)}>
          <NativeSelectOption value="all">Every task</NativeSelectOption>
          <NativeSelectOption value="none">Not reviewed</NativeSelectOption>
          <NativeSelectOption value="rejected">Rejected</NativeSelectOption>
          <NativeSelectOption value="ok">Marked ok</NativeSelectOption>
        </NativeSelect>
        {tasks.length >= GROUP_TASKS && <Note>The first {GROUP_TASKS} tasks read.</Note>}
      </div>
      <Note>
        A verdict is a mark on the answer: the run is not touched. While an answer's pay is held, a rejection takes it back and Mark ok gives it back. A
        rejection's why is what the worker reads in their app.
      </Note>
      <ErrorLine error={error} />
      {shown.length === 0 ? (
        <Empty>No task here.</Empty>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((t) => (
            <GroupTile key={t.id} task={t} who={who} busy={busy !== null} go={props.go} onReview={(worker, verdict, why) => void act("review", () => client.run("staff/review", { task: t.id, ...(worker ? { worker } : {}), verdict, ...(why ? { why } : {}) }))} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** What a tile draws: the reply's first picture (what the run made of the
 *  answer), else the answer's. */
function pictureOf(t: Task): SentFile | undefined {
  return t.reply?.files?.find((f) => isPicture(f.path, f.mediaType)) ?? answerFiles(t).find((f) => isPicture(f.path, f.mediaType));
}

/** The reply's words, short: its `title` and `ask` when they are text. */
function captionOf(t: Task): string {
  const s = t.reply?.show ?? {};
  return [s["title"], s["ask"]].filter((v): v is string => typeof v === "string" && !!v).join(" · ");
}

function GroupTile(props: { task: Task; who: (a: string) => string; busy: boolean; go: (p: Place) => void; onReview: (worker: string | undefined, verdict: "ok" | "rejected", why?: string) => void }) {
  const t = props.task;
  const pic = pictureOf(t);
  const answers = reviewable(t);
  const copies = answers.length > 1;
  const rejected = answers.some((l) => l.review?.verdict === "rejected");
  return (
    <li className={cn("flex min-w-0 flex-col gap-1.5 rounded-md border p-2", rejected && "border-destructive")}>
      {pic ? <Thumb task={t.id} file={pic} version={t.reply?.at ?? 0} /> : <div className="grid h-40 place-items-center rounded bg-muted text-xs text-muted-foreground">no picture</div>}
      <button type="button" className="text-left text-xs font-medium break-words underline-offset-2 hover:underline" onClick={() => props.go({ tab: "tasks", task: t.id })}>
        {captionOf(t) || `Task ${t.id.slice(0, 8)}`}
      </button>
      <span className="text-xs text-muted-foreground">
        {t.by ? props.who(t.by) : "—"} · {fmtWhen(t.settledAt ?? t.created)}
      </span>
      {answers.length === 0 ? (
        <Note>No answer.</Note>
      ) : (
        <ul className="flex flex-col gap-1">
          {answers.map((l) => (
            <ReviewLine key={l.id} lease={l} who={copies ? props.who(l.worker) : undefined} busy={props.busy} onReview={(verdict, why) => props.onReview(copies ? l.worker : undefined, verdict, why)} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** One picture of a task through `staff/file`, read once it scrolls into
 *  view (a book is hundreds of pages), under the task page's own key. */
function Thumb(props: { task: string; file: SentFile; version: number }) {
  const client = useStrutClient();
  const [box, seen] = useSeen<HTMLDivElement>(true);
  const q = useQuery({
    queryKey: ["staff-file", props.task, props.file.path, props.version],
    queryFn: () => client.run<TaskFile>("staff/file", { task: props.task, path: props.file.path }),
    enabled: seen,
    staleTime: Infinity,
    retry: false,
  });
  const f = q.data;
  return (
    <div ref={box} className="grid h-40 place-items-center overflow-hidden rounded bg-muted">
      {q.error ? (
        <ErrorLine error={q.error} />
      ) : f?.base64 && f.mediaType.startsWith("image/") ? (
        <Picture alt={props.file.name} className="max-h-40 max-w-full object-contain" src={`data:${f.mediaType};base64,${f.base64}`} />
      ) : (
        <div className="h-full w-full animate-pulse" />
      )}
    </div>
  );
}
