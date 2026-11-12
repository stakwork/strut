// What a Concept's readers are held to, and what waits on a person: its
// CLAIMS (each sentence, its status, the latest evidence in a line) and the
// CHANGES to it the dream proposed, each drawn over the page as it is now
// (strut/views' ConceptDiff) and decided here (`proposal/decide`). Accepting
// one is the only write this app makes.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Lightbulb, Loader2, RotateCcw, X } from "lucide-react";
import { useStrutClient } from "@strut/kit";
import { ConceptDiff } from "strut/views";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { usePage } from "../lib/read";
import { byStatus, CLAIM_STATUS, claimsUnavailable, evidenceLine, type ClaimStatus, type PendingChange } from "../lib/learning";
import { SectionLabel } from "./bits";

const TONE: Record<ClaimStatus, string> = {
  supported: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  refuted: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  stale: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  unknown: "text-muted-foreground",
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The claims on the Concept `name` (`id`, so a namesake elsewhere never lends it its claims). */
export function ClaimsSection({ id, name }: { id: string; name: string }) {
  const q = usePage(name);
  if (q.isLoading) return <Skeleton className="h-10" />;
  if (q.isError) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="claims-unavailable">
        {claimsUnavailable(errorText(q.error))}
      </p>
    );
  }
  if (!q.data || q.data.ref_id !== id) return null;
  const claims = [...q.data.claims].sort(byStatus);
  return (
    <section className="space-y-1.5" data-testid="concept-claims">
      <SectionLabel>
        Held to <span className="tabular-nums">{claims.length || ""}</span>
      </SectionLabel>
      {!claims.length && <p className="text-xs text-muted-foreground">No claims on this page yet.</p>}
      <ul className="space-y-2">
        {claims.map((c) => {
          const s = CLAIM_STATUS[c.status] ?? CLAIM_STATUS.unknown;
          const line = evidenceLine(c.latest);
          return (
            <li key={c.id} className="space-y-0.5" data-testid="concept-claim" data-status={c.status}>
              <div className="flex items-start gap-2">
                <span className={cn("mt-0.5 shrink-0 rounded border px-1.5 text-[11px]", TONE[c.status] ?? TONE.unknown)} title={s.means}>
                  {s.label}
                </span>
                <span className="min-w-0 break-words text-sm">{c.text}</span>
              </div>
              {line && <p className="break-words pl-1 text-xs text-muted-foreground">{line}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

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
