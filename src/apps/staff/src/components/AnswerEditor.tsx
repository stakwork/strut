// The answer's shape in the type editor (plans/human-steps.md §9.5): fields,
// JSON, and a preview of what a worker sees when the app has no view of its
// own. It writes only what the store checks: `modelProblem` runs the kit's
// `answerSchemaProblem` on every change.
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { answerSchemaProblem } from "@strut/kit/folds";
import { TaskForm } from "strut/views";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { KINDS, KIND_LABELS, modelOf, modelProblem, newField, parseOptions, schemaOf, withKind, type AnswerModel, type FieldModel, type Kind, type ValueModel } from "../lib/schema";
import { Note } from "./bits";

type Mode = "fields" | "json" | "preview";

export function AnswerEditor(props: { model: AnswerModel | null; json: string; onChange: (model: AnswerModel | null, json: string) => void; disabled?: boolean }) {
  const { model, json } = props;
  const [mode, setMode] = useState<Mode>(model ? "fields" : "json");
  const [tried, setTried] = useState<unknown>(undefined);
  const setModel = (m: AnswerModel) => props.onChange(m, JSON.stringify(schemaOf(m), null, 2));
  const problem = model ? modelProblem(model) : jsonProblem(json);
  const schema = useMemo(() => (model ? schemaOf(model) : parsed(json)), [model, json]);

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-1">
        {(["fields", "json", "preview"] as const).map((m) => (
          <Button key={m} type="button" size="xs" variant={mode === m ? "secondary" : "ghost"} onClick={() => setMode(m)} disabled={m === "fields" && !model}>
            {m === "fields" ? "Fields" : m === "json" ? "JSON" : "Preview"}
          </Button>
        ))}
        {!model && <Note className="ml-2">This shape stays in JSON: the fields cannot draw it (an enum on an object, a list of groups, null, or a keyword a kind does not write).</Note>}
      </div>

      {mode === "fields" && model && (
        <fieldset disabled={props.disabled} className="m-0 flex flex-col gap-3 border-0 p-0">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>The answer is</span>
            <NativeSelect
              value={model.form ? "form" : "value"}
              onChange={(e) => {
                // One value becomes a form of one field, and a form's first field the one value.
                if (e.target.value === "form" && !model.form) setModel({ form: true, fields: [{ ...model.value, key: "answer", required: true }] });
                if (e.target.value === "value" && model.form) setModel({ form: false, value: stripKey(model.fields[0] ?? newField("text", [])) });
              }}
            >
              <NativeSelectOption value="form">a form of fields</NativeSelectOption>
              <NativeSelectOption value="value">one value (a box on a photo: four numbers)</NativeSelectOption>
            </NativeSelect>
            {!model.form && (
              <NativeSelect aria-label="The value's kind" value={model.value.kind} onChange={(e) => setModel({ form: false, value: stripKey(withKind({ ...model.value, key: "answer", required: true }, e.target.value as Kind)) })}>
                {KINDS.map((k) => (
                  <NativeSelectOption key={k} value={k}>
                    {KIND_LABELS[k]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </div>
          {model.form ? (
            <FieldList fields={model.fields} onChange={(fields) => setModel({ ...model, fields })} depth={1} />
          ) : (
            <ValueEditor value={model.value} onChange={(value) => setModel({ form: false, value })} depth={1} />
          )}
        </fieldset>
      )}

      {mode === "json" && (
        <Textarea
          aria-label="The answer's shape as JSON"
          className="min-h-48 font-mono text-xs"
          value={json}
          disabled={props.disabled}
          onChange={(e) => {
            const text = e.target.value;
            const v = parsed(text);
            // A shape the fields draw goes back to them; any other stays JSON.
            props.onChange(v !== undefined && !answerSchemaProblem(v) ? modelOf(v) : null, text);
          }}
        />
      )}

      {mode === "preview" && (
        <div className="flex flex-col gap-2">
          <Note>What a worker sees when the app has no view of its own (TaskForm). Try it: nothing is sent.</Note>
          {schema !== undefined ? <TaskForm task={{ lease: `preview-${json.length}`, answer: schema as never }} onSubmit={(a) => setTried(a)} label="Try it" /> : <Note>Not JSON yet.</Note>}
          {tried !== undefined && <pre className="rounded bg-muted p-2 font-mono text-xs">{JSON.stringify(tried)}</pre>}
        </div>
      )}

      {problem && <p className="text-sm text-destructive" data-testid="answer-problem">{problem}</p>}
    </div>
  );
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function jsonProblem(text: string): string | undefined {
  const v = parsed(text);
  return v === undefined ? "not JSON yet" : answerSchemaProblem(v);
}

const stripKey = (f: FieldModel): ValueModel => {
  const { key: _k, required: _r, ...v } = f;
  return v;
};

function FieldList(props: { fields: FieldModel[]; onChange: (f: FieldModel[]) => void; depth: number }) {
  const [kind, setKind] = useState<Kind>("text");
  const { fields } = props;
  const set = (i: number, f: FieldModel) => props.onChange(fields.map((x, j) => (j === i ? f : x)));
  const move = (i: number, by: number) => {
    const next = [...fields];
    const [f] = next.splice(i, 1);
    next.splice(i + by, 0, f!);
    props.onChange(next);
  };
  return (
    <div className="flex flex-col gap-2">
      {fields.map((f, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-md border bg-muted/30 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label="Key" className="h-8 w-36 font-mono text-xs" value={f.key} onChange={(e) => set(i, { ...f, key: e.target.value.trim() })} placeholder="key" />
            <NativeSelect aria-label="Kind" className="h-8" value={f.kind} onChange={(e) => set(i, withKind(f, e.target.value as Kind))}>
              {KINDS.filter((k) => k !== "group" || props.depth < 7).map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {KIND_LABELS[k]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <label className="flex items-center gap-1.5 text-xs">
              <Checkbox checked={f.required} onCheckedChange={(c) => set(i, { ...f, required: c === true })} /> required
            </label>
            <div className="ml-auto flex gap-1">
              <Button type="button" variant="ghost" size="icon-xs" title="Up" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp />
              </Button>
              <Button type="button" variant="ghost" size="icon-xs" title="Down" disabled={i === fields.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown />
              </Button>
              <Button type="button" variant="ghost" size="icon-xs" title="Remove" onClick={() => props.onChange(fields.filter((_, j) => j !== i))}>
                <Trash2 />
              </Button>
            </div>
          </div>
          <ValueEditor value={f} onChange={(v) => set(i, { ...f, ...v, key: f.key, required: f.required })} depth={props.depth} />
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect aria-label="New field's kind" className="h-8" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {KINDS.filter((k) => k !== "group" || props.depth < 7).map((k) => (
            <NativeSelectOption key={k} value={k}>
              {KIND_LABELS[k]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button type="button" size="sm" variant="outline" onClick={() => props.onChange([...fields, newField(kind, fields.map((f) => f.key))])}>
          <Plus /> Add field
        </Button>
      </div>
    </div>
  );
}

/** One value's own settings: its labels and what its kind takes. */
function ValueEditor(props: { value: ValueModel; onChange: (v: ValueModel) => void; depth: number }) {
  const v = props.value;
  const set = (patch: Partial<ValueModel>) => props.onChange({ ...v, ...patch });
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <Input aria-label="Label" className="h-8 text-xs" placeholder="Label (what the worker reads)" value={v.title ?? ""} onChange={(e) => set({ title: e.target.value || undefined })} />
        <Input aria-label="Help" className="h-8 text-xs" placeholder="Help (a line under it)" value={v.description ?? ""} onChange={(e) => set({ description: e.target.value || undefined })} />
      </div>
      {v.kind === "text" && <Bounds a="minLength" b="maxLength" labels={["Shortest", "Longest"]} v={v} set={set} />}
      {(v.kind === "number" || v.kind === "integer") && <Bounds a="minimum" b="maximum" labels={["Least", "Most"]} v={v} set={set} />}
      {(v.kind === "one" || v.kind === "several") && (
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect aria-label="Options are" className="h-8" value={v.optionType ?? "string"} onChange={(e) => set({ optionType: e.target.value as ValueModel["optionType"], options: [] })}>
            <NativeSelectOption value="string">text options</NativeSelectOption>
            <NativeSelectOption value="number">number options</NativeSelectOption>
            <NativeSelectOption value="integer">whole number options</NativeSelectOption>
          </NativeSelect>
          <OptionsInput value={v} onChange={(options) => set({ options })} />
        </div>
      )}
      {(v.kind === "several" || v.kind === "numbers") && <Bounds a="minItems" b="maxItems" labels={["Fewest", "Most"]} v={v} set={set} />}
      {v.kind === "group" && (
        <div className="ml-3 border-l pl-3">
          <FieldList fields={v.fields ?? []} onChange={(fields) => set({ fields })} depth={props.depth + 1} />
        </div>
      )}
    </div>
  );
}

function Bounds(props: { a: keyof ValueModel; b: keyof ValueModel; labels: [string, string]; v: ValueModel; set: (p: Partial<ValueModel>) => void }) {
  const box = (k: keyof ValueModel, label: string) => (
    <label className="flex items-center gap-1.5 text-xs">
      {label}
      <Input
        type="number"
        className="h-8 w-24"
        value={props.v[k] === undefined ? "" : String(props.v[k])}
        onChange={(e) => props.set({ [k]: e.target.value === "" ? undefined : Number(e.target.value) } as Partial<ValueModel>)}
      />
    </label>
  );
  return (
    <div className="flex flex-wrap gap-3">
      {box(props.a, props.labels[0])}
      {box(props.b, props.labels[1])}
    </div>
  );
}

/** Options as a comma-separated list, kept as typed until it reads. */
function OptionsInput(props: { value: ValueModel; onChange: (o: Array<string | number>) => void }) {
  const joined = (props.value.options ?? []).join(", ");
  const [text, setText] = useState(joined);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    // The list changed elsewhere (a kind switched): show it.
    if (parseKey(text, props.value.optionType) !== joined) setText(joined);
  }, [joined]);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <Input
        aria-label="Options"
        className={cn("h-8 text-xs", problem && "border-destructive")}
        placeholder="Options, comma-separated"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const read = parseOptions(e.target.value, props.value.optionType ?? "string");
          if (Array.isArray(read)) {
            setProblem(null);
            props.onChange(read);
          } else setProblem(read.problem);
        }}
      />
      {problem && <span className="text-xs text-destructive">{problem}</span>}
    </div>
  );
}

const parseKey = (text: string, type: ValueModel["optionType"]) => {
  const read = parseOptions(text, type ?? "string");
  return Array.isArray(read) ? read.join(", ") : null;
};
