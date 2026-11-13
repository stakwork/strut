// strut/earnings (plans/paid-runs.md §8–§10, specs/API.md §14.14): what this
// server earned from what anyone may run here, and its Lightning wallet, for
// an ADMIN — strut's own Earnings tab as an app a host frames (Stadeum's org
// admin pages) without anyone opening strut's UI. On top the wallet: its
// balance at the rate of the moment, Add sats and Withdraw, the credit still
// owed as service, once any worker was paid what workers are owed for
// accepted answers and whether the balance covers it (plans/human-steps.md
// §8.1), the books' check and the sends still on their way. Then
// earned, cost and margin over a range, by item and by day; the credit this
// server bought at other strut servers; which wallet is set. Every call is
// an `earnings/*` step, which answers only strut's own page shown to an admin.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2, RefreshCw, Wallet } from "lucide-react";
import { useStrutClient } from "@strut/kit";
import {
  RANGES,
  byEarned,
  coverLine,
  fmtSats,
  fmtUsd,
  priceLine,
  rangeFrom,
  showsWorkers,
  subjectLabel,
  workersAcceptedLine,
  workersDayMsat,
  workersOwedSub,
  type RangeId,
  type WorkersView,
} from "@strut/kit/folds";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { addBlocked, walletLine, withdrawBlocked, type WalletInfo } from "./lib/view";
import type { EarningsView } from "./lib/types";
import { DepositDialog } from "./components/DepositDialog";
import { WithdrawDialog } from "./components/WithdrawDialog";
import { PendingRow } from "./components/PendingRow";
import { Buying } from "./components/Buying";
import { Label, Section } from "./components/bits";

export default function App() {
  const client = useStrutClient();
  const qc = useQueryClient();
  const [range, setRange] = useState<RangeId>("30d");
  const [adding, setAdding] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const from = rangeFrom(range);
  const byItem = useQuery({
    queryKey: ["earnings", "item", range],
    queryFn: () => client.run<EarningsView>("earnings/read", { by: "item", wallet: true, ...(from ? { from } : {}) }),
  });
  const byDay = useQuery({
    queryKey: ["earnings", "day", range],
    queryFn: () => client.run<EarningsView>("earnings/read", { by: "day", ...(from ? { from } : {}) }),
  });
  const walletInfo = useQuery({ queryKey: ["earnings", "wallet"], queryFn: () => client.run<WalletInfo>("earnings/wallet", {}) });
  const reload = () => void qc.invalidateQueries({ queryKey: ["earnings"] });

  const view = byItem.data;
  const wallet = view?.wallet;
  const blocked = withdrawBlocked(wallet);
  const noAdd = addBlocked(wallet);
  const error = byItem.error ?? byDay.error;
  // Shown once any worker was paid: a strut that never paid one reads as it did.
  const workers = showsWorkers(view?.workers) ? view?.workers : undefined;
  const cover = coverLine(wallet);

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 bg-background p-4 text-foreground sm:p-6">
      <header className="flex items-center gap-3">
        <Wallet className="size-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Earnings</h1>
        <span className="hidden text-sm text-muted-foreground sm:inline">What anyone's runs here were charged, what they cost, and the wallet the sats land in.</span>
        <Button variant="ghost" size="icon-sm" className="ml-auto" title="Read again" onClick={reload}>
          <RefreshCw className={cn(byItem.isFetching && "animate-spin")} />
        </Button>
      </header>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error instanceof Error ? error.message : String(error)}</span>
        </div>
      )}
      {!view && !error && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Reading the books…
        </div>
      )}

      {view && (
        <>
          <section className={cn("grid gap-4 rounded-lg border p-4", workers ? "sm:grid-cols-[1fr_1fr_1fr_auto]" : "sm:grid-cols-[1fr_1fr_auto]")}>
            <Figure
              label="Wallet"
              value={wallet?.balance ? fmtSats(wallet.balance.msat) : "—"}
              sub={wallet?.balance?.usd !== undefined && wallet.rate ? `≈ ${fmtUsd(wallet.balance.usd)} at ${fmtUsd(wallet.rate)} per bitcoin` : (wallet?.error ?? "")}
              note={cover ? <span className={cn(cover.short && "text-destructive")}>{cover.text}</span> : undefined}
            />
            <Figure
              label="Owed as service"
              title="Paid for and not yet charged: what buyers are still owed as service. The sats are yours either way."
              value={fmtUsd(view.outstanding.usd)}
              sub={`${view.outstanding.tokens} credit token${view.outstanding.tokens === 1 ? "" : "s"}${view.outstanding.held > 0 ? ` · ${fmtUsd(view.outstanding.held)} held for runs in flight` : ""}`}
            />
            {workers && (
              <Figure
                label="Owed to workers"
                title="Earned by workers for accepted answers, less what was taken back: sats this wallet must hold for them. Held earnings wait out their task type's hold before they can be withdrawn."
                value={fmtSats(workers.owedMsat)}
                sub={workersOwedSub(workers, wallet?.rate)}
              />
            )}
            <div className="flex flex-col gap-2 sm:items-end">
              <div className="flex gap-2">
                <Button variant="outline" disabled={!!noAdd} title={noAdd ?? "An invoice into this wallet, to pay from your own"} onClick={() => setAdding(true)}>
                  Add sats
                </Button>
                <Button disabled={!!blocked} title={blocked ?? "Pay a Lightning invoice out of this wallet"} onClick={() => setWithdrawing(true)}>
                  Withdraw
                </Button>
              </div>
              {blocked && <span className="text-xs text-muted-foreground">{blocked}</span>}
            </div>
            {wallet && (wallet.balance || wallet.expectedMsat !== 0) && (
              <p className={cn("text-sm text-muted-foreground", workers ? "sm:col-span-4" : "sm:col-span-3")}>
                The books say it should hold {fmtSats(Math.max(0, wallet.expectedMsat))}: everything received and added, less everything sent and its fees
                {wallet.pendingMsat > 0 ? `, and less the ${fmtSats(wallet.pendingMsat)} still on its way` : ""}.
                {wallet.differenceMsat !== undefined && wallet.differenceMsat !== 0 && (
                  <>
                    {" "}It holds {fmtSats(Math.abs(wallet.differenceMsat))}{" "}
                    {wallet.differenceMsat > 0 ? "more — money that came some other way, or a paid invoice whose credit was never used" : "less — money that left some other way"}.
                  </>
                )}
                {wallet.differenceMsat === 0 && " It does."}
              </p>
            )}
            {view.pending.length > 0 && (
              <div className={cn("flex flex-col gap-2", workers ? "sm:col-span-4" : "sm:col-span-3")}>
                <Label>On their way</Label>
                {view.pending.map((p) => (
                  <PendingRow key={p.paymentHash} p={p} onChanged={reload} />
                ))}
              </div>
            )}
          </section>

          <div className="flex flex-wrap gap-1" role="tablist">
            {RANGES.map((r) => (
              <Button key={r.id} role="tab" aria-selected={r.id === range} size="sm" variant={r.id === range ? "secondary" : "ghost"} onClick={() => setRange(r.id)}>
                {r.label}
              </Button>
            ))}
          </div>

          <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Tile label="Earned" value={fmtUsd(view.totals.earned)} sub={`${view.totals.calls} run${view.totals.calls === 1 ? "" : "s"}${view.totals.failed ? ` · ${view.totals.failed} failed` : ""}`} />
            <Tile label="Cost" value={fmtUsd(view.totals.cost)} sub="what they spent on models" />
            <Tile label="Margin" value={fmtUsd(view.totals.margin)} sub="earned − cost" loss={view.totals.margin < 0} />
            <Tile label="Received" value={fmtSats(view.received.msat)} sub={`${view.received.count} payment${view.received.count === 1 ? "" : "s"} · ${fmtUsd(view.received.usd)} of credit`} />
            <Tile label="Withdrawn" value={fmtSats(view.withdrawn.msat)} sub={`${view.withdrawn.count} · fees ${fmtSats(view.withdrawn.feeMsat)}`} />
          </section>
          {view.deposited.count > 0 && (
            <p className="text-sm text-muted-foreground">Also added by hand: {fmtSats(view.deposited.msat)} ({view.deposited.count}). Not credit and not earnings: sats this server may spend.</p>
          )}
          {view.purchases.count > 0 && (
            <p className="text-sm text-muted-foreground">
              Also paid out: {fmtSats(view.purchases.msat)} for credit bought from other servers ({view.purchases.count}, fees {fmtSats(view.purchases.feeMsat)}).
            </p>
          )}
          {workers && workers.accepted.answers > 0 && (
            <p className="text-sm text-muted-foreground">In this range, {workersAcceptedLine(workers)} Worker pay is owed in sats, apart from what this server earned.</p>
          )}

          <Section title="By item">
            {view.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing anyone may run here has been sold in this range.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead><TableHead>Price</TableHead><TableHead className="text-right">Runs</TableHead><TableHead className="text-right">Failed</TableHead>
                    <TableHead className="text-right">Earned</TableHead><TableHead className="text-right">Cost</TableHead><TableHead className="text-right">Margin</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byEarned(view.rows).map((r) => {
                    const s = subjectLabel(r.key);
                    return (
                      <TableRow key={r.key}>
                        <TableCell className="max-w-64 truncate"><Badge variant="outline" className="mr-2">{s.kind}</Badge>{s.name}</TableCell>
                        <TableCell>{r.price ? priceLine(r.price) : s.kind === "expired" ? "" : "not sold now"}</TableCell>
                        <TableCell className="text-right">{r.calls}</TableCell>
                        <TableCell className={cn("text-right", r.failed && "text-destructive")}>{r.failed}</TableCell>
                        <TableCell className="text-right">{fmtUsd(r.earned)}</TableCell>
                        <TableCell className="text-right">{fmtUsd(r.cost)}</TableCell>
                        <TableCell className={cn("text-right", r.margin < 0 && "text-destructive")}>{fmtUsd(r.margin)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Section>

          <Section title="By day">
            <ByDay view={view} days={byDay.data} {...(workers ? { workers } : {})} />
          </Section>

          <Buying />

          <Section title="Wallet">
            <p className="text-sm text-muted-foreground">{walletInfo.data ? walletLine(walletInfo.data) : walletInfo.error ? String(walletInfo.error) : "…"}</p>
            {walletInfo.data && walletInfo.data.provider && (
              <div className="flex flex-wrap gap-2">
                <Badge variant={walletInfo.data.receive ? "secondary" : "outline"}>{walletInfo.data.receive ? "receives" : "cannot receive"}</Badge>
                <Badge variant={walletInfo.data.pay ? "secondary" : "outline"}>{walletInfo.data.pay ? "can pay" : "cannot pay"}</Badge>
                {walletInfo.data.check && (
                  <span className="text-xs text-muted-foreground">{walletInfo.data.check.ok ? `answers: ${fmtSats(walletInfo.data.check.msat)}` : walletInfo.data.check.error}</span>
                )}
              </div>
            )}
          </Section>
        </>
      )}

      {adding && (
        <DepositDialog
          {...(wallet?.rate ? { rate: wallet.rate } : {})}
          onClose={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
      {withdrawing && wallet && view && (
        <WithdrawDialog
          wallet={wallet}
          outstandingUsd={view.outstanding.usd}
          {...(workers ? { workers } : {})}
          onClose={() => {
            setWithdrawing(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function ByDay(props: { view: EarningsView; days: EarningsView | undefined; workers?: WorkersView }) {
  const { view, workers } = props;
  const rows = new Map((props.days?.rows ?? []).map((d) => [d.key, d]));
  const received = new Map(view.received.days.map((d) => [d.day, d]));
  const withdrawn = new Map(view.withdrawn.days.map((d) => [d.day, d]));
  const deposited = new Map(view.deposited.days.map((d) => [d.day, d]));
  const paid = new Map(workers?.accepted.days.map((d) => [d.day, d]) ?? []);
  const days = [...new Set([...rows.keys(), ...received.keys(), ...withdrawn.keys(), ...deposited.keys(), ...paid.keys()])].sort().reverse();
  if (!days.length) return <p className="text-sm text-muted-foreground">Nothing in this range.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Day (UTC)</TableHead><TableHead className="text-right">Runs</TableHead><TableHead className="text-right">Earned</TableHead><TableHead className="text-right">Cost</TableHead>
          <TableHead className="text-right">Margin</TableHead><TableHead className="text-right">Received</TableHead>{deposited.size > 0 && <TableHead className="text-right">Added</TableHead>}
          <TableHead className="text-right">Withdrawn</TableHead>
          {workers && (
            <TableHead className="text-right" title="Sats that day's accepted answers earned workers, less what of them was taken back">
              Workers
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {days.map((day) => {
          const d = rows.get(day);
          const add = deposited.get(day);
          const pay = paid.get(day);
          return (
            <TableRow key={day}>
              <TableCell>{day}</TableCell>
              <TableCell className="text-right">{d?.calls ?? 0}</TableCell>
              <TableCell className="text-right">{fmtUsd(d?.earned ?? 0)}</TableCell>
              <TableCell className="text-right">{fmtUsd(d?.cost ?? 0)}</TableCell>
              <TableCell className={cn("text-right", (d?.margin ?? 0) < 0 && "text-destructive")}>{fmtUsd(d?.margin ?? 0)}</TableCell>
              <TableCell className="text-right">{received.has(day) ? fmtSats(received.get(day)!.msat) : ""}</TableCell>
              {deposited.size > 0 && <TableCell className="text-right">{add ? fmtSats(add.msat) : ""}</TableCell>}
              <TableCell className="text-right">{withdrawn.has(day) ? fmtSats(withdrawn.get(day)!.msat) : ""}</TableCell>
              {workers && (
                <TableCell className="text-right" title={pay ? `${pay.answers} answer${pay.answers === 1 ? "" : "s"}${pay.takenBackAnswers ? `, ${pay.takenBackAnswers} taken back` : ""}` : undefined}>
                  {pay ? fmtSats(workersDayMsat(pay)) : ""}
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function Figure(props: { label: string; value: string; sub: string; title?: string; note?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1" title={props.title}>
      <Label>{props.label}</Label>
      <div className="text-2xl font-semibold tabular-nums">{props.value}</div>
      <div className="text-xs text-muted-foreground">{props.sub}</div>
      {props.note && <div className="text-xs text-muted-foreground">{props.note}</div>}
    </div>
  );
}

function Tile(props: { label: string; value: string; sub: string; loss?: boolean }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-3">
      <Label>{props.label}</Label>
      <div className={cn("text-lg font-semibold tabular-nums", props.loss && "text-destructive")}>{props.value}</div>
      <div className="truncate text-xs text-muted-foreground" title={props.sub}>{props.sub}</div>
    </div>
  );
}
