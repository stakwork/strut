import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Loader2, Play, Square } from "lucide-react";
import { isInFlight, useCancel, useLaunch, useRuns, useWorkflow, type LaunchResult, type RunSummary } from "@strut/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { errorText, fmtTime } from "../lib/format";
import { RunStatus } from "./RunStatus";

/** One field of a workflow's `input:` block (src/input-block.ts). */
export interface InputField {
  type: "string" | "number" | "boolean" | "json";
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface LaunchFormProps {
  /** A routine: a workflow the importing app's `grants.workflows` names. */
  workflow: string;
  /** The `input:` block to draw, instead of reading it (`run/workflow`). */
  fields?: Record<string, InputField>;
  /** Values to start the form with. */
  initial?: Record<string, unknown>;
  /** What makes two launches the same run (`run/launch { key }`): a launch
   *  while a run under the same key is in flight joins it instead of
   *  starting another (plans/apps.md §5.1). By default the workflow and the
   *  input, so a double click is one run and a different input is another. */
  dedupe?: string | ((input: Record<string, unknown>) => string);
  /** The button's text. */
  label?: string;
  onLaunched?: (result: LaunchResult, input: Record<string, unknown>) => void;
  className?: string;
}

/** A stable text for a value: object keys sorted, so `{a,b}` and `{b,a}` are one key. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

function initialValue(f: InputField, given: unknown): string | boolean {
  const v = given !== undefined ? given : f.default;
  if (f.type === "boolean") return v === true;
  if (v === undefined || v === null) return "";
  return f.type === "json" ? JSON.stringify(v, null, 2) : String(v);
}

/**
 * A routine's face (plans/apps.md §5.1): the workflow's `input:` block as a
 * form, a button bound to `useLaunch` with a dedupe key, the in-flight run
 * a launch joined, and the last run's status. A workflow with no `input:`
 * block takes its input as JSON. Launching is a click — nothing here
 * launches on a render, a refetch or a poll.
 */
export function LaunchForm({ workflow, fields: given, initial, dedupe, label = "Run", onLaunched, className }: LaunchFormProps) {
  const info = useWorkflow(workflow, { enabled: !given });
  const fields = (given ?? (info.data?.input as Record<string, InputField> | undefined)) ?? null;
  const runs = useRuns(workflow, { limit: 1, live: true });
  const last: RunSummary | undefined = runs.data?.[0];
  const { launch, pending, error, data } = useLaunch(workflow);
  const { cancel, pending: cancelling } = useCancel();

  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [raw, setRaw] = useState(() => (initial ? JSON.stringify(initial, null, 2) : "{}"));
  const [problem, setProblem] = useState<string | null>(null);
  const known = useMemo(() => (fields ? Object.keys(fields).join(",") : ""), [fields]);
  useEffect(() => {
    if (!fields) return;
    setValues(Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, initialValue(f, initial?.[k])])));
    // Once per block: a refetch that returns the same block keeps what was typed.
  }, [known]);

  /** The input as the workflow takes it, or the first problem with it. */
  const read = (): Record<string, unknown> | string => {
    if (!fields) {
      try {
        const v = JSON.parse(raw || "{}");
        return v && typeof v === "object" && !Array.isArray(v) ? v : "the input is a JSON object";
      } catch (e) {
        return `the input is not JSON: ${errorText(e)}`;
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(fields)) {
      const v = values[k];
      const required = f.required ?? f.default === undefined;
      if (f.type === "boolean") {
        out[k] = v === true;
        continue;
      }
      const text = typeof v === "string" ? v : "";
      if (!text.trim()) {
        if (required) return `${k} is required`;
        continue;
      }
      if (f.type === "number") {
        const n = Number(text);
        if (!Number.isFinite(n)) return `${k} is a number`;
        out[k] = n;
      } else if (f.type === "json") {
        try {
          out[k] = JSON.parse(text);
        } catch (e) {
          return `${k} is not JSON: ${errorText(e)}`;
        }
      } else {
        out[k] = text;
      }
    }
    return out;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const input = read();
    if (typeof input === "string") return setProblem(input);
    setProblem(null);
    const key = typeof dedupe === "function" ? dedupe(input) : dedupe ?? `${workflow}:${stable(input)}`;
    const result = await launch(input, undefined, key).catch(() => null);
    if (result) onLaunched?.(result, input);
  };

  if (!given && info.isPending) return <Skeleton className={cn("h-32 w-full", className)} />;
  const running = last && isInFlight(last) ? last : undefined;
  return (
    <form onSubmit={submit} className={cn("flex flex-col gap-3 text-sm", className)} data-testid="launch-form">
      {info.data?.description && !given && <p className="text-muted-foreground">{info.data.description}</p>}
      {info.isError && !given && <p className="text-destructive">{errorText(info.error)}</p>}
      {fields ? (
        Object.entries(fields).map(([k, f]) => {
          const id = `launch-${workflow}-${k}`;
          const required = f.required ?? f.default === undefined;
          return (
            <div key={k} className="grid gap-1.5">
              {f.type === "boolean" ? (
                <div className="flex items-center gap-2">
                  <Switch id={id} checked={values[k] === true} onCheckedChange={(c) => setValues((v) => ({ ...v, [k]: c }))} />
                  <Label htmlFor={id}>{k}</Label>
                </div>
              ) : (
                <>
                  <Label htmlFor={id}>
                    {k}
                    {required && <span className="text-destructive">*</span>}
                  </Label>
                  {f.type === "json" ? (
                    <Textarea id={id} className="font-mono text-xs" rows={4} value={String(values[k] ?? "")} onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))} />
                  ) : (
                    <Input id={id} type={f.type === "number" ? "number" : "text"} value={String(values[k] ?? "")} onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))} />
                  )}
                </>
              )}
              {f.description && <p className="text-xs text-muted-foreground">{f.description}</p>}
            </div>
          );
        })
      ) : (
        <div className="grid gap-1.5">
          <Label htmlFor={`launch-${workflow}-raw`}>Input (JSON)</Label>
          <Textarea id={`launch-${workflow}-raw`} className="font-mono text-xs" rows={4} value={raw} onChange={(e) => setRaw(e.target.value)} />
        </div>
      )}
      {(problem || error) && <p className="text-destructive">{problem ?? errorText(error)}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <Play />}
          {label}
        </Button>
        {running && (
          <Button type="button" variant="outline" disabled={cancelling} onClick={() => void cancel(workflow, running.runId)}>
            <Square />
            Cancel
          </Button>
        )}
        {data?.existing && <span className="text-xs text-muted-foreground" data-testid="launch-joined">Already running — joined run {data.runId}</span>}
        {data && !data.existing && <span className="text-xs text-muted-foreground">Started run {data.runId}</span>}
      </div>
      {last && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Last run</span>
          <RunStatus status={last.status} />
          <span className="font-mono">{last.runId}</span>
          <span>{fmtTime(last.startedAt)}</span>
        </div>
      )}
    </form>
  );
}
