import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, Loader2, SkipForward } from "lucide-react";
import { answerOf, fieldsOf, formProblem, initialContent, type FormField, type FormSchema, type WorkerTask } from "@strut/kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { errorText } from "../lib/format";

export interface TaskFormProps {
  /** The task in hand (`useTask().task`): its `answer` schema is the form. */
  task: Pick<WorkerTask, "lease" | "answer">;
  /** Sends the answer: `useTask().submit`. */
  onSubmit: (answer: Record<string, unknown>) => Promise<unknown> | unknown;
  /** Passes on the task: `useTask().skip`. No Skip button without it. */
  onSkip?: () => Promise<unknown> | unknown;
  /** The submit button's text. */
  label?: string;
  className?: string;
}

/** A string field with room to write in: no `maxLength`, or a long one. */
const long = (schema: FormSchema, name: string) => {
  const max = schema.properties?.[name]?.maxLength;
  return max === undefined || max > 120;
};

/**
 * A task's answer as a form (plans/human-steps.md §5.3), for a task type
 * that needs no UI of its own: its answer schema's fields — text, numbers,
 * yes or no, one of a list, several of a list — drawn in schema order, the
 * answer checked against the schema before it is sent (the server checks it
 * again). A schema it cannot draw — a nested object, a list of numbers such
 * as a box on a photo — says the task type needs its own UI. The page draws
 * what the task shows (`task.show`, `useTaskFileUrl`); this is only the answer.
 */
export function TaskForm({ task, onSubmit, onSkip, label = "Submit", className }: TaskFormProps) {
  const problem = useMemo(() => formProblem(task.answer), [task.answer]);
  const schema = task.answer as FormSchema;
  const fields = useMemo(() => (problem ? [] : fieldsOf(schema, { other: false })), [problem, schema]);
  const [content, setContent] = useState<Record<string, unknown>>(() => (problem ? {} : initialContent(schema)));
  const [busy, setBusy] = useState<"submit" | "skip" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A new task starts a new form.
  useEffect(() => {
    setContent(problem ? {} : initialContent(schema));
    setError(null);
  }, [task.lease]);

  if (problem) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)} data-testid="task-form-custom">
        This task type needs its own UI: {problem}.
      </p>
    );
  }

  const set = (name: string, v: unknown) => setContent((c) => ({ ...c, [name]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const read = answerOf(schema, content);
    if ("problem" in read) return setError(read.problem);
    setError(null);
    setBusy("submit");
    try {
      await onSubmit(read.answer);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const skip = async () => {
    if (!onSkip) return;
    setBusy("skip");
    try {
      await onSkip();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <form onSubmit={submit} className={cn("flex flex-col gap-3 text-sm", className)} data-testid="task-form">
      <fieldset disabled={busy !== null} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        {fields.map((f) => (
          <Field key={f.name} field={f} long={long(schema, f.name)} value={content[f.name]} set={(v) => set(f.name, v)} />
        ))}
        {error && <p className="text-destructive">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit">
            {busy === "submit" ? <Loader2 className="animate-spin" /> : <Check />}
            {label}
          </Button>
          {onSkip && (
            <Button type="button" variant="outline" onClick={() => void skip()}>
              {busy === "skip" ? <Loader2 className="animate-spin" /> : <SkipForward />}
              Skip
            </Button>
          )}
        </div>
      </fieldset>
    </form>
  );
}

function Field({ field: f, long, value, set }: { field: FormField; long: boolean; value: unknown; set: (v: unknown) => void }) {
  const id = `task-${f.name}`;
  const label = (
    <Label htmlFor={id}>
      {f.label ?? f.name}
      {f.required && <span className="text-destructive">*</span>}
    </Label>
  );
  const hint = f.description ? <p className="text-xs text-muted-foreground">{f.description}</p> : null;
  const text = (v: string) => f.enumLabels?.[v] ?? v;
  if (f.kind === "boolean") {
    // Two buttons, none picked: a required yes-or-no is the worker's to say.
    return (
      <div className="grid gap-1.5">
        {label}
        <div className="flex gap-2" role="radiogroup" aria-labelledby={id}>
          {[true, false].map((b) => (
            <Button key={String(b)} type="button" size="sm" variant={value === b ? "default" : "outline"} aria-pressed={value === b} onClick={() => set(b)}>
              {b ? "Yes" : "No"}
            </Button>
          ))}
        </div>
        {hint}
      </div>
    );
  }
  if (f.kind === "enum") {
    return (
      <div className="grid gap-1.5">
        {label}
        <NativeSelect id={id} value={value === undefined ? "" : String(value)} onChange={(e) => set(e.target.value || undefined)}>
          <NativeSelectOption value="">Choose…</NativeSelectOption>
          {(f.enumValues ?? []).map((v) => (
            <NativeSelectOption key={v} value={v}>
              {text(v)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {hint}
      </div>
    );
  }
  if (f.kind === "multi") {
    const picked = new Set(Array.isArray(value) ? value.map(String) : []);
    return (
      <div className="grid gap-1.5">
        {label}
        <div className="flex flex-col gap-1.5">
          {(f.enumValues ?? []).map((v) => (
            <label key={v} className="flex items-center gap-2">
              <Checkbox
                checked={picked.has(v)}
                onCheckedChange={(c) => {
                  const next = new Set(picked);
                  if (c === true) next.add(v);
                  else next.delete(v);
                  set((f.enumValues ?? []).filter((x) => next.has(x)));
                }}
              />
              <span>{text(v)}</span>
            </label>
          ))}
        </div>
        {hint}
      </div>
    );
  }
  const shown = value === undefined || value === null ? "" : String(value);
  return (
    <div className="grid gap-1.5">
      {label}
      {f.kind === "string" && long ? (
        <Textarea id={id} rows={3} value={shown} onChange={(e) => set(e.target.value)} />
      ) : (
        <Input id={id} type={f.kind === "number" ? "number" : "text"} step={f.kind === "number" ? "any" : undefined} value={shown} onChange={(e) => set(e.target.value)} />
      )}
      {hint}
    </div>
  );
}
