// Answers, one by one (plans/human-steps.md §9.5): every task, newest first,
// a page at a time — its picture when the answer carried one, what it is
// called, who answered and how long that took, the pay, and the verdict
// (§9.6) given right in the row. Filtered by review, type and who answered;
// status, workflow, run and tests under More filters.
//
// One answer's page reads in the order a person asks: what was asked, what
// the worker sent (its pictures large, the fields with a value as a short
// list), what the run told them back (`task/reply`; its other fields
// folded). Beside it: the verdict, a mark on the answer and never an undo of
// the run; who, how long, the pay and the run; and what happened, in order,
// with each answer's earning and a take-back inside its hold (5a). With item
// 4, a disputed task's copies and their answers, a test instance's grade,
// and "make a test of it". In a group, previous and next; O, R and the
// arrow keys review without the mouse.
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { useHost, useStrutClient } from "@strut/kit";
import { shownFields, taskAsk } from "strut/views";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  answerFields, answerFiles, answerLease, answerLine, captionOf, earningText, emptyFields, fmtClock, fmtSats, fmtWhen, GROUP_TASKS, happenings, jsonText, labelOf, parseJson, pictureOf, reviewable,
  reviewSummary, runOf, shortActor, shownLine, STATUS_WORDS, tookText, toReviewOf, whoOf,
  type Place, type ReviewFilter,
} from "../lib/view";
import type { Lease, Task, TaskRun, TaskStatus, Test, Verdict } from "../lib/types";
import { Chip, Crumbs, Empty, ErrorLine, JsonTree, Label, Loading, Note, ReasonButton, Section, useAct } from "./bits";
import type { AnswersProps } from "./Answers";
import { AnswersHead, TypeSelect } from "./AnswersHead";
import { ReviewControl, reviewOpen, TaskFileView, Thumb, useWho, VerdictBadge } from "./review";

const PAGE = 50;

interface Filters {
  type: string;
  status: "" | TaskStatus;
  workflow: string;
  runId: string;
  by: string;
  test: "" | "true" | "false";
  /** §9.6: the review queue. */
  review: "" | ReviewFilter;
}

function filtersOf(p: Place): Filters {
  const run = p.run ? runOf(p.run) : null;
  return { type: p.type ?? "", status: "", workflow: run?.workflow ?? "", runId: run?.runId ?? "", by: p.by ?? "", test: "", review: p.review ?? "" };
}

export function TaskList(props: AnswersProps) {
  const client = useStrutClient();
  const { act, busy, error } = useAct();
  const [f, setF] = useState<Filters>(() => filtersOf(props.place));
  useEffect(() => setF(filtersOf(props.place)), [props.place.type, props.place.run, props.place.by, props.place.review]);
  /** Status, tests, workflow and run: folded until one is in force. */
  const [more, setMore] = useState(false);
  /** The pages read before this one (their `before`), for going back. */
  const [pages, setPages] = useState<Array<number | undefined>>([undefined]);
  const before = pages[pages.length - 1];
  useEffect(() => setPages([undefined]), [JSON.stringify(f)]);
  const q = useQuery({
    queryKey: ["staff", "tasks", f, before],
    queryFn: () =>
      client.run<{ tasks: Task[] }>("staff/tasks", {
        ...(f.type ? { type: f.type } : {}),
        ...(f.status ? { status: f.status } : {}),
        ...(f.workflow ? { workflow: f.workflow } : {}),
        ...(f.runId ? { runId: f.runId } : {}),
        ...(f.by ? { by: f.by } : {}),
        ...(f.test ? { test: f.test === "true" } : {}),
        ...(f.review ? { review: f.review } : {}),
        ...(before !== undefined ? { before } : {}),
        limit: PAGE,
      }),
  });
  const who = useWho(props.workers);
  const set = (patch: Partial<Filters>) => setF((x) => ({ ...x, ...patch }));
  const tasks = q.data?.tasks ?? [];
  const statuses: TaskStatus[] = ["open", "settled", "expired", "cancelled", ...(props.shown.copies ? (["disputed"] as const) : [])];
  const folded = [f.status, f.test, f.workflow, f.runId].filter(Boolean).length;
  // How many are left to review, where the queue counts them: of the type, with nothing else in force.
  const left = !f.by && !folded ? toReviewOf(props.stats, f.type || undefined) : undefined;
  const review = (task: string, verdict: Verdict, why?: string) => void act("review", () => client.run("staff/review", { task, verdict, ...(why ? { why } : {}) }));

  return (
    <section className="flex flex-col gap-3">
      <AnswersHead view="tasks" hasGroups={props.hasGroups} go={props.go} type={f.type}>
        <TypeSelect types={props.types} value={f.type} onChange={(type) => set({ type })} />
        <NativeSelect aria-label="Answered by" value={f.by} onChange={(e) => set({ by: e.target.value })}>
          <NativeSelectOption value="">Any worker</NativeSelectOption>
          {f.by && !(props.workers ?? []).some((w) => w.actor === f.by) && <NativeSelectOption value={f.by}>{shortActor(f.by)}</NativeSelectOption>}
          {(props.workers ?? []).map((w) => (
            <NativeSelectOption key={w.actor} value={w.actor}>
              {whoOf(w)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button size="sm" variant="ghost" aria-expanded={more || folded > 0} onClick={() => setMore((m) => !m)}>
          More filters{folded ? ` (${folded})` : ""}
        </Button>
      </AnswersHead>

      {(more || folded > 0) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2">
          <NativeSelect aria-label="Status" value={f.status} onChange={(e) => set({ status: e.target.value as Filters["status"] })}>
            <NativeSelectOption value="">Any status</NativeSelectOption>
            {statuses.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {STATUS_WORDS[s]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {props.shown.tests && (
            <NativeSelect aria-label="Tests" value={f.test} onChange={(e) => set({ test: e.target.value as Filters["test"] })}>
              <NativeSelectOption value="">Tasks and tests</NativeSelectOption>
              <NativeSelectOption value="false">Real tasks</NativeSelectOption>
              <NativeSelectOption value="true">Tests served</NativeSelectOption>
            </NativeSelect>
          )}
          <Input aria-label="Workflow" className="h-9 w-44" placeholder="workflow" value={f.workflow} onChange={(e) => set({ workflow: e.target.value.trim() })} />
          <Input aria-label="Run" className="h-9 w-44" placeholder="run id" value={f.runId} onChange={(e) => set({ runId: e.target.value.trim() })} />
          {folded > 0 && (
            <Button size="sm" variant="ghost" onClick={() => set({ status: "", test: "", workflow: "", runId: "" })}>
              Clear
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {props.shown.review && (
          <>
            <Chip on={f.review === "none"} onClick={() => set({ review: "none" })} count={left}>
              To review
            </Chip>
            <Chip on={f.review === "rejected"} onClick={() => set({ review: "rejected" })}>
              Rejected
            </Chip>
            <Chip on={f.review === "ok"} onClick={() => set({ review: "ok" })}>
              OK
            </Chip>
            <Chip on={f.review === ""} onClick={() => set({ review: "" })}>
              Everything
            </Chip>
          </>
        )}
        <Note className="ml-auto">Newest first</Note>
      </div>

      <ErrorLine error={error} />
      {q.error ? (
        <ErrorLine error={q.error} />
      ) : !q.data ? (
        <Loading>Reading the answers…</Loading>
      ) : tasks.length === 0 ? (
        <Empty>{f.review === "none" && pages.length < 2 ? "Nothing left to review here." : `Nothing here${pages.length > 1 ? " past this point" : ""}.`}</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" />
                <TableHead>Answer</TableHead>
                <TableHead>Worker</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead className="text-right" title="From taking the task to sending the answer">Took</TableHead>
                {props.shown.earnings && <TableHead className="text-right">Pay</TableHead>}
                <TableHead className="w-52">{props.shown.review ? "Review" : "Status"}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t) => {
                const answers = reviewable(t);
                const lease = answerLease(t);
                const pic = pictureOf(t);
                const answered = t.status === "settled";
                const copies = (t.copies ?? 1) > 1;
                return (
                  <TableRow key={t.id} className={cn("cursor-pointer", !answered && "text-muted-foreground")} onClick={() => props.go({ tab: "tasks", task: t.id })}>
                    <TableCell className="pr-0">
                      <Thumb task={t.id} file={pic} version={t.reply?.at} className="size-10" dashed={!answered} words />
                    </TableCell>
                    <TableCell className="max-w-80">
                      <div className="truncate font-medium">
                        {captionOf(t) || t.type} {t.test && <Badge variant="outline">test</Badge>}
                      </div>
                      {/* Its group; what it showed; an answer with no picture, its fields; its type where no group says. */}
                      <div className="truncate text-xs text-muted-foreground">{[t.group, shownLine(t.show), pic ? "" : answerLine(t.answer), t.group ? "" : t.type].filter(Boolean).join(" · ")}</div>
                    </TableCell>
                    <TableCell>{t.by ? who(t.by) : copies ? `${answers.length} of ${t.copies}` : "—"}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{fmtWhen(t.settledAt ?? t.created)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums">{tookText(lease) || "—"}</TableCell>
                    {props.shown.earnings && <TableCell className="text-right whitespace-nowrap tabular-nums">{payText(lease) || "—"}</TableCell>}
                    <TableCell>
                      {!props.shown.review || answers.length === 0 ? (
                        <StatusWords task={t} />
                      ) : answers.length === 1 ? (
                        <ReviewControl lease={answers[0]!} busy={busy !== null} onReview={(verdict, why) => review(t.id, verdict, why)} />
                      ) : (
                        <span className={cn("text-sm", answers.some((l) => l.review?.verdict === "rejected") && "text-destructive")}>{reviewSummary(t)}</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={pages.length < 2} onClick={() => setPages((p) => p.slice(0, -1))}>
          <ChevronLeft /> Newer
        </Button>
        <Button size="sm" variant="outline" disabled={tasks.length < PAGE} onClick={() => setPages((p) => [...p, tasks[tasks.length - 1]!.seq])}>
          Older <ChevronRight />
        </Button>
      </div>
    </section>
  );
}

/** What an answer earns or earned, short: `4 sats`, `4 sats, taken back`. */
function payText(l: Lease | undefined): string {
  if (l?.earning) return `${fmtSats(l.earning.msat)}${l.earning.takenBack !== undefined ? ", taken back" : ""}`;
  return l?.payMsat ? fmtSats(l.payMsat) : "";
}

/** A task with nothing to review, in words: a test's grade, or how it stands. */
function StatusWords({ task: t }: { task: Task }) {
  if (t.test) return <span className="text-sm">{t.grade ? `test: ${t.grade}` : t.status === "settled" ? "test: not graded yet" : `test: ${STATUS_WORDS[t.status]}`}</span>;
  if (t.status === "disputed") return <span className="text-sm text-destructive">the copies did not agree</span>;
  if (t.status === "open") return <span className="text-sm">{t.leases.some((l) => l.status === "open" && l.expires > Date.now()) ? "being worked on" : "waiting for a worker"}</span>;
  return <span className="text-sm">{t.status === "expired" ? "nobody answered in time" : STATUS_WORDS[t.status]}</span>;
}

function StatusBadge({ status }: { status: TaskStatus }) {
  return <Badge variant={status === "disputed" ? "destructive" : status === "settled" ? "secondary" : "outline"}>{STATUS_WORDS[status]}</Badge>;
}

/** A card of the answer's page: a small heading, and what it holds. */
function Card(props: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-3 rounded-lg border p-4", props.className)}>
      <div className="flex flex-wrap items-baseline gap-2">
        <Label>{props.title}</Label>
        {props.aside && <span className="ml-auto text-xs text-muted-foreground">{props.aside}</span>}
      </div>
      {props.children}
    </section>
  );
}

/** Fields as a short list, label and value. */
function Fields(props: { fields: Array<[string, string]>; small?: boolean }) {
  return (
    <dl className={cn("m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5", props.small ? "gap-y-1 text-xs" : "gap-y-2 text-sm")}>
      {props.fields.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{labelOf(k)}</dt>
          <dd className="m-0 font-medium break-words whitespace-pre-line">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What a task or a reply shows a worker: its words, then its plain fields
 *  (`fold`: behind a line, the run's own bookkeeping), and a tree when it is
 *  neither. */
function ShownView(props: { show: unknown; fold?: boolean }) {
  const heading = taskAsk(props.show);
  const fields = shownFields(props.show);
  if (!heading && !fields.length) {
    return props.show === undefined || props.show === null ? null : (
      <div className="rounded-md border p-2">
        <JsonTree value={props.show} />
      </div>
    );
  }
  return (
    <>
      {heading && <p className="m-0 text-[15px] leading-snug font-medium break-words">{heading}</p>}
      {fields.length > 0 &&
        (props.fold ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground select-none">
              {fields.length} more field{fields.length === 1 ? "" : "s"} the run sent
            </summary>
            <div className="mt-2">
              <Fields fields={fields} small />
            </div>
          </details>
        ) : (
          <Fields fields={fields} />
        ))}
    </>
  );
}

/** One answer: its files first, pictures large, beside its fields with a
 *  value; the ones left empty in a line. */
function AnswerView(props: { task: string; answer: unknown; files: Array<{ path: string; mediaType: string }> }) {
  const fields = answerFields(props.answer);
  const empty = emptyFields(props.answer);
  const plain = props.answer !== null && typeof props.answer === "object" && !Array.isArray(props.answer);
  // A nested value (a list of boxes, a group): the tree says it whole.
  const nested = plain && Object.values(props.answer as Record<string, unknown>).some((v) => v !== null && typeof v === "object");
  return (
    <div className="flex flex-wrap items-start gap-5">
      {props.files.length > 0 && (
        <div className="flex min-w-0 flex-[1_1_18rem] flex-col gap-3 sm:max-w-md">
          {props.files.map((a) => (
            <TaskFileView key={a.path} task={props.task} path={a.path} mediaType={a.mediaType} large />
          ))}
        </div>
      )}
      <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-3">
        {!plain ? (
          <div className="rounded-md border p-2">
            <JsonTree value={props.answer} />
          </div>
        ) : fields.length > 0 ? (
          <Fields fields={fields} />
        ) : !nested ? (
          <Note>{props.files.length ? "No fields: only the files sent with it." : "No fields."}</Note>
        ) : null}
        {nested && (
          <div className="rounded-md border p-2">
            <JsonTree value={props.answer} />
          </div>
        )}
        {empty.length > 0 && <Note>Left empty: {empty.map(labelOf).join(", ")}</Note>}
      </div>
    </div>
  );
}

export function TaskDetail(props: AnswersProps & { id: string }) {
  const client = useStrutClient();
  const host = useHost();
  const { act, busy, error } = useAct();
  const q = useQuery({ queryKey: ["staff", "task", props.id], queryFn: () => client.run<{ task: Task; run: TaskRun | null }>("staff/task", { id: props.id }) });
  const who = useWho(props.workers);
  const t = q.data?.task;
  // Its group's tasks, in the order they were made: previous and next.
  const group = useQuery({
    queryKey: ["staff", "group", t?.group ?? "", t?.type ?? ""],
    queryFn: () => client.run<{ tasks: Task[] }>("staff/tasks", { group: t!.group, type: t!.type, limit: GROUP_TASKS }),
    enabled: !!t?.group,
  });
  const siblings = [...(group.data?.tasks ?? [])].sort((a, b) => a.seq - b.seq);
  const at = siblings.findIndex((s) => s.id === props.id);
  const prev = at > 0 ? siblings[at - 1] : undefined;
  const next = at >= 0 ? siblings[at + 1] : undefined;
  const answers = t ? reviewable(t) : [];
  /** The one answer a key can mark: a task with several says whose by hand. */
  const one = props.shown.review && answers.length === 1 ? answers[0]! : undefined;
  const [rejecting, setRejecting] = useState(false);
  useEffect(() => setRejecting(false), [props.id]);
  const review = (worker: string | undefined, verdict: Verdict, why?: string) =>
    act("review", () => client.run("staff/review", { task: props.id, ...(worker ? { worker } : {}), verdict, ...(why ? { why } : {}) }));

  // O marks it OK and moves on, R opens the reason line, the arrows move
  // through the group. Never while typing, and never with a modifier held.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || (el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName)))) return;
      if (e.key === "ArrowLeft" && prev) props.go({ tab: "tasks", task: prev.id });
      else if (e.key === "ArrowRight" && next) props.go({ tab: "tasks", task: next.id });
      else if (one && reviewOpen(one) && busy === null && e.key.toLowerCase() === "o" && one.review?.verdict !== "ok") {
        void review(undefined, "ok").then((done) => done && next && props.go({ tab: "tasks", task: next.id }));
      } else if (one && reviewOpen(one) && e.key.toLowerCase() === "r") {
        e.preventDefault();
        setRejecting(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const list: Place = t?.group ? { tab: "groups", type: t.type } : { tab: "tasks" };
  if (q.error) {
    return (
      <div className="flex flex-col gap-3">
        <Crumbs go={props.go} to={[["Answers", list]]} here="This task" />
        <ErrorLine error={q.error} />
      </div>
    );
  }
  if (!t || !q.data) return <Loading>Reading the answer…</Loading>;
  const { run } = q.data;
  const type = (props.types ?? []).find((k) => k.name === t.type);
  const copies = (t.copies ?? 1) > 1;
  const now = Date.now();
  const lease = answerLease(t);
  const title = captionOf(t) || t.type;
  const files = answerFiles(t);
  const whom = copies ? "the workers" : t.by ? who(t.by) : "the worker";
  const paid = answers.filter((l) => l.earning && l.earning.takenBack === undefined);
  const held = paid.filter((l) => l.earning!.releases > now);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-72">
          <Crumbs go={props.go} to={[["Answers", list], ...(t.group ? ([[t.group, { tab: "groups", group: t.group, type: t.type }]] as Array<[string, Place]>) : [])]} here={title} />
        </div>
        {siblings.length > 1 && at >= 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground tabular-nums">
              {at + 1} of {siblings.length} in this group
            </span>
            <Button size="icon-sm" variant="outline" aria-label="Previous answer" title="Previous (left arrow)" disabled={!prev} onClick={() => prev && props.go({ tab: "tasks", task: prev.id })}>
              <ChevronLeft />
            </Button>
            <Button size="icon-sm" variant="outline" aria-label="Next answer" title="Next (right arrow)" disabled={!next} onClick={() => next && props.go({ tab: "tasks", task: next.id })}>
              <ChevronRight />
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold break-words">{title}</h2>
          {one ? (
            one.review ? (
              <VerdictBadge verdict={one.review.verdict} />
            ) : (
              <Badge variant="secondary">
                <span aria-hidden className="size-1.5 rounded-full bg-[color:var(--peel-attention)]" /> To review
              </Badge>
            )
          ) : (
            <StatusBadge status={t.status} />
          )}
          {t.test && <Badge variant="outline">test instance</Badge>}
          {copies && <Badge variant="outline">{t.copies} copies</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          {t.type} ·{" "}
          {t.status === "settled" && t.by
            ? `answered by ${who(t.by)}, ${fmtWhen(t.settledAt ?? t.created)}`
            : t.status === "open"
              ? `made ${fmtWhen(t.created)}, expires unanswered ${fmtWhen(t.due)}`
              : `made ${fmtWhen(t.created)}${t.settledAt ? `, ${STATUS_WORDS[t.status]} ${fmtWhen(t.settledAt)}` : ""}`}
        </p>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[999_1_32rem] flex-col gap-4">
          <Card title="What was asked">
            <ShownView show={t.show} />
            {t.files.length > 0 && (
              <div className="flex flex-col gap-3">
                {t.files.map((path) => (
                  <TaskFileView key={path} task={t.id} path={path} />
                ))}
              </div>
            )}
          </Card>

          <Card title={copies ? "What they sent" : `What ${whom} sent`} aside={lease ? `${fmtWhen(lease.closed ?? lease.taken)}${tookText(lease) ? ` · took ${tookText(lease)}` : ""}` : undefined}>
            {t.status === "settled" && t.answer !== undefined ? (
              <>
                {copies && <Note>The answer they agreed on, first given by {t.by ? who(t.by) : "—"}.</Note>}
                <AnswerView task={t.id} answer={t.answer} files={files} />
              </>
            ) : t.status === "disputed" ? (
              <Note>The copies did not agree: the step failed task_disputed, and its onError ran. Each copy's answer is below.</Note>
            ) : (
              <Note>
                No answer{t.status === "open" ? " yet" : `: ${t.status === "expired" ? "nobody answered in time" : STATUS_WORDS[t.status]}`}.
              </Note>
            )}
            {copies && answers.length > 0 && (
              <ul className="flex flex-col gap-3 border-t pt-3">
                {answers.map((l) => (
                  <li key={l.id} className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{who(l.worker)}</span>
                      {l.agrees !== undefined && <Badge variant={l.agrees ? "secondary" : "outline"}>{l.agrees ? "agreed" : "disagreed"}</Badge>}
                      <span className="text-xs text-muted-foreground">
                        {fmtWhen(l.closed ?? l.taken)}
                        {tookText(l) ? ` · took ${tookText(l)}` : ""}
                      </span>
                    </div>
                    <AnswerView task={t.id} answer={l.answer} files={l.attachments ?? []} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {t.reply && (
            <Card title={`What ${whom} ${copies ? "were" : "was"} told back`} aside={`${fmtWhen(t.reply.at)} · by the run`}>
              <ShownView show={t.reply.show} fold />
              {(t.reply.files ?? []).length > 0 && (
                <div className="flex flex-wrap gap-3">
                  {t.reply.files!.map((f) => (
                    <TaskFileView key={f.path} task={t.id} path={f.path} mediaType={f.mediaType} version={t.reply!.at} />
                  ))}
                </div>
              )}
            </Card>
          )}
        </div>

        <aside className="flex min-w-0 flex-[1_1_18rem] flex-col gap-4 lg:max-w-sm">
          {props.shown.review && answers.length > 0 && (
            <section className="flex flex-col gap-3 rounded-lg border border-foreground/25 bg-muted/30 p-4">
              <h3 className="text-[15px] font-semibold">{answers.length > 1 ? "Are these answers good?" : "Is this answer good?"}</h3>
              <ul className="flex flex-col gap-3">
                {answers.map((l) => (
                  <li key={l.id} className="flex flex-col gap-1.5">
                    {copies && <span className="text-sm font-medium">{who(l.worker)}</span>}
                    {!l.review && !copies && <span className="text-sm text-muted-foreground">Not reviewed yet</span>}
                    <ReviewControl
                      big
                      lease={l}
                      busy={busy !== null}
                      onReview={(verdict, why) => void review(copies ? l.worker : undefined, verdict, why)}
                      {...(one ? { rejecting, onRejecting: setRejecting } : {})}
                    />
                  </li>
                ))}
              </ul>
              <ErrorLine error={error} />
              <Note>
                A rejection's reason is what the worker reads in their app. The run this came from is not touched.
                {type?.tests ? " A rejection counts against their standing in this type as a failed test does, and Mark OK takes it out." : ""}
                {props.shown.earnings && held.length ? ` While the pay is held (until ${fmtWhen(Math.min(...held.map((l) => l.earning!.releases)))}), a rejection takes it back and Mark OK gives it back.` : ""}
                {props.shown.earnings && paid.length && !held.length ? " The pay is past its hold, so a verdict is a mark only." : ""}
                {props.shown.earnings && type?.payOn === "ok" && answers.some((l) => l.payMsat && !l.earning)
                  ? " This type pays only once an answer is marked OK: Mark OK pays it now, and a rejected one is never paid."
                  : ""}
              </Note>
              {one && reviewOpen(one) && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Key>O</Key> OK
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Key>R</Key> reject
                  </span>
                  {siblings.length > 1 && (
                    <span className="flex items-center gap-1.5">
                      <Key>←</Key>
                      <Key>→</Key> previous, next
                    </span>
                  )}
                </div>
              )}
            </section>
          )}
          {!(props.shown.review && answers.length > 0) && <ErrorLine error={error} />}

          <Card title="Details">
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              {answers.length > 0 && (
                <Row label={answers.length > 1 ? "Workers" : "Worker"}>
                  <span className="flex flex-wrap gap-x-2">
                    {answers.map((l) => (
                      <button key={l.id} type="button" className="font-medium underline underline-offset-2" onClick={() => props.go({ tab: "workers", worker: l.worker })}>
                        {who(l.worker)}
                      </button>
                    ))}
                  </span>
                </Row>
              )}
              {tookText(lease) && <Row label="Took">{tookText(lease)}</Row>}
              {props.shown.earnings && lease && (lease.earning || lease.payMsat) && (
                <Row label="Pay">{lease.earning ? earningText(lease.earning, now) : `${fmtSats(lease.payMsat!)}, being booked`}</Row>
              )}
              <Row label="Task type">
                <button type="button" className="underline underline-offset-2" onClick={() => props.go({ tab: "types", type: t.type })}>
                  {t.type}
                </button>
              </Row>
              {t.group && (
                <Row label="Group">
                  <button type="button" className="text-left underline underline-offset-2" onClick={() => props.go({ tab: "groups", group: t.group!, type: t.type })}>
                    {t.group}
                  </button>
                </Row>
              )}
              {t.test ? (
                <Row label="Test">
                  Served to {who(t.servedTo ?? "")}. {t.grade ? `Graded ${t.grade} ${fmtWhen(t.gradedAt!)}.` : t.status === "settled" ? "Not graded yet." : ""}{" "}
                  <button type="button" className="underline underline-offset-2" onClick={() => props.go({ tab: "tests", test: t.test! })}>
                    Open the test
                  </button>
                </Row>
              ) : (
                <Row label="Run">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>{t.workflow}</span>
                    <Badge variant="outline">{run ? run.status : "not on file"}</Badge>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 underline underline-offset-2"
                      onClick={() => void host.openLink(`?wf=${encodeURIComponent(t.workflow)}&run=${encodeURIComponent(t.runId)}`).catch(() => {})}
                    >
                      Open the run <ExternalLink className="size-3" />
                    </button>
                  </span>
                  {run?.waitingOn?.length ? <span className="block text-xs text-muted-foreground">Waiting on {run.waitingOn.join(", ")}</span> : null}
                </Row>
              )}
            </dl>
          </Card>

          <Card title="What happened">
            <ol className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
              {happenings(t, who, now).map((h, i) => (
                <li key={i} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
                  <span className="whitespace-nowrap text-muted-foreground tabular-nums" title={new Date(h.at).toLocaleString()}>
                    {new Date(h.at).toDateString() === new Date(now).toDateString() ? fmtClock(h.at) : fmtWhen(h.at, now)}
                  </span>
                  <span className="min-w-0 break-words">
                    {h.text}
                    {props.shown.earnings && h.lease?.earning && (
                      <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {earningText(h.lease.earning, now)}
                        {h.lease.earning.takenBack === undefined && h.lease.earning.releases > now && (
                          <ReasonButton
                            label="Take back"
                            placeholder="Why (the worker's balance says so)"
                            required
                            disabled={busy !== null}
                            onAct={(why) => void act("take-back", () => client.run("staff/take-back", { task: t.id, worker: h.lease!.worker, why }))}
                          />
                        )}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
            {t.leases.length === 0 && <Note>Nobody has taken it.</Note>}
          </Card>

          {props.shown.tests && !t.test && (t.status === "settled" || t.status === "disputed") && <MakeTest task={t} go={props.go} />}

          <details className="rounded-lg border p-4 text-sm">
            <summary className="cursor-pointer text-muted-foreground select-none">Technical details</summary>
            <div className="mt-3 flex flex-col gap-3">
              <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
                <Row label="Task">
                  <span className="font-mono break-all">{t.id}</span>
                </Row>
                {!t.test && (
                  <>
                    <Row label="Run id">
                      <span className="font-mono break-all">{t.runId}</span>
                    </Row>
                    <Row label="Step">
                      <span className="font-mono break-all">{t.path}</span>
                    </Row>
                  </>
                )}
              </dl>
              <div>
                <Note>What the worker was shown, as the step made it</Note>
                <div className="mt-1 rounded-md border p-2">
                  <JsonTree value={t.show} />
                </div>
              </div>
              {t.answer !== undefined && (
                <div>
                  <Note>The answer, as it was sent</Note>
                  <div className="mt-1 rounded-md border p-2">
                    <JsonTree value={t.answer} />
                  </div>
                </div>
              )}
            </div>
          </details>
        </aside>
      </div>
    </div>
  );
}

function Row(props: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="m-0 min-w-0 break-words">{props.children}</dd>
    </div>
  );
}

function Key(props: { children: ReactNode }) {
  return <kbd className="inline-grid h-5 min-w-5 place-items-center rounded border px-1 font-sans text-[11px] text-foreground">{props.children}</kbd>;
}

/** Make a test of a real task (§7.1): its show and files, and the expected
 *  answer — the accepted one unless staff give another; a disputed task
 *  needs one. The workers who answered it are never served it. */
function MakeTest(props: { task: Task; go: (p: Place) => void }) {
  const client = useStrutClient();
  const { act, busy, error } = useAct();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => (props.task.status === "settled" ? jsonText(props.task.answer) : ""));
  const read = parseJson(text);
  if (!open) {
    return (
      <div className="flex flex-col gap-1">
        <Button size="sm" variant="outline" className="w-fit" onClick={() => setOpen(true)}>
          Make a test from this answer
        </Button>
        <Note>What it showed and its files, with an answer you know; its workers are never served it.</Note>
      </div>
    );
  }
  return (
    <Section title="Make a test from this answer">
      <Note>{props.task.status === "disputed" ? "The copies did not agree: give the expected answer." : "The expected answer, the accepted one unless you change it."}</Note>
      <Textarea aria-label="Expected answer" className="min-h-24 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
      {"problem" in read && text && <span className="text-xs text-destructive">{read.problem}</span>}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy !== null || "problem" in read}
          onClick={() =>
            void act("test", () => client.run<{ test: Test }>("staff/test-from-task", { task: props.task.id, ...("value" in read ? { expected: read.value } : {}) })).then((r) => {
              if (r) props.go({ tab: "tests", test: r.test.id });
            })
          }
        >
          Make the test
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <ErrorLine error={error} />
    </Section>
  );
}
