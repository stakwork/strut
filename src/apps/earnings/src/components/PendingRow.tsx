import { useState } from "react";
import { useStrutClient } from "@strut/kit";
import { fmtSats, withdrawRefusal } from "@strut/kit/folds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { decidesByHand, pendingState, type PendingSend } from "../lib/view";
import type { PaymentAnswer } from "../lib/types";

/** One send still out: where it stands; read it now; once stale (or sent
 *  through a wallet no longer set) record it as paid or drop it. */
export function PendingRow(props: { p: PendingSend; onChanged: () => void }) {
  const { p } = props;
  const client = useStrutClient();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [fee, setFee] = useState("");
  const [confirm, setConfirm] = useState<"paid" | "drop" | null>(null);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setSaid(null);
    try {
      await fn();
      props.onChanged();
    } catch (err) {
      setSaid(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };
  const read = () =>
    act(async () => {
      const r = await client.run<PaymentAnswer>("earnings/withdrawal-read", { paymentHash: p.paymentHash });
      setSaid(
        r.ok
          ? r.state === "settled"
            ? `Settled: recorded, fee ${fmtSats(r.feeMsat)}.`
            : r.state === "failed"
              ? `It failed: ${r.error ?? "nothing was paid"}.`
              : r.reading
                ? "The wallet has not answered yet: still reading."
                : `Still on its way${r.error ? `: ${r.error}` : ""}.`
          : withdrawRefusal(r),
      );
    });
  const resolve = (action: "paid" | "drop") =>
    act(async () => {
      const sats = Number(fee);
      await client.run("earnings/withdrawal-resolve", {
        paymentHash: p.paymentHash,
        action,
        ...(action === "paid" && fee.trim() && Number.isFinite(sats) && sats >= 0 ? { feeMsat: Math.round(sats * 1000) } : {}),
      });
    });
  const decide = decidesByHand(p);
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-medium">{fmtSats(p.msat)}{p.purpose === "purchase" ? " · credit" : ""}</span>
        <span className="text-muted-foreground">{pendingState(p)}</span>
        <span className="ml-auto text-xs text-muted-foreground">{new Date(p.at).toLocaleString()}</span>
      </div>
      {p.lastError && <div className="text-xs text-muted-foreground">Last read: {p.lastError}</div>}
      <div className="flex flex-wrap items-center gap-2">
        {!p.otherWallet && <Button size="sm" variant="outline" disabled={busy || p.reading} onClick={() => void read()}>Read it now</Button>}
        {decide && !confirm && (
          <>
            <Input className="h-8 w-28" type="number" min="0" step="1" placeholder="fee, sats" value={fee} onChange={(e) => setFee(e.target.value)} />
            <Button size="sm" variant="outline" disabled={busy || p.reading} onClick={() => setConfirm("paid")}>Record as paid</Button>
            <Button size="sm" variant="ghost" disabled={busy || p.reading} onClick={() => setConfirm("drop")}>Drop</Button>
          </>
        )}
        {confirm && (
          <>
            <span>{confirm === "paid" ? `Record ${fmtSats(p.msat)} as paid out? Only if it left the wallet.` : "Forget it? Nothing goes in the books."}</span>
            <Button size="sm" disabled={busy} onClick={() => void resolve(confirm)}>{confirm === "paid" ? "Record" : "Drop"}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button>
          </>
        )}
        {said && <span className="text-muted-foreground">{said}</span>}
      </div>
    </div>
  );
}
