// Answers, by group: the tasks a workflow put together with `task/reply`'s
// `group` (one order's photos, one batch's labels, one book's pages), read
// and reviewed as one. The list: each group with its newest pictures (read
// as the row comes into view), who answered, how many answers, and how far
// its review is, the one with the newest task first; filtered by what is
// left to review. A group's page: its tasks oldest first, each a tile with
// its picture (the reply's first, else the answer's; an answer with none,
// its fields in a line) and its verdict (OK, Reject with why); Mark the
// others OK gives every answer with no verdict the same one.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronRight } from "lucide-react";
import { useStrutClient } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { answerLine, captionOf, fmtWhen, GROUP_TASKS, pictureOf, reviewable, type Place } from "../lib/view";
import type { Task, TaskGroup } from "../lib/types";
import { Chip, Crumbs, Empty, ErrorLine, Loading, Note, useAct } from "./bits";
import type { AnswersProps } from "./Answers";
import { AnswersHead, TypeSelect } from "./AnswersHead";
import { ReviewControl, Thumb, useSeen, useWho } from "./review";

/** The pictures a group's row shows. */
const STRIP = 3;

/** Which answers show: the ones with no verdict, the rejected, the OK, all. */
type Show = "none" | "rejected" | "ok" | "all";

interface Verdicts {
  ok: number;
  rejected: number;
  unreviewed: number;
}

/** `2 OK, 1 rejected, 3 to review`; "" with no answer. */
function verdictsText(n: Verdicts): string {
  return [n.ok && `${n.ok} OK`, n.rejected && `${n.rejected} rejected`, n.unreviewed && `${n.unreviewed} to review`].filter(Boolean).join(", ");
}

/** How far a review is, as a bar: OK, then rejected, the rest still to do. */
function Progress(props: Verdicts & { className?: string }) {
  const all = props.ok + props.rejected + props.unreviewed;
  if (!all) return null;
  return (
    <div aria-hidden className={cn("flex h-1.5 overflow-hidden rounded-full bg-muted", props.className)}>
      <div className="bg-emerald-500" style={{ width: `${(props.ok / all) * 100}%` }} />
      <div className="bg-destructive" style={{ width: `${(props.rejected / all) * 100}%` }} />
    </div>
  );
}

/** The filters both the list and a group's page have, each with its count. */
function ShowChips(props: { show: Show; set: (s: Show) => void; n: Verdicts }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Chip on={props.show === "none"} onClick={() => props.set("none")} count={props.n.unreviewed}>
        To review
      </Chip>
      <Chip on={props.show === "rejected"} onClick={() => props.set("rejected")} count={props.n.rejected}>
        Rejected
      </Chip>
      <Chip on={props.show === "ok"} onClick={() => props.set("ok")} count={props.n.ok}>
        OK
      </Chip>
      <Chip on={props.show === "all"} onClick={() => props.set("all")} count={props.n.ok + props.n.rejected + props.n.unreviewed}>
        Everything
      </Chip>
    </div>
  );
}

const has = (n: Verdicts, show: Show) => show === "all" || (show === "none" ? n.unreviewed > 0 : show === "rejected" ? n.rejected > 0 : n.ok > 0);

export function GroupList(props: AnswersProps) {
  const client = useStrutClient();
  const [type, setType] = useState(props.place.type ?? "");
  /** What shows; until picked, what is left to review when there is any. */
  const [picked, setPicked] = useState<Show | null>(null);
  const q = useQuery({
    queryKey: ["staff", "groups", type],
    queryFn: () => client.run<{ groups: TaskGroup[] }>("staff/groups", { ...(type ? { type } : {}), limit: 500 }),
  });
  const who = useWho(props.workers);
  const groups = q.data?.groups ?? [];
  const n: Verdicts = { ok: 0, rejected: 0, unreviewed: 0 };
  for (const g of groups) {
    n.ok += g.ok;
    n.rejected += g.rejected;
    n.unreviewed += g.unreviewed;
  }
  const show: Show = picked ?? (props.shown.review && n.unreviewed > 0 ? "none" : "all");
  const shown = groups.filter((g) => has(g, show));

  return (
    <section className="flex flex-col gap-3">
      <AnswersHead view="groups" hasGroups go={props.go} type={type}>
        <TypeSelect types={props.types} value={type} onChange={setType} />
      </AnswersHead>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {props.shown.review && <ShowChips show={show} set={setPicked} n={n} />}
        <Note className="ml-auto">A group is a set of answers a workflow put together, to review as one. Newest first.</Note>
      </div>
      {q.error ? (
        <ErrorLine error={q.error} />
      ) : !q.data ? (
        <Loading>Reading the groups…</Loading>
      ) : groups.length === 0 ? (
        <Empty>No group yet. A workflow names one with its task/reply step's group.</Empty>
      ) : shown.length === 0 ? (
        <Empty>{show === "none" ? "Nothing left to review: every answer in a group has its verdict." : "No group here."}</Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((g) => (
            <li key={`${g.type}\0${g.group}`}>
              <button
                type="button"
                onClick={() => props.go({ tab: "groups", group: g.group, type: g.type })}
                className="flex w-full flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/40"
              >
                <Strip group={g} />
                <span className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
                  <span className="font-semibold break-words">{g.group}</span>
                  <span className="text-sm text-muted-foreground">
                    {g.answers} answer{g.answers === 1 ? "" : "s"}
                    {g.workers.length ? ` · ${g.workers.slice(0, 3).map(who).join(", ")}${g.workers.length > 3 ? ` +${g.workers.length - 3}` : ""}` : ""} · {fmtWhen(g.last)}
                    {!type && (props.types?.length ?? 0) > 1 ? ` · ${g.type}` : ""}
                  </span>
                </span>
                {props.shown.review && (
                  <span className="flex w-56 max-w-full flex-col gap-1.5">
                    <Progress {...g} />
                    <span className="text-xs text-muted-foreground">{verdictsText(g) || "No answer"}</span>
                  </span>
                )}
                <span className={buttonVariants({ variant: "outline", size: "sm" })}>
                  {props.shown.review && g.unreviewed > 0 ? "Review" : "Open"} <ChevronRight />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A group's newest pictures, read once its row comes into view: one read of
 *  its newest tasks, then each picture. A group whose answers carry no
 *  picture shows none. */
function Strip({ group: g }: { group: TaskGroup }) {
  const client = useStrutClient();
  const [box, seen] = useSeen<HTMLSpanElement>(true);
  const q = useQuery({
    queryKey: ["staff", "group-strip", g.type, g.group],
    queryFn: () => client.run<{ tasks: Task[] }>("staff/tasks", { group: g.group, type: g.type, limit: STRIP }),
    enabled: seen,
    staleTime: 60_000,
  });
  // Oldest of them first, as the group's page lists them.
  const tasks = [...(q.data?.tasks ?? [])].sort((a, b) => a.seq - b.seq).filter((t) => pictureOf(t));
  const more = g.tasks - tasks.length;
  return (
    <span ref={box} aria-hidden className={cn("flex shrink-0 items-center gap-1.5", (!q.data || tasks.length > 0) && "w-[13.5rem]")}>
      {!q.data && !q.error && <span className="size-12 animate-pulse rounded-md bg-muted" />}
      {tasks.map((t) => (
        <Thumb key={t.id} task={t.id} file={pictureOf(t)} version={t.reply?.at} className="size-12" />
      ))}
      {tasks.length > 0 && more > 0 && <span className="grid size-12 place-items-center rounded-md border text-xs font-medium text-muted-foreground">+{more}</span>}
    </span>
  );
}

export function GroupPage(props: AnswersProps & { group: string }) {
  const client = useStrutClient();
  const { act, busy, error } = useAct();
  const [show, setShow] = useState<Show>("all");
  const type = props.place.type;
  const q = useQuery({
    queryKey: ["staff", "group", props.group, type ?? ""],
    queryFn: () => client.run<{ tasks: Task[] }>("staff/tasks", { group: props.group, ...(type ? { type } : {}), limit: GROUP_TASKS }),
  });
  const who = useWho(props.workers);
  const list: Place = { tab: "groups", ...(type ? { type } : {}) };
  const crumbs = <Crumbs go={props.go} to={[["Answers", list]]} here={props.group} />;
  if (q.error) {
    return (
      <div className="flex flex-col gap-3">
        {crumbs}
        <ErrorLine error={q.error} />
      </div>
    );
  }
  if (!q.data) return <Loading>Reading the group…</Loading>;
  // Oldest first: the order they were answered in.
  const tasks = [...q.data.tasks].sort((a, b) => a.seq - b.seq);
  const answers = tasks.flatMap((t) => reviewable(t));
  const n: Verdicts = { ok: 0, rejected: 0, unreviewed: 0 };
  for (const l of answers) n[l.review?.verdict ?? "unreviewed"]++;
  const workers = [...new Set(answers.map((l) => l.worker))];
  const shown = tasks.filter((t) => {
    if (show === "all") return true;
    const ls = reviewable(t);
    return show === "none" ? ls.some((l) => !l.review) : ls.some((l) => l.review?.verdict === show);
  });

  return (
    <div className="flex flex-col gap-4">
      {crumbs}
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-80 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold break-words">{props.group}</h2>
            {type && <Badge variant="outline">{type}</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">
            {answers.length} answer{answers.length === 1 ? "" : "s"}
            {workers.length ? ` by ${workers.map(who).join(", ")}` : ""}
            {tasks.length ? ` · ${fmtWhen(tasks[0]!.created)} to ${fmtWhen(Math.max(...tasks.map((t) => t.settledAt ?? t.created)))}` : ""}
          </p>
        </div>
        {props.shown.review && n.unreviewed > 0 && (
          <Button disabled={busy !== null} onClick={() => void act("group-ok", () => client.run("staff/review-group", { group: props.group, ...(type ? { type } : {}), verdict: "ok" }))}>
            <Check strokeWidth={2.5} /> {n.ok + n.rejected > 0 ? `Mark the other ${n.unreviewed} OK` : `Mark all ${n.unreviewed} OK`}
          </Button>
        )}
      </div>
      {props.shown.review && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <ShowChips show={show} set={setShow} n={n} />
          <div className="flex min-w-40 flex-1 items-center gap-3">
            <Progress {...n} className="flex-1" />
            <span className="text-xs whitespace-nowrap text-muted-foreground">
              {n.ok + n.rejected} of {answers.length} reviewed
            </span>
          </div>
        </div>
      )}
      {tasks.length >= GROUP_TASKS && <Note>The first {GROUP_TASKS} tasks read.</Note>}
      <ErrorLine error={error} />
      {shown.length === 0 ? (
        <Empty>{show === "none" ? "Nothing left to review in this group." : "Nothing here."}</Empty>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
          {shown.map((t) => (
            <Tile
              key={t.id}
              task={t}
              who={who}
              review={props.shown.review}
              busy={busy !== null}
              go={props.go}
              onReview={(worker, verdict, why) => void act("review", () => client.run("staff/review", { task: t.id, ...(worker ? { worker } : {}), verdict, ...(why ? { why } : {}) }))}
            />
          ))}
        </ul>
      )}
      {props.shown.review && (
        <Note>
          A verdict is a mark on the answer: the run it came from is not touched. While an answer's pay is held, a rejection takes it back and OK gives it back. A rejection's reason is what the worker
          reads in their app.
        </Note>
      )}
    </div>
  );
}

function Tile(props: { task: Task; who: (a: string) => string; review: boolean; busy: boolean; go: (p: Place) => void; onReview: (worker: string | undefined, verdict: "ok" | "rejected", why?: string) => void }) {
  const t = props.task;
  const pic = pictureOf(t);
  const answers = reviewable(t);
  const copies = answers.length > 1;
  const rejected = answers.some((l) => l.review?.verdict === "rejected");
  const caption = captionOf(t);
  const line = answerLine(t.answer, 4);
  return (
    <li className={cn("flex min-w-0 flex-col overflow-hidden rounded-lg border", rejected && "border-destructive/60")}>
      <button type="button" className="flex min-w-0 flex-col text-left" title="Open this answer" onClick={() => props.go({ tab: "tasks", task: t.id })}>
        {pic ? (
          <Thumb task={t.id} file={pic} version={t.reply?.at} className="h-56 w-full rounded-none" fit />
        ) : (
          <span className="grid min-h-24 w-full place-items-center bg-muted/50 p-3 text-center text-sm break-words text-muted-foreground">{line || "No picture"}</span>
        )}
        <span className="flex items-baseline justify-between gap-2 px-3 pt-2.5">
          <span className="min-w-0 text-sm font-semibold break-words">{caption || (pic && line) || `Task ${t.id.slice(0, 8)}`}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{fmtWhen(t.settledAt ?? t.created)}</span>
        </span>
        {!copies && t.by && <span className="px-3 text-xs text-muted-foreground">{props.who(t.by)}</span>}
      </button>
      <div className="mt-auto flex flex-col gap-2 px-3 pt-2 pb-3">
        {answers.length === 0 ? (
          <Note>No answer.</Note>
        ) : !props.review ? null : (
          answers.map((l) => (
            <div key={l.id} className="flex flex-col gap-1">
              {copies && <span className="text-xs font-medium">{props.who(l.worker)}</span>}
              <ReviewControl lease={l} busy={props.busy} onReview={(verdict, why) => props.onReview(copies ? l.worker : undefined, verdict, why)} />
            </div>
          ))
        )}
      </div>
    </li>
  );
}
