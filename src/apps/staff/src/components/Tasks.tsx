// Tasks (plans/human-steps.md §9.5): filtered by type, status, workflow, run
// and who answered, newest first, a page at a time. A task shows what the
// worker was shown (a JSON tree and its files), its leases in order, the
// answer — in the type's form, read only, when the shape draws as one — and
// its run as it stands now. With item 4, a disputed task's copies and their
// answers, a test instance's grade, and "make a test of it"; with 5a, each
// answer's earning and a take-back inside its hold. The verdict (§9.6): each
// answer marked ok or rejected with why, a mark on the answer and never an
// undo of the run; the review filter is the review queue. The run's reply to
// its workers (`task/reply`) beside the answer, and every picture drawn as it
// comes into view.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, FileText, Image as ImageIcon, Paperclip } from "lucide-react";
import { formProblem } from "@strut/kit/folds";
import { useHost, useStrutClient } from "@strut/kit";
import { TaskForm, TaskReplyView } from "strut/views";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  answerFiles, earningText, fmtWhen, isPicture, jsonText, leaseOutcome, parseJson, REVIEW_FILTERS, REVIEW_WORDS, reviewable, reviewSummary, reviewText, runOf, shortActor, STATUS_WORDS, whoOf,
  type Place, type ReviewFilter, type Shown,
} from "../lib/view";
import type { Lease, Task, TaskFile, TaskRun, TaskStatus, TaskType, Test, Verdict, Worker } from "../lib/types";
import { Back, Empty, ErrorLine, JsonTree, Loading, Note, Picture, ReasonButton, Section, useAct } from "./bits";

const PAGE = 50;

interface Props {
  go: (p: Place) => void;
  place: Place;
  shown: Shown;
  types?: TaskType[];
  workers?: Worker[];
}

export function Tasks(props: Props) {
  if (props.place.task) return <TaskDetail {...props} id={props.place.task} />;
  return <TaskList {...props} />;
}

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

function TaskList(props: Props) {
  const client = useStrutClient();
  const [f, setF] = useState<Filters>(() => filtersOf(props.place));
  useEffect(() => setF(filtersOf(props.place)), [props.place.type, props.place.run, props.place.by, props.place.review]);
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

  return (
    <Section title="Tasks" aside={<Note>Newest first</Note>}>
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect aria-label="Type" value={f.type} onChange={(e) => set({ type: e.target.value })}>
          <NativeSelectOption value="">Every type</NativeSelectOption>
          {(props.types ?? []).map((t) => (
            <NativeSelectOption key={t.name} value={t.name}>
              {t.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="Status" value={f.status} onChange={(e) => set({ status: e.target.value as Filters["status"] })}>
          <NativeSelectOption value="">Any status</NativeSelectOption>
          {statuses.map((s) => (
            <NativeSelectOption key={s} value={s}>
              {STATUS_WORDS[s]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="Answered by" value={f.by} onChange={(e) => set({ by: e.target.value })}>
          <NativeSelectOption value="">Answered by anyone</NativeSelectOption>
          {f.by && !(props.workers ?? []).some((w) => w.actor === f.by) && <NativeSelectOption value={f.by}>{shortActor(f.by)}</NativeSelectOption>}
          {(props.workers ?? []).map((w) => (
            <NativeSelectOption key={w.actor} value={w.actor}>
              {whoOf(w)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {props.shown.review && (
          <NativeSelect aria-label="Review" value={f.review} onChange={(e) => set({ review: e.target.value as Filters["review"] })}>
            <NativeSelectOption value="">Reviewed or not</NativeSelectOption>
            {REVIEW_FILTERS.map((r) => (
              <NativeSelectOption key={r} value={r}>
                {REVIEW_WORDS[r]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        {props.shown.tests && (
          <NativeSelect aria-label="Tests" value={f.test} onChange={(e) => set({ test: e.target.value as Filters["test"] })}>
            <NativeSelectOption value="">Tasks and tests</NativeSelectOption>
            <NativeSelectOption value="false">Real tasks</NativeSelectOption>
            <NativeSelectOption value="true">Tests served</NativeSelectOption>
          </NativeSelect>
        )}
        <Input aria-label="Workflow" className="h-9 w-40" placeholder="workflow" value={f.workflow} onChange={(e) => set({ workflow: e.target.value.trim() })} />
        <Input aria-label="Run" className="h-9 w-40" placeholder="run id" value={f.runId} onChange={(e) => set({ runId: e.target.value.trim() })} />
      </div>
      {q.error ? (
        <ErrorLine error={q.error} />
      ) : !q.data ? (
        <Loading>Reading tasks…</Loading>
      ) : tasks.length === 0 ? (
        <Empty>No task here{pages.length > 1 ? " past this point" : ""}.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Made</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Run</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Answered by</TableHead>
                {props.shown.review && <TableHead>Review</TableHead>}
                <TableHead className="text-right">Leases</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t) => (
                <TableRow key={t.id} className="cursor-pointer" onClick={() => props.go({ tab: "tasks", task: t.id })}>
                  <TableCell className="whitespace-nowrap">{fmtWhen(t.created)}</TableCell>
                  <TableCell>
                    {t.type} {t.test && <Badge variant="outline">test</Badge>}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-1">
                      <StatusBadge status={t.status} />
                      {t.reply && <Badge variant="outline">replied</Badge>}
                    </span>
                  </TableCell>
                  {/* The whole run id: it is Date.now(), so a prefix is the same for runs a minute apart. */}
                  <TableCell className="font-mono text-xs">{t.workflow ? `${t.workflow} · ${t.runId}` : t.test ? "a test" : "—"}</TableCell>
                  <TableCell className="whitespace-nowrap">{t.status === "open" ? fmtWhen(t.due) : "—"}</TableCell>
                  <TableCell>
                    {t.by ? who(t.by) : (t.copies ?? 1) > 1 ? `${t.leases.filter((l) => l.status === "submitted").length} of ${t.copies}` : "—"}
                    {answerFiles(t).length > 0 && (
                      <span className="ml-1.5 inline-flex items-center gap-0.5 text-xs text-muted-foreground" title="Files the answer carried">
                        <Paperclip className="size-3" />
                        {answerFiles(t).length}
                      </span>
                    )}
                  </TableCell>
                  {props.shown.review && <TableCell className={t.leases.some((l) => l.review?.verdict === "rejected") ? "text-destructive" : undefined}>{reviewSummary(t) || "—"}</TableCell>}
                  <TableCell className="text-right tabular-nums">{t.leases.length}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={pages.length < 2} onClick={() => setPages((p) => p.slice(0, -1))}>
          Newer
        </Button>
        <Button size="sm" variant="outline" disabled={tasks.length < PAGE} onClick={() => setPages((p) => [...p, tasks[tasks.length - 1]!.seq])}>
          Older
        </Button>
      </div>
    </Section>
  );
}

function StatusBadge({ status }: { status: TaskStatus }) {
  return <Badge variant={status === "disputed" ? "destructive" : status === "settled" ? "secondary" : "outline"}>{STATUS_WORDS[status]}</Badge>;
}

/** A worker's name here, from the list read. */
function useWho(workers: Worker[] | undefined) {
  const byActor = useMemo(() => new Map((workers ?? []).map((w) => [w.actor, w])), [workers]);
  return (actor: string) => {
    const w = byActor.get(actor);
    return w ? whoOf(w) : shortActor(actor);
  };
}

function TaskDetail(props: Props & { id: string }) {
  const client = useStrutClient();
  const host = useHost();
  const { act, busy, error } = useAct();
  const q = useQuery({ queryKey: ["staff", "task", props.id], queryFn: () => client.run<{ task: Task; run: TaskRun | null }>("staff/task", { id: props.id }) });
  const who = useWho(props.workers);
  const back = <Back onClick={() => props.go({ tab: "tasks" })}>Tasks</Back>;
  if (q.error) return (<div className="flex flex-col gap-3">{back}<ErrorLine error={q.error} /></div>);
  if (!q.data) return <Loading>Reading the task…</Loading>;
  const { task: t, run } = q.data;
  const type = (props.types ?? []).find((k) => k.name === t.type);
  const draws = type && !formProblem(type.answer) && t.answer && typeof t.answer === "object" && !Array.isArray(t.answer);
  const copies = (t.copies ?? 1) > 1;
  const now = Date.now();

  return (
    <div className="flex flex-col gap-5">
      {back}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{t.type}</h2>
        <StatusBadge status={t.status} />
        {t.group && (
          <Button size="xs" variant="outline" title="The group its run put it in" onClick={() => props.go({ tab: "groups", group: t.group, type: t.type })}>
            {t.group}
          </Button>
        )}
        {t.test && <Badge variant="outline">test instance</Badge>}
        {copies && <Badge variant="outline">{t.copies} copies</Badge>}
        <span className="font-mono text-xs text-muted-foreground">{t.id}</span>
      </div>
      <Note>
        Made {fmtWhen(t.created)}
        {t.status === "open" ? ` · expires unanswered ${fmtWhen(t.due)}` : t.settledAt ? ` · ${STATUS_WORDS[t.status]} ${fmtWhen(t.settledAt)}` : ""}
      </Note>

      {t.test ? (
        <Section title="The test">
          <p className="text-sm">
            Served to {who(t.servedTo ?? "")}.{" "}
            {t.grade ? `Graded ${t.grade} ${fmtWhen(t.gradedAt!)}.` : t.status === "settled" ? "Not graded yet." : ""}{" "}
            <button type="button" className="underline underline-offset-2" onClick={() => props.go({ tab: "tests", test: t.test })}>
              Open the test
            </button>
          </p>
        </Section>
      ) : (
        <Section title="The run">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{t.workflow}</span>
            <span className="font-mono text-xs">{t.runId}</span>
            <span className="text-muted-foreground">step {t.path}</span>
            {run ? <Badge variant="outline">{run.status}</Badge> : <Badge variant="outline">not on file</Badge>}
            <Button size="xs" variant="outline" onClick={() => void host.openLink(`?wf=${encodeURIComponent(t.workflow)}&run=${encodeURIComponent(t.runId)}`).catch(() => {})}>
              <ExternalLink /> Open the run
            </Button>
          </div>
          {run?.waitingOn?.length ? <Note>Waiting on {run.waitingOn.join(", ")}</Note> : null}
        </Section>
      )}

      <Section title="What the worker was shown">
        <div className="rounded-md border p-2">
          <JsonTree value={t.show} />
        </div>
        {t.files.length > 0 && (
          <div className="flex flex-col gap-2">
            {t.files.map((path) => (
              <TaskFileView key={path} task={t.id} path={path} />
            ))}
          </div>
        )}
      </Section>

      {/* With a reply, the answer and the reply side by side on a wide
          screen: the answer's pictures beside what the run made of them. */}
      <div className={t.reply ? "grid items-start gap-5 md:grid-cols-2" : "contents"}>
        <Section title={copies ? "The answers" : "The answer"} className="min-w-0">
          {t.status === "settled" && t.answer !== undefined ? (
            <>
              <Note>
                {copies ? "Agreed on; first given by" : "Given by"} {t.by ? who(t.by) : "—"}
              </Note>
              {noFields(t.answer) ? (
                <NoFields files={answerFiles(t).length} />
              ) : draws ? (
                <TaskForm task={{ lease: t.id, answer: type!.answer }} readOnly value={t.answer as Record<string, unknown>} />
              ) : (
                <div className="rounded-md border p-2"><JsonTree value={t.answer} /></div>
              )}
              {/* The files the answer carried (§5.6): in the run, read through staff/file. */}
              {answerFiles(t).map((a) => (
                <TaskFileView key={a.path} task={t.id} path={a.path} mediaType={a.mediaType} />
              ))}
            </>
          ) : t.status === "disputed" ? (
            <Note>The copies did not agree: the step failed task_disputed, and its onError ran. Each copy's answer is under its lease below.</Note>
          ) : (
            <Note>No answer {t.status === "open" ? "yet" : `: ${STATUS_WORDS[t.status]}`}.</Note>
          )}
        </Section>
        {t.reply && (
          <Section title="The reply" className="min-w-0">
            <Note>
              What the run told {copies ? "the workers who answered" : "the worker"} after the answer, {fmtWhen(t.reply.at)}
            </Note>
            <TaskReplyView reply={t.reply} file={(f) => <TaskFileView task={t.id} path={f.path} mediaType={f.mediaType} version={t.reply!.at} />} />
          </Section>
        )}
      </div>

      {props.shown.review && reviewable(t).length > 0 && (
        <Section title="Review">
          <Note>
            A mark on {copies ? "each answer" : "the answer"}: the run has gone on and is not touched.
            {type?.tests ? " A rejection counts against the worker's standing in this type as a failed test does, and Mark ok takes it out." : ""}
            {props.shown.earnings && reviewable(t).some((l) => l.payMsat) ? " While the earning is held, a rejection takes it back and Mark ok gives it back (a take-back by hand stays)." : ""} It
            can change until the answer's hold ends; then it is final.
          </Note>
          <ul className="flex flex-col gap-2">
            {reviewable(t).map((l) => (
              <ReviewLine
                key={l.id}
                lease={l}
                who={copies ? who(l.worker) : undefined}
                busy={busy !== null}
                onReview={(verdict, why) => void act("review", () => client.run("staff/review", { task: t.id, ...(copies ? { worker: l.worker } : {}), verdict, ...(why ? { why } : {}) }))}
              />
            ))}
          </ul>
        </Section>
      )}

      <Section title="Leases">
        {t.leases.length === 0 ? (
          <Note>Nobody has taken it.</Note>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Who</TableHead>
                  <TableHead>Taken</TableHead>
                  <TableHead>How it closed</TableHead>
                  {copies && <TableHead>Answer</TableHead>}
                  {props.shown.earnings && <TableHead>Earned</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {t.leases.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>
                      <button type="button" className="underline-offset-2 hover:underline" onClick={() => props.go({ tab: "workers", worker: l.worker })}>
                        {who(l.worker)}
                      </button>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{fmtWhen(l.taken)}</TableCell>
                    <TableCell>
                      {leaseOutcome(l, now)}
                      {l.closed ? <span className="text-xs text-muted-foreground"> · {fmtWhen(l.closed)}</span> : null}
                    </TableCell>
                    {copies && (
                      <TableCell className="max-w-72">
                        {l.answer === undefined ? "—" : noFields(l.answer) ? <NoFields files={l.attachments?.length ?? 0} /> : <JsonTree value={l.answer} />}
                        {l.attachments?.map((a) => <TaskFileView key={a.path} task={t.id} path={a.path} mediaType={a.mediaType} />)}
                        {l.agrees !== undefined && <Badge variant={l.agrees ? "secondary" : "outline"}>{l.agrees ? "agreed" : "disagreed"}</Badge>}
                      </TableCell>
                    )}
                    {props.shown.earnings && (
                      <TableCell>
                        {l.earning ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm">{earningText(l.earning, now)}</span>
                            {l.earning.takenBack === undefined && l.earning.releases > now && (
                              <ReasonButton
                                label="Take back"
                                placeholder="Why (the worker's balance says so)"
                                required
                                disabled={busy !== null}
                                onAct={(why) => void act("take-back", () => client.run("staff/take-back", { task: t.id, worker: l.worker, why }))}
                              />
                            )}
                          </div>
                        ) : l.payMsat && l.status === "submitted" ? (
                          <span className="text-xs text-muted-foreground">being booked</span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>
      <ErrorLine error={error} />

      {props.shown.tests && !t.test && (t.status === "settled" || t.status === "disputed") && <MakeTest task={t} go={props.go} />}
    </div>
  );
}

/** An answer of no fields (`{}`, a type that takes only files): said in a
 *  line, not drawn as an empty tree. */
function noFields(answer: unknown): boolean {
  return !!answer && typeof answer === "object" && !Array.isArray(answer) && Object.keys(answer).length === 0;
}

function NoFields({ files }: { files: number }) {
  return <Note>{files ? "No fields: only the files sent with it." : "No fields."}</Note>;
}

/** §9.6: one answer's verdict, with Mark ok and Reject (why on a line in the
 *  page) while it can change. A first verdict can always be given. */
export function ReviewLine(props: { lease: Lease; who?: string; busy: boolean; onReview: (verdict: Verdict, why?: string) => void }) {
  const r = props.lease.review;
  const now = Date.now();
  const open = !r || (!r.final && r.until > now);
  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      {props.who && <span className="font-medium">{props.who}</span>}
      {r ? (
        <span className={r.verdict === "rejected" ? "text-destructive" : undefined}>{reviewText(r, now)}</span>
      ) : (
        <span className="text-muted-foreground">not reviewed</span>
      )}
      {open && (
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {r?.verdict !== "ok" && (
            <Button size="xs" variant="outline" disabled={props.busy} onClick={() => props.onReview("ok")}>
              Mark ok
            </Button>
          )}
          <ReasonButton
            label={r?.verdict === "rejected" ? "Change the reason" : "Reject"}
            placeholder="Why it is wrong (kept with the verdict)"
            required
            variant="outline"
            disabled={props.busy}
            onAct={(why) => props.onReview("rejected", why)}
          />
        </span>
      )}
    </li>
  );
}

/** One of a task's files through `staff/file`. A picture is read as it
 *  comes into view and drawn (a click shows it full size); text and any other
 *  file are read when opened. Each is read once — its key is outside
 *  ["staff", …], so a review's reads again never read it again — and its
 *  error is its own: a file that is gone says so, and the rest still draw.
 *  `version` is in the key: a reply's files are read again when a later
 *  reply (its `at`) replaces it, even under the same path. */
function TaskFileView(props: { task: string; path: string; mediaType?: string; version?: number }) {
  const client = useStrutClient();
  const picture = isPicture(props.path, props.mediaType);
  const [open, setOpen] = useState(false);
  const [box, seen] = useSeen<HTMLDivElement>(picture);
  const q = useQuery({
    queryKey: ["staff-file", props.task, props.path, props.version ?? 0],
    queryFn: () => client.run<TaskFile>("staff/file", { task: props.task, path: props.path }),
    enabled: picture ? seen : open,
    staleTime: Infinity,
    retry: false,
  });
  const f = q.data;
  return (
    <div ref={box} className="min-w-0 rounded-md border p-2">
      {picture ? (
        <div className="flex items-center gap-2 text-sm font-medium break-all">
          <ImageIcon className="size-4 shrink-0" /> {props.path}
        </div>
      ) : (
        <button type="button" className="flex items-center gap-2 text-left text-sm font-medium break-all" onClick={() => setOpen((o) => !o)}>
          <FileText className="size-4 shrink-0" /> {props.path}
        </button>
      )}
      {(picture || open) &&
        (q.error ? (
          <ErrorLine error={q.error} className="mt-2" />
        ) : !f ? (
          picture ? <div className="mt-2 h-48 w-full max-w-sm animate-pulse rounded bg-muted" /> : <Loading />
        ) : (
          <div className="mt-2">
            {f.base64 && f.mediaType.startsWith("image/") ? (
              <Picture alt={props.path} className="max-h-96 max-w-full rounded" src={`data:${f.mediaType};base64,${f.base64}`} />
            ) : f.text !== undefined ? (
              <pre className="max-h-96 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{f.text}</pre>
            ) : f.base64 ? (
              <a className="text-sm underline" download={props.path.split("/").pop()} href={`data:${f.mediaType};base64,${f.base64}`}>
                Download ({f.bytes.toLocaleString("en-US")} bytes)
              </a>
            ) : null}
            {f.truncated && <Note>Cut at the size a page can be handed.</Note>}
          </div>
        ))}
    </div>
  );
}

/** Whether the element has come into view, once (`on` false: never asked).
 *  A page with ten pictures reads the ones in view, then each as it is
 *  scrolled to, not all ten at once. */
export function useSeen<T extends Element>(on: boolean) {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!on || seen || !el) return;
    if (typeof IntersectionObserver === "undefined") return setSeen(true);
    const watch = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true));
    watch.observe(el);
    return () => watch.disconnect();
  }, [on, seen]);
  return [ref, seen] as const;
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
  return (
    <Section title="Make a test of it">
      {!open ? (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Make a test of it
          </Button>
          <Note>Its show and files, with an answer you know; its workers are never served it.</Note>
        </div>
      ) : (
        <>
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
        </>
      )}
    </Section>
  );
}
