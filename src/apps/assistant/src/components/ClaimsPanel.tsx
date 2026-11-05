// A job's claims (plans/job-claims.md §7; Hive's claims viewer): what the
// work must deliver and whether it does — each claim's status, its latest
// verdict, its checks and how each did, and, when one waits on a person's
// look, what to look at with "It does" / "It doesn't" right there. Those
// waiting come first. Verify runs every check on the job's newest turn
// (`job/verify`, detached: the verdicts arrive on `job/updates`); a person's
// verdict is `job/evidence`.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, ShieldCheck, X } from "lucide-react";
import { useJobUpdates, useStrutClient } from "@strut/kit";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { checkWords, claimPill, openSlot, sortClaims, type ClaimPill } from "../lib/jobs";
import type { LedgerClaim } from "../lib/types";
import { Notice, errorText } from "./bits";

const PILL: Record<ClaimPill, string> = {
  supported: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300",
  refuted: "bg-rose-500/10 text-rose-700 ring-rose-500/20 dark:text-rose-300",
  stale: "bg-amber-500/10 text-amber-700 ring-amber-500/20 dark:text-amber-300",
  unknown: "bg-muted text-muted-foreground ring-border",
  "needs a look": "bg-amber-500/10 text-amber-700 ring-amber-500/20 dark:text-amber-300",
};

const HINT: Record<ClaimPill, string> = {
  supported: "The newest verdict, on the newest turn, supports it.",
  refuted: "A verdict on the newest turn refutes it.",
  stale: "The verdict is about an earlier turn: verify to check the newest one.",
  unknown: "Never verified.",
  "needs a look": "Only a person can tell: look, then say whether it does.",
};

export function ClaimsPanel({ job, claims, runId }: { job: string; claims: LedgerClaim[]; runId: string }) {
  const client = useStrutClient();
  const qc = useQueryClient();
  const [verifying, setVerifying] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "muted" | "error"; text: string } | null>(null);
  const { updates } = useJobUpdates(job, { enabled: verifying !== null });
  const reread = () => qc.invalidateQueries({ queryKey: ["assistant", "job-view", job] });

  // A detached verify ends with `verify` done after it began.
  useEffect(() => {
    if (!verifying) return;
    if (updates.some((u) => u.kind === "verify" && u.state === "done" && u.at >= verifying)) {
      setVerifying(null);
      setNote({ tone: "muted", text: "Verified." });
      void reread();
    }
  }, [updates, verifying]);

  const verify = async () => {
    setNote(null);
    try {
      setVerifying(new Date().toISOString());
      await client.run("job/verify", { job, detach: true });
    } catch (err) {
      setVerifying(null);
      setNote({ tone: "error", text: errorText(err) });
    }
  };

  const answer = async (claim: LedgerClaim, supports: boolean) => {
    setBusy(claim.id);
    setNote(null);
    try {
      const slot = openSlot(claim);
      await client.run("job/evidence", {
        job,
        claim: claim.id,
        runId,
        supports,
        content: supports ? "A person looked: it does." : "A person looked: it does not.",
        ...(slot ? { slot } : {}),
      });
      await reread();
    } catch (err) {
      setNote({ tone: "error", text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const verdicts = verifying ? updates.filter((u) => u.kind === "evidence" && u.at >= verifying) : [];
  return (
    <div className="rounded-md border" data-testid="claims-panel">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <ShieldCheck className="size-3.5 text-muted-foreground" />
        <span className="flex-1 text-sm font-medium">What it must do</span>
        <Button size="sm" variant="outline" className="h-7" disabled={verifying !== null} onClick={() => void verify()}>
          {verifying ? <Loader2 className="animate-spin" /> : null}
          {verifying ? `Verifying${verdicts.length ? ` · ${verdicts.length}` : ""}…` : "Verify"}
        </Button>
      </div>
      <ul className="divide-y">
        {sortClaims(claims).map((c) => {
          const pill = claimPill(c);
          return (
            <li key={c.id} className="space-y-1 px-3 py-2">
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 text-sm">{c.text}</span>
                <span title={HINT[pill]} className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset", PILL[pill])}>
                  {pill}
                </span>
              </div>
              {c.latest?.content && <p className="text-xs text-muted-foreground">{c.latest.content}</p>}
              {c.checks.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {c.checks.map((k) => [k.name, checkWords(k.lastVerify)].filter(Boolean).join(": ")).join(" · ")}
                </p>
              )}
              {pill === "needs a look" && (
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" className="h-7 text-emerald-700" disabled={busy !== null} onClick={() => void answer(c, true)}>
                    <Check /> It does
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-rose-700" disabled={busy !== null} onClick={() => void answer(c, false)}>
                    <X /> It doesn't
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
    </div>
  );
}
