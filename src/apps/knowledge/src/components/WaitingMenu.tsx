// "Waiting N" over the graph: the Concepts with a change waiting on a person
// or a claim refuted, without opening every page. A row opens its Concept;
// a click away or Escape closes the list.
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { waitingWords, type Waiting } from "../lib/learning";
import { Dot } from "./bits";
import { TREE_TYPE } from "../lib/tree";

export function WaitingMenu({ waiting, onOpen }: { waiting: readonly Waiting[]; onOpen: (w: Waiting) => void }) {
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
  const changes = waiting.some((w) => w.changes > 0);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn("flex h-9 items-center gap-1.5 rounded-md border bg-background/95 px-2.5 text-sm shadow hover:bg-muted/60", changes && "border-amber-500/60")}
        title="Concepts with a change waiting on you or a claim that does not hold"
        data-testid="waiting-menu"
      >
        <Inbox className="size-4 text-muted-foreground" />
        Waiting
        <span className="tabular-nums text-xs text-muted-foreground">{waiting.length}</span>
        <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-[calc(100%+0.25rem)] z-30 max-h-80 w-72 overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg" data-testid="waiting-list">
          {waiting.map((w) => (
            <button
              key={w.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onOpen(w);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              data-testid="waiting-row"
            >
              <Dot type={TREE_TYPE} />
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              <span className={cn("shrink-0 text-xs tabular-nums", w.changes ? "text-amber-700 dark:text-amber-300" : "text-rose-700 dark:text-rose-300")}>{waitingWords(w)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
