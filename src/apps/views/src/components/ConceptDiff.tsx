import { useEffect, useMemo, useState } from "react";
import { ArrowRight, FileText, GitCommitHorizontal, GitCompare, History } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  attributeText, conceptPagePath, foldConceptDiff, foldDiffLines, lineDiff, useStrutClient,
  type AttributeChange, type ConceptChange, type ConceptDiffNode, type ConceptEntry, type ConceptPage, type ConceptStatus,
} from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { displayActor, errorText, fmtTime } from "../lib/format";
import {
  HISTORY_STEP, PROPOSAL_GET_STEP, commitReads, compareReads, readDiff, readEntry, readLog, readPage, readProposalEntry,
  type HistoryCommit, type ProposalRecord,
} from "../lib/history";
import { DocumentView } from "./DocumentView";

export interface ConceptDiffProps {
  /** Draw these entries — any source: a history diff, a proposal laid over its page, an unsaved edit… */
  entries?: ConceptEntry[];
  /** …or read the tree between two moments: commits or times (ISO 8601, epoch ms), `main` for now. */
  from?: string;
  to?: string;
  /** The folder the moments are read in: `concepts` (the backend's own namespace) by default. */
  path?: string;
  /** …or a pending proposal, by id, laid over the page as it is now. */
  proposal?: string;
  /** …or ONE page's history: its name (or its path in the history). */
  page?: { name?: string; path?: string };
  /** The live tree's parents by name, so a parent the diff lacks climbs to its root. */
  parentsOf?: (name: string) => readonly string[] | undefined;
  /** Leave pages that did not change out. */
  hideUnchanged?: boolean;
  /** A page opened (its path), when the caller holds it. */
  selected?: string | null;
  onSelect?: (change: ConceptChange | null) => void;
  /** A run named on a commit was clicked. */
  onOpenRun?: (runId: string) => void;
  /** Most commits a page's history lists. */
  limit?: number;
  className?: string;
}

/** How each status is drawn: the tree's dot, the label, the badge. */
export const CONCEPT_STATUS: Record<ConceptStatus, { label: string; dot: string; badge: string }> = {
  added: { label: "added", dot: "bg-emerald-500", badge: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  removed: { label: "removed", dot: "bg-red-500", badge: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300" },
  renamed: { label: "renamed", dot: "bg-violet-500", badge: "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300" },
  moved: { label: "moved", dot: "bg-sky-500", badge: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  edited: { label: "edited", dot: "bg-amber-500", badge: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300" },
  unchanged: { label: "unchanged", dot: "bg-muted-foreground/40", badge: "text-muted-foreground" },
};

const ADD = "bg-emerald-500/10 text-emerald-900 dark:text-emerald-100";
const DEL = "bg-red-500/10 text-red-900 dark:text-red-100";

function StatusBadge({ status }: { status: ConceptStatus }) {
  const s = CONCEPT_STATUS[status];
  return (
    <Badge variant="outline" className={cn("h-5 px-1.5 text-[11px] font-normal", s.badge)}>
      {s.label}
    </Badge>
  );
}

function Problem({ error }: { error: unknown }) {
  const noHistory = !!(error as { noHistory?: boolean } | null)?.noHistory;
  return (
    <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="concept-diff-problem">
      {noHistory ? errorText(error) : `Couldn't read the history: ${errorText(error)}`}
    </p>
  );
}

/**
 * Two states of the Concept tree drawn as one (plans/concept-history.md §8
 * item 4): the tree with each page marked added, removed, renamed, moved or
 * edited, and a page opening to what changed — its name, its parents, its
 * attributes, its docs line by line. The two states come from anywhere —
 * two commits or two times in the HISTORY (`history/read`), a PENDING
 * PROPOSAL laid over the page as it is now (`proposal/get`), a person's
 * unsaved edit (`entries`) — and are drawn the same way. Given a page, its
 * HISTORY instead: every commit that changed it (followed through renames),
 * a click drawing what that commit did, two ticked compared.
 */
export function ConceptDiff(props: ConceptDiffProps) {
  if (props.page) return <ConceptHistory {...props} page={props.page} />;
  return <ConceptTreeDiff {...props} />;
}

function ConceptTreeDiff({ entries, from, to, path, proposal, parentsOf, hideUnchanged, selected, onSelect, className }: ConceptDiffProps) {
  const client = useStrutClient();
  const moments = !entries && !proposal && !!from && !!to;
  const diffQ = useQuery({
    queryKey: ["strut", HISTORY_STEP, "diff", from, to, path ?? "concepts"],
    queryFn: () => readDiff(client, { from: from!, to: to!, ...(path ? { path } : {}) }),
    enabled: moments,
    staleTime: 30_000,
  });
  const proposalQ = useQuery({
    queryKey: ["strut", PROPOSAL_GET_STEP, proposal, "entry"],
    queryFn: () => readProposalEntry(client, proposal!),
    enabled: !entries && !!proposal,
    staleTime: 10_000,
  });
  const source = entries ?? (proposal ? (proposalQ.data?.entry ? [proposalQ.data.entry] : proposalQ.data ? [] : undefined) : diffQ.data?.entries);
  const diff = useMemo(() => (source ? foldConceptDiff(source, { ...(parentsOf ? { parentsOf } : {}), ...(hideUnchanged ? { hideUnchanged } : {}) }) : null), [source, parentsOf, hideUnchanged]);
  const [own, setOwn] = useState<string | null>(null);
  const openPath = selected !== undefined ? selected : own;
  const open = diff?.pages.find((p) => p.path === openPath) ?? diff?.pages.find((p) => p.status !== "unchanged") ?? null;
  const pick = (c: ConceptChange) => {
    setOwn(c.path);
    onSelect?.(c);
  };

  const q = proposal ? proposalQ : diffQ;
  if (!entries && !proposal && !moments) return <p className={cn("text-sm text-muted-foreground", className)}>Nothing to compare: give two moments, a proposal or the entries.</p>;
  if (!entries && q.isError) return <Problem error={q.error} />;
  if (!diff) return <Skeleton className={cn("h-40", className)} />;
  const changed = diff.pages.filter((p) => p.status !== "unchanged").length;
  return (
    // A container: the tree beside the page only where the box itself is wide, not the window (a card, a panel).
    <div className={cn("@container/diff flex min-w-0 flex-col gap-3 text-sm", className)} data-testid="concept-diff">
      {proposalQ.data && <ProposalHead proposal={proposalQ.data.proposal} />}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {changed === 0 ? (
          <span className="text-muted-foreground">{proposal ? "This proposal changes no Concept page." : "No page changed."}</span>
        ) : (
          (Object.keys(CONCEPT_STATUS) as ConceptStatus[])
            .filter((s) => s !== "unchanged" && diff.counts[s])
            .map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5">
                <span className={cn("size-2 rounded-full", CONCEPT_STATUS[s].dot)} />
                {diff.counts[s]} {CONCEPT_STATUS[s].label}
              </span>
            ))
        )}
        {diffQ.data?.more && <span className="text-muted-foreground">· more pages changed than are shown</span>}
      </div>
      {changed > 0 && (
        <div className="grid min-w-0 gap-4 @xl/diff:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)]">
          <nav className="min-w-0 rounded-md border py-1" aria-label="Changed pages" data-testid="concept-diff-tree">
            {diff.tree.map((n) => (
              <TreeRow key={n.key} node={n} depth={0} open={open?.path ?? null} onPick={pick} />
            ))}
          </nav>
          <div className="min-w-0">{open ? <PageDiff change={open} /> : null}</div>
        </div>
      )}
    </div>
  );
}

function ProposalHead({ proposal }: { proposal: ProposalRecord }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="font-medium">{proposal.title || proposal.step}</span>
        {proposal.status && <Badge variant="outline" className="h-5 px-1.5 text-[11px] font-normal">{proposal.status}</Badge>}
      </div>
      {proposal.rationale && <p className="text-xs text-muted-foreground">{proposal.rationale}</p>}
    </div>
  );
}

function TreeRow({ node, depth, open, onPick }: { node: ConceptDiffNode; depth: number; open: string | null; onPick: (c: ConceptChange) => void }) {
  const c = node.change;
  const live = !!c && c.status !== "unchanged";
  return (
    <>
      <button
        type="button"
        disabled={!c}
        onClick={() => c && onPick(c)}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 py-1 pr-2 text-left",
          c ? "hover:bg-muted/60" : "cursor-default text-muted-foreground",
          c && open === c.path && "bg-primary/10 ring-1 ring-inset ring-primary/40",
        )}
        style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}
        title={c?.nameBefore ? `${c.nameBefore} → ${c.name}` : node.name}
        data-testid="concept-diff-row"
        data-status={node.context ? "context" : node.status}
      >
        <span className={cn("size-2 shrink-0 rounded-full", node.context ? "border border-muted-foreground/50" : CONCEPT_STATUS[node.status].dot)} />
        <span className={cn("min-w-0 flex-1 truncate", node.status === "removed" && "line-through decoration-red-500/60", live && "font-medium")}>{node.name}</span>
        {live && <span className="shrink-0 text-[11px] text-muted-foreground">{c!.marks.length > 1 ? c!.marks.join(" · ") : CONCEPT_STATUS[c!.status].label}</span>}
      </button>
      {node.children.map((k) => (
        <TreeRow key={k.key} node={k} depth={depth + 1} open={open} onPick={onPick} />
      ))}
    </>
  );
}

function Names({ names, tone }: { names: readonly string[]; tone?: "add" | "del" }) {
  if (!names.length) return <span className="text-xs text-muted-foreground">none</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {names.map((n) => (
        <span key={n} className={cn("rounded border px-1.5 py-0.5 text-xs", tone === "add" && ADD, tone === "del" && cn(DEL, "line-through"))}>
          {n}
        </span>
      ))}
    </span>
  );
}

/** One page's change: its name, its parents, its attributes, its docs line by line. */
export function PageDiff({ change, className }: { change: ConceptChange; className?: string }) {
  const [all, setAll] = useState(false);
  const { before, after } = change;
  const docsLines = useMemo(() => {
    if (!change.docs && before && after) return null;
    return lineDiff(before?.docs, after?.docs);
  }, [change, before, after]);
  const shown = docsLines ? (all ? docsLines : foldDiffLines(docsLines, 3)) : null;
  const attrs: AttributeChange[] = before && after ? change.attributes : Object.entries((after ?? before)!.attributes).map(([name, v]) => (after ? { name, after: v } : { name, before: v }));
  const parentsBefore = change.parentsBefore ?? (after ? undefined : before?.parents);
  const parentsAfter = change.parentsAfter ?? after?.parents;
  return (
    <article className={cn("flex min-w-0 flex-col gap-3", className)} data-testid="page-diff">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {change.nameBefore && (
          <>
            <span className="text-base font-semibold text-muted-foreground line-through decoration-red-500/60">{change.nameBefore}</span>
            <ArrowRight className="size-3.5 self-center text-muted-foreground" />
          </>
        )}
        <h3 className={cn("text-base font-semibold", change.status === "removed" && "line-through decoration-red-500/60")}>{change.name}</h3>
        {(change.marks.length ? change.marks : [change.status]).map((m) => (
          <StatusBadge key={m} status={m} />
        ))}
        {change.paired && <span className="text-[11px] text-muted-foreground" title="Git saw a page removed and another added; their parents and words match">paired by content</span>}
      </header>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 text-xs">
        <dt className="pt-0.5 text-muted-foreground">Parents</dt>
        <dd className="flex flex-wrap items-center gap-1.5">
          {change.parentsBefore ? (
            <>
              <Names names={parentsBefore!.filter((p) => !parentsAfter!.includes(p))} tone="del" />
              <Names names={parentsAfter!.filter((p) => !parentsBefore!.includes(p))} tone="add" />
              {parentsAfter!.filter((p) => parentsBefore!.includes(p)).length > 0 && <Names names={parentsAfter!.filter((p) => parentsBefore!.includes(p))} />}
            </>
          ) : (
            <Names names={(parentsAfter ?? parentsBefore)!} {...(change.status === "added" ? { tone: "add" as const } : change.status === "removed" ? { tone: "del" as const } : {})} />
          )}
        </dd>
        {attrs.map((a) => (
          <div key={a.name} className="contents">
            <dt className="pt-0.5 text-muted-foreground">{a.name}</dt>
            <dd className="flex min-w-0 flex-col gap-1">
              {a.before !== undefined && <span className={cn("rounded px-1.5 py-0.5 break-words line-through decoration-red-500/40", DEL)}>{attributeText(a.before)}</span>}
              {a.after !== undefined && <span className={cn("rounded px-1.5 py-0.5 break-words", ADD)}>{attributeText(a.after)}</span>}
            </dd>
          </div>
        ))}
      </dl>

      <section className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Docs
          {shown && docsLines && docsLines.some((l) => l.op === "same") && (
            <button type="button" onClick={() => setAll(!all)} className="font-normal normal-case tracking-normal underline-offset-2 hover:underline">
              {all ? "fold unchanged" : "show every line"}
            </button>
          )}
        </div>
        {!shown ? (
          <p className="text-xs text-muted-foreground">{before?.docs || after?.docs ? "Unchanged." : "None."}</p>
        ) : !docsLines!.length ? (
          <p className="text-xs text-muted-foreground">None.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border font-mono text-xs" data-testid="docs-diff">
            {shown.map((l, i) =>
              l.op === "gap" ? (
                <button key={i} type="button" onClick={() => setAll(true)} className="block w-full bg-muted/40 px-2 py-0.5 text-left text-muted-foreground hover:bg-muted">
                  ⋯ {l.count} unchanged line{l.count === 1 ? "" : "s"}
                </button>
              ) : (
                <div key={i} className={cn("grid grid-cols-[2.5rem_1rem_minmax(0,1fr)]", l.op === "add" && ADD, l.op === "del" && DEL)}>
                  <span className="select-none pr-1 text-right text-muted-foreground/70">{l.op === "add" ? l.b : l.a}</span>
                  <span className="select-none text-center text-muted-foreground">{l.op === "add" ? "+" : l.op === "del" ? "−" : ""}</span>
                  <span className="whitespace-pre-wrap break-words pr-2">{l.text || " "}</span>
                </div>
              ),
            )}
          </div>
        )}
      </section>
    </article>
  );
}

/** A page as it was: its parents, its attributes, its docs. */
export function PageView({ page, className }: { page: ConceptPage; className?: string }) {
  return (
    <article className={cn("flex min-w-0 flex-col gap-3", className)} data-testid="page-view">
      <h3 className="text-base font-semibold">{page.name}</h3>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
        <dt className="text-muted-foreground">Parents</dt>
        <dd>
          <Names names={page.parents} />
        </dd>
        {Object.entries(page.attributes).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="break-words">{attributeText(v)}</dd>
          </div>
        ))}
      </dl>
      {page.docs ? (
        <DocumentView text={page.docs} kind="markdown" className="[&>div]:max-h-none [&>div]:overflow-visible" />
      ) : (
        <p className="text-xs text-muted-foreground">No docs.</p>
      )}
    </article>
  );
}

const shortId = (id: string) => id.slice(0, 7);
/** A commit names at most this many of the runs that wrote it; the rest are a count. */
const RUNS_SHOWN = 2;

/** One page's history: every commit that changed it, newest first. */
function ConceptHistory({ page, limit = 20, onOpenRun, className }: ConceptDiffProps & { page: { name?: string; path?: string } }) {
  const client = useStrutClient();
  const pathQ = useQuery({
    queryKey: ["strut", "concept-page-path", page.path ?? page.name],
    queryFn: async () => page.path ?? (page.name ? await conceptPagePath(page.name) : null),
  });
  const path = pathQ.data ?? null;
  const logQ = useQuery({
    queryKey: ["strut", HISTORY_STEP, "log", path, limit],
    queryFn: () => readLog(client, { path: path!, limit }),
    enabled: !!path,
    staleTime: 15_000,
  });
  const commits = logQ.data?.commits ?? [];
  const shownCommits = commits.slice(0, limit);
  const [row, setRow] = useState(0);
  const [ticked, setTicked] = useState<number[]>([]);
  const [then, setThen] = useState(false);
  useEffect(() => {
    setRow(0);
    setTicked([]);
  }, [path]);
  const reads = ticked.length === 2 ? compareReads(commits, ticked[0]!, ticked[1]!) : commitReads(commits, row);
  const entryQ = useQuery({
    queryKey: ["strut", HISTORY_STEP, "entry", path, reads.before?.at, reads.before?.path, reads.after?.at, reads.after?.path],
    queryFn: () => readEntry(client, reads),
    enabled: !!(reads.before || reads.after) && !then,
    staleTime: Infinity,
  });
  const thenQ = useQuery({
    queryKey: ["strut", HISTORY_STEP, "show", commits[row]?.changes[0]?.path, commits[row]?.id],
    queryFn: () => readPage(client, commits[row]!.changes[0]!.path, commits[row]!.id),
    enabled: then && !!commits[row]?.changes[0] && commits[row]!.changes[0]!.status !== "deleted",
    staleTime: Infinity,
  });
  const change = useMemo(() => (entryQ.data ? foldConceptDiff([entryQ.data]).pages[0] : undefined), [entryQ.data]);

  if (pathQ.isSuccess && !path) return <p className={cn("text-sm text-muted-foreground", className)}>This page's name has no file in the history.</p>;
  if (logQ.isError) return <Problem error={logQ.error} />;
  if (!logQ.data) return <Skeleton className={cn("h-32", className)} />;
  if (!shownCommits.length) return <p className={cn("text-sm text-muted-foreground", className)}>No history for this page yet.</p>;

  const toggle = (i: number) =>
    setTicked((t) => {
      const next = t.includes(i) ? t.filter((x) => x !== i) : [...t, i].slice(-2);
      if (next.length) setRow(next[next.length - 1]!);
      return next;
    });
  return (
    <div className={cn("flex min-w-0 flex-col gap-3 text-sm", className)} data-testid="concept-history">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <History className="size-3.5" />
        <span className="flex-1">{ticked.length === 2 ? "Comparing the two ticked" : "Tick two to compare them"}</span>
        {ticked.length > 0 && (
          <button type="button" onClick={() => setTicked([])} className="hover:text-foreground">
            clear
          </button>
        )}
      </div>
      <ol className="flex flex-col rounded-md border" data-testid="concept-history-commits">
        {shownCommits.map((c, i) => {
          const ch = c.changes[0];
          const active = ticked.length === 2 ? ticked.includes(i) : row === i;
          return (
            <li key={c.id} className={cn("flex min-w-0 items-start gap-2 border-b px-2 py-1.5 last:border-b-0", active && "bg-primary/10")}>
              <input type="checkbox" className="mt-1 shrink-0" checked={ticked.includes(i)} onChange={() => toggle(i)} aria-label={`Compare ${shortId(c.id)}`} />
              <button
                type="button"
                className="flex min-w-0 flex-1 flex-col text-left"
                onClick={() => {
                  setTicked([]);
                  setRow(i);
                }}
                data-testid="concept-history-commit"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{c.subject}</span>
                </span>
                <span className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
                  <span>{fmtTime(c.time)}</span>
                  <span>· {displayActor(c.author)}</span>
                  {ch && ch.status !== "modified" && <span>· {ch.status === "deleted" ? "removed" : ch.status}</span>}
                  <span className="font-mono">· {shortId(c.id)}</span>
                </span>
              </button>
              {/* The runs that wrote: the subject names the first; a click opens one when the importer can. */}
              {(onOpenRun ? c.runs.length > 0 : c.runs.length > 1) && (
                <span className="flex max-w-[40%] shrink-0 flex-wrap justify-end gap-1">
                  {c.runs.slice(0, RUNS_SHOWN).map((r) =>
                    onOpenRun ? (
                      <button key={r} type="button" onClick={() => onOpenRun(r)} className="rounded border px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground" title={`Open run ${r}`}>
                        run {r.slice(-6)}
                      </button>
                    ) : (
                      <span key={r} className="text-[11px] text-muted-foreground" title={`Run ${r}`}>
                        run {r.slice(-6)}
                      </span>
                    ),
                  )}
                  {c.runs.length > RUNS_SHOWN && (
                    <span className="text-[11px] text-muted-foreground" title={c.runs.slice(RUNS_SHOWN).join(", ")}>
                      +{c.runs.length - RUNS_SHOWN} runs
                    </span>
                  )}
                </span>
              )}
            </li>
          );
        })}
        {(logQ.data.more || commits.length > limit) && <li className="px-2 py-1 text-[11px] text-muted-foreground">Older commits not shown.</li>}
      </ol>
      {ticked.length < 2 && (
        <div className="flex gap-1">
          {[false, true].map((t) => (
            <Button key={String(t)} size="xs" variant={then === t ? "secondary" : "ghost"} onClick={() => setThen(t)}>
              {t ? <FileText /> : <GitCompare />}
              {t ? "The page then" : "What changed"}
            </Button>
          ))}
        </div>
      )}
      {then && ticked.length < 2 ? (
        thenQ.data ? <PageView page={thenQ.data} /> : thenQ.isFetching ? <Skeleton className="h-24" /> : <p className="text-xs text-muted-foreground">The page was removed in this commit.</p>
      ) : entryQ.isError ? (
        <Problem error={entryQ.error} />
      ) : change ? (
        <PageDiff change={change} />
      ) : entryQ.isFetching ? (
        <Skeleton className="h-24" />
      ) : (
        <p className="text-xs text-muted-foreground">Nothing to compare.</p>
      )}
    </div>
  );
}
