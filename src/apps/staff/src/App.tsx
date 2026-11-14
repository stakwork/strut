// strut/staff (plans/human-steps.md §9, specs/API.md §14.15): the task
// store's staff routes as a page, for an ADMIN — strut's own UI lists it in
// Apps, a host (Stadeum) frames it for a person it signed in as an admin.
// Six tabs, each deep-linkable (`?input=tab=…`, `type=`, `worker=`,
// `task=`, `test=`, `run=`, `payout=`): the Queue (what waits, and what needs a
// person), the task Types (who draws them, the answer's shape, pay, tests,
// copies, who holds them), the Workers (letting them in, what they did and
// earned), the Tasks (every task and its answers), the Tests, and the
// Payouts (workers' withdrawals: the switch, the caps, the list). Every call
// is a `staff/*` step, which answers only strut's own page shown to an admin
// with a name; the page is only a face, the routes decide. Parts of items 4
// (tests, standing, copies) and 5a (pay, earnings) show only when the server
// answers for them (§9.7).
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Users } from "lucide-react";
import { useAppLink, useHost, useStrutClient, useToolInput } from "@strut/kit";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TABS, TAB_LABELS, inputOf, placeOf, shownOf, testsAnswerOf, type Place, type Tab } from "./lib/view";
import type { TaskType, Test, Worker } from "./lib/types";
import { ErrorLine } from "./components/bits";
import { Queue } from "./components/Queue";
import { Types } from "./components/Types";
import { Workers } from "./components/Workers";
import { Tasks } from "./components/Tasks";
import { Tests } from "./components/Tests";
import { Payouts } from "./components/Payouts";

export default function App() {
  const client = useStrutClient();
  const qc = useQueryClient();
  const host = useHost();
  const link = useAppLink();
  const input = useToolInput<Record<string, string>>();
  const [place, setPlace] = useState<Place>(() => placeOf(input));
  // A link opened from outside (the run overview's task, a host's address bar).
  useEffect(() => setPlace(placeOf(input)), [JSON.stringify(input ?? {})]);
  const go = (p: Place) => {
    setPlace(p);
    // Each move goes back to the host, so its address bar follows (§9.1).
    if (host.connected) void host.openLink(link(inputOf(p))).catch(() => {});
  };

  const types = useQuery({ queryKey: ["staff", "types"], queryFn: () => client.run<{ types: TaskType[] }>("staff/types", {}) });
  const workers = useQuery({ queryKey: ["staff", "workers"], queryFn: () => client.run<{ workers: Worker[] }>("staff/workers", {}) });
  // Whether the test routes answer here (item 4): the Tests tab's own read.
  const tests = useQuery({ queryKey: ["staff", "tests", "all"], queryFn: () => client.run<{ tests: Test[] }>("staff/tests", {}) });
  // Whether the payout routes answer here (item 5b): the Payouts tab's own read.
  const payouts = useQuery({ queryKey: ["staff", "payouts", "any"], queryFn: () => client.run("staff/payouts", { limit: 1 }) });
  const shown = useMemo(
    () => shownOf({ types: types.data?.types, workers: workers.data?.workers, testsAnswer: testsAnswerOf(tests), payoutsAnswer: testsAnswerOf(payouts) }),
    [types.data, workers.data, tests.data, tests.error, payouts.data, payouts.error],
  );
  const tabs = TABS.filter((t) => (t !== "tests" || shown.tests) && (t !== "payouts" || shown.payouts));
  const tab: Tab = tabs.includes(place.tab) ? place.tab : "queue";
  // Strut's own admin pages act as the person viewing them: with the bare
  // key and no name, every step refuses.
  const refused = [types.error, workers.error].find((e) => e && /is an admin's/.test(e instanceof Error ? e.message : String(e)));

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-5 bg-background p-4 text-foreground sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <Users className="size-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Tasks and workers</h1>
        <span className="hidden text-sm text-muted-foreground md:inline">The people who answer this server's workflows, and what they answered.</span>
        <Button variant="ghost" size="icon-sm" className="ml-auto" title="Read again" onClick={() => void qc.invalidateQueries({ queryKey: ["staff"] })}>
          <RefreshCw className={cn((types.isFetching || workers.isFetching) && "animate-spin")} />
        </Button>
      </header>

      <nav className="flex flex-wrap gap-1 border-b" aria-label="Tabs">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={t === tab}
            onClick={() => go({ tab: t })}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              t === tab ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </nav>

      {refused ? (
        <ErrorLine
          error={`This page acts as the admin viewing it, and has no name to act as. Open it signed in as an admin of this server (an admin's session, or the deployment key with x-strut-actor). ${refused instanceof Error ? refused.message : String(refused)}`}
        />
      ) : (
        <main className="flex min-w-0 flex-col gap-5">
          {tab === "queue" && <Queue go={go} />}
          {tab === "types" && <Types go={go} place={place} shown={shown} types={types.data?.types} workers={workers.data?.workers} error={types.error} />}
          {tab === "workers" && <Workers go={go} place={place} shown={shown} types={types.data?.types} workers={workers.data?.workers} error={workers.error} />}
          {tab === "tasks" && <Tasks go={go} place={place} shown={shown} types={types.data?.types} workers={workers.data?.workers} />}
          {tab === "tests" && shown.tests && <Tests go={go} place={place} types={types.data?.types} />}
          {tab === "payouts" && shown.payouts && <Payouts go={go} place={place} workers={workers.data?.workers} />}
        </main>
      )}
    </div>
  );
}
