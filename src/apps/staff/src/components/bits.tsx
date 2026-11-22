import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errorText, initialsOf, type Place } from "../lib/view";

export function Section(props: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-3", props.className)}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-bold">{props.title}</h2>
        {props.aside && <div className="ml-auto flex flex-wrap items-center gap-2">{props.aside}</div>}
      </div>
      {props.children}
    </section>
  );
}

export function Label(props: { children: ReactNode; title?: string }) {
  return (
    <div className="text-xs font-semibold text-muted-foreground" title={props.title}>
      {props.children}
    </div>
  );
}

/** A refusal or a failure, in its words. */
export function ErrorLine(props: { error: unknown; className?: string }) {
  if (!props.error) return null;
  return (
    <div className={cn("flex items-start gap-2 rounded-[var(--peel-r-card)] border border-[color-mix(in_srgb,var(--peel-destructive)_28%,transparent)] bg-[color-mix(in_srgb,var(--peel-destructive)_7%,transparent)] px-3 py-2.5 text-sm text-destructive", props.className)} role="alert">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words">{errorText(props.error)}</span>
    </div>
  );
}

export function Loading(props: { children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 text-xs text-muted-foreground" role="status">
      <span className="peel-spinner" aria-hidden /> {props.children ?? "Reading…"}
    </div>
  );
}

export function Empty(props: { children: ReactNode }) {
  return <p className="rounded-[var(--peel-r-card)] bg-[var(--peel-panel)] px-3 py-5 text-center text-sm text-muted-foreground">{props.children}</p>;
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
        <span className={typeof value === "string" ? "text-[color:var(--peel-confirmed)]" : ""}>{JSON.stringify(value)}</span>
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

/** A picture at the size `className` gives it; a click shows it full size
 *  over the page, and a click or Esc closes that. */
export function Picture(props: { src: string; alt: string; className?: string }) {
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);
  return (
    <>
      <button type="button" className="w-fit max-w-full cursor-zoom-in" onClick={() => setFull(true)} title="Full size">
        <img alt={props.alt} src={props.src} className={props.className} />
      </button>
      {full && (
        <button type="button" className="fixed inset-0 z-50 grid cursor-zoom-out place-items-center bg-black/80 p-4" onClick={() => setFull(false)} aria-label="Close">
          <img alt={props.alt} src={props.src} className="max-h-full max-w-full" />
        </button>
      )}
    </>
  );
}

/** A small figure: a label over a number. */
export function Figure(props: { label: string; value: ReactNode; title?: string; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-0.5", props.className)} title={props.title}>
      <Label>{props.label}</Label>
      <div className="text-[17px] font-semibold tabular-nums">{props.value}</div>
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
        className="h-7 w-56 rounded-[var(--peel-r-control)] border bg-background px-2 text-xs"
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

/** A filter as a pill: pressed is the one in force; `count` beside its words. */
export function Chip(props: { on: boolean; onClick: () => void; children: ReactNode; count?: number | undefined }) {
  return (
    <button
      type="button"
      aria-pressed={props.on}
      onClick={props.onClick}
      className={cn("inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] font-medium", props.on ? "border-transparent bg-primary text-primary-foreground" : "hover:bg-[var(--peel-hover)]")}
    >
      {props.children}
      {props.count !== undefined && <span className={cn("font-normal tabular-nums", !props.on && "text-muted-foreground")}>{props.count.toLocaleString("en-US")}</span>}
    </button>
  );
}

/** Two or three views of one thing, one shown at a time. */
export function Segmented<T extends string>(props: { label: string; value: T; onChange: (v: T) => void; options: ReadonlyArray<{ value: T; label: string }> }) {
  return (
    <div role="group" aria-label={props.label} className="inline-flex rounded-[var(--peel-r-control)] bg-[var(--peel-panel)] p-0.5">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === props.value}
          onClick={() => props.onChange(o.value)}
          className={cn("h-7 rounded-[5px] px-3 text-[13px] font-medium", o.value === props.value ? "bg-[var(--peel-card)] text-foreground" : "text-muted-foreground hover:text-foreground")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** One number a person reads at a glance: the number, what it counts, and a line under it. */
export function Stat(props: { value: ReactNode; label: string; note?: ReactNode; title?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" title={props.title}>
      <div className="text-[24px] leading-tight font-semibold tabular-nums">{props.value}</div>
      <div className="text-[13px] font-semibold">{props.label}</div>
      {props.note && <div className="text-xs text-muted-foreground">{props.note}</div>}
    </div>
  );
}

/** A person as two letters in a circle (no pictures of workers here). */
export function Avatar(props: { name: string; className?: string }) {
  return (
    <span aria-hidden className={cn("grid size-8 shrink-0 place-items-center rounded-full bg-[var(--peel-panel)] text-xs font-semibold", props.className)}>
      {initialsOf(props.name)}
    </span>
  );
}

/** A count beside a tab's or a heading's words. */
export function Count(props: { n: number; warn?: boolean; label?: string }) {
  return (
    <span
      aria-label={props.label}
      className={cn("inline-grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums", props.warn ? "bg-[color-mix(in_srgb,var(--peel-attention)_20%,transparent)] text-[color:var(--peel-attention)]" : "bg-muted text-foreground")}
    >
      {props.n.toLocaleString("en-US")}
    </span>
  );
}

/** Where a page is, each step back a link. */
export function Crumbs(props: { go: (p: Place) => void; to: Array<[string, Place]>; here: string }) {
  return (
    <nav aria-label="Where this is" className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
      {props.to.map(([label, place]) => (
        <span key={label} className="flex min-w-0 items-center gap-1.5">
          <button type="button" className="text-left break-words underline underline-offset-2 hover:text-foreground" onClick={() => props.go(place)}>
            {label}
          </button>
          <ChevronRight aria-hidden className="size-3.5 shrink-0" />
        </span>
      ))}
      <span className="break-words text-foreground">{props.here}</span>
    </nav>
  );
}
