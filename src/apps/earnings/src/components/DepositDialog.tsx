import { useEffect, useState } from "react";
import { useStrutClient } from "@strut/kit";
import { fmtSats, fmtUsd, usdOfMsat } from "@strut/kit/folds";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DEPOSIT_PRESETS, depositAmount } from "../lib/view";
import type { DepositAnswer } from "../lib/types";
import { CopyText } from "./Copy";

/** How often a shown invoice is read. */
const READ_EVERY_MS = 2_000;

/** Add sats: an amount, then the invoice as a QR code the admin pays from
 *  their own wallet, read until it settles or ends. Closing loses nothing:
 *  the server keeps reading it. */
export function DepositDialog(props: { rate?: number; onClose: () => void }) {
  const client = useStrutClient();
  const [text, setText] = useState("50000");
  const [asked, setAsked] = useState<DepositAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const amount = depositAmount(text);

  useEffect(() => {
    if (!asked || asked.state !== "pending") return;
    const t = setInterval(() => {
      client.run<DepositAnswer>("earnings/deposit-read", { paymentHash: asked.paymentHash }).then(
        (r) => setAsked((a) => (a ? { ...a, ...r, qr: a.qr } : r)),
        () => undefined,
      );
    }, READ_EVERY_MS);
    return () => clearInterval(t);
  }, [asked?.paymentHash, asked?.state]);

  const ask = async () => {
    if (!("sats" in amount)) return;
    setBusy(true);
    setError(null);
    try {
      setAsked(await client.run<DepositAnswer>("earnings/deposit", { sats: amount.sats }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add sats</DialogTitle>
          <DialogDescription>An invoice into this server's wallet, to pay from your own. Sats it may spend — never credit, never earnings.</DialogDescription>
        </DialogHeader>
        {!asked && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {DEPOSIT_PRESETS.map((s) => (
                <Button key={s} size="sm" variant={text === String(s) ? "secondary" : "outline"} onClick={() => setText(String(s))}>
                  {s.toLocaleString("en-US")}
                </Button>
              ))}
            </div>
            <Input inputMode="numeric" value={text} onChange={(e) => setText(e.target.value)} aria-label="Sats" />
            <div className="text-xs text-muted-foreground">
              {"error" in amount ? amount.error : props.rate ? `≈ ${fmtUsd(usdOfMsat(amount.sats * 1000, props.rate))}` : ""}
            </div>
            {error && <div className="text-sm text-destructive">{error}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
              <Button disabled={busy || !("sats" in amount)} onClick={() => void ask()}>Make the invoice</Button>
            </div>
          </div>
        )}
        {asked && asked.state === "pending" && asked.invoice && (
          <div className="flex flex-col items-center gap-3">
            {asked.qr && <img src={asked.qr} alt="The invoice as a QR code" className="size-56 rounded-md bg-white p-2" />}
            <div className="text-sm">{fmtSats(asked.msat)} · ends {new Date(asked.expires).toLocaleTimeString()}</div>
            <CopyText text={asked.invoice} />
            <div className="text-xs text-muted-foreground">Waiting for the payment…{asked.error ? ` (${asked.error})` : ""}</div>
          </div>
        )}
        {asked && asked.state === "settled" && (
          <div className="flex flex-col gap-3">
            <div className="text-sm">Added: {fmtSats(asked.deposit?.msat ?? asked.msat)}.</div>
            <div className="flex justify-end"><Button onClick={props.onClose}>Done</Button></div>
          </div>
        )}
        {asked && asked.state === "expired" && (
          <div className="flex flex-col gap-3">
            <div className="text-sm">The invoice ended unpaid.</div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={props.onClose}>Close</Button>
              <Button onClick={() => setAsked(null)}>Another</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
