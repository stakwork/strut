// A change the assistant proposed (Hive's `StrutProposalCard`): what step
// it would run and with what — the card's fields, computed at proposal time
// (src/proposal-card.ts) — and the person's decision on it
// (`proposal/decide`): accept runs it, reject records why. Read live
// (`proposal/get`), since a decision made elsewhere moves it too. One only
// an admin accepts (installing a package) says so to anyone else, in place
// of an Accept the decision would refuse (lib/proposals.ts).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Lightbulb, Loader2, RotateCcw, ShieldCheck, X } from "lucide-react";
import { useStrutClient } from "@strut/kit";
import { Markdown } from "./Markdown";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Tone } from "../lib/jobs";
import type { Proposal, ProposalBrief, ProposalStatus } from "../lib/types";
import { ADMIN_MUST_APPROVE, acceptLook } from "../lib/proposals";
import { Notice, Pill, errorText } from "./bits";

const STATUS: Record<ProposalStatus, { label: string; tone: Tone }> = {
  pending: { label: "Waiting on you", tone: "attention" },
  accepted: { label: "Applying", tone: "running" },
  applied: { label: "Applied", tone: "ok" },
  rejected: { label: "Rejected", tone: "muted" },
  failed: { label: "Failed", tone: "failed" },
};

const WAITING_ON_ADMIN: { label: string; tone: Tone } = { label: "Waiting on an admin", tone: "attention" };

/** `graph/create-node` → "Graph · create node". */
export const stepLabel = (step: string) => {
  const [ns, name] = step.includes("/") ? [step.slice(0, step.indexOf("/")), step.slice(step.indexOf("/") + 1)] : ["", step];
  const words = name.replace(/[-_]/g, " ");
  return ns ? `${ns[0]!.toUpperCase()}${ns.slice(1)} · ${words}` : words;
};

export function ProposalCard({ brief }: { brief: ProposalBrief }) {
  const client = useStrutClient();
  const qc = useQueryClient();
  const key = ["assistant", "proposal", brief.id];
  const live = useQuery({ queryKey: key, queryFn: () => client.run<Proposal>("proposal/get", { id: brief.id }), staleTime: 10_000, refetchInterval: (q) => (q.state.data?.status === "accepted" ? 2_000 : false) });
  const [deciding, setDeciding] = useState<"accept" | "reject" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const p = live.data;
  const status: ProposalStatus = p?.status ?? brief.status;
  const card = p?.card ?? brief.card;
  const canDecide = status === "pending" || status === "failed";
  const accept = acceptLook(p?.approver ?? brief.approver, p?.viewer);
  const look = status === "pending" && accept === "admin" ? WAITING_ON_ADMIN : (STATUS[status] ?? STATUS.pending);

  const decide = async (action: "accept" | "reject") => {
    setDeciding(action);
    setNote(null);
    try {
      const out = await client.run<Proposal>("proposal/decide", { id: brief.id, action });
      qc.setQueryData(key, out);
    } catch (err) {
      setNote(errorText(err));
      void qc.invalidateQueries({ queryKey: key });
    } finally {
      setDeciding(null);
    }
  };

  return (
    <div
      className={cn("rounded-lg border bg-card text-card-foreground transition-opacity", (status === "applied" || status === "rejected") && "opacity-70")}
      data-testid="proposal-card"
      data-status={status}
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span className="font-medium">{stepLabel(p?.step ?? brief.step)}</span>
            <span className="ml-auto normal-case tracking-normal">
              <Pill tone={look.tone} spin={status === "accepted"}>{look.label}</Pill>
            </span>
          </div>
          <div className={cn("break-words text-sm font-medium", status === "rejected" && "line-through decoration-1")}>{card?.title ?? p?.title ?? brief.title}</div>
          {(card?.summary ?? brief.summary) && <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{card?.summary ?? brief.summary}</p>}
          {card?.fields.length ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
              {card.fields.map((f, i) => (
                <div key={i} className="contents">
                  <dt className={cn("text-muted-foreground", f.danger && "text-rose-600")}>{f.label}</dt>
                  <dd className="min-w-0 break-words">
                    {f.kind === "markdown" ? <Markdown text={f.value} className="text-xs" /> : f.kind === "code" ? <code className="whitespace-pre-wrap font-mono text-[11px]">{f.value}</code> : f.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {(p?.rationale ?? brief.rationale) && <p className="text-xs italic text-muted-foreground">{p?.rationale ?? brief.rationale}</p>}
          {p?.decision?.reason && status === "rejected" && <p className="text-xs text-muted-foreground">Reason: {p.decision.reason}</p>}
          {p?.result?.error && <p className="text-xs text-rose-700 dark:text-rose-300">{p.result.error}</p>}
          {note && <Notice tone="error">{note}</Notice>}
          {canDecide && (
            <div className="flex items-center justify-end gap-1 pt-1">
              {accept === "admin" && (
                <span className="mr-auto flex items-center gap-1 text-xs text-muted-foreground" data-testid="proposal-admin-only">
                  <ShieldCheck className="size-3.5" />
                  {ADMIN_MUST_APPROVE}
                </span>
              )}
              {accept === "accept" && (
                <Button size="sm" variant="ghost" className="h-7 text-emerald-700 dark:text-emerald-300" disabled={deciding !== null} onClick={() => void decide("accept")}>
                  {deciding === "accept" ? <Loader2 className="animate-spin" /> : status === "failed" ? <RotateCcw /> : <Check />}
                  {status === "failed" ? "Accept again" : (card?.actions.accept ?? "Approve")}
                </Button>
              )}
              {status === "pending" && (
                <Button size="sm" variant="ghost" className="h-7 text-rose-700 dark:text-rose-300" disabled={deciding !== null} onClick={() => void decide("reject")}>
                  {deciding === "reject" ? <Loader2 className="animate-spin" /> : <X />}
                  {card?.actions.reject ?? "Reject"}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
