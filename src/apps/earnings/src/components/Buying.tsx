import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useStrutClient } from "@strut/kit";
import { fmtUsd } from "@strut/kit/folds";
import { Button } from "@/components/ui/button";
import type { HeldAtSeller } from "../lib/types";
import { Section } from "./bits";

/** The credit this server BOUGHT at other strut servers (plans/paid-runs.md
 *  §10): per seller what is left, what is held for runs, a purchase still
 *  being paid (Drop, when the seller will never answer). Buying is not a
 *  button: it is an accepted `remote/buy-credit` proposal. */
export function Buying() {
  const client = useStrutClient();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["earnings", "remote"], queryFn: () => client.run<{ sellers: HeldAtSeller[] }>("earnings/remote-credit", { balance: true }) });
  const [said, setSaid] = useState<string | null>(null);
  const drop = async (seller: string) => {
    setSaid(null);
    try {
      await client.run("earnings/drop-purchase", { seller });
      void qc.invalidateQueries({ queryKey: ["earnings", "remote"] });
    } catch (err) {
      setSaid(err instanceof Error ? err.message : String(err));
    }
  };
  const sellers = q.data?.sellers ?? [];
  return (
    <Section title="Credit bought at other servers">
      {q.error && <p className="text-sm text-destructive">{q.error instanceof Error ? q.error.message : String(q.error)}</p>}
      {q.data && sellers.length === 0 && <p className="text-sm text-muted-foreground">This server holds no credit at another strut server.</p>}
      {sellers.map((s) => (
        <div key={s.seller} className="flex flex-col gap-1 rounded-md border p-3 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="font-medium">{hostOf(s.seller)}</span>
            {s.balance?.remaining_usd !== undefined && <span>{fmtUsd(s.balance.remaining_usd)} left</span>}
            {!!s.balance?.held_usd && <span className="text-muted-foreground">{fmtUsd(s.balance.held_usd)} held for runs</span>}
            {s.credit && <span className="text-muted-foreground">bought {fmtUsd(s.credit.usd)} · ends {s.credit.expires.slice(0, 10)}</span>}
            {s.runs > 0 && <span className="text-muted-foreground">{s.runs} run{s.runs === 1 ? "" : "s"} waiting</span>}
          </div>
          {s.balance?.error && <div className="text-xs text-muted-foreground">The seller: {s.balance.error}</div>}
          {s.balance?.expired && <div className="text-xs text-muted-foreground">The credit there has ended.</div>}
          {s.purchase && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span>Buying {fmtUsd(s.purchase.usd)}{s.purchase.sent ? ", paid, waiting for the seller" : ""}{s.purchase.lastError ? ` — ${s.purchase.lastError}` : ""}.</span>
              <Button size="xs" variant="ghost" onClick={() => void drop(s.seller)}>Drop</Button>
            </div>
          )}
        </div>
      ))}
      {said && <p className="text-sm text-destructive">{said}</p>}
      <p className="text-xs text-muted-foreground">
        To buy credit at another server, ask the assistant: it proposes the purchase, and an admin accepts it.
      </p>
    </Section>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host + new URL(url).pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
};
