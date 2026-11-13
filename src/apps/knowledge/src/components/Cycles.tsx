// What the dream did, afterwards (docs/knowledge.md "The dream"): its
// recent CYCLES, each with when it ran, the tree it tends, its LESSONS —
// what a person said, the claim it wrote, the change it made — and, opened,
// the diff of the commits that carry its run (strut/views' ConceptDiff over
// `history/read`). For the whole tree (a view in place of the graph) or for
// one Concept (a section of its card). An admin's alone: the lessons quote
// the conversations the dream read (`knowledge/cycles`).
import { useMemo, useState, type ReactNode } from "react";
import { AlertCircle, ChevronDown, Moon, X } from "lucide-react";
import { ConceptDiff } from "strut/views";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useCycleChange, useCycles, usePageRuns } from "../lib/read";
import { cycleWords, cyclesFor, cyclesUnavailable, type DreamCycle } from "../lib/cycles";
import { parentsByName, type ConceptTree } from "../lib/tree";
import { SectionLabel } from "./bits";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The tree's cycles, newest first, in place of the graph. */
export function CyclesView({ tree, onClose, lead }: { tree?: ConceptTree; onClose: () => void; lead?: ReactNode }) {
  const q = useCycles();
  const parentsOf = useMemo(() => parentsByName(tree), [tree]);
  const why = q.isError ? cyclesUnavailable(errorText(q.error)) : null;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="cycles">
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        {lead}
        <Moon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">What the dream learned</h2>
        <span className="flex-1" />
        <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-muted-foreground hover:text-foreground">
          <X className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex max-w-4xl flex-col gap-3">
          {q.isPending && <Skeleton className="h-24" />}
          {q.isError && <p className="text-sm text-muted-foreground">{why ?? "Only an admin of this server sees what the dream learned."}</p>}
          {q.data && !q.data.length && <p className="text-sm text-muted-foreground">The dream hasn't learned anything yet: no dream has read a conversation.</p>}
          {q.data?.map((c) => (
            <CycleCard key={c.run} cycle={c} parentsOf={parentsOf} showTree />
          ))}
        </div>
      </div>
    </div>
  );
}

/** The cycles about one Concept, in its card: a lesson's claim is on it, or the cycle changed its page. Nothing
 *  when there are none, or the viewer may not read them. */
export function ConceptCycles({ name, tree }: { name: string; tree?: ConceptTree }) {
  const q = useCycles();
  const runs = usePageRuns(q.data?.length ? name : undefined);
  const parentsOf = useMemo(() => parentsByName(tree), [tree]);
  const mine = useMemo(() => cyclesFor(q.data ?? [], name, runs.data), [q.data, name, runs.data]);
  if (!mine.length) return null;
  return (
    <section className="space-y-2" data-testid="concept-cycles">
      <SectionLabel>
        Learned by the dream <span className="tabular-nums">{mine.length}</span>
      </SectionLabel>
      {mine.map((c) => (
        <CycleCard key={c.run} cycle={c} parentsOf={parentsOf} only={name} />
      ))}
    </section>
  );
}

/** One cycle: when, which tree, what it learned; opened, what it changed. `only`: its lessons on that page alone,
 *  where it has any (a cycle here because its run changed the page keeps them all: they are why). */
function CycleCard({ cycle, parentsOf, showTree, only }: { cycle: DreamCycle; parentsOf: (name: string) => readonly string[] | undefined; showTree?: boolean; only?: string }) {
  const [open, setOpen] = useState(false);
  const lessons = only && cycle.lessons.some((l) => l.concept === only) ? cycle.lessons.filter((l) => l.concept === only) : cycle.lessons;
  const failed = cycle.status !== "success";
  return (
    <article className="space-y-2 rounded-lg border p-3" data-testid="cycle" data-run={cycle.run}>
      <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{when(cycle.startedAt)}</span>
        {showTree && cycle.tree && <span>· {cycle.tree}</span>}
        <span>· {cycleWords(cycle)}</span>
        {cycle.review && (
          <span className="rounded border px-1.5 text-[11px]" title="A person accepted or rejected each change this dream made">
            reviewed
          </span>
        )}
        {failed && <span className="rounded border border-rose-500/40 bg-rose-500/10 px-1.5 text-[11px] text-rose-700 dark:text-rose-300">{cycle.status}</span>}
      </header>
      {cycle.error && (
        <p className="flex items-start gap-1.5 text-xs text-rose-700 dark:text-rose-300">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">{cycle.error}</span>
        </p>
      )}
      {lessons.length > 0 && (
        <ul className="space-y-2.5">
          {lessons.map((l, i) => (
            <li key={`${l.session}-${l.turn}-${i}`} className="space-y-0.5 text-sm" data-testid="cycle-lesson">
              <p className="break-words italic text-muted-foreground">“{l.said}”</p>
              <p className="break-words">
                <span className="text-xs text-muted-foreground">Claim on {l.concept}: </span>
                {l.claim}
              </p>
              {l.change && (
                <p className="break-words">
                  <span className="text-xs text-muted-foreground">{cycle.review ? "Proposed: " : "Changed: "}</span>
                  {l.change}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {cycle.stuck.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-xs text-amber-800 dark:text-amber-300">Stuck: the page already says it, and it went wrong again</p>
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            {cycle.stuck.map((s, i) => (
              <li key={i} className="break-words">
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        data-testid="cycle-open"
      >
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        {open ? "Less" : "What it changed"}
      </button>
      {open && <CycleChange cycle={cycle} parentsOf={parentsOf} />}
    </article>
  );
}

/** The diff of the commits that carry the cycle's run; where nothing does, why. */
function CycleChange({ cycle, parentsOf }: { cycle: DreamCycle; parentsOf: (name: string) => readonly string[] | undefined }) {
  const q = useCycleChange(cycle.run);
  if (q.isPending) return <Skeleton className="h-24" />;
  if (q.isError) {
    const noHistory = !!(q.error as { noHistory?: boolean } | null)?.noHistory;
    return (
      <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="cycle-change-problem">
        {noHistory ? errorText(q.error) : `Couldn't read the history: ${errorText(q.error)}`}
      </p>
    );
  }
  if (!q.data.span) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="cycle-unchanged">
        {cycle.review
          ? "No page changed under this dream: its changes waited for a person, and what they accepted is in Changes as its own commit."
          : "No page changed under this dream."}
      </p>
    );
  }
  return <ConceptDiff from={q.data.span.from} to={q.data.span.to} parentsOf={parentsOf} hideUnchanged />;
}
