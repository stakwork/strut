// strut/staff (plans/human-steps.md §9, specs/API.md §14.15): the task
// store's staff routes as a page, for an ADMIN — strut's own UI lists it in
// Apps, a host (Stadeum) frames it for a person it signed in as an admin.
// Six tabs, one a job: the Overview (what needs a person, and how the work
// goes), the Answers (every task and what was answered — one by one, or by
// the groups a workflow put them in with task/reply's group — and the
// verdict on each), the Workers (letting them in, what they did and earned),
// the Task types (who draws them, the answer's shape, pay, tests, copies),
// the Payouts (workers' withdrawals: the switch, the caps, the list) and
// Support (the chat with workers, plans/support-chat.md, with its unread
// count on the tab; its tables are this app's own SQLite,
// plans/people-and-hosts.md §5). A type's Tests open from the type. Every
// place is deep-linkable as before (`?input=tab=…`, `type=`, `worker=`,
// `task=`, `group=`, `test=`, `run=`, `payout=`, `tab=support&worker=`).
// Invite a worker is in the header, on every tab. Every call
// to the task store is a `staff/*` step, which answers only strut's own page
// shown to an admin with a name; the page is only a face, the routes decide.
// Support's are SQL on the app's own tables and its `support/*` tools. Parts of items 4
// (tests, standing, copies) and 5a (pay, earnings) show only when the server
// answers for them (§9.7).
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, UserPlus, Users } from "lucide-react";
import { useAppLink, useChannel, useHost, useNames, useSql, useStrutClient, useToolInput } from "@strut/kit";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NAV, NAV_LABELS, inputOf, navOf, placeOf, shownOf, testsAnswerOf, toReviewOf, type NavTab, type Place } from "./lib/view";
import type { TaskStats, TaskType, Test, TypeShare, Worker } from "./lib/types";
import { Count, ErrorLine } from "./components/bits";
import { Overview } from "./components/Overview";
import { Answers } from "./components/Answers";
import { InvitePanel } from "./components/Share";
import { Types } from "./components/Types";
import { Workers } from "./components/Workers";
import { Tests } from "./components/Tests";
import { Payouts } from "./components/Payouts";
import { Support } from "./components/Support";
import { COUNTS_SQL, SUPPORT_CHANNEL, SUPPORT_REFETCH_MS } from "./lib/support";

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

  const types = useQuery({ queryKey: ["staff", "types"], queryFn: () => client.run<{ types: TaskType[]; tasks?: TypeShare }>("staff/types", {}) });
  const workers = useQuery({ queryKey: ["staff", "workers"], queryFn: () => client.run<{ workers: Worker[] }>("staff/workers", {}) });
  // Their names (plans/people-and-hosts.md §1), asked once for the list;
  // each worker carries theirs for `whoOf`, after the staff's own note.
  const names = useNames(workers.data?.workers.map((w) => w.actor)).data;
  const listed = useMemo(() => workers.data?.workers.map((w) => (names?.[w.actor] ? { ...w, name: names[w.actor] } : w)), [workers.data, names]);
  // Whether the test routes answer here (item 4): the Tests tab's own read.
  const tests = useQuery({ queryKey: ["staff", "tests", "all"], queryFn: () => client.run<{ tests: Test[] }>("staff/tests", {}) });
  // Whether any workflow named a group (`task/reply`'s `group`): the Groups tab shows once one did.
  const groups = useQuery({ queryKey: ["staff", "groups", "any"], queryFn: () => client.run<{ groups: unknown[] }>("staff/groups", { limit: 1 }), retry: false });
  // Whether the payout routes answer here (item 5b): the Payouts tab's own read.
  const payouts = useQuery({ queryKey: ["staff", "payouts", "any"], queryFn: () => client.run("staff/payouts", { limit: 1 }) });
  // Support (plans/people-and-hosts.md §5): its tables are this app's own
  // SQLite. Shown where the wallet is a Sphinx daemon with its message token,
  // or Support already has a conversation; its unread count on the tab, read
  // again when the app's channel says a DM came, and every 30 s besides. The
  // channel also says when an invite was used.
  const wallet = useQuery({
    queryKey: ["staff", "wallet"],
    queryFn: () => client.run<{ wallet?: { provider?: string | null; messages?: boolean } }>("earnings/read", { wallet: true, days: 1 }),
    retry: false,
    staleTime: Infinity,
  });
  const counts = useSql<{ conversations: number; unread: number }>(COUNTS_SQL, undefined, { refetchInterval: SUPPORT_REFETCH_MS });
  const supportAnswer = wallet.data?.wallet?.messages === true || (counts.data?.rows[0]?.conversations ?? 0) > 0 ? "yes" : "no";
  const shown = useMemo(
    () => shownOf({ types: types.data?.types, workers: listed, testsAnswer: testsAnswerOf(tests), payoutsAnswer: testsAnswerOf(payouts), supportAnswer }),
    [types.data, listed, tests.data, tests.error, payouts.data, payouts.error, supportAnswer],
  );
  // Joined whatever tab is open: a worker signing up with an invite says
  // `invites` here, and the Share block and Workers tab read them again.
  useChannel(SUPPORT_CHANNEL, {
    onMessage: (m) => {
      void qc.invalidateQueries({ queryKey: ["strut", "sqlite"] });
      if (m.key === "invites") void qc.invalidateQueries({ queryKey: ["staff", "invites"] });
    },
  });
  // The queue's counts, for the tabs: the Overview reads them again every
  // 10 s while it shows, and every write reads them again.
  const stats = useQuery({ queryKey: ["staff", "stats"], queryFn: () => client.run<TaskStats>("staff/stats", {}), retry: false });
  const hasGroups = (groups.data?.groups.length ?? 0) > 0 || place.tab === "groups";
  const shownNav = NAV.filter((t) => (t !== "payouts" || shown.payouts) && (t !== "support" || shown.support));
  const unread = counts.data?.rows[0]?.unread ?? 0;
  // A place the server does not answer for (its tests, its payouts) opens the Overview.
  const here: Place = (place.tab === "tests" && !shown.tests) || (place.tab === "payouts" && !shown.payouts) || (place.tab === "support" && !shown.support) ? { tab: "queue" } : place;
  const nav = navOf(here.tab);
  const fresh = listed?.filter((w) => w.status === "new").length ?? 0;
  const toReview = shown.review ? (toReviewOf(stats.data) ?? 0) : 0;
  /** Where a tab opens: the answers by group once a workflow named one. */
  const open = (t: NavTab) => go(t === "tasks" && hasGroups ? { tab: "groups" } : { tab: t });
  // Invite a worker, from any tab: open, and the kind of work picked first
  // when a type's card asked. Kept mounted once opened, so an invite just
  // made stays on its card.
  const [invite, setInvite] = useState<{ open: boolean; pick?: string } | null>(null);
  // Strut's own admin pages act as the person viewing them: with the bare
  // key and no name, every step refuses.
  const refused = [types.error, workers.error].find((e) => e && /is an admin's/.test(e instanceof Error ? e.message : String(e)));
  const share = types.data?.tasks ? { tasks: types.data.tasks } : {};

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-5 bg-background p-4 text-foreground sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <Users className="size-5 text-muted-foreground" />
        <h1 className="text-base font-semibold">Workers</h1>
        <div className="ml-auto flex items-center gap-2">
          {!refused && types.data && (
            <Button variant="outline" size="sm" aria-expanded={!!invite?.open} onClick={() => setInvite((i) => ({ open: !i?.open }))} data-testid="invite-a-worker">
              <UserPlus /> Invite a worker
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" title="Read again" aria-label="Read again" onClick={() => void qc.invalidateQueries({ queryKey: ["staff"] })}>
            <RefreshCw className={cn((types.isFetching || workers.isFetching) && "animate-spin")} />
          </Button>
        </div>
      </header>

      <nav className="-mx-4 flex gap-1 overflow-x-auto border-b px-4 [scrollbar-width:none] sm:mx-0 sm:px-0" aria-label="Tabs">
        {shownNav.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={t === nav}
            onClick={() => open(t)}
            className={cn(
              "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap",
              t === nav ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {NAV_LABELS[t]}
            {t === "tasks" && toReview > 0 && <Count n={toReview} label={`${toReview} to review`} />}
            {t === "workers" && fresh > 0 && <Count n={fresh} warn label={`${fresh} waiting to be let in`} />}
            {t === "support" && unread > 0 && <Count n={unread} warn label={`${unread} unread`} />}
          </button>
        ))}
      </nav>

      {refused ? (
        <ErrorLine
          error={`This page acts as the admin viewing it, and has no name to act as. Open it signed in as an admin of this server (an admin's session, or the deployment key with x-strut-actor). ${refused instanceof Error ? refused.message : String(refused)}`}
        />
      ) : (
        <main className="flex min-w-0 flex-col gap-5">
          {invite && types.data && (
            <div hidden={!invite.open}>
              <InvitePanel key={invite.pick ?? ""} types={types.data.types} {...share} {...(invite.pick ? { pick: invite.pick } : {})} onClose={() => setInvite((i) => ({ ...i, open: false }))} />
            </div>
          )}
          {here.tab === "queue" && <Overview go={go} shown={shown} hasGroups={hasGroups} types={types.data?.types} />}
          {(here.tab === "tasks" || here.tab === "groups") && <Answers go={go} place={here} shown={shown} hasGroups={hasGroups} types={types.data?.types} workers={listed} stats={stats.data} />}
          {here.tab === "types" && (
            <Types go={go} place={here} shown={shown} types={types.data?.types} {...share} workers={listed} error={types.error} invite={(pick) => setInvite({ open: true, pick })} />
          )}
          {here.tab === "workers" && <Workers go={go} place={here} shown={shown} types={types.data?.types} workers={listed} error={workers.error} />}
          {here.tab === "tests" && <Tests go={go} place={here} types={types.data?.types} />}
          {here.tab === "payouts" && <Payouts go={go} place={here} workers={listed} />}
          {here.tab === "support" && <Support go={go} place={here} shown={shown} workers={listed} />}
        </main>
      )}
    </div>
  );
}
