// Task types (plans/human-steps.md §9.5): each kind of work as a card —
// whether it is on, who may take it, what it pays, how its answers are
// checked, and how today went — with New type, and the editor: name (a new
// type only), the app that draws it and what is wrong with it, the lease
// and expiry, on or off, open or invite-only (ruling 9: a paid open type
// needs its K ready tests), the answer's shape, and, when the server
// answers for them (§9.7), its pay (5a), its tests and copies (4). Save is
// `staff/save-type`, the whole type; Delete only with no task open. Below,
// the workers who hold it, with Revoke and Grant. A type's tests open from
// its card and its page.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Save, Trash2, UserPlus } from "lucide-react";
import { taskAppProblem } from "@strut/kit/folds";
import { useStrutClient } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { answerOfDraft, draftOf, saveOf, shapeChanged, type Draft, type GradeDraft } from "../lib/draft";
import { fmtDuration, liveTypes, OPEN_GRANT_BY, openPayHint, standingText, typeNameProblem, whoOf, type Place, type Shown } from "../lib/view";
import type { TaskStats, TaskType, TypeNumbers, TypeShare, TypeStats, Worker } from "../lib/types";
import { AnswerEditor } from "./AnswerEditor";
import { Back, Empty, ErrorLine, Field, Label, Loading, Note, ReasonButton, Section, useAct } from "./bits";
import { TypeInvite } from "./Share";
import { RoundNote, SendRound } from "./SendRound";

interface Props {
  go: (p: Place) => void;
  place: Place;
  shown: Shown;
  types?: TaskType[];
  /** Tasks' share (`staff/types`' `tasks`): every invite opens it. */
  tasks?: TypeShare;
  workers?: Worker[];
  error: unknown;
  /** Opens Invite a worker with this type picked. */
  invite?: (type: string) => void;
}

export function Types(props: Props) {
  const client = useStrutClient();
  const stats = useQuery({ queryKey: ["staff", "stats"], queryFn: () => client.run<TaskStats>("staff/stats", {}) });
  const [creating, setCreating] = useState(false);
  const open = props.place.type;
  useEffect(() => {
    if (open) setCreating(false);
  }, [open]);
  if (props.error) return <ErrorLine error={props.error} />;
  if (!props.types) return <Loading>Reading the task types…</Loading>;
  const editing = open ? props.types.find((t) => t.name === open) : undefined;
  if (creating || editing || open) {
    return (
      <TypeEditor
        key={editing?.name ?? "new"}
        {...props}
        type={editing}
        missing={open && !editing ? open : undefined}
        openTasks={editing ? openOf(stats.data, editing.name) : 0}
        readyTests={editing ? stats.data?.types.find((t) => t.type === editing.name)?.readyTests : 0}
        onDone={(name) => {
          setCreating(false);
          props.go(name ? { tab: "types", type: name } : { tab: "types" });
        }}
      />
    );
  }
  const row = (name: string) => stats.data?.types.find((t) => t.type === name);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-96 flex-col gap-1">
          <h2 className="text-base font-semibold">Task types</h2>
          <Note>A task type is one kind of work: the app that shows it, what an answer looks like, who may take it and what it pays. A workflow's human step names the type.</Note>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus /> New type
        </Button>
      </div>
      {props.types.length === 0 ? (
        <Empty>No task types yet. Make one here, or ask the assistant to build the workflow and its task type together.</Empty>
      ) : (
        <ul className="flex flex-col gap-3">
          {props.types.map((t) => (
            <TypeCard key={t.name} type={t} row={row(t.name)} shown={props.shown} go={props.go} {...(props.invite ? { invite: props.invite } : {})} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One kind of work at a glance: on or off, who may take it, its pay, how
 *  its answers are checked, and today. */
function TypeCard(props: { type: TaskType; row?: TypeStats | undefined; shown: Shown; go: (p: Place) => void; invite?: (type: string) => void }) {
  const { type: t, row, shown } = props;
  const day = row?.windows.day;
  const checks = [t.check && "Checked when handed in", t.tests && `Tested: ${Math.round(t.tests.rate * 100)}% of tasks`, t.copies && `${t.copies.agree} of up to ${t.copies.max} copies must agree`].filter(Boolean) as string[];
  const review = shown.review && row?.toReview ? `${row.toReview.toLocaleString("en-US")} answer${row.toReview === 1 ? "" : "s"} to review` : "";
  return (
    <li className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-72 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="text-left text-[17px] font-semibold break-words underline-offset-2 hover:underline" onClick={() => props.go({ tab: "types", type: t.name })}>
              {t.name}
            </button>
            {t.enabled ? (
              <Badge variant="outline">
                <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" /> On
              </Badge>
            ) : (
              <Badge variant="secondary">Off</Badge>
            )}
            {t.standing && <Badge variant="outline">any time</Badge>}
            {t.round && <Badge variant="outline">rounds</Badge>}
            {row?.appProblem && (
              <Badge variant="destructive" title={row.appProblem}>
                app problem
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {t.title?.trim() ? `Workers call it “${t.title.trim()}”, and see it in ` : "Workers see it in "}
            {t.app}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => props.go({ tab: "tasks", type: t.name })}>
            See answers
          </Button>
          {shown.tests && (
            <Button size="sm" variant="ghost" onClick={() => props.go({ tab: "tests", type: t.name })}>
              Tests
            </Button>
          )}
          {props.invite && t.enabled && (
            <Button size="sm" variant="outline" onClick={() => props.invite!(t.name)}>
              <UserPlus /> Invite someone
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => props.go({ tab: "types", type: t.name })}>
            Edit
          </Button>
        </div>
      </div>
      <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-x-6 gap-y-4 border-t pt-4">
        {shown.open && (
          <Fact label="Who can take it" value={t.open ? "Anyone signed in" : "Invite-only"} note={row ? `${row.granted.toLocaleString("en-US")} worker${row.granted === 1 ? "" : "s"} ${t.open ? "took it up" : "let in"}` : undefined} />
        )}
        {shown.pay && (
          <Fact
            label="Pay"
            value={t.paySats ? `${t.paySats.toLocaleString("en-US")} sats an answer` : "Unpaid"}
            note={t.paySats ? [t.payOn === "ok" ? "paid once marked OK" : "", t.holdHours ? `held ${t.holdHours} h before it can be withdrawn` : "no hold", t.limits?.budgetSats !== undefined ? `budget ${t.limits.budgetSats.toLocaleString("en-US")} sats` : ""].filter(Boolean).join(" · ") : undefined}
          />
        )}
        <Fact label="Checking" value={checks[0] ?? (shown.review ? "Reviewed by hand" : "No check")} note={[...checks.slice(1), review].filter(Boolean).join(" · ") || undefined} />
        <Fact
          label="Today"
          value={day ? `${day.answered.toLocaleString("en-US")} answered` : "—"}
          note={row ? [`${row.waiting} waiting`, day?.toAnswer ? `typical time ${fmtDuration(day.toAnswer.p50)}` : ""].filter(Boolean).join(" · ") : undefined}
        />
      </dl>
    </li>
  );
}

function Fact(props: { label: string; value: string; note?: string | undefined }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt>
        <Label>{props.label}</Label>
      </dt>
      <dd className="m-0 text-[15px] font-semibold break-words">{props.value}</dd>
      {props.note && <dd className="m-0 text-xs text-muted-foreground">{props.note}</dd>}
    </div>
  );
}

const openOf = (s: TaskStats | undefined, type: string) => {
  const r = s?.types.find((t) => t.type === type);
  return r ? r.waiting + r.working : 0;
};

const WHEN_HINT: Record<Draft["when"], string> = {
  sent: "A workflow's human step makes each task, when it runs.",
  standing: "Any time: a worker starts one whenever they like, and their answer starts the workflow. Its first step is this type's human step.",
  round: "One for each item: you send a round (here, or by asking the assistant), and the workflow makes a task for each item ticked.",
};

/** When there is work (plans/human-steps.md §5.7, rounds): when a workflow
 *  sends one, any time, or in rounds — the last two with the workflow, from
 *  those that can feed this type (`staff/type-workflows`). */
function WhenField(props: { d: Draft; set: (patch: Partial<Draft>) => void }) {
  const { d, set } = props;
  const client = useStrutClient();
  const fits = useQuery({
    queryKey: ["staff", "type-workflows", d.name],
    queryFn: () => client.run<{ workflows: Array<{ name: string; standing: boolean }> }>("staff/type-workflows", { type: d.name }),
    enabled: d.when !== "sent" && !!d.name,
  });
  const choices = (fits.data?.workflows ?? []).filter((w) => d.when !== "standing" || w.standing).map((w) => w.name);
  const none = fits.data && choices.length === 0;
  return (
    <>
      <Field label="When there is work" htmlFor="type-when" hint={WHEN_HINT[d.when]}>
        <NativeSelect
          id="type-when"
          value={d.when}
          onChange={(e) => {
            const when = e.target.value as Draft["when"];
            // The workflow picked stays only where it can be one.
            const keep = fits.data?.workflows.some((w) => w.name === d.workflow && (when !== "standing" || w.standing));
            set({ when, workflow: keep ? d.workflow : "" });
          }}
        >
          <NativeSelectOption value="sent">When a workflow sends one</NativeSelectOption>
          <NativeSelectOption value="standing">Any time: a worker starts one</NativeSelectOption>
          <NativeSelectOption value="round">In rounds: one for each item</NativeSelectOption>
        </NativeSelect>
      </Field>
      {d.when !== "sent" && (
        <Field
          label={d.when === "standing" ? "Workflow each answer starts" : "Workflow a round runs"}
          htmlFor="type-workflow"
          hint={
            !d.name ? (
              "Name the type first: the workflows listed are those with a human step of it."
            ) : none ? (
              <span className="text-destructive">
                No workflow here has {d.when === "standing" ? "this type's human step as its first step" : "a human step of this type"} yet: ask the assistant to build one.
              </span>
            ) : (
              "Workflows with a human step of this type."
            )
          }
        >
          <NativeSelect id="type-workflow" value={d.workflow} onChange={(e) => set({ workflow: e.target.value })}>
            <NativeSelectOption value="">Choose a workflow…</NativeSelectOption>
            {d.workflow && !choices.includes(d.workflow) && <NativeSelectOption value={d.workflow}>{d.workflow}</NativeSelectOption>}
            {choices.map((w) => (
              <NativeSelectOption key={w} value={w}>
                {w}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      )}
    </>
  );
}

function TypeEditor(props: Props & { type?: TaskType; missing?: string; openTasks: number; readyTests?: number; onDone: (name?: string) => void }) {
  const client = useStrutClient();
  const { act, busy, error } = useAct();
  const was = props.type;
  const [d, setD] = useState<Draft>(() => draftOf(was));
  const [confirm, setConfirm] = useState<"delete" | "shape" | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => {
    setD((x) => ({ ...x, ...patch }));
    setSaved(null);
    setConfirm(null);
  };
  const apps = useQuery({ queryKey: ["staff", "apps"], queryFn: () => client.run<{ apps: Array<{ name: string; title: string; grants?: { steps?: string[] } }> }>("app/list", {}) });
  const appRow = apps.data?.apps.find((a) => a.name === d.app);
  const appProblem = d.app && apps.data ? taskAppProblem(d.app, appRow ?? null) : undefined;
  const nameProblem = was ? undefined : typeNameProblem(d.name, (props.types ?? []).map((t) => t.name));
  const out = saveOf(d, props.shown, was);
  const holders = useMemo(() => (props.workers ?? []).filter((w) => was && liveTypes(w).includes(was.name)), [props.workers, was]);
  const payHint = props.shown.open && props.shown.pay ? openPayHint({ open: d.open, paySats: Number(d.paySats) || 0, testsOn: props.shown.tests && d.testsOn, qualify: Number(d.tests.qualify) }, props.readyTests) : null;
  const others = (props.workers ?? []).filter((w) => was && !liveTypes(w).includes(was.name) && w.status !== "banned");
  const [granting, setGranting] = useState("");

  if (props.missing) {
    return (
      <div className="flex flex-col gap-3">
        <Back onClick={() => props.onDone()}>Task types</Back>
        <Empty>There is no task type {props.missing} here. Its tasks on file keep the name.</Empty>
      </div>
    );
  }

  const save = async () => {
    if ("problem" in out) return;
    const schema = answerOfDraft(d);
    // A new shape for a type with open tasks: their answers are checked against it.
    if (confirm !== "shape" && "schema" in schema && shapeChanged(was, schema.schema) && props.openTasks > 0) {
      setConfirm("shape");
      return;
    }
    const r = await act("save", () => client.run<{ type: TaskType }>("staff/save-type", out.input));
    if (r) {
      setSaved(`Saved ${r.type.name}.`);
      setConfirm(null);
      if (!was) props.onDone(r.type.name);
    }
  };
  const remove = async () => {
    if (!was) return;
    if (confirm !== "delete") return setConfirm("delete");
    const r = await act("delete", () => client.run<{ name: string; revoked: number }>("staff/delete-type", { name: was.name }));
    if (r) props.onDone();
  };

  return (
    <div className="flex flex-col gap-5">
      <Back onClick={() => props.onDone()}>Task types</Back>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{was ? was.name : "New task type"}</h2>
        {was && !was.enabled && <Badge variant="outline">off</Badge>}
        {was && was.open === false && <Badge variant="outline">invite-only</Badge>}
        {was?.standing && <Badge variant="outline">standing</Badge>}
        {was?.round && <Badge variant="outline">rounds</Badge>}
        {was?.changedBy && <Note>last saved by {was.changedBy}</Note>}
        {was && props.shown.tests && (
          <Button size="sm" variant="ghost" onClick={() => props.go({ tab: "tests", type: was.name })}>
            Its tests
          </Button>
        )}
        {was?.round && (
          <div className="ml-auto">
            <SendRound type={was} />
          </div>
        )}
      </div>
      {was && <TypeInvite type={was} types={props.types} tasks={props.tasks} />}
      {was?.standing && <Note>Standing: a worker starts one whenever they ask, and each answer starts the workflow {was.standing.workflow}.</Note>}
      {was?.round && <RoundNote type={was} />}

      <div className="grid gap-4 md:grid-cols-2">
        {!was && (
          <Field label="Name" htmlFor="type-name" hint={d.name ? (nameProblem ?? "A saved name is fixed: a type under another name is a new type.") : "Lowercase letters, digits, “.”, “_” and “-”, segments joined by “/”."}>
            <Input id="type-name" value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="pet-match" aria-invalid={!!(d.name && nameProblem)} />
          </Field>
        )}
        <Field label="What workers call it" htmlFor="type-title" hint="In their language, any words: “Revisión de recibo”. Empty: they read the name.">
          <Input id="type-title" value={d.title} maxLength={80} onChange={(e) => set({ title: e.target.value })} placeholder={d.name ? d.name.split("/").pop()!.replace(/[-_]+/g, " ") : "Pet match"} />
        </Field>
        <Field label="App" htmlFor="type-app" hint={appProblem ? <span className="text-destructive">{appProblem}.</span> : "The worker app whose page draws this type's tasks."}>
          <NativeSelect id="type-app" value={d.app} onChange={(e) => set({ app: e.target.value })}>
            <NativeSelectOption value="">Choose an app…</NativeSelectOption>
            {d.app && !appRow && <NativeSelectOption value={d.app}>{d.app} (not here)</NativeSelectOption>}
            {(apps.data?.apps ?? [])
              // Strut's own apps are not worker apps — but strut/worker is.
              .filter((a) => !a.name.startsWith("strut/") || a.name === "strut/worker")
              .map((a) => (
                <NativeSelectOption key={a.name} value={a.name}>
                  {a.title ? `${a.title} (${a.name})` : a.name}
                </NativeSelectOption>
              ))}
          </NativeSelect>
        </Field>
        <Field label="Lease, minutes" htmlFor="type-lease" hint="How long one worker holds a task before it is free again.">
          <Input id="type-lease" type="number" min={1} max={1440} value={d.leaseMinutes} onChange={(e) => set({ leaseMinutes: e.target.value })} />
        </Field>
        <Field label="Expires unanswered after, hours" htmlFor="type-within" hint="Unless the step says otherwise; then the step fails task_expired.">
          <Input id="type-within" type="number" min={0} value={d.withinHours} onChange={(e) => set({ withinHours: e.target.value })} />
        </Field>
        <Field label="On" hint={d.enabled ? "A human step makes tasks of it, and workers are handed them." : "Off: a human step can make no new task of it, and its open tasks are not handed out and expire when due."}>
          <Switch checked={d.enabled} onCheckedChange={(c) => set({ enabled: c })} aria-label="On" />
        </Field>
        <WhenField d={d} set={set} />
        {props.shown.open && (
          <Field
            label="Who takes it"
            htmlFor="type-open"
            hint={
              payHint ? (
                <span className="text-destructive">{payHint}</span>
              ) : d.open ? (
                "Anyone signed in to its app who is not suspended or banned, with no grant: their first ask records one, qualifying first on its tests. A revoke stays until you grant it again."
              ) : (
                "Only the workers you grant it to."
              )
            }
          >
            <NativeSelect id="type-open" value={d.open ? "open" : "invite"} onChange={(e) => set({ open: e.target.value === "open" })}>
              <NativeSelectOption value="open">Open: any signed-in worker</NativeSelectOption>
              <NativeSelectOption value="invite">Invite-only: workers you grant</NativeSelectOption>
            </NativeSelect>
          </Field>
        )}
      </div>

      <Section title="The answer's shape">
        <AnswerEditor model={d.model} json={d.json} onChange={(model, json) => set({ model, json })} />
      </Section>

      {props.shown.pay && (
        <Section title="Pay">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Sats an answer earns" htmlFor="type-pay" hint="Locked when a worker takes the task. Empty or 0: unpaid. At most 1,000,000.">
              <Input id="type-pay" type="number" min={0} step="any" value={d.paySats} onChange={(e) => set({ paySats: e.target.value })} placeholder="unpaid" />
            </Field>
            <Field label="Hold, hours" htmlFor="type-hold" hint="How long an earning waits before it can be withdrawn: 0 (none, at once) to 720. A failed test or a take-back inside it loses the earning.">
              <Input id="type-hold" type="number" min={0} max={720} value={d.holdHours} onChange={(e) => set({ holdHours: e.target.value })} />
            </Field>
            <Field
              label="Paid when"
              htmlFor="type-pay-on"
              hint="Once marked OK: an answer earns nothing until you, or the workflow itself, mark it OK, and one marked rejected (a retake, a duplicate) is never paid. The hold runs from the OK."
            >
              <NativeSelect id="type-pay-on" value={d.payOnOk ? "ok" : "answer"} onChange={(e) => set({ payOnOk: e.target.value === "ok" })}>
                <NativeSelectOption value="answer">Handed in</NativeSelectOption>
                <NativeSelectOption value="ok">Marked OK</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field label="Budget, sats" htmlFor="type-budget" hint="The most this task pays in all. Once it is spent, no more is handed out. Empty: no budget beyond the wallet.">
              <Input id="type-budget" type="number" min={0} step="any" value={d.budgetSats} onChange={(e) => set({ budgetSats: e.target.value })} placeholder="no budget" />
            </Field>
            <Field label="Most a worker does a day" htmlFor="type-day" hint="Tasks of this type one worker takes in a day (UTC). Empty: no limit.">
              <Input id="type-day" type="number" min={1} step={1} value={d.perWorkerDay} onChange={(e) => set({ perWorkerDay: e.target.value })} placeholder="no limit" />
            </Field>
          </div>
        </Section>
      )}

      {props.shown.tests && (
        <Section title="Tests" aside={<Switch checked={d.testsOn} onCheckedChange={(c) => set({ testsOn: c })} aria-label="Tests on" />}>
          {!d.testsOn ? (
            <Note>Off: no test is mixed in and nobody qualifies. On, workers answer tests whose answer staff know, are scored, and lose the type under the threshold.</Note>
          ) : (
            <div className="grid gap-3 md:grid-cols-4">
              <Num label="Share of tasks a test" v={d.tests.rate} set={(rate) => set({ tests: { ...d.tests, rate } })} hint="0 to 1" />
              <Num label="… while new" v={d.tests.newRate} set={(newRate) => set({ tests: { ...d.tests, newRate } })} hint="0 to 1" />
              <Num label="New for, answers" v={d.tests.newTasks} set={(newTasks) => set({ tests: { ...d.tests, newTasks } })} />
              <Num label="Tests to qualify" v={d.tests.qualify} set={(qualify) => set({ tests: { ...d.tests, qualify } })} hint="before any real task" />
              <Num label="Standing over the last" v={d.tests.window} set={(window) => set({ tests: { ...d.tests, window } })} hint="graded tests" />
              <Num label="Read once graded" v={d.tests.minGraded} set={(minGraded) => set({ tests: { ...d.tests, minGraded } })} />
              <Num label="Pass at least" v={d.tests.threshold} set={(threshold) => set({ tests: { ...d.tests, threshold } })} hint="0 to 1; under it revokes" />
              <Num label="Grader cap, $" v={d.tests.gradeCapUsd} set={(gradeCapUsd) => set({ tests: { ...d.tests, gradeCapUsd } })} />
              <div className="md:col-span-4">
                <GradeEditor label="Graded by" g={d.tests.grade} set={(grade) => set({ tests: { ...d.tests, grade } })} />
              </div>
            </div>
          )}
        </Section>
      )}

      {props.shown.copies && (
        <Section title="Copies" aside={<Switch checked={d.copiesOn} onCheckedChange={(c) => set({ copiesOn: c })} aria-label="Copies on" />}>
          {!d.copiesOn ? (
            <Note>Off: a human step asks one worker. On, a step may ask several and settles when enough agree; each copy is paid work.</Note>
          ) : (
            <div className="grid gap-3 md:grid-cols-4">
              <Num label="At most" v={d.copies.max} set={(max) => set({ copies: { ...d.copies, max } })} hint="copies a step may ask, 1 to 10" />
              <Num label="Agree to settle" v={d.copies.agree} set={(agree) => set({ copies: { ...d.copies, agree } })} />
              <Field label="When they disagree">
                <NativeSelect value={d.copies.onDisagree} onChange={(e) => set({ copies: { ...d.copies, onDisagree: e.target.value as "more" | "fail" } })}>
                  <NativeSelectOption value="more">ask one more, up to the most</NativeSelectOption>
                  <NativeSelectOption value="fail">dispute it: the step fails</NativeSelectOption>
                </NativeSelect>
              </Field>
              <div className="md:col-span-4">
                <GradeEditor label="Compared by" g={d.copies.compare} set={(compare) => set({ copies: { ...d.copies, compare } })} />
              </div>
            </div>
          )}
        </Section>
      )}

      <Section title="Files" aside={<Switch checked={d.filesOn} onCheckedChange={(c) => set({ filesOn: c })} aria-label="Files with each answer" />}>
        {!d.filesOn ? (
          <Note>Off: an answer is its fields alone. On, the worker sends files with it (a photo of a document), saved in the task's run for the workflow's next steps.</Note>
        ) : (
          <div className="grid gap-3 md:grid-cols-4">
            <Num label="At most" v={d.files.max} set={(max) => set({ files: { ...d.files, max } })} hint="files an answer carries, 1 to 10" />
            <Num label="At least" v={d.files.min} set={(min) => set({ files: { ...d.files, min } })} hint="0: optional" />
            <div className="md:col-span-2">
              <Field label="Of the types">
                <Input value={d.files.types} onChange={(e) => set({ files: { ...d.files, types: e.target.value } })} placeholder="image/*, application/pdf" />
              </Field>
            </div>
          </div>
        )}
      </Section>

      <Section title="Check when handed in" aside={<Switch checked={d.checkOn} onCheckedChange={(c) => set({ checkOn: c })} aria-label="Check each answer when handed in" />}>
        {!d.checkOn ? (
          <Note>Off: every answer that fits is accepted, and earns, the moment it is sent. On, a sealed step checks each answer and its files first: one that fails is refused with its reason, the worker keeps the task and sends it again, and nothing is paid for it.</Note>
        ) : (
          <GradeEditor
            label="Checked by"
            steps
            g={d.check}
            set={(check) => set({ check })}
            hint="grade/judge: a model looks at the answer and its photos against the task. Its rubric says what passes (“A sharp photo of one whole book page: no text cut off”); each answer is one model call."
          />
        )}
      </Section>

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <Button onClick={() => void save()} disabled={busy !== null || "problem" in out || !!nameProblem} title={"problem" in out ? out.problem : undefined}>
          <Save /> {confirm === "shape" ? `Save: check ${props.openTasks} open task${props.openTasks === 1 ? "'s" : "s'"} answers against the new shape` : "Save"}
        </Button>
        {was &&
          (props.openTasks > 0 ? (
            <Note>To delete it, turn it off and let its {props.openTasks} open task{props.openTasks === 1 ? "" : "s"} settle.</Note>
          ) : (
            <Button variant={confirm === "delete" ? "destructive" : "outline"} onClick={() => void remove()} disabled={busy !== null}>
              <Trash2 /> {confirm === "delete" ? `Delete: ${holders.length} worker${holders.length === 1 ? "" : "s"} lose the grant` : "Delete"}
            </Button>
          ))}
        {"problem" in out && <span className="text-sm text-muted-foreground">{out.problem}</span>}
        {saved && <span className="text-sm text-emerald-700 dark:text-emerald-400">{saved}</span>}
      </div>
      <ErrorLine error={error} />

      {was && <TypeNumbersSection type={was.name} paySats={was.paySats} workers={props.workers} go={props.go} />}

      {was && (
        <Section
          title="Workers who hold it"
          aside={
            <Button size="sm" variant="outline" disabled={busy !== null} title="Grant it to yourself, as you are signed in here, to do one in the worker page" onClick={() => void act("grant", () => client.run("staff/grant", { actor: "@me", type: was.name }))}>
              Try it yourself
            </Button>
          }
        >
          {holders.length === 0 ? (
            <Note>{was.open ? "Nobody holds it yet: it is open, so a worker holds it from their first ask." : "Nobody holds it: no worker can take its tasks."}</Note>
          ) : (
            <ul className="flex flex-col gap-1">
              {holders.map((w) => (
                <li key={w.actor} className="flex flex-wrap items-center gap-2 text-sm">
                  <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={() => props.go({ tab: "workers", worker: w.actor })}>
                    {whoOf(w)}
                  </button>
                  <Badge variant="outline">{w.status}</Badge>
                  {w.grants.some((g) => g.type === was.name && g.revokedAt === undefined && g.by === OPEN_GRANT_BY) && <Badge variant="secondary">open</Badge>}
                  {props.shown.standing && w.standing?.[was.name] && <span className="text-xs text-muted-foreground">{standingText(w.standing[was.name]!)}</span>}
                  <span className="ml-auto">
                    <ReasonButton
                      label="Revoke"
                      placeholder="Why (kept with the grant)"
                      disabled={busy !== null}
                      onAct={(why) => void act("revoke", () => client.run("staff/revoke", { actor: w.actor, type: was.name, ...(why ? { why } : {}) }))}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
          {others.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect aria-label="Worker to grant" value={granting} onChange={(e) => setGranting(e.target.value)}>
                <NativeSelectOption value="">Grant it to…</NativeSelectOption>
                {others.map((w) => (
                  <NativeSelectOption key={w.actor} value={w.actor}>
                    {whoOf(w)} ({w.status})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Button size="sm" variant="outline" disabled={!granting || busy !== null} onClick={() => void act("grant", () => client.run("staff/grant", { actor: granting, type: was.name })).then(() => setGranting(""))}>
                Grant
              </Button>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

/** A type's numbers: what it has paid against its budget, and what each
 *  worker did of it in the last 7 days. */
function TypeNumbersSection(props: { type: string; paySats?: number; workers?: Worker[]; go: (p: Place) => void }) {
  const client = useStrutClient();
  const numbers = useQuery({ queryKey: ["staff", "numbers", props.type], queryFn: () => client.run<{ types: TypeNumbers[] }>("staff/numbers", { type: props.type }), refetchInterval: 60_000 });
  const n = numbers.data?.types[0];
  if (!n) return null;
  const named = new Map((props.workers ?? []).map((w) => [w.actor, whoOf(w)]));
  const sats = (v: number) => `${v.toLocaleString("en-US", { maximumFractionDigits: 3 })} sats`;
  const budget = n.limits?.budgetSats;
  return (
    <Section title={`How it's going: last ${n.days} days`}>
      <Note>
        {props.paySats ? `Paid ${sats(n.spentSats)} in all${n.workingSats ? `, ${sats(n.workingSats)} more on tasks being done` : ""}${budget !== undefined ? ` of a ${sats(budget)} budget` : ""}. ` : ""}
        {n.answered} answered in the last {n.days} days{n.limits?.perWorkerDay ? `; at most ${n.limits.perWorkerDay} a worker a day` : ""}.
      </Note>
      {n.workers.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Worker</TableHead>
              <TableHead className="text-right">Answered</TableHead>
              <TableHead className="text-right">Time</TableHead>
              <TableHead className="text-right">Per hour</TableHead>
              <TableHead className="text-right">Earned</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {n.workers.map((w) => (
              <TableRow key={w.worker}>
                <TableCell>
                  <button type="button" className="underline-offset-2 hover:underline" onClick={() => props.go({ tab: "workers", worker: w.worker })}>
                    {named.get(w.worker) ?? w.worker}
                  </button>
                </TableCell>
                <TableCell className="text-right">{w.answered}</TableCell>
                <TableCell className="text-right">{w.workMinutes >= 60 ? `${Math.floor(w.workMinutes / 60)} h ${w.workMinutes % 60} min` : `${w.workMinutes} min`}</TableCell>
                <TableCell className="text-right">{w.perHour ?? "—"}</TableCell>
                <TableCell className="text-right">{sats(w.earnedSats)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

function Num(props: { label: string; v: string; set: (v: string) => void; hint?: string }) {
  return (
    <Field label={props.label} hint={props.hint}>
      <Input type="number" step="any" value={props.v} onChange={(e) => props.set(e.target.value)} />
    </Field>
  );
}

/** `equal`, or a sealed step and its config (§7.4): strut ships
 *  `grade/overlap` (boxes, `{ min, key }`) and `grade/judge` (a model,
 *  `{ rubric, model }`). `steps`: a step only, as a check takes (§5.6.7 c). */
export function GradeEditor(props: { label: string; g: GradeDraft; set: (g: GradeDraft) => void; steps?: boolean; hint?: string }) {
  const { g } = props;
  return (
    <div className="grid gap-2 md:grid-cols-[auto_1fr]">
      <Field label={props.label} hint={props.hint}>
        <NativeSelect value={g.kind === "equal" ? "equal" : g.step} onChange={(e) => props.set(e.target.value === "equal" ? { kind: "equal", step: "", config: "" } : { kind: "step", step: e.target.value === "other" ? "" : e.target.value, config: g.config })}>
          {!props.steps && <NativeSelectOption value="equal">equal: the same JSON</NativeSelectOption>}
          {!props.steps && <NativeSelectOption value="grade/overlap">grade/overlap: boxes on an image</NativeSelectOption>}
          <NativeSelectOption value="grade/judge">grade/judge: a model under a rubric</NativeSelectOption>
          {g.kind === "step" && g.step !== "grade/overlap" && g.step !== "grade/judge" && <NativeSelectOption value={g.step}>{g.step || "another sealed step…"}</NativeSelectOption>}
          <NativeSelectOption value="other">another sealed step…</NativeSelectOption>
        </NativeSelect>
      </Field>
      {g.kind === "step" && (
        <div className="grid gap-2">
          {g.step !== "grade/overlap" && g.step !== "grade/judge" && <Input placeholder="the step (sealed: true)" value={g.step} onChange={(e) => props.set({ ...g, step: e.target.value })} />}
          <Textarea
            className="min-h-16 font-mono text-xs"
            placeholder={g.step === "grade/overlap" ? '{ "min": 0.7 }' : g.step === "grade/judge" ? '{ "rubric": "The answer passes when …" }' : "{ } its config"}
            value={g.config}
            onChange={(e) => props.set({ ...g, config: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}
