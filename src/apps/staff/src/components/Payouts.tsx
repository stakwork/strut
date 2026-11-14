// Payouts (plans/human-steps.md §8.2): workers' withdrawals to their own
// Sphinx address, with nobody's yes per payment. The switch that lets them
// happen, the caps with today's use against them, the wallet's cover (a
// withdrawal is refused while it is short), and the list: each payout, its
// state, and for a stale one — out a day, the wallet silent — Read again,
// Record as paid and Drop. Shown only when `/tasks/payouts` answers.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useStrutClient } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { fmtSats, fmtWhen, mostByOneWorkerToday, PAYOUT_STATES, payoutCover, payoutState, shortActor, shortAddress, whoOf, type PayoutState, type Place } from "../lib/view";
import type { Books, Payout, PayoutSettings, PayoutsAnswer, Worker } from "../lib/types";
import { Back, Empty, ErrorLine, Field, Loading, Note, Section, useAct } from "./bits";

export const ON_WORDS = "Workers may withdraw what passed its hold to their own Sphinx address, up to the caps below, with nobody's yes per payment.";
export const OFF_WORDS = "No new withdrawal starts; those on their way finish.";

export function Payouts(props: { go: (p: Place) => void; place: Place; workers?: Worker[] }) {
  const client = useStrutClient();
  const [state, setState] = useState<PayoutState | "">("");
  const { worker, payout: key } = props.place;
  // One payout is looked up in the newest 500; a list in the newest 50.
  const q = useQuery({
    queryKey: ["staff", "payouts", worker ?? "", key ? "one" : state],
    queryFn: () => client.run<PayoutsAnswer>("staff/payouts", { ...(worker ? { worker } : {}), ...(state && !key ? { state } : {}), ...(key ? { limit: 500 } : {}) }),
  });
  // The cover is the Queue's read (item 5a): the same key, read once.
  const books = useQuery({ queryKey: ["staff", "books"], queryFn: () => client.run<Books>("earnings/read", { by: "total", days: 1, wallet: true }) });
  if (q.error) return <ErrorLine error={q.error} />;
  if (!q.data) return <Loading>Reading the payouts…</Loading>;
  const { settings, today, payouts } = q.data;
  const cover = payoutCover(books.data);
  const names = new Map((props.workers ?? []).map((w) => [w.actor, whoOf(w)]));

  if (key) {
    const one = payouts.find((p) => p.key === key);
    return (
      <div className="flex flex-col gap-4">
        <Back onClick={() => props.go({ tab: "payouts" })}>Payouts</Back>
        {one ? <PayoutTable payouts={[one]} go={props.go} names={names} full /> : <Empty>No payout {key} among the newest 500.</Empty>}
      </div>
    );
  }

  return (
    <>
      <Switcher settings={settings} />
      {/* The worker cap's use reads the list: only an unfiltered one says it. */}
      <Caps settings={settings} today={today} payouts={state ? undefined : payouts} />
      {cover && (
        <p className={cn("text-sm", cover.short && "text-destructive")} data-testid="payouts-cover">
          {cover.text}
          {cover.short && " Withdrawals are refused while the wallet is short."}
        </p>
      )}
      <Section
        title={worker ? `Payouts to ${shortActor(worker)}` : "Payouts"}
        aside={
          <>
            {worker && (
              <Button size="xs" variant="ghost" onClick={() => props.go({ tab: "payouts" })}>
                All workers
              </Button>
            )}
            <NativeSelect aria-label="State" value={state} onChange={(e) => setState(e.target.value as PayoutState | "")}>
              <NativeSelectOption value="">any state</NativeSelectOption>
              {PAYOUT_STATES.map((s) => (
                <NativeSelectOption key={s} value={s}>
                  {s}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </>
        }
      >
        {payouts.length === 0 ? <Empty>{state || worker ? "No payout matches." : "No worker has withdrawn yet."}</Empty> : <PayoutTable payouts={payouts} go={props.go} names={names} />}
      </Section>
    </>
  );
}

/** The switch: turning it on asks first, and says what it does. */
function Switcher(props: { settings: PayoutSettings }) {
  const client = useStrutClient();
  const { act, busy, error } = useAct();
  const [asking, setAsking] = useState(false);
  const { on, minSats, workerDaySats, serverDaySats } = props.settings;
  const save = (next: boolean) => act("switch", () => client.run("staff/save-payouts", { on: next, minSats, workerDaySats, serverDaySats })).then(() => setAsking(false));
  return (
    <section className="flex flex-col gap-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Switch checked={on} disabled={busy !== null} aria-label="Workers may withdraw" onCheckedChange={(c) => (c ? setAsking(true) : void save(false))} />
        <span className="text-sm font-medium">{on ? "On: workers may withdraw" : "Off: workers cannot withdraw"}</span>
        {props.settings.changedBy && <Note className="ml-auto">Last changed by {props.settings.changedBy}{props.settings.changedAt ? ` ${fmtWhen(props.settings.changedAt)}` : ""}</Note>}
      </div>
      <Note>{on ? ON_WORDS : OFF_WORDS}</Note>
      {asking && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-sm" role="alertdialog">
          <span>{ON_WORDS}</span>
          <Button size="sm" disabled={busy !== null} onClick={() => void save(true)}>
            Turn on
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
            Cancel
          </Button>
        </div>
      )}
      <ErrorLine error={error} />
    </section>
  );
}

/** The caps edited in place, each beside today's use against it. */
function Caps(props: { settings: PayoutSettings; today: PayoutsAnswer["today"]; payouts?: Payout[] }) {
  const client = useStrutClient();
  const { act, busy, error } = useAct();
  const s = props.settings;
  const [d, setD] = useState({ minSats: String(s.minSats), workerDaySats: String(s.workerDaySats), serverDaySats: String(s.serverDaySats) });
  useEffect(() => setD({ minSats: String(s.minSats), workerDaySats: String(s.workerDaySats), serverDaySats: String(s.serverDaySats) }), [s.minSats, s.workerDaySats, s.serverDaySats]);
  const n = { minSats: Number(d.minSats), workerDaySats: Number(d.workerDaySats), serverDaySats: Number(d.serverDaySats) };
  const whole = Object.values(n).every((v) => Number.isInteger(v) && v >= 1);
  const problem = !whole ? "Each is a whole number of sats, at least 1." : n.workerDaySats < n.minSats || n.serverDaySats < n.minSats ? "Each cap is at least the minimum." : undefined;
  const changed = n.minSats !== s.minSats || n.workerDaySats !== s.workerDaySats || n.serverDaySats !== s.serverDaySats;
  const used = props.today.paidMsat + props.today.outMsat;
  const field = (k: keyof typeof d, label: string, hint: string) => (
    <Field label={label} hint={hint} htmlFor={`payout-${k}`}>
      <Input id={`payout-${k}`} type="number" min={1} value={d[k]} onChange={(e) => setD({ ...d, [k]: e.target.value })} />
    </Field>
  );
  return (
    <Section title="Caps" aside={<Note>UTC day {props.today.day} · {props.today.count} payout{props.today.count === 1 ? "" : "s"} today</Note>}>
      <div className="grid gap-3 md:grid-cols-3">
        {field("minSats", "Least one withdrawal (sats)", "A worker asks for at least this.")}
        {field("workerDaySats", "One worker a day (sats)", props.payouts ? `Most by one worker today: ${fmtSats(mostByOneWorkerToday(props.payouts, props.today.day))}, of those listed.` : "Each worker, in a UTC day.")}
        {field("serverDaySats", "All workers a day (sats)", `Today: ${fmtSats(used)} paid or on its way; ${fmtSats(props.today.serverLeftMsat)} left.`)}
      </div>
      {problem && changed && <Note className="text-destructive">{problem}</Note>}
      {changed && (
        <div className="flex gap-2">
          <Button size="sm" disabled={!!problem || busy !== null} onClick={() => void act("caps", () => client.run("staff/save-payouts", { on: s.on, ...n }))}>
            Save caps
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setD({ minSats: String(s.minSats), workerDaySats: String(s.workerDaySats), serverDaySats: String(s.serverDaySats) })}>
            Cancel
          </Button>
        </div>
      )}
      <ErrorLine error={error} />
    </Section>
  );
}

function PayoutTable(props: { payouts: Payout[]; go: (p: Place) => void; names: Map<string, string>; full?: boolean }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Who</TableHead>
            <TableHead>Address</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right" title="What the wallet was charged; the cap while it is out">Fee</TableHead>
            <TableHead>State</TableHead>
            <TableHead>When</TableHead>
            <TableHead>Note</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.payouts.map((p) => (
            <PayoutRow key={p.key} p={p} go={props.go} name={props.names.get(p.worker)} full={props.full} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function PayoutRow(props: { p: Payout; go: (p: Place) => void; name?: string; full?: boolean }) {
  const { p } = props;
  const st = payoutState(p);
  return (
    <>
      <TableRow className={cn(!props.full && "cursor-pointer")} onClick={props.full ? undefined : () => props.go({ tab: "payouts", payout: p.key })}>
        <TableCell onClick={(e) => e.stopPropagation()}>
          <button type="button" className="text-sm font-medium underline-offset-2 hover:underline" title={p.worker} onClick={() => props.go({ tab: "workers", worker: p.worker })}>
            {props.name ?? shortActor(p.worker)}
          </button>
        </TableCell>
        <TableCell className="font-mono text-xs" title={p.address}>
          {props.full ? <span className="break-all">{p.address}</span> : shortAddress(p.address)}
        </TableCell>
        <TableCell className="text-right tabular-nums">{fmtSats(p.msat)}</TableCell>
        <TableCell className="text-right tabular-nums">{p.state === "out" ? `up to ${fmtSats(p.maxFeeMsat)}` : p.feeMsat !== undefined ? fmtSats(p.feeMsat) : "—"}</TableCell>
        <TableCell>
          <Badge variant={st === "failed" ? "destructive" : st === "paid" ? "secondary" : "outline"}>{st}</Badge>
        </TableCell>
        <TableCell className="whitespace-nowrap">{fmtWhen(p.at)}</TableCell>
        <TableCell className="max-w-xs text-xs break-words whitespace-normal text-muted-foreground">{p.why ?? ""}{p.by ? ` (by ${p.by})` : ""}</TableCell>
      </TableRow>
      {props.full && (
        <TableRow>
          <TableCell colSpan={7} className="text-xs whitespace-normal text-muted-foreground">
            <div className="font-mono break-all">key {p.key}</div>
            {p.paymentHash && <div className="font-mono break-all">payment hash {p.paymentHash}</div>}
            {p.ended && <div>ended {fmtWhen(p.ended)}</div>}
          </TableCell>
        </TableRow>
      )}
      {st === "stale" && (
        <TableRow>
          <TableCell colSpan={7} className="whitespace-normal">
            <Stale p={p} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** A stale payout: out a day and the wallet will not say. Only the worker's
 *  wallet knows whether the sats arrived. */
function Stale(props: { p: Payout }) {
  const client = useStrutClient();
  const { act, busy, error } = useAct();
  const [fee, setFee] = useState("");
  const [asking, setAsking] = useState<"paid" | "drop" | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const key = props.p.key;
  const feeMsat = fee.trim() === "" ? 0 : Math.round(Number(fee) * 1000);
  const feeBad = !Number.isFinite(feeMsat) || feeMsat < 0;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <Note>On its way for over a day and the wallet does not say. Only the worker's wallet knows whether the sats arrived: look there before you decide. Recording it paid when it did not loses the sats; dropping it when it did pays the worker twice.</Note>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act("read", () => client.run<{ state?: string }>("staff/payout-read", { key })).then((r) => setSaid(r ? `Read again: ${r.state ?? "no answer"}.` : null))}>
          Read again
        </Button>
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setAsking("paid")}>
          Record as paid
        </Button>
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setAsking("drop")}>
          Drop
        </Button>
        {said && <span className="text-xs text-muted-foreground" role="status">{said}</span>}
      </div>
      {asking === "paid" && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs" htmlFor={`fee-${key}`}>Fee the wallet charged (sats, optional)</label>
          <Input id={`fee-${key}`} className="h-7 w-24" type="number" min={0} value={fee} onChange={(e) => setFee(e.target.value)} />
          <Button size="sm" disabled={busy !== null || feeBad} onClick={() => void act("paid", () => client.run("staff/payout-resolve", { key, action: "paid", feeMsat }))}>
            Record {fmtSats(props.p.msat)} as paid
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAsking(null)}>Cancel</Button>
        </div>
      )}
      {asking === "drop" && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs">It did not arrive: it fails and {fmtSats(props.p.msat)} is the worker's again.</span>
          <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => void act("drop", () => client.run("staff/payout-resolve", { key, action: "drop" }))}>
            Drop it
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAsking(null)}>Cancel</Button>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}
