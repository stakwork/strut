import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ChevronLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errorText } from "../lib/view";

export function Section(props: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-3", props.className)}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{props.title}</h2>
        {props.aside && <div className="ml-auto flex flex-wrap items-center gap-2">{props.aside}</div>}
      </div>
      {props.children}
    </section>
  );
}

export function Label(props: { children: ReactNode; title?: string }) {
  return (
    <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase" title={props.title}>
      {props.children}
    </div>
  );
}

/** A refusal or a failure, in its words. */
export function ErrorLine(props: { error: unknown; className?: string }) {
  if (!props.error) return null;
  return (
    <div className={cn("flex items-start gap-2 rounded-md border border-destructive/40 p-3 text-sm text-destructive", props.className)} role="alert">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words">{errorText(props.error)}</span>
    </div>
  );
}

export function Loading(props: { children?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> {props.children ?? "Reading…"}
    </div>
  );
}

export function Empty(props: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{props.children}</p>;
}

/** A line of muted text. */
export function Note(props: { children: ReactNode; className?: string }) {
  return <p className={cn("text-xs text-muted-foreground", props.className)}>{props.children}</p>;
}

/** Back from a detail to its list (a phone shows one at a time). */
export function Back(props: { onClick: () => void; children?: ReactNode }) {
  return (
    <Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={props.onClick}>
      <ChevronLeft /> {props.children ?? "Back"}
    </Button>
  );
}

/** A JSON value as a tree: objects and lists fold open, values in a line. */
export function JsonTree(props: { value: unknown; name?: string; depth?: number }) {
  const { value, name } = props;
  const depth = props.depth ?? 0;
  const key = name !== undefined ? <span className="text-muted-foreground">{name}: </span> : null;
  if (value === null || typeof value !== "object") {
    return (
      <div className="font-mono text-xs break-all">
        {key}
        <span className={typeof value === "string" ? "text-emerald-700 dark:text-emerald-400" : ""}>{JSON.stringify(value)}</span>
      </div>
    );
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  const shape = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;
  return (
    <details open={depth < 2} className="font-mono text-xs">
      <summary className="cursor-pointer select-none">
        {key}
        <span className="text-muted-foreground">{shape}</span>
      </summary>
      <div className="ml-3 border-l pl-2">
        {entries.map(([k, v]) => (
          <JsonTree key={k} name={k} value={v} depth={depth + 1} />
        ))}
      </div>
    </details>
  );
}

/** One write through the door: busy while it runs, its refusal kept, the
 *  page's reads read again after it. */
export function useAct() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const act = async <T,>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(what);
    setError(null);
    try {
      const out = await fn();
      await qc.invalidateQueries({ queryKey: ["staff"] });
      return out;
    } catch (err) {
      setError(err);
      return undefined;
    } finally {
      setBusy(null);
    }
  };
  return { act, busy, error, setError };
}

/** A small figure: a label over a number. */
export function Figure(props: { label: string; value: ReactNode; title?: string; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-0.5", props.className)} title={props.title}>
      <Label>{props.label}</Label>
      <div className="text-lg font-semibold tabular-nums">{props.value}</div>
    </div>
  );
}

/** A labelled field in a form. */
export function Field(props: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <div className={cn("grid content-start gap-1.5", props.className)}>
      <label htmlFor={props.htmlFor} className="text-sm font-medium">
        {props.label}
      </label>
      {props.children}
      {props.hint && <p className="text-xs text-muted-foreground">{props.hint}</p>}
    </div>
  );
}

/** A button that asks why first (a revoke's `why`, a take-back's): it opens
 *  into a line to write the reason in, then acts. No `window.prompt`: an app
 *  frame is sandboxed without modals. */
export function ReasonButton(props: { label: string; placeholder: string; required?: boolean; disabled?: boolean; onAct: (why: string) => void; variant?: "ghost" | "outline" | "destructive" }) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  if (!open) {
    return (
      <Button size="xs" variant={props.variant ?? "ghost"} disabled={props.disabled} onClick={() => setOpen(true)}>
        {props.label}
      </Button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      <input
        autoFocus
        className="h-7 w-56 rounded-md border bg-background px-2 text-xs"
        placeholder={props.placeholder}
        value={why}
        onChange={(e) => setWhy(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <Button
        size="xs"
        variant="destructive"
        disabled={props.disabled || (props.required && !why.trim())}
        onClick={() => {
          props.onAct(why.trim());
          setOpen(false);
          setWhy("");
        }}
      >
        {props.label}
      </Button>
      <Button size="xs" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </span>
  );
}
