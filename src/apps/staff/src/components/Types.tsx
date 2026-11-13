// Types (plans/human-steps.md §9.5): the task types, New type, and the
// editor — name (a new type only), the app that draws it and what is wrong
// with it, the lease and expiry, on or off, open or invite-only (ruling 9:
// a paid open type needs its K ready tests), the answer's shape, and, when
// the server answers for them (§9.7), its pay (5a), its tests and copies
// (4). Save is `staff/save-type`, the whole type; Delete only with no task
// open. Below, the workers who hold it, with Revoke and Grant.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Save, Trash2 } from "lucide-react";
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
import { liveTypes, OPEN_GRANT_BY, openPayHint, standingText, typeNameProblem, whoOf, type Place, type Shown } from "../lib/view";
import type { TaskStats, TaskType, Worker } from "../lib/types";
import { AnswerEditor } from "./AnswerEditor";
import { Back, Empty, ErrorLine, Field, Loading, Note, ReasonButton, Section, useAct } from "./bits";

interface Props {
  go: (p: Place) => void;
  place: Place;
  shown: Shown;
  types?: TaskType[];
  workers?: Worker[];
  error: unknown;
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
    <Section
      title="Task types"
      aside={
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus /> New type
        </Button>
      }
    >
      {props.types.length === 0 ? (
        <Empty>No task types yet. A type names the app that draws its tasks and the shape of an answer; a workflow's human step names the type.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>App</TableHead>
                <TableHead>On</TableHead>
                {props.shown.open && <TableHead>Who takes it</TableHead>}
                <TableHead className="text-right">Waiting</TableHead>
                <TableHead className="text-right">Workers</TableHead>
                {props.shown.pay && <TableHead className="text-right">Pay</TableHead>}
                {props.shown.tests && <TableHead>Tests</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.types.map((t) => (
                <TableRow key={t.name} className="cursor-pointer" onClick={() => props.go({ tab: "types", type: t.name })}>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell>{t.app}</TableCell>
                  <TableCell>{t.enabled ? "on" : <Badge variant="outline">off</Badge>}</TableCell>
                  {props.shown.open && <TableCell>{t.open ? "open" : <Badge variant="outline">invite-only</Badge>}</TableCell>}
                  <TableCell className="text-right tabular-nums">{row(t.name)?.waiting ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{row(t.name)?.granted ?? "—"}</TableCell>
                  {props.shown.pay && <TableCell className="text-right tabular-nums">{t.paySats ? `${t.paySats} sats` : "unpaid"}</TableCell>}
                  {props.shown.tests && <TableCell>{t.tests ? `${Math.round(t.tests.rate * 100)}%, qualify ${t.tests.qualify}` : "off"}</TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Section>
  );
}

const openOf = (s: TaskStats | undefined, type: string) => {
  const r = s?.types.find((t) => t.type === type);
  return r ? r.waiting + r.working : 0;
};

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
        {was?.changedBy && <Note>last saved by {was.changedBy}</Note>}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {!was && (
          <Field label="Name" htmlFor="type-name" hint={d.name ? (nameProblem ?? "A saved name is fixed: a type under another name is a new type.") : "Lowercase letters, digits, “.”, “_” and “-”, segments joined by “/”."}>
            <Input id="type-name" value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="pet-match" aria-invalid={!!(d.name && nameProblem)} />
          </Field>
        )}
        <Field label="App" htmlFor="type-app" hint={appProblem ? <span className="text-destructive">{appProblem}.</span> : "The worker app whose page draws this type's tasks."}>
          <NativeSelect id="type-app" value={d.app} onChange={(e) => set({ app: e.target.value })}>
            <NativeSelectOption value="">Choose an app…</NativeSelectOption>
            {d.app && !appRow && <NativeSelectOption value={d.app}>{d.app} (not here)</NativeSelectOption>}
            {(apps.data?.apps ?? [])
              .filter((a) => !a.name.startsWith("strut/"))
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
            <Field label="Hold, hours" htmlFor="type-hold" hint="How long an earning waits before it can be withdrawn: 1 to 720. A failed test or a take-back inside it loses the earning.">
              <Input id="type-hold" type="number" min={1} max={720} value={d.holdHours} onChange={(e) => set({ holdHours: e.target.value })} />
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

      {was && (
        <Section title="Workers who hold it">
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

function Num(props: { label: string; v: string; set: (v: string) => void; hint?: string }) {
  return (
    <Field label={props.label} hint={props.hint}>
      <Input type="number" step="any" value={props.v} onChange={(e) => props.set(e.target.value)} />
    </Field>
  );
}

/** `equal`, or a sealed step and its config (§7.4): strut ships
 *  `grade/overlap` (boxes, `{ min, key }`) and `grade/judge` (a model,
 *  `{ rubric, model }`). */
export function GradeEditor(props: { label: string; g: GradeDraft; set: (g: GradeDraft) => void }) {
  const { g } = props;
  return (
    <div className="grid gap-2 md:grid-cols-[auto_1fr]">
      <Field label={props.label}>
        <NativeSelect value={g.kind === "equal" ? "equal" : g.step} onChange={(e) => props.set(e.target.value === "equal" ? { kind: "equal", step: "", config: "" } : { kind: "step", step: e.target.value === "other" ? "" : e.target.value, config: g.config })}>
          <NativeSelectOption value="equal">equal: the same JSON</NativeSelectOption>
          <NativeSelectOption value="grade/overlap">grade/overlap: boxes on an image</NativeSelectOption>
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
