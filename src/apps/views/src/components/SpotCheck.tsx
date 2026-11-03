import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, Eye, PenLine, ScanSearch, Terminal } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { findHighlightRanges, highlightPieces, useStrutClient } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { errorText } from "../lib/format";
import {
  PROVENANCE_STEP, clock, landmarks, markTerms, momentPhrase, sameCell, subjectKey, subjectLabel, whoOf,
  type Provenance, type ProvenanceMoment, type ProvenanceSubject,
} from "../lib/provenance";

export interface SpotCheckProps {
  /** The run (`run/provenance` — its workflow in the importing app's `grants.workflows`). */
  workflow: string;
  runId: string;
  /** What was picked: a cell, a passage, a node, a file. */
  subject: ProvenanceSubject;
  /** "Show in the run": a moment's agent (or step) path, and when it happened. */
  onOpenStep?: (path: string, at: string) => void;
  /** A node a moment names was clicked. */
  onOpenNode?: (refId: string) => void;
  /** The trail moved to another subject (a cell a formula reads, a figure, back). */
  onSubject?: (subject: ProvenanceSubject) => void;
  className?: string;
}

const KIND: Record<ProvenanceMoment["kind"], { icon: typeof PenLine; dot: string }> = {
  wrote: { icon: PenLine, dot: "bg-sky-600 dark:bg-sky-400" },
  used: { icon: Terminal, dot: "bg-muted-foreground/60" },
  read: { icon: Eye, dot: "bg-emerald-600 dark:bg-emerald-400" },
};

/**
 * A SPOT CHECK: where one thing a run made came from (plans/spot-check.md) —
 * a sheet cell, a passage of a document, a graph node — read off the run's
 * own log by `run/provenance`. Its moments oldest first: where the run first
 * saw it, every time an agent wrote it (with the agent's words before the
 * write and the calls just before it), every time it was used or read back.
 * A cell a formula reads, a number a passage states, a cell a moment cites
 * is a spot check of its own: a click follows it, the back arrow returns.
 */
export function SpotCheck({ workflow, runId, subject, onOpenStep, onOpenNode, onSubject, className }: SpotCheckProps) {
  const client = useStrutClient();
  const [trail, setTrail] = useState<ProvenanceSubject[]>([subject]);
  const rootKey = subjectKey(subject);
  useEffect(() => setTrail([subject]), [rootKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = trail[trail.length - 1] ?? subject;
  const key = subjectKey(current);
  const q = useQuery({
    queryKey: ["strut", PROVENANCE_STEP, workflow, runId, key],
    queryFn: () => client.run<Provenance>(PROVENANCE_STEP, { workflow, runId, ...current }),
    staleTime: 60_000,
  });
  const follow = (s: ProvenanceSubject) => {
    setTrail((t) => [...t, s]);
    onSubject?.(s);
  };
  const back = () => {
    const prev = trail[trail.length - 2];
    if (!prev) return;
    setTrail((t) => t.slice(0, -1));
    onSubject?.(prev);
  };
  const p = q.data;
  const nodeName = p?.moments.find((m) => m.node?.ref_id === current.node)?.node?.name;
  const marks = useMemo(() => markTerms(current.value), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const { firstSeen, lastWrite } = useMemo(() => landmarks(p?.moments ?? []), [p]);
  const cellOf = (cell: string): ProvenanceSubject => ({ cell, ...(current.spreadsheet ? { spreadsheet: current.spreadsheet } : {}) });

  return (
    <div className={cn("flex min-w-0 flex-col gap-3 text-sm", className)} data-testid="spot-check">
      <div className="flex min-w-0 items-start gap-2">
        {trail.length > 1 ? (
          <Button size="icon-xs" variant="ghost" className="mt-0.5 shrink-0" onClick={back} aria-label="Back" title={`Back to ${subjectLabel(trail[trail.length - 2]!)}`}>
            <ArrowLeft />
          </Button>
        ) : (
          <ScanSearch className="mt-1 size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted-foreground">Spot check</div>
          <div className="font-medium break-words" data-testid="spot-check-subject">{subjectLabel(current, nodeName)}</div>
          {current.file && !current.cell && <div className="truncate text-xs text-muted-foreground">in {current.file.split("/").pop()}</div>}
        </div>
      </div>

      {q.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <p className="text-sm text-destructive">{errorText(q.error)}</p>
      ) : p ? (
        <>
          {(p.formula || p.refs.length > 0 || p.figures.length > 0) && (
            <div className="flex min-w-0 flex-col gap-1.5 rounded-md border bg-muted/30 p-2 text-xs" data-testid="spot-check-parts">
              {p.formula && <code className="font-mono break-all text-sky-700 dark:text-sky-400">{p.formula}</code>}
              {p.refs.length > 0 && (
                <Chips label={p.formula ? "Reads" : "Cites"}>
                  {p.refs.map((r) => <Chip key={r} onClick={() => follow(cellOf(r))}>{r}</Chip>)}
                </Chips>
              )}
              {p.literals.length > 0 && (
                <Chips label="Typed in">
                  {p.literals.map((l) => <Chip key={l} title={`${l} has no cell behind it — where did the run get it?`} onClick={() => follow({ value: l })}>{l}</Chip>)}
                </Chips>
              )}
              {p.figures.length > 0 && (
                <Chips label="Figures">
                  {p.figures.map((f) => <Chip key={f} onClick={() => follow({ value: f })}>{f}</Chip>)}
                </Chips>
              )}
            </div>
          )}
          {p.note && <p className="text-xs text-muted-foreground">{p.note}</p>}
          <ol className="flex min-w-0 flex-col" data-testid="spot-check-moments">
            {p.moments.map((m, i) => (
              <Moment
                key={`${m.path}/${m.kind}`}
                m={m}
                last={i === p.moments.length - 1}
                badge={i === firstSeen ? "first seen" : i === lastWrite ? (m.exact ? "last write" : "written") : undefined}
                marks={marks}
                subjectCell={current.cell}
                subjectNode={current.node}
                onCell={(c) => follow(cellOf(c))}
                onNode={(n) => (onOpenNode ? onOpenNode(n) : follow({ node: n }))}
                onOpenStep={onOpenStep}
              />
            ))}
          </ol>
          {p.omitted ? <p className="text-xs text-muted-foreground">{p.omitted} more moments left out — the exact ones are all here.</p> : null}
        </>
      ) : null}
    </div>
  );
}

function Chips({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function Chip({ children, onClick, title }: { children: ReactNode; onClick: () => void; title?: string }) {
  return (
    <button type="button" onClick={onClick} title={title ?? "Spot check this"} className="max-w-full truncate rounded border bg-background px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted">
      {children}
    </button>
  );
}

function Marked({ text, marks }: { text: string; marks: string[] }) {
  const ranges = marks.length ? findHighlightRanges(text, marks) : [];
  if (!ranges.length) return <>{text}</>;
  return (
    <>
      {highlightPieces(text, ranges).map((piece, i) =>
        typeof piece === "string" ? <Fragment key={i}>{piece}</Fragment> : <mark key={i} className="rounded-sm bg-amber-200 px-0.5 text-amber-950 dark:bg-amber-500/40 dark:text-amber-50">{piece.mark}</mark>,
      )}
    </>
  );
}

function Moment({ m, last, badge, marks, subjectCell, subjectNode, onCell, onNode, onOpenStep }: {
  m: ProvenanceMoment;
  last: boolean;
  badge?: string;
  marks: string[];
  subjectCell?: string;
  subjectNode?: string;
  onCell: (cell: string) => void;
  onNode: (refId: string) => void;
  onOpenStep?: (path: string, at: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const k = KIND[m.kind];
  const Icon = k.icon;
  const isSubject = sameCell(m.cell, subjectCell);
  const shown = m.value !== undefined ? (m.value === "" ? "(blank)" : m.value) : m.snippet;
  const quiet = m.kind !== "wrote" && !badge;
  return (
    <li className="relative flex min-w-0 gap-2.5 pb-3" data-kind={m.kind} data-exact={m.exact || undefined}>
      <div className="flex shrink-0 flex-col items-center">
        <span className={cn("mt-1 flex size-5 items-center justify-center rounded-full text-white", k.dot)}>
          <Icon className="size-3" />
        </span>
        {!last && <span className="mt-1 w-px flex-1 bg-border" />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <span className="text-xs text-muted-foreground tabular-nums">{clock(m.at)}</span>
          <span className="font-medium">{whoOf(m)}</span>
          <span className={cn("min-w-0 break-words", quiet && "text-muted-foreground")}>{momentPhrase(m)}</span>
          {badge && <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">{badge}</Badge>}
          {!m.exact && <span className="text-[10px] text-muted-foreground" title="Found by its text, not by where it sits">by text</span>}
        </div>
        {shown && (
          <div className={cn("min-w-0 rounded border-l-2 pl-2 font-mono text-xs break-words whitespace-pre-wrap", m.kind === "wrote" ? "border-sky-500/60" : "border-border text-muted-foreground")}>
            <Marked text={shown} marks={marks} />
          </div>
        )}
        {m.why && (
          <p className="min-w-0 border-l-2 border-transparent pl-2 text-xs break-words text-muted-foreground italic" title="The agent's words before the call">
            {m.why.length > 400 && !open ? `…${m.why.slice(-400)}` : m.why}
          </p>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {m.before?.length ? (
            <Button size="xs" variant="ghost" className="text-muted-foreground" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <ChevronRight className={cn("transition-transform", open && "rotate-90")} />
              {m.before.length} call{m.before.length === 1 ? "" : "s"} before
            </Button>
          ) : null}
          {m.cell && !isSubject && <Chip onClick={() => onCell(m.cell!)}>{m.cell}</Chip>}
          {m.cites?.filter((c) => !sameCell(c, subjectCell)).map((c) => <Chip key={c} onClick={() => onCell(c)}>{c}</Chip>)}
          {m.node && m.node.ref_id !== subjectNode && <Chip title="Open the node" onClick={() => onNode(m.node!.ref_id)}>{m.node.name?.split("\n")[0] ?? m.node.ref_id}</Chip>}
          {onOpenStep && (
            <Button size="xs" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => onOpenStep(m.agent ?? m.path, m.at)} title={m.agent ?? m.path}>
              Show in run
            </Button>
          )}
        </div>
        {open && m.before && (
          <ol className="flex min-w-0 flex-col gap-1.5 rounded-md border bg-muted/30 p-2" data-testid="spot-check-before">
            {m.before.map((b) => (
              <li key={b.path} className="min-w-0 text-xs">
                <div className="font-medium">{b.tool}</div>
                <pre className="max-h-24 overflow-auto font-mono text-[11px] break-words whitespace-pre-wrap text-muted-foreground">{b.input}</pre>
                {b.output && <pre className="mt-0.5 max-h-40 overflow-auto border-l-2 pl-2 font-mono text-[11px] break-words whitespace-pre-wrap"><Marked text={b.output} marks={marks} /></pre>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </li>
  );
}
