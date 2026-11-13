// Tests (plans/human-steps.md §7.1, §9.7, item 4): a type's tests — what a
// worker is shown, the answer staff know, how it is graded — with how often
// each was served, passed and failed; a test with each instance served and
// what its grader said. Read and written only through the `staff/*` steps:
// the expected answer and a grader's note stay behind the test routes, and
// no read of them is ever kept as a run. A test that was served is never
// edited: retire it and make another, so each grade was against what that
// worker saw.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Upload } from "lucide-react";
import { formProblem } from "@strut/kit/folds";
import { useStrutClient } from "@strut/kit";
import { TaskForm } from "strut/views";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { gradeDraftOf, gradeOf, type GradeDraft } from "../lib/draft";
import { fmtWhen, jsonLine, jsonText, parseJson, shortActor, STATUS_WORDS, type Place } from "../lib/view";
import type { GradeRule, TaskType, Test, TestInstance } from "../lib/types";
import { Back, Empty, ErrorLine, Field, JsonTree, Loading, Note, Section, useAct } from "./bits";
import { GradeEditor } from "./Types";

interface Props {
  go: (p: Place) => void;
  place: Place;
  types?: TaskType[];
}

export function Tests(props: Props) {
  const [making, setMaking] = useState(false);
  if (props.place.test) return <TestDetail {...props} id={props.place.test} />;
  if (making) return <NewTest {...props} onDone={(id) => { setMaking(false); if (id) props.go({ tab: "tests", test: id }); }} />;
  return <TestList {...props} onNew={() => setMaking(true)} />;
}

const gradeWords = (g: GradeRule | undefined, type?: TaskType) => {
  const own = g ?? type?.tests?.grade ?? "equal";
  return `${own === "equal" ? "equal" : own.step}${g ? "" : " (the type's)"}`;
};

function TestList(props: Props & { onNew: () => void }) {
  const client = useStrutClient();
  const [type, setType] = useState(props.place.type ?? "");
  const [retired, setRetired] = useState(false);
  const q = useQuery({
    queryKey: ["staff", "tests", type, retired],
    queryFn: () => client.run<{ tests: Test[] }>("staff/tests", { ...(type ? { type } : {}), retired }),
  });
  const kinds = new Map((props.types ?? []).map((t) => [t.name, t]));
  const tested = (props.types ?? []).filter((t) => t.tests);
  return (
    <Section
      title="Tests"
      aside={
        <Button size="sm" onClick={props.onNew} disabled={!props.types?.length}>
          <Plus /> New test
        </Button>
      }
    >
      <Note>
        A test is a task whose answer you know, mixed in among a type's real tasks to score its workers. {tested.length ? `Tests are on for ${tested.map((t) => t.name).join(", ")}.` : "No type has tests on yet: turn them on in a type's editor."}
      </Note>
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect aria-label="Type" value={type} onChange={(e) => setType(e.target.value)}>
          <NativeSelectOption value="">Every type</NativeSelectOption>
          {(props.types ?? []).map((t) => (
            <NativeSelectOption key={t.name} value={t.name}>
              {t.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <label className="flex items-center gap-1.5 text-sm">
          <Checkbox checked={retired} onCheckedChange={(c) => setRetired(c === true)} /> retired
        </label>
      </div>
      {q.error ? (
        <ErrorLine error={q.error} />
      ) : !q.data ? (
        <Loading>Reading tests…</Loading>
      ) : q.data.tests.length === 0 ? (
        <Empty>No {retired ? "retired " : ""}test here.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Shows</TableHead>
                <TableHead>Expected</TableHead>
                <TableHead>Graded by</TableHead>
                <TableHead className="text-right" title="Served · passed · failed · grader errors">Served · pass · fail · err</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.tests.map((x) => (
                <TableRow key={x.id} className="cursor-pointer" onClick={() => props.go({ tab: "tests", test: x.id })}>
                  <TableCell>{x.type}</TableCell>
                  <TableCell className="max-w-48 truncate font-mono text-xs">{jsonLine(x.show, 48)}</TableCell>
                  <TableCell className="max-w-48 truncate font-mono text-xs">{jsonLine(x.expected, 48)}</TableCell>
                  <TableCell className="text-xs">{gradeWords(x.grade, kinds.get(x.type))}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {x.served} · {x.passed} · {x.failed} · {x.errors}
                  </TableCell>
                  <TableCell>{x.retired ? <Badge variant="outline">retired</Badge> : x.ready ? <Badge variant="secondary">ready</Badge> : <Badge variant="outline">files missing</Badge>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Section>
  );
}

/** The expected answer: the type's form when its shape draws as one, else JSON. */
function ExpectedEditor(props: { type?: TaskType; text: string; set: (text: string) => void }) {
  const drawable = props.type && !formProblem(props.type.answer);
  const [form, setForm] = useState(!!drawable);
  return (
    <div className="flex flex-col gap-2">
      {drawable && (
        <div className="flex gap-1">
          <Button type="button" size="xs" variant={form ? "secondary" : "ghost"} onClick={() => setForm(true)}>
            Form
          </Button>
          <Button type="button" size="xs" variant={!form ? "secondary" : "ghost"} onClick={() => setForm(false)}>
            JSON
          </Button>
        </div>
      )}
      {form && drawable ? (
        <div className="rounded-md border p-3">
          <TaskForm task={{ lease: `expected-${props.type!.name}`, answer: props.type!.answer }} onSubmit={(a) => props.set(jsonText(a))} label="Use as the expected answer" />
          {props.text && <pre className="mt-2 rounded bg-muted p-2 font-mono text-xs">{props.text}</pre>}
        </div>
      ) : (
        <Textarea aria-label="Expected answer" className="min-h-24 font-mono text-xs" value={props.text} onChange={(e) => props.set(e.target.value)} placeholder='{ "same": true }' />
      )}
    </div>
  );
}

/** A test's own grade, or the type's. */
function OwnGrade(props: { own: boolean; setOwn: (b: boolean) => void; g: GradeDraft; set: (g: GradeDraft) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-1.5 text-sm">
        <Checkbox checked={props.own} onCheckedChange={(c) => props.setOwn(c === true)} /> its own grader (else the type's)
      </label>
      {props.own && <GradeEditor label="Graded by" g={props.g} set={props.set} />}
    </div>
  );
}

function NewTest(props: Props & { onDone: (id?: string) => void }) {
  const client = useStrutClient();
  const { act, busy, error } = useAct();
  const [typeName, setTypeName] = useState(props.place.type ?? props.types?.find((t) => t.tests)?.name ?? props.types?.[0]?.name ?? "");
  const [show, setShow] = useState("{}");
  const [files, setFiles] = useState("");
  const [expected, setExpected] = useState("");
  const [own, setOwn] = useState(false);
  const [g, setG] = useState<GradeDraft>(gradeDraftOf("equal"));
  const type = props.types?.find((t) => t.name === typeName);
  const shown = parseJson(show);
  const exp = parseJson(expected);
  const grade = own ? gradeOf(g, "the grader") : undefined;
  const problem =
    "problem" in shown ? `what it shows: ${shown.problem}` : !expected.trim() ? "give the expected answer" : "problem" in exp ? `the expected answer: ${exp.problem}` : grade && typeof grade === "object" && "problem" in grade ? grade.problem : undefined;
  const create = () =>
    void act("create", () =>
      client.run<{ test: Test }>("staff/save-test", {
        type: typeName,
        show: "value" in shown ? shown.value : {},
        ...(files.trim() ? { files: files.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
        expected: "value" in exp ? exp.value : null,
        ...(grade ? { grade } : {}),
      }),
    ).then((r) => r && props.onDone(r.test.id));
  return (
    <div className="flex flex-col gap-4">
      <Back onClick={() => props.onDone()}>Tests</Back>
      <h2 className="text-base font-semibold">New test</h2>
      <Field label="Type">
        <NativeSelect value={typeName} onChange={(e) => setTypeName(e.target.value)}>
          {(props.types ?? []).map((t) => (
            <NativeSelectOption key={t.name} value={t.name}>
              {t.name}
              {t.tests ? "" : " (tests off)"}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Field label="What the worker is shown" hint="JSON, as a human step's show: a worker cannot tell a test from a real task.">
        <Textarea className="min-h-24 font-mono text-xs" value={show} onChange={(e) => setShow(e.target.value)} />
      </Field>
      <Field label="Its files" hint="Paths, comma-separated; put each file on the test's page. It is served once every one is there.">
        <Input value={files} onChange={(e) => setFiles(e.target.value)} placeholder="photo.jpg" />
      </Field>
      <Field label="The expected answer" hint="Checked against the type's answer shape when saved.">
        <ExpectedEditor type={type} text={expected} set={setExpected} />
      </Field>
      <OwnGrade own={own} setOwn={setOwn} g={g} set={setG} />
      <div className="flex items-center gap-2">
        <Button disabled={!!problem || busy !== null || !typeName} onClick={create}>
          Make the test
        </Button>
        {problem && <span className="text-sm text-muted-foreground">{problem}</span>}
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

function TestDetail(props: Props & { id: string }) {
  const client = useStrutClient();
  const { act, busy, error } = useAct();
  const q = useQuery({ queryKey: ["staff", "test", props.id], queryFn: () => client.run<{ test: Test; instances: TestInstance[] }>("staff/test", { id: props.id }) });
  const [editing, setEditing] = useState<{ show: string; expected: string; own: boolean; g: GradeDraft } | null>(null);
  const back = <Back onClick={() => props.go({ tab: "tests" })}>Tests</Back>;
  if (q.error) return (<div className="flex flex-col gap-3">{back}<ErrorLine error={q.error} /></div>);
  if (!q.data) return <Loading>Reading the test…</Loading>;
  const { test: x, instances } = q.data;
  const type = props.types?.find((t) => t.name === x.type);
  const fixed = x.served > 0 || x.retired !== undefined;
  const missing = new Set(x.missing ?? (x.ready ? [] : x.files));
  const save = () => {
    if (!editing) return;
    const show = parseJson(editing.show);
    const expected = parseJson(editing.expected);
    if ("problem" in show || "problem" in expected) return;
    const grade = editing.own ? gradeOf(editing.g, "the grader") : null;
    if (grade && typeof grade === "object" && "problem" in grade) return;
    void act("save", () => client.run("staff/save-test", { id: x.id, show: show.value, expected: expected.value, grade })).then((r) => r && setEditing(null));
  };
  const upload = (path: string, file: File) =>
    void act("file", async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return client.run("staff/test-file", { id: x.id, path, base64: btoa(bin) });
    });

  return (
    <div className="flex flex-col gap-5">
      {back}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">A test of {x.type}</h2>
        {x.retired ? <Badge variant="outline">retired</Badge> : x.ready ? <Badge variant="secondary">ready</Badge> : <Badge variant="outline">files missing</Badge>}
        <span className="font-mono text-xs text-muted-foreground">{x.id}</span>
      </div>
      <Note>
        Made {fmtWhen(x.created)}
        {x.createdBy ? ` by ${x.createdBy}` : ""}
        {x.fromTask ? " from a task" : ""} · served {x.served} · passed {x.passed} · failed {x.failed} · grader errors {x.errors}
        {x.retired ? ` · retired ${fmtWhen(x.retired)}${x.retiredBy ? ` by ${x.retiredBy}` : ""}` : ""}
      </Note>
      {x.fromTask && (
        <button type="button" className="w-fit text-sm underline underline-offset-2" onClick={() => props.go({ tab: "tasks", task: x.fromTask })}>
          The task it was made from
        </button>
      )}

      {editing ? (
        <Section title="Change it" aside={<Note>Only before it is first served</Note>}>
          <Field label="What the worker is shown">
            <Textarea className="min-h-24 font-mono text-xs" value={editing.show} onChange={(e) => setEditing({ ...editing, show: e.target.value })} />
          </Field>
          <Field label="The expected answer">
            <ExpectedEditor type={type} text={editing.expected} set={(expected) => setEditing({ ...editing, expected })} />
          </Field>
          <OwnGrade own={editing.own} setOwn={(own) => setEditing({ ...editing, own })} g={editing.g} set={(g) => setEditing({ ...editing, g })} />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy !== null} onClick={save}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </Section>
      ) : (
        <>
          <Section title="What the worker is shown">
            <div className="rounded-md border p-2">
              <JsonTree value={x.show} />
            </div>
          </Section>
          <Section title="The expected answer" aside={<Note>Graded by {gradeWords(x.grade, type)}</Note>}>
            <div className="rounded-md border p-2">
              <JsonTree value={x.expected} />
            </div>
          </Section>
        </>
      )}

      {x.files.length > 0 && (
        <Section title="Its files">
          <ul className="flex flex-col gap-1 text-sm">
            {x.files.map((path) => (
              <li key={path} className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{path}</span>
                {missing.has(path) ? <Badge variant="outline">missing</Badge> : <Badge variant="secondary">there</Badge>}
                {!fixed && (
                  <label className="inline-flex cursor-pointer items-center gap-1 text-xs underline underline-offset-2">
                    <Upload className="size-3" /> {missing.has(path) ? "Put it" : "Replace"}
                    <input type="file" className="hidden" onChange={(e) => e.target.files?.[0] && upload(path, e.target.files[0])} />
                  </label>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {!x.retired && (
        <div className="flex flex-wrap items-center gap-2">
          {!fixed && !editing && (
            <Button size="sm" variant="outline" onClick={() => setEditing({ show: jsonText(x.show), expected: jsonText(x.expected), own: !!x.grade, g: gradeDraftOf(x.grade) })}>
              Change it
            </Button>
          )}
          {x.served > 0 && <Note>Served {x.served} time{x.served === 1 ? "" : "s"}: it is never changed. Retire it and make another.</Note>}
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act("retire", () => client.run("staff/retire-test", { id: x.id }))}>
            Retire
          </Button>
        </div>
      )}
      <ErrorLine error={error} />

      <Section title="Served">
        {instances.length === 0 ? (
          <Note>Not served yet.</Note>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>To</TableHead>
                  <TableHead>Served</TableHead>
                  <TableHead>How it closed</TableHead>
                  <TableHead>Answer</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead>What the grader said</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {instances.map((i) => (
                  <TableRow key={i.task}>
                    <TableCell>
                      <button type="button" className="underline-offset-2 hover:underline" onClick={() => props.go({ tab: "workers", worker: i.worker })}>
                        {shortActor(i.worker)}
                      </button>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{fmtWhen(i.served)}</TableCell>
                    <TableCell>{STATUS_WORDS[i.status]}</TableCell>
                    <TableCell className="max-w-48 truncate font-mono text-xs">{i.answer !== undefined ? jsonLine(i.answer, 48) : "—"}</TableCell>
                    <TableCell>{i.grade ? <Badge variant={i.grade === "pass" ? "secondary" : i.grade === "fail" ? "destructive" : "outline"}>{i.grade}</Badge> : i.status === "settled" ? "pending" : "—"}</TableCell>
                    <TableCell className="max-w-72 text-xs">{i.note ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>
    </div>
  );
}
