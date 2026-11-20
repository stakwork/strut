import { useEffect, useState } from "react";
import { useStrutClient } from "@strut/kit";
import { fmtExpiresIn, fmtSats, fmtUsd, shortOfWorkersRefusal, withdrawRefusal, type WorkersView } from "@strut/kit/folds";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { EarningsView, InvoiceReading, PaymentAnswer } from "../lib/types";

type Wallet = NonNullable<EarningsView["wallet"]>;

/** Withdraw: a BOLT11 invoice pasted and read by the server's own reader
 *  (`earnings/read-invoice`, what strut's own dialog reads it with), the
 *  amount it asks and its fee cap confirmed, then paid — what the person
 *  confirmed is what the route checks. It cannot be taken back. Once
 *  workers are owed for accepted answers (plans/human-steps.md §8.1), the
 *  reader says when the amount would leave the wallet short of it, and the
 *  dialog REFUSES it with the reason (5a warned, 5b refuses): Review stays
 *  off, as the route's `409 short_of_workers` would refuse it. */
export function WithdrawDialog(props: { wallet: Wallet; outstandingUsd: number; workers?: WorkersView; onClose: () => void }) {
  const { wallet } = props;
  const client = useStrutClient();
  const [text, setText] = useState("");
  const [reading, setReading] = useState<InvoiceReading | null>(null);
  const [stage, setStage] = useState<"paste" | "confirm" | "paying" | "done">("paste");
  const [answer, setAnswer] = useState<PaymentAnswer | null>(null);

  useEffect(() => {
    const invoice = text.trim();
    if (!invoice) return setReading(null);
    let alive = true;
    const t = setTimeout(() => {
      client
        .run<InvoiceReading>("earnings/read-invoice", {
          invoice,
          provider: wallet.provider,
          ...(wallet.balance ? { balanceMsat: wallet.balance.msat } : {}),
          ...(wallet.rate ? { usdPerBtc: wallet.rate } : {}),
          ...(wallet.owedToWorkersMsat ? { owedToWorkersMsat: wallet.owedToWorkersMsat } : {}),
        })
        .then((r) => alive && setReading(r), (err) => alive && setReading({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [text]);

  const pay = async () => {
    if (!reading?.ok || reading.shortOfWorkers) return;
    setStage("paying");
    try {
      setAnswer(await client.run<PaymentAnswer>("earnings/withdraw", { invoice: text.trim(), msat: reading.msat, maxFeeMsat: reading.maxFeeMsat }));
    } catch (err) {
      setAnswer({ ok: false, status: 0, error: err instanceof Error ? err.message : String(err) });
    }
    setStage("done");
  };
  const askAgain = async () => {
    if (!answer?.ok) return;
    setAnswer(await client.run<PaymentAnswer>("earnings/withdrawal-read", { paymentHash: answer.paymentHash }));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && stage !== "paying" && props.onClose()}>
      <DialogContent className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>Withdraw</DialogTitle>
          <DialogDescription>
            Pay a Lightning invoice out of this wallet. It holds {wallet.balance ? fmtSats(wallet.balance.msat) : "an amount the wallet did not say"}
            {props.outstandingUsd > 0 ? `; buyers are still owed ${fmtUsd(props.outstandingUsd)} as service` : ""}
            {props.workers && props.workers.owedMsat > 0 ? `; workers are owed ${fmtSats(props.workers.owedMsat)} for accepted answers` : ""}.
          </DialogDescription>
        </DialogHeader>
        {stage === "paste" && (
          <div className="flex flex-col gap-3">
            <Textarea placeholder="lnbc… — an invoice from the wallet the sats should go to" className="h-24 w-full min-w-0 resize-none font-mono text-xs break-all [field-sizing:fixed]" value={text} onChange={(e) => setText(e.target.value)} />
            {reading && !reading.ok && reading.error && <div className="text-sm text-destructive">{reading.error}</div>}
            {reading?.ok && (
              <div className="flex flex-col gap-1 text-sm">
                <div className="text-lg font-semibold">{fmtSats(reading.msat)}{reading.usd !== undefined ? ` ≈ ${fmtUsd(reading.usd)}` : ""}</div>
                {reading.invoice.description && <div>“{reading.invoice.description}”</div>}
                <div className="text-muted-foreground">Ends {fmtExpiresIn(reading.expiresIn)} · routing fee at most {fmtSats(reading.maxFeeMsat)}</div>
                {reading.network && <div className="text-muted-foreground">A {reading.network} invoice: the wallet decides whether it pays one.</div>}
                {reading.shortOfWorkers && <div className="text-destructive" role="alert">{shortOfWorkersRefusal(reading.shortOfWorkers, reading.msat)}</div>}
                {reading.overBalance && <div className="text-destructive">More than this wallet can send.</div>}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
              <Button disabled={!reading?.ok || !!reading.shortOfWorkers} onClick={() => setStage("confirm")}>Review</Button>
            </div>
          </div>
        )}
        {stage === "confirm" && reading?.ok && (
          <div className="flex flex-col gap-3">
            <div className="text-sm">
              Pay {fmtSats(reading.msat)} out of this wallet, with a routing fee of at most {fmtSats(reading.maxFeeMsat)}?
 It cannot be taken back.
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setStage("paste")}>Back</Button>
              <Button onClick={() => void pay()}>Pay {fmtSats(reading.msat)}</Button>
            </div>
          </div>
        )}
        {stage === "paying" && <div className="text-sm text-muted-foreground">Paying… the wallet has up to a minute to answer.</div>}
        {stage === "done" && answer && (
          <div className="flex flex-col gap-3 text-sm">
            {answer.ok ? (
              answer.state === "settled" ? (
                <div>Paid {fmtSats(answer.msat)}, fee {fmtSats(answer.feeMsat)}.</div>
              ) : answer.state === "failed" ? (
                <div className="text-destructive">It failed: {answer.error ?? "nothing was paid"}.</div>
              ) : (
                <div>Sent, not settled yet{answer.error ? `: ${answer.error}` : ""}. It shows under “On their way” and is read again every minute.</div>
              )
            ) : (
              <div className="text-destructive">{withdrawRefusal(answer)}</div>
            )}
            <div className="flex justify-end gap-2">
              {answer.ok && answer.state === "pending" && <Button variant="outline" onClick={() => void askAgain()}>Ask again</Button>}
              {answer.ok && answer.state === "failed" && <Button variant="outline" onClick={() => setStage("paste")}>Try again</Button>}
              <Button onClick={props.onClose}>Done</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
