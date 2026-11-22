// The Overview (plans/human-steps.md §9.5; it was the Queue): first what
// needs a person, each with its one button; then the queue as it stands now
// and over the last day, from `staff/stats`, read every 10 s while the page
// is shown (none while hidden); with item 5a, what workers are owed beside
// what the wallet holds; then one row a task type, one number a column.
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, ListChecks } from "lucide-react";
import { useStrutClient } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { fmtDuration, fmtSats, moneyOf, needsYou, type Place, type Shown } from "../lib/view";
import type { Books, TaskStats, TaskType } from "../lib/types";
import { Empty, ErrorLine, Label, Loading, Note, Section, Stat } from "./bits";
import { SendRound } from "./SendRound";

export const STATS_EVERY_MS = 10_000;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function Overview(props: { go: (p: Place) => void; shown: Shown; hasGroups: boolean; types?: TaskType[] }) {
  const client = useStrutClient();
  // React Query refetches on the interval only while the page is visible.
  const stats = useQuery({ queryKey: ["staff", "stats"], queryFn: () => client.run<TaskStats>("staff/stats", {}), refetchInterval: STATS_EVERY_MS });
  // What workers are owed and what the wallet holds (item 5a): the books'
  // read, once; a server that never paid a worker shows nothing.
  const books = useQuery({ queryKey: ["staff", "books"], queryFn: () => client.run<Books>("earnings/read", { by: "total", days: 1, wallet: true }) });
  const s = stats.data;
  if (stats.error) return <ErrorLine error={stats.error} />;
  if (!s) return <Loading>Reading the queue…</Loading>;
  // The answers to review are named only where a verdict can be given.
  const needs = needsYou(s, { groups: props.hasGroups }).filter((n) => n.tone === "warn" || props.shown.review);
  const waiting = sum(s.types.map((t) => t.waiting));
  const working = sum(s.types.map((t) => t.working));
  const oldest = Math.max(0, ...s.types.map((t) => t.oldest ?? 0));
  const day = (k: "answered" | "expired" | "skipped" | "leasesLost") => sum(s.types.map((t) => t.windows.day[k]));
  const dropped = day("skipped") + day("leasesLost");
  const active = s.workers.active ?? 0;
  const money = moneyOf(books.data);

  return (
    <>
      <Section title="Needs you">
        {needs.length === 0 ? (
          <p className="flex items-center gap-2 rounded-lg border p-3 text-sm text-muted-foreground">
            <Check className="size-4 text-[color:var(--peel-confirmed)]" /> Nothing needs you right now.
          </p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Needs you">
            {needs.map((n) => (
              <li key={n.text} className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-3", n.tone === "warn" ? "border-[color-mix(in_srgb,var(--peel-attention)_28%,transparent)] bg-[color-mix(in_srgb,var(--peel-attention)_7%,transparent)]" : "bg-muted/30")}>
                <span aria-hidden className={cn("grid size-9 shrink-0 place-items-center rounded-full", n.tone === "warn" ? "bg-[color-mix(in_srgb,var(--peel-attention)_15%,transparent)] text-[color:var(--peel-attention)]" : "bg-muted")}>
                  {n.tone === "warn" ? <AlertTriangle className="size-4" /> : <ListChecks className="size-4" />}
                </span>
                <span className="min-w-0 flex-1 basis-64 text-sm font-medium">{n.text}</span>
                <Button size="sm" variant={n.tone === "warn" ? "default" : "outline"} onClick={() => props.go(n.to)}>
                  {n.action}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="flex flex-col gap-3 rounded-lg border p-4">
          <Label>Right now</Label>
          <div className="grid grid-cols-3 gap-4">
            <Stat value={waiting} label="Waiting for a worker" note={waiting ? `the oldest for ${fmtDuration(oldest)}` : "Nothing is waiting"} title="Open tasks nobody has taken" />
            <Stat value={working} label="Being worked on" note={working ? "taken, not answered yet" : "Nobody has a task open"} title="Open tasks a worker has taken and not answered yet" />
            <Stat value={s.asking} label="Workers online" note={`of ${active.toLocaleString("en-US")} who can take tasks`} title="Workers whose page is open and asking for a task now" />
          </div>
        </section>
        <section className="flex flex-col gap-3 rounded-lg border p-4">
          <Label>Last 24 hours</Label>
          <div className="grid grid-cols-3 gap-4">
            <Stat
              value={day("answered")}
              label="Answered"
              note={`${sum(s.types.map((t) => t.windows.hour.answered))} in the last hour, ${sum(s.types.map((t) => t.windows.week.answered))} this week`}
            />
            <Stat value={dropped} label="Started, not finished" note={`${day("leasesLost")} timed out, ${day("skipped")} skipped`} title="A worker took the task and did not answer: they ran out of time, or passed" />
            <Stat value={day("expired")} label="Expired unanswered" note={day("expired") ? "nobody answered in time" : "None"} title="Tasks nobody answered before they were due" />
          </div>
        </section>
      </div>

      {money && (
        <section className="flex flex-col gap-3 rounded-lg border p-4" data-testid="queue-owed">
          <div className="flex flex-wrap items-start gap-x-10 gap-y-3">
            <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
              <Label>Owed to workers</Label>
              <div className="text-xl font-semibold tabular-nums">{fmtSats(money.owedMsat)}</div>
              <Note>{money.heldMsat > 0 ? `${fmtSats(money.withdrawableMsat)} can be withdrawn now; ${fmtSats(money.heldMsat)} still held.` : "All of it can be withdrawn now; nothing is still held."}</Note>
            </div>
            <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
              <Label>In the wallet</Label>
              {money.walletMsat === undefined ? (
                <Note>{money.walletError ? `The wallet could not be read: ${money.walletError}.` : "No wallet is read here."}</Note>
              ) : (
                <>
                  <div className="text-xl font-semibold tabular-nums">{fmtSats(money.walletMsat)}</div>
                  {money.coverMsat! >= 0 ? (
                    <p className="flex items-center gap-1.5 text-xs text-[color:var(--peel-confirmed)]">
                      <Check className="size-3.5 shrink-0" strokeWidth={2.5} /> Covers what is owed, with {fmtSats(money.coverMsat!)} to spare
                    </p>
                  ) : (
                    <p className="flex items-center gap-1.5 text-xs text-destructive">
                      <AlertTriangle className="size-3.5 shrink-0" /> {fmtSats(-money.coverMsat!)} short of what is owed
                    </p>
                  )}
                </>
              )}
            </div>
            {props.shown.payouts && (
              <Button size="sm" variant="ghost" onClick={() => props.go({ tab: "payouts" })}>
                Payouts
              </Button>
            )}
          </div>
          {money.walletMsat !== undefined && money.walletMsat > 0 && (
            // The wallet as a bar, what is owed marked on it.
            <div aria-hidden className="flex h-2 overflow-hidden rounded-full bg-muted">
              <div className={cn("min-w-1.5", money.coverMsat! >= 0 ? "bg-foreground" : "bg-destructive")} style={{ width: `${Math.min(100, (money.owedMsat / money.walletMsat) * 100)}%` }} />
            </div>
          )}
        </section>
      )}

      <Section title="By task type" aside={<Note>The last 24 hours. Read again every 10 s while shown.</Note>}>
        {s.types.length === 0 ? (
          <Empty>No task types yet. Make one under Task types: a workflow's human step names it, and a worker app draws it.</Empty>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Task type</TableHead>
                  <TableHead className="text-right" title="Open tasks nobody has taken">Waiting</TableHead>
                  <TableHead className="text-right" title="Open tasks a worker has taken">In progress</TableHead>
                  <TableHead className="text-right" title="Answers in the last 24 hours">Answered</TableHead>
                  <TableHead className="text-right" title="From made to answered: half are faster than this">Time to answer</TableHead>
                  <TableHead className="text-right" title="Taken and not answered in time, over 24 hours">Timed out</TableHead>
                  {props.shown.review && <TableHead className="text-right" title="Answers with no verdict yet">To review</TableHead>}
                  <TableHead className="text-right" title="Workers who may take it">Workers</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.types.map((t) => {
                  const kind = props.types?.find((k) => k.name === t.type);
                  const took = t.windows.day.toAnswer;
                  return (
                    <TableRow key={t.type} className="cursor-pointer" onClick={() => props.go({ tab: "types", type: t.type })}>
                      <TableCell>
                        <div className="font-medium">{t.type}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {t.enabled ? (
                            <Badge variant="outline">
                              <span aria-hidden className="size-1.5 rounded-full bg-[color:var(--peel-confirmed)]" /> On
                            </Badge>
                          ) : (
                            <Badge variant="secondary">Off</Badge>
                          )}
                          {kind?.open !== undefined && <Badge variant="outline">{kind.open ? "Open to anyone" : "Invite-only"}</Badge>}
                          {kind?.paySats ? <Badge variant="outline">{kind.paySats.toLocaleString("en-US")} sats an answer</Badge> : null}
                          {t.appProblem && (
                            <Badge variant="destructive" title={t.appProblem}>
                              app problem
                            </Badge>
                          )}
                          <span className="text-xs text-muted-foreground">in {t.app}</span>
                        </div>
                        {/* A round type: Send a round in the row, where a wide table never scrolls it away. */}
                        {kind?.round && (
                          <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
                            <SendRound type={kind} small />
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {t.waiting}
                        {t.oldest !== undefined && <div className="text-xs text-muted-foreground">oldest {fmtDuration(t.oldest)}</div>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{t.working}</TableCell>
                      <TableCell className="text-right tabular-nums">{t.windows.day.answered}</TableCell>
                      <TableCell className="text-right tabular-nums" title={t.windows.day.work ? `Work time, taken to answered: ${fmtDuration(t.windows.day.work.p50)}, 9 in 10 within ${fmtDuration(t.windows.day.work.p90)}` : undefined}>
                        {took ? fmtDuration(took.p50) : "—"}
                        {took && <div className="text-xs text-muted-foreground">9 in 10 within {fmtDuration(took.p90)}</div>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {t.windows.day.leasesLost}
                        {t.windows.week.disputed > 0 && <div className="text-xs text-muted-foreground">{t.windows.week.disputed} disputed this week</div>}
                      </TableCell>
                      {props.shown.review && <TableCell className="text-right tabular-nums">{t.toReview ?? "—"}</TableCell>}
                      <TableCell className="text-right tabular-nums">{t.granted}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>
    </>
  );
}
