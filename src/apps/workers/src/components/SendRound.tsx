// Send a round: for a ROUND type (one saved with `round: { workflow }`), its
// workflow launched as the admin with the items they tick — all of them by
// default, one to test ("send Bean There only"). The items are the
// workflow's own list (`staff/round-items`), and the dialog says what the
// round can cost at most: each item a task at the type's pay.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { fmtSats, fmtUsd, usdOfMsat } from "@strut/kit/folds";
import { useStrutClient } from "@strut/kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { fmtWhen } from "../lib/view";
import type { Books, RoundInfo, TaskType } from "../lib/types";
import { ErrorLine, Loading, Note, useAct } from "./bits";

/** The round's items and its last round, read once the dialog or a note needs them. */
export function useRound(type: TaskType | undefined) {
  const client = useStrutClient();
  return useQuery({
    queryKey: ["staff", "round", type?.name],
    queryFn: () => client.run<RoundInfo>("staff/round-items", { type: type!.name }),
    enabled: !!type?.round,
  });
}

/** The type page's line on its rounds: the workflow, and the last one sent. */
export function RoundNote(props: { type: TaskType }) {
  const round = useRound(props.type);
  const last = round.data?.last;
  return (
    <Note>
      Rounds: one task for each item the workflow {props.type.round!.workflow} sends.{" "}
      {round.data ? (last ? `Last round: ${fmtWhen(last.at)}, ${last.tasks} task${last.tasks === 1 ? "" : "s"}.` : "None sent yet.") : ""}
    </Note>
  );
}

/** [ Send a round ] and its dialog. `small`: the Queue row's. */
export function SendRound(props: { type: TaskType; small?: boolean; onSent?: (runId: string) => void }) {
  const [open, setOpen] = useState(false);
  // The Queue's rows open the type's page: nothing here does — the dialog
  // too, whose clicks reach the row through React's tree from its portal.
  return (
    <span className="contents" onClick={(e) => e.stopPropagation()}>
      <Button type="button" size={props.small ? "sm" : "default"} variant={props.small ? "outline" : "default"} onClick={() => setOpen(true)}>
        <Send /> Send a round
      </Button>
      {open && <RoundDialog type={props.type} onClose={() => setOpen(false)} {...(props.onSent ? { onSent: props.onSent } : {})} />}
    </span>
  );
}

function RoundDialog(props: { type: TaskType; onClose: () => void; onSent?: (runId: string) => void }) {
  const client = useStrutClient();
  const round = useRound(props.type);
  // The wallet's rate and balance, as the Queue reads them.
  const books = useQuery({ queryKey: ["staff", "books"], queryFn: () => client.run<Books>("earnings/read", { by: "total", days: 1, wallet: true }) });
  /** Unticked items, by index: all are ticked to start. */
  const [off, setOff] = useState<Set<number>>(new Set());
  const [sent, setSent] = useState<string | null>(null);
  const { act, busy, error } = useAct();
  const items = round.data?.items ?? [];
  const picked = items.filter((_, i) => !off.has(i));
  // A workflow with no list of its own: its defaults decide how many.
  const n = round.data?.input ? picked.length : undefined;
  const payMsat = Math.round((props.type.paySats ?? 0) * 1000);
  const costMsat = (n ?? 0) * payMsat;
  const rate = books.data?.wallet?.rate;
  const balance = books.data?.wallet?.balance?.msat;
  const cost = !payMsat ? "unpaid" : `${rate ? `${fmtUsd(usdOfMsat(costMsat, rate))} (${fmtSats(costMsat)})` : fmtSats(costMsat)} at most`;
  const toggle = (i: number) =>
    setOff((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const send = async () => {
    const input = round.data?.input && off.size ? { [round.data.input]: picked.map((p) => p.value) } : undefined;
    const r = await act("send", () => client.run<{ runId: string }>("staff/send-round", { type: props.type.name, ...(input ? { input } : {}) }));
    if (r) {
      setSent(r.runId);
      props.onSent?.(r.runId);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a round of {props.type.name}</DialogTitle>
          <DialogDescription>
            One task for each item ticked, made by the workflow {props.type.round?.workflow}. Workers see them on the worker page at once.
          </DialogDescription>
        </DialogHeader>
        {round.error ? (
          <ErrorLine error={round.error} />
        ) : !round.data ? (
          <Loading>Reading the round's items…</Loading>
        ) : sent ? (
          <p className="text-sm" role="status">
            Sent{n !== undefined ? `: ${n} task${n === 1 ? "" : "s"} on their way` : ""}. They show in the Queue as the run makes them.
          </p>
        ) : items.length === 0 ? (
          <Note>The workflow lists no items of its own: a round sends what its defaults send.</Note>
        ) : (
          <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-md border p-2" aria-label="Items">
            {items.map((item, i) => (
              <li key={i}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted/60">
                  <Checkbox checked={!off.has(i)} onCheckedChange={() => toggle(i)} aria-label={item.label} />
                  <span>{item.label}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {round.data && !sent && n !== undefined && (
          <p className={cn("text-sm", balance !== undefined && costMsat > balance && "text-destructive")} data-testid="round-cost">
            {n} task{n === 1 ? "" : "s"} · {cost}
            {balance !== undefined && costMsat > balance ? ` — more than the wallet's ${fmtSats(balance)}` : ""}
          </p>
        )}
        {error ? <ErrorLine error={error} /> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onClose}>
            {sent ? "Close" : "Cancel"}
          </Button>
          {!sent && (
            <Button type="button" onClick={() => void send()} disabled={!round.data || n === 0 || busy === "send"}>
              <Send /> {n === undefined ? "Send the round" : `Send ${n} task${n === 1 ? "" : "s"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
