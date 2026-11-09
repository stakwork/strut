// The tree between two moments (plans/concept-history.md §8 item 4): the
// Concept pages that changed from one to the other, marked on the tree
// (strut/views' ConceptDiff over `history/read diff`). A moment is typed —
// `now`, `1 day ago`, a date, a commit — or picked from the recent changes,
// which are the history's commits, never the live change feed: that is a
// notification and empties on a restart.
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { GitCommitHorizontal, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useStrutClient } from "@strut/kit";
import { ConceptDiff, HISTORY_STEP, readLog } from "strut/views";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { DEFAULT_FROM, DEFAULT_TO, momentOf } from "../lib/moments";
import type { ConceptTree } from "../lib/tree";
import { SectionLabel } from "./bits";

/** The recent commits listed beside the diff. */
const RECENT = 15;

export function Changes({ tree, onClose, narrow, lead }: { tree?: ConceptTree; onClose: () => void; narrow: boolean; lead?: ReactNode }) {
  const client = useStrutClient();
  const [fromText, setFromText] = useState(DEFAULT_FROM);
  const [toText, setToText] = useState(DEFAULT_TO);
  // Read once the box is left, so typing a date does not read every half of it.
  const [moments, setMoments] = useState(() => ({ from: momentOf(DEFAULT_FROM)!, to: momentOf(DEFAULT_TO)! }));
  const [commit, setCommit] = useState<string | null>(null);
  const settle = () => {
    const from = momentOf(fromText);
    const to = momentOf(toText);
    if (from && to) {
      setMoments({ from, to });
      setCommit(null);
    }
  };
  const recent = useQuery({
    queryKey: ["strut", HISTORY_STEP, "log", "concepts", RECENT],
    queryFn: () => readLog(client, { path: "concepts", limit: RECENT }),
    staleTime: 15_000,
  });
  const commits = recent.data?.commits ?? [];
  // A commit's change: from the commit before it that touched the tree, to it.
  const pickCommit = (i: number) => {
    const c = commits[i]!;
    const before = commits[i + 1];
    setCommit(c.id);
    setFromText(before ? before.id.slice(0, 12) : "");
    setToText(c.id.slice(0, 12));
    setMoments({ from: before?.id ?? new Date(Date.parse(c.time) - 1000).toISOString(), to: c.id });
  };

  const byName = useMemo(() => {
    const m = new Map<string, string[]>();
    if (!tree) return m;
    for (const [id, c] of Object.entries(tree.nodes)) m.set(c.name, (tree.parents[id] ?? []).map((p) => tree.nodes[p]?.name ?? p));
    return m;
  }, [tree]);
  const parentsOf = useCallback((name: string) => byName.get(name), [byName]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="changes">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        {lead}
        <h2 className="text-sm font-semibold">Changes</h2>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          from
          <Input className="h-8 w-36 text-xs" value={fromText} onChange={(e) => setFromText(e.target.value)} onBlur={settle} onKeyDown={(e) => e.key === "Enter" && settle()} aria-label="From" placeholder="1 day ago" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          to
          <Input className="h-8 w-36 text-xs" value={toText} onChange={(e) => setToText(e.target.value)} onBlur={settle} onKeyDown={(e) => e.key === "Enter" && settle()} aria-label="To" placeholder="now" />
        </label>
        {(!momentOf(fromText) || !momentOf(toText)) && <span className="text-xs text-muted-foreground">a time (“2 days ago”, a date) or a commit</span>}
        <span className="flex-1" />
        <button type="button" onClick={onClose} aria-label="Close the changes" className="rounded p-1 text-muted-foreground hover:text-foreground">
          <X className="size-4" />
        </button>
      </header>
      <div className={cn("flex min-h-0 flex-1", narrow && "flex-col overflow-y-auto")}>
        <aside className={cn("shrink-0 overflow-y-auto", narrow ? "border-b p-3" : "w-64 border-r p-3")} data-testid="recent-changes">
          <SectionLabel>Recent changes</SectionLabel>
          {recent.isError && <p className="pt-2 text-xs text-muted-foreground">{recent.error instanceof Error ? recent.error.message : String(recent.error)}</p>}
          {recent.data && !commits.length && <p className="pt-2 text-xs text-muted-foreground">No Concept has changed yet.</p>}
          <ol className="flex flex-col gap-0.5 pt-1.5">
            {commits.slice(0, RECENT).map((c, i) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => pickCommit(i)}
                  className={cn("flex w-full flex-col rounded-md px-2 py-1 text-left hover:bg-muted/60", commit === c.id && "bg-primary/10 ring-1 ring-inset ring-primary/40")}
                  data-testid="recent-commit"
                >
                  <span className="flex min-w-0 items-center gap-1.5 text-xs">
                    <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{c.subject}</span>
                  </span>
                  <span className="pl-5 text-[11px] text-muted-foreground">
                    {new Date(c.time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {c.changes.length} page{c.changes.length === 1 ? "" : "s"}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </aside>
        <div className={cn("min-w-0 flex-1 p-4", !narrow && "overflow-y-auto")}>
          <ConceptDiff key={`${moments.from}|${moments.to}`} from={moments.from} to={moments.to} parentsOf={parentsOf} />
        </div>
      </div>
    </div>
  );
}
