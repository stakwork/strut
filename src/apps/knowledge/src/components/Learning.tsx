// What waits on a person: the CHANGES to a Concept the dream proposed, each
// drawn over the page as it is now (strut/views' ConceptDiff) and decided
// here (`proposal/decide`). What the page's readers are held to is ./Checks.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Lightbulb, Loader2, RotateCcw, X } from "lucide-react";
import { useStrutClient } from "@strut/kit";
import { ConceptDiff } from "strut/views";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PendingChange } from "../lib/learning";
import { SectionLabel } from "./bits";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The changes to this Concept that wait on a person. `wide`: drawn open. */
export function ChangesSection({ changes, wide, onWide }: { changes: readonly PendingChange[]; wide: boolean; onWide: (wide: boolean) => void }) {
  if (!changes.length) return null;
  return (
    <section className="space-y-2" data-testid="concept-changes">
      <SectionLabel>
        Waiting on you <span className="tabular-nums">{changes.length}</span>
      </SectionLabel>
      {changes.map((p) => (
        <ChangeCard key={p.id} change={p} wide={wide} onWide={onWide} />
      ))}
    </section>
  );
}

function ChangeCard({ change, wide, onWide }: { change: PendingChange; wide: boolean; onWide: (wide: boolean) => void }) {
  const client = useStrutClient();
  const qc = useQueryClient();
  // Open, the change is drawn over the page (its title and rationale with it); closed, the two in a line.
  const [open, setOpen] = useState(wide);
  const [deciding, setDeciding] = useState<"accept" | "reject" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Accepted and failed: it may be accepted again once the cause is fixed; a reject no longer applies.
  const failed = change.status === "failed";
  const decide = async (action: "accept" | "reject") => {
    setDeciding(action);
    setNote(null);
    try {
      const out = await client.run<{ status: string; result?: { error?: string } }>("proposal/decide", { id: change.id, action });
      if (out.status === "failed") setNote(`It could not be made: ${out.result?.error ?? "the step failed"}`);
      // An accepted change moves the tree, the page and its claims: read it all again.
      await (out.status === "applied" ? qc.invalidateQueries() : qc.invalidateQueries({ queryKey: ["knowledge", "changes"] }));
    } catch (err) {
      setNote(errorText(err));
    } finally {
      setDeciding(null);
    }
  };
  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="concept-change">
      {open ? (
        <ConceptDiff proposal={change.id} />
      ) : (
        <div className="flex items-start gap-2">
          <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <div className="min-w-0 space-y-0.5">
            <p className="break-words text-sm font-medium">{change.title}</p>
            {change.rationale && <p className="break-words text-xs italic text-muted-foreground">{change.rationale}</p>}
          </div>
        </div>
      )}
      {failed && !note && <p className="text-xs text-rose-700 dark:text-rose-300">Accepting it failed: the change was not made.</p>}
      {note && <p className="text-xs text-rose-700 dark:text-rose-300">{note}</p>}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => {
            if (!open && !wide) onWide(true);
            setOpen(!open);
          }}
          className="flex items-center gap-1 whitespace-nowrap rounded px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={open}
        >
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          {open ? "Less" : "See the change"}
        </button>
        <span className="flex-1" />
        {!failed && (
          <Button size="sm" variant="ghost" className="h-7 text-rose-700 dark:text-rose-300" disabled={deciding !== null} onClick={() => void decide("reject")} data-testid="change-reject">
            {deciding === "reject" ? <Loader2 className="animate-spin" /> : <X />}
            Reject
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-7 text-emerald-700 dark:text-emerald-300" disabled={deciding !== null} onClick={() => void decide("accept")} data-testid="change-accept">
          {deciding === "accept" ? <Loader2 className="animate-spin" /> : failed ? <RotateCcw /> : <Check />}
          {failed ? "Accept again" : "Accept"}
        </Button>
      </div>
    </div>
  );
}
