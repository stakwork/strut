// The Queue (plans/human-steps.md §9.5): one row a task type, from
// `staff/stats`, read every 10 s while the page is shown (none while
// hidden). Above it, what needs a person; with item 5a, what workers are
// owed beside what the wallet holds.
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useStrutClient } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { fmtDuration, owedLine, queueWarnings, type Place } from "../lib/view";
import type { Books, TaskStats } from "../lib/types";
import { Empty, ErrorLine, Figure, Loading, Note, Section } from "./bits";

export const STATS_EVERY_MS = 10_000;

export function Queue(props: { go: (p: Place) => void }) {
  const client = useStrutClient();
  // React Query refetches on the interval only while the page is visible.
  const stats = useQuery({ queryKey: ["staff", "stats"], queryFn: () => client.run<TaskStats>("staff/stats", {}), refetchInterval: STATS_EVERY_MS });
  // What workers are owed and what the wallet holds (item 5a): the books'
  // read, once; a server that never paid a worker shows nothing.
  const books = useQuery({ queryKey: ["staff", "books"], queryFn: () => client.run<Books>("earnings/read", { by: "total", days: 1, wallet: true }) });
  const s = stats.data;
  const owed = owedLine(books.data);
  if (stats.error) return <ErrorLine error={stats.error} />;
  if (!s) return <Loading>Reading the queue…</Loading>;
  const warnings = queueWarnings(s);
  const p = (x: { p50: number; p90: number } | undefined) => (x ? `${fmtDuration(x.p50)} · ${fmtDuration(x.p90)}` : "—");

  return (
    <>
      {warnings.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label="Needs a person">
          {warnings.map((w) => (
            <li key={w.text}>
              <button type="button" onClick={() => props.go(w.to)} className="flex w-full items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-left text-sm hover:bg-amber-500/10">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                <span>{w.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <section className="grid grid-cols-2 gap-4 rounded-lg border p-4 sm:grid-cols-6">
        <Figure label="Waiting" value={s.types.reduce((n, t) => n + t.waiting, 0)} title="Open tasks no worker holds" />
        <Figure label="Being worked" value={s.types.reduce((n, t) => n + t.working, 0)} title="Open tasks a worker holds a lease on" />
        <Figure label="Answered today" value={s.types.reduce((n, t) => n + t.windows.day.answered, 0)} title="Answers given in the last 24 hours" />
        <Figure label="Workers active" value={s.workers.active ?? 0} title="Workers who may take tasks of the types granted them" />
        <Figure label="Holding a lease" value={s.holding} />
        <Figure label="Asking now" value={s.asking} title="Workers whose page holds a task/next waiting for a task" />
      </section>

      {owed && <p className={cn("text-sm", owed.short && "text-destructive")} data-testid="queue-owed">{owed.text}</p>}

      <Section title="By task type" aside={<Note>Read every 10 s while shown · times are p50 · p90 over the last day</Note>}>
        {s.types.length === 0 ? (
          <Empty>No task types yet. Make one under Types: a workflow's human step names it, and a worker app draws it.</Empty>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right" title="Waiting · being worked">Waiting · working</TableHead>
                  <TableHead className="text-right">Oldest waiting</TableHead>
                  <TableHead className="text-right" title="Open tasks due within 24 hours">Due in a day</TableHead>
                  <TableHead className="text-right" title="Answers in the last hour · day · week">Answered h · d · w</TableHead>
                  <TableHead className="text-right" title="Made to answered">Time to answer</TableHead>
                  <TableHead className="text-right" title="Taken to answered">Work time</TableHead>
                  <TableHead className="text-right" title="Skipped and leases run out over the day; expired over the week">Skipped · lost · expired</TableHead>
                  <TableHead className="text-right" title="Workers granted · holding a lease · asking now">Workers</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.types.map((t) => (
                  <TableRow key={t.type} className="cursor-pointer" onClick={() => props.go({ tab: "types", type: t.type })}>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{t.type}</span>
                        {!t.enabled && <Badge variant="outline">off</Badge>}
                        {t.appProblem && (
                          <Badge variant="destructive" title={t.appProblem}>
                            app
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">{t.app}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {t.waiting} · {t.working}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{t.oldest !== undefined ? fmtDuration(t.oldest) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.dueSoon}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {t.windows.hour.answered} · {t.windows.day.answered} · {t.windows.week.answered}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{p(t.windows.day.toAnswer)}</TableCell>
                    <TableCell className="text-right tabular-nums">{p(t.windows.day.work)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {t.windows.day.skipped} · {t.windows.day.leasesLost} · {t.windows.week.expired}
                      {t.windows.week.disputed > 0 && <div className="text-xs text-muted-foreground">{t.windows.week.disputed} disputed this week</div>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {t.granted} · {t.holding} · {t.asking}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>
    </>
  );
}
