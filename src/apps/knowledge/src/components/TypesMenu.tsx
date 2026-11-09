// "Types ▾" over the graph: each node type with a tick when the graph shows
// it; a click turns it on or off (the menu stays open for the next). Opens
// under its button; a click away or Escape closes it.
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { typePlural, type OntologyType } from "../lib/ontology";
import { Dot } from "./bits";

export function TypesMenu({ types, hidden, onHidden }: { types: OntologyType[]; hidden: ReadonlySet<string>; onHidden: (next: Set<string>) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const shown = types.filter((t) => !hidden.has(t.type));
  const toggle = (type: string) => {
    const next = new Set(hidden);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    onHidden(next);
  };
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn("flex h-9 items-center gap-2 rounded-md border bg-background/95 px-3 text-sm shadow hover:bg-muted/60", hidden.size > 0 && "border-primary/50")}
        data-testid="types-menu"
      >
        <span className="flex -space-x-0.5">
          {shown.slice(0, 5).map((t) => (
            <Dot key={t.type} type={t.type} className="ring-2 ring-background" />
          ))}
        </span>
        Types
        {hidden.size > 0 && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {shown.length} of {types.length}
          </span>
        )}
        <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-[calc(100%+0.25rem)] z-30 w-60 rounded-lg border bg-popover p-1 shadow-lg">
          <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Show on the graph</p>
          {types.map((t) => {
            const on = !hidden.has(t.type);
            return (
              <button
                key={t.type}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                onClick={() => toggle(t.type)}
                className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted", !on && "text-muted-foreground")}
              >
                <Check className={cn("size-3.5 shrink-0", on ? "opacity-100" : "opacity-0")} />
                <Dot type={t.type} className={cn(!on && "opacity-40")} />
                <span className="flex-1">{typePlural(t.type)}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{t.count.toLocaleString()}</span>
              </button>
            );
          })}
          {hidden.size > 0 && (
            <div className="mt-1 border-t px-1 pt-1">
              <button type="button" onClick={() => onHidden(new Set())} className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
                Show all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
