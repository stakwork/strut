import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Check, Loader2, SkipForward, X } from "lucide-react";
import { answerOf, fieldsOf, formProblem, initialContent, type FormField, type FormSchema, type WorkerTask } from "@strut/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { errorText } from "../lib/format";
import { refusalText, useWorkerWords } from "../lib/words";

export interface TaskFormProps {
  /** The task in hand (`useTask().task`): its `answer` schema is the form. */
  task: Pick<WorkerTask, "lease" | "answer">;
  /** Sends the answer: `useTask().submit`. No Submit button without it. */
  onSubmit?: (answer: Record<string, unknown>) => Promise<unknown> | unknown;
  /** An answer given, drawn in the form READ ONLY (plans/human-steps.md
   *  §9.5: staff reading what a worker answered): every field disabled, no
   *  buttons. */
  readOnly?: boolean;
  value?: Record<string, unknown>;
  /** Passes on the task: `useTask().skip`. No Skip button without it. */
  onSkip?: () => Promise<unknown> | unknown;
  /** The submit button's text: "Submit" in the page's language without one. */
  label?: string;
  /** Submit stays off while this is set, and it is said above the buttons:
   *  what the answer still lacks that the form does not hold (a photo). */
  waitingFor?: string;
  /** The buttons as a bar held at the bottom of the screen, wide, as a phone
   *  page draws them (`WorkerTask` does); else a row under the fields. */
  bar?: boolean;
  className?: string;
}

/** A string field with room to write in: no `maxLength`, or a long one. */
const long = (schema: FormSchema, name: string) => {
  const max = schema.properties?.[name]?.maxLength;
  return max === undefined || max > 120;
};

/** A number field with a short whole range (a 1–5 rating): its values, to tap. */
const scaleOf = (schema: FormSchema, name: string): number[] | undefined => {
  const p = schema.properties?.[name];
  if (p?.type !== "integer" || p.minimum === undefined || p.maximum === undefined) return undefined;
  const n = p.maximum - p.minimum + 1;
  return Number.isInteger(p.minimum) && n >= 2 && n <= 11 ? Array.from({ length: n }, (_, i) => p.minimum! + i) : undefined;
};

/** The most choices drawn as buttons to tap; more is a select. */
const MAX_TAPPED = 6;

/** The worker's accent: what pays, and what is picked. */
export const ACCENT_BUTTON = "wk-primary disabled:opacity-50";
const PICKED = "border-ring bg-ring/10 text-foreground ring-1 ring-ring";
const CHOICE = "flex min-h-11 items-center gap-3 rounded-[9px] border bg-background px-3 text-left text-sm hover:bg-accent disabled:opacity-60";

/**
 * A task's answer as a form (plans/human-steps.md §5.3), for a task type
 * that needs no UI of its own: its answer schema's fields — text, numbers,
 * yes or no, one of a list, several of a list — drawn in schema order, the
 * answer checked against the schema before it is sent (the server checks it
 * again). Sized for a thumb: yes or no is two big buttons, a short list is
 * buttons to tap (a long one a select), a short whole range (`minimum` 1,
 * `maximum` 5) a row of numbers. A schema it cannot draw — a nested object,
 * a list of numbers such as a box on a photo — says the task type needs its
 * own UI. The page draws what the task shows (`task.show`, `useTaskFileUrl`);
 * this is only the answer.
 */
export function TaskForm({ task, onSubmit, onSkip, readOnly = false, value, label, waitingFor, bar = false, className }: TaskFormProps) {
  const w = useWorkerWords();
  const problem = useMemo(() => formProblem(task.answer), [task.answer]);
  const schema = task.answer as FormSchema;
  const fields = useMemo(() => (problem ? [] : fieldsOf(schema, { other: false })), [problem, schema]);
  const start = () => (problem ? {} : readOnly && value ? { ...value } : initialContent(schema));
  const [content, setContent] = useState<Record<string, unknown>>(start);
  const [busy, setBusy] = useState<"submit" | "skip" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A new task starts a new form; an answer shown read only follows its value.
  useEffect(() => {
    setContent(start());
    setError(null);
  }, [task.lease, readOnly ? value : undefined]);

  if (problem) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)} data-testid="task-form-custom">
        {w.needsOwnUi(problem)}
      </p>
    );
  }

  const set = (name: string, v: unknown) => setContent((c) => ({ ...c, [name]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (readOnly || !onSubmit || waitingFor) return;
    const read = answerOf(schema, content);
    if ("problem" in read) return setError(w.issue(read.issue));
    setError(null);
    setBusy("submit");
    try {
      await onSubmit(read.answer);
    } catch (err) {
      // A refusal in the worker's words: a check's reason, its code dropped.
      setError(err instanceof Error ? refusalText(err, w) || errorText(err) : errorText(err));
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

  const buttons = !readOnly && (onSubmit || onSkip) && (
    <div
      className={cn(
        "flex items-center gap-2",
        bar && "sticky bottom-0 z-10 mt-auto -mx-4 gap-3 bg-gradient-to-t from-background from-70% to-transparent px-4 pt-6 pb-[max(1rem,env(safe-area-inset-bottom))]",
      )}
    >
      {onSkip && (
        <Button type="button" disabled={busy !== null} variant={bar ? "secondary" : "outline"} size={bar ? "lg" : "default"} onClick={() => void skip()}>
          {busy === "skip" ? <Loader2 className="animate-spin" /> : <SkipForward />}
          {w.skip}
        </Button>
      )}
      {onSubmit && (
        <Button type="submit" disabled={!!waitingFor || busy !== null} size={bar ? "lg" : "default"} className={cn(bar && cn("flex-1", ACCENT_BUTTON))}>
          {busy === "submit" ? <Loader2 className="animate-spin" /> : <Check />}
          {label ?? w.submit}
        </Button>
      )}
    </div>
  );

  return (
    <form onSubmit={submit} className={cn("flex flex-col gap-5 text-sm", bar && "flex-1", className)} data-testid={readOnly ? "task-form-read-only" : "task-form"}>
      <fieldset disabled={busy !== null || readOnly} className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0">
        {fields.map((f) => (
          <Field key={f.name} field={f} long={long(schema, f.name)} scale={scaleOf(schema, f.name)} value={content[f.name]} set={(v) => set(f.name, v)} />
        ))}
        {(error || (waitingFor && !readOnly)) && (
          <p className={cn("rounded-[9px] px-3 py-2.5 text-xs", error ? "border border-destructive/30 bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")} role={error ? "alert" : undefined}>
            {error ?? waitingFor}
          </p>
        )}
      </fieldset>
      {buttons}
    </form>
  );
}

function Field({ field: f, long, scale, value, set }: { field: FormField; long: boolean; scale: number[] | undefined; value: unknown; set: (v: unknown) => void }) {
  const w = useWorkerWords();
  const id = `task-${f.name}`;
  const head = (
    <div className="grid gap-1">
      <Label htmlFor={id} id={`${id}-label`} className="text-[13px] font-semibold">
        {f.label ?? f.name}
        {f.required && <span className="text-destructive">*</span>}
      </Label>
      {f.description && <p className="text-[13px] leading-snug text-muted-foreground">{f.description}</p>}
    </div>
  );
  const wrap = (body: ReactNode) => (
    <div className="grid gap-2.5">
      {head}
      {body}
    </div>
  );
  const text = (v: string) => f.enumLabels?.[v] ?? v;
  if (f.kind === "boolean") {
    // Two buttons, none picked: a required yes-or-no is the worker's to say.
    return wrap(
      <div className="grid grid-cols-2 gap-2.5" role="radiogroup" aria-labelledby={`${id}-label`}>
        {[true, false].map((b) => (
          <button key={String(b)} type="button" role="radio" aria-checked={value === b} className={cn(CHOICE, "h-14 justify-center font-semibold", value === b && PICKED)} onClick={() => set(b)}>
            {b ? <Check className="size-5" /> : <X className="size-5" />}
            {b ? w.yes : w.no}
          </button>
        ))}
      </div>,
    );
  }
  if (f.kind === "enum" && (f.enumValues ?? []).length <= MAX_TAPPED) {
    return wrap(
      <div className="grid gap-2" role="radiogroup" aria-labelledby={`${id}-label`}>
        {(f.enumValues ?? []).map((v) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} className={cn(CHOICE, value === v && PICKED)} onClick={() => set(value === v && !f.required ? undefined : v)}>
            <Dot on={value === v} round />
            <span className="flex-1">{text(v)}</span>
          </button>
        ))}
      </div>,
    );
  }
  if (f.kind === "enum") {
    return wrap(
      <NativeSelect id={id} className="h-10 w-full rounded-[7px] text-sm" value={value === undefined ? "" : String(value)} onChange={(e) => set(e.target.value || undefined)}>
        <NativeSelectOption value="">{w.chooseOne}</NativeSelectOption>
        {(f.enumValues ?? []).map((v) => (
          <NativeSelectOption key={v} value={v}>
            {text(v)}
          </NativeSelectOption>
        ))}
      </NativeSelect>,
    );
  }
  if (f.kind === "multi") {
    const picked = new Set(Array.isArray(value) ? value.map(String) : []);
    return wrap(
      <div className="grid gap-2" role="group" aria-labelledby={`${id}-label`}>
        {(f.enumValues ?? []).map((v) => (
          <button
            key={v}
            type="button"
            role="checkbox"
            aria-checked={picked.has(v)}
            className={cn(CHOICE, picked.has(v) && PICKED)}
            onClick={() => {
              const next = new Set(picked);
              if (next.has(v)) next.delete(v);
              else next.add(v);
              set((f.enumValues ?? []).filter((x) => next.has(x)));
            }}
          >
            <Dot on={picked.has(v)} />
            <span className="flex-1">{text(v)}</span>
          </button>
        ))}
      </div>,
    );
  }
  if (f.kind === "number" && scale) {
    const n = value === undefined || value === "" ? undefined : Number(value);
    return wrap(
      <div className="flex gap-2" role="radiogroup" aria-labelledby={`${id}-label`}>
        {scale.map((v) => (
          <button key={v} type="button" role="radio" aria-checked={n === v} className={cn(CHOICE, "h-14 flex-1 justify-center px-0 text-lg font-semibold tabular-nums", n === v && PICKED)} onClick={() => set(v)}>
            {v}
          </button>
        ))}
      </div>,
    );
  }
  const shown = value === undefined || value === null ? "" : String(value);
  return wrap(
    f.kind === "string" && long ? (
      <Textarea id={id} rows={4} className="min-h-28 rounded-[7px] px-3 py-2.5 text-sm" placeholder={w.writeHere} value={shown} onChange={(e) => set(e.target.value)} />
    ) : (
      <Input
        id={id}
        className="h-10 rounded-[7px] px-3 text-sm"
        type={f.kind === "number" ? "number" : "text"}
        inputMode={f.kind === "number" ? "decimal" : undefined}
        step={f.kind === "number" ? "any" : undefined}
        value={shown}
        onChange={(e) => set(e.target.value)}
      />
    ),
  );
}

/** A choice's mark: a radio's dot, or a checkbox's tick. */
function Dot({ on, round = false }: { on: boolean; round?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-5 shrink-0 place-items-center border-2 transition-colors",
        round ? "rounded-full" : "rounded-md",
        on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
      )}
    >
      {on && (round ? <span className="size-2 rounded-full bg-primary-foreground" /> : <Check className="size-3.5" strokeWidth={3} />)}
    </span>
  );
}
