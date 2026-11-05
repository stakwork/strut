// Small pieces every card shares: a status pill, an icon button with its
// label as a tooltip, a quiet notice line, a copy button.
import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Tone } from "../lib/jobs";

export const TONE: Record<Tone, string> = {
  running: "bg-sky-500/10 text-sky-700 ring-sky-500/20 dark:text-sky-300",
  ok: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300",
  attention: "bg-amber-500/10 text-amber-700 ring-amber-500/20 dark:text-amber-300",
  failed: "bg-rose-500/10 text-rose-700 ring-rose-500/20 dark:text-rose-300",
  muted: "bg-muted text-muted-foreground ring-border",
  merged: "bg-violet-500/10 text-violet-700 ring-violet-500/20 dark:text-violet-300",
};

export function Pill({ tone, children, title, spin }: { tone: Tone; children: ReactNode; title?: string; spin?: boolean }) {
  return (
    <span
      title={title}
      className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none ring-1 ring-inset", TONE[tone])}
    >
      {spin && <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

export function IconButton({
  label,
  onClick,
  children,
  disabled,
  className,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Notice({ tone = "muted", children }: { tone?: "muted" | "warn" | "error"; children: ReactNode }) {
  return (
    <p
      role={tone === "muted" ? undefined : "status"}
      className={cn(
        "rounded-md px-3 py-2 text-xs",
        tone === "warn" && "bg-amber-500/10 text-amber-800 dark:text-amber-200",
        tone === "error" && "bg-rose-500/10 text-rose-700 dark:text-rose-300",
        tone === "muted" && "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

/** A thrown step's message, as a person reads it. */
export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^step_run refused: /, "");

/** Text onto the clipboard. A framed page may be denied the clipboard API
 *  (its frame's `allow` decides), so a selected textarea and `copy` is the
 *  fallback, which a click allows. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}

/** Copies `text`; a check for a moment once it did. */
export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={done ? "Copied" : label}
      className={cn("size-6 [&_svg]:size-3.5", className)}
      onClick={() =>
        void copyText(text).then((ok) => {
          if (!ok) return;
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? <Check /> : <Copy />}
    </IconButton>
  );
}
