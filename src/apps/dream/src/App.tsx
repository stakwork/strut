// strut/dream (plans/dream.md): what the dreams found and did, read two ways.
// Causes: every claim as it stands now, most corrected first, each with what
// memory holds for it and one history of what was said and what was changed.
// Dreams: each run, newest first, with what it changed and what it noted.
// A claim in a dream opens its cause; a remark or change in a cause opens
// its dream. The app starts no run and writes nothing: a dream runs from its
// automation, as one of strut's own jobs, since a run an app launches reads
// only what an app may and could not see a private tree. Everything is read
// from the runs' outputs (`grants.workflows: [dream]`), every listed run's,
// not only the picked one's: a cause's history spans them.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { hierarchy, pack } from "d3";
import { RUN_STEPS, isInFlight, runKeys, useRuns, useStrutClient, type RunSummary } from "@strut/kit";
import { DocumentView, RunStatus, Transcript } from "strut/views";
import { cn } from "@/lib/utils";
import { costText, foundBy, sectionsOf, type DreamOutput, type Outcome, type SaidRow } from "./lib/report";
import { buildModel, headline, inMemory, runSummary, wordDiff, type Cause, type Change, type Model, type Run } from "./lib/model";

const WORKFLOW = "dream";
/** The agent step's path in an older, one-agent run: its transcript. */
const AGENT_PATH = "dream/dream";
const NARROW = 768;
const RUNS_MAX = 30;

const OUTCOME: Record<Outcome, string> = {
  missing: "Not in memory",
  not_opened: "In memory, not opened",
  not_followed: "Opened, not followed",
  contradicted: "Memory said the opposite",
  followed: "Followed",
};
const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
};

function useNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < NARROW);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < NARROW);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return narrow;
}

/** Every listed run with its output: the list, then each run (a settled run never changes). */
function useDreams(): { runs: Run[]; loading: boolean; error?: string } {
  const client = useStrutClient();
  const list = useRuns(WORKFLOW, { limit: RUNS_MAX, live: true });
  const listed = list.data ?? [];
  const each = useQueries({
    queries: listed.map((r) => ({
      queryKey: runKeys.run(WORKFLOW, r.runId),
      queryFn: () => client.run<RunSummary>(RUN_STEPS.get, { workflow: WORKFLOW, runId: r.runId }),
      staleTime: isInFlight(r) ? 0 : Infinity,
    })),
  });
  const stamp = each.map((q) => q.dataUpdatedAt).join(",");
  const runs = useMemo(
    () =>
      listed.map((r, i): Run => {
        const full = each[i]?.data;
        const output = (full?.output && typeof full.output === "object" ? full.output : {}) as DreamOutput;
        const error = (full?.error ?? r.error)?.message;
        return { runId: r.runId, startedAt: r.startedAt ?? "", status: r.status, output, ...(error ? { error } : {}) };
      }),
    // The list and each run's data, by when they last changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list.dataUpdatedAt, stamp],
  );
  const error = list.isError ? (list.error instanceof Error ? list.error.message : String(list.error)) : undefined;
  return { runs, loading: list.isLoading || each.some((q) => q.isLoading), ...(error ? { error } : {}) };
}

function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }>; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex max-w-full flex-wrap rounded-md bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value} type="button" role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={cn("whitespace-nowrap rounded px-2.5 py-1 text-xs transition-colors duration-100", value === o.value ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const CHIP = {
  strong: "border border-foreground/60 text-foreground",
  tint: "bg-primary/10 text-foreground",
  quiet: "bg-muted text-muted-foreground",
} as const;
const Chip = ({ tone = "quiet", children }: { tone?: keyof typeof CHIP; children: ReactNode }) => (
  <span className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs", CHIP[tone])}>{children}</span>
);

/** What the assistant did, as a mark: empty (not in memory), half (in memory, not opened), full (opened, not followed), struck (said the opposite), tick (followed). */
function OutcomeMark({ outcome }: { outcome?: Outcome }) {
  const c = "size-3 shrink-0";
  if (outcome === "followed") return <svg viewBox="0 0 12 12" className={c} aria-hidden><path d="M2.5 6.5l2.5 2.5 4.5-5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  return (
    <svg viewBox="0 0 12 12" className={c} aria-hidden>
      <circle cx="6" cy="6" r="4.25" fill={outcome === "not_followed" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" />
      {outcome === "not_opened" && <path d="M6 1.75a4.25 4.25 0 0 0 0 8.5z" fill="currentColor" />}
      {outcome === "contradicted" && <path d="M2.5 9.5l7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
    </svg>
  );
}

const RED = "bg-red-500/10 text-red-800 dark:text-red-200";
const GREEN = "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200";

function Line({ sign, parts }: { sign: "-" | "+"; parts: Array<[string, boolean]> }) {
  return (
    <p className={cn("grid grid-cols-[1rem_minmax(0,1fr)] rounded px-2 py-1.5 text-sm leading-snug", sign === "-" ? RED : GREEN)}>
      <span className="select-none font-mono opacity-60" aria-label={sign === "-" ? "Removed" : "Added"}>{sign}</span>
      <span className="break-words">
        {parts.map(([w, hot], k) => (hot && w.trim() ? <span key={k} className={cn("rounded-sm", sign === "-" ? "bg-red-500/25 line-through" : "bg-emerald-500/25")}>{w}</span> : w))}
      </span>
    </p>
  );
}

/** What a dream did to a Concept, as a diff: the lines it lost and gained, the changed words marked within a line. */
function ChangeView({ change }: { change: Change }) {
  const c = change.change;
  const removed = [...(c.description?.was ? [c.description.was] : []), ...c.removed];
  const added = [...(c.description?.is ? [c.description.is] : []), ...c.added];
  const none = (l: string): Array<[string, boolean]> => [[l, false]];
  return (
    <div className="flex flex-col gap-1" data-testid="change">
      {removed.map((l, i) => <Line key={`r${i}`} sign="-" parts={added[i] !== undefined ? wordDiff(l, added[i]!).was : none(l)} />)}
      {added.map((l, i) => <Line key={`a${i}`} sign="+" parts={removed[i] !== undefined ? wordDiff(removed[i]!, l).is : none(l)} />)}
    </div>
  );
}

/** A list beside what is picked from it. Narrow, they take the screen in turn. */
function Split({ list, detail, open, onBack, narrow, wide }: { list: ReactNode; detail: ReactNode; open: boolean; onBack: () => void; narrow: boolean; wide?: boolean }) {
  if (narrow) {
    return open ? (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <button type="button" onClick={onBack} className="flex w-fit items-center gap-1 px-4 pt-3 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" /> Back</button>
        {detail}
      </div>
    ) : (
      <div className="min-h-0 flex-1 overflow-y-auto">{list}</div>
    );
  }
  return (
    <div className={cn("grid min-h-0 flex-1", wide ? "grid-cols-[minmax(0,1fr)_30rem]" : "grid-cols-[26rem_minmax(0,1fr)]")}>
      <div className="min-h-0 overflow-y-auto border-r">{list}</div>
      <div className="min-h-0 overflow-y-auto">{detail}</div>
    </div>
  );
}

/** Only the standings worth a glance get a chip. */
function Standing({ cause }: { cause: Cause }) {
  if (cause.fix === "back") return <Chip tone="strong">Came back {cause.back}×</Chip>;
  if (cause.fix === "held") return <Chip tone="quiet">Held</Chip>;
  if (cause.fix === "untested") return <Chip tone="tint">Changed</Chip>;
  if (cause.fresh) return <Chip tone="tint">New</Chip>;
  return null;
}

/** A speaker's name when the turn carries a plain one; an account id is not something to read. */
const speaker = (by: string | undefined) => (by && /^[\p{L}][\p{L} .'-]{0,15}$/u.test(by) ? `${by} said` : "You said");

/** One remark, read left to right: who said what, and what the assistant had done. The rule it became is `lead`;
 *  where it was said sits quietly on the right. `outcome` is shown only where the section does not already say it. */
function Said({ said, lead, model, onRun, outcome }: { said: SaidRow; lead?: ReactNode; model: Model; onRun?: (id: string) => void; outcome?: boolean }) {
  const run = model.runs.find((r) => r.runId === said.dream);
  const label = "truncate pt-0.5 text-xs text-muted-foreground";
  const where = <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">{when(said.at)} · <span className="font-mono">{said.session.split("/").pop()}</span> · turn {said.turn}</span>;
  return (
    <div className="flex flex-col gap-2">
      {lead && (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">{lead}</div>
          <span className="pt-0.5">{where}</span>
        </div>
      )}
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <dt className={label}>{speaker(said.said_by)}</dt>
        <dd className="break-words text-sm leading-snug">“{said.excerpt}”</dd>
        {said.why && (
          <>
            <dt className={label}>What happened</dt>
            <dd className="break-words text-sm leading-snug text-muted-foreground">{said.why}</dd>
          </>
        )}
        {outcome && (
          <>
            <dt className={label}>At the time</dt>
            <dd className="inline-flex items-center gap-1 text-sm text-muted-foreground"><OutcomeMark outcome={said.outcome} />{said.outcome ? OUTCOME[said.outcome] : ""}</dd>
          </>
        )}
        {(!lead || (run && onRun)) && (
          <>
            <dt />
            <dd className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
              {!lead && where}
              {run && onRun && <button type="button" onClick={() => onRun(run.runId)} className="ml-auto whitespace-nowrap underline decoration-dotted underline-offset-2 hover:text-foreground">Dream {when(run.startedAt)}</button>}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

// ── Causes ──

function CauseRow({ cause, selected, onPick, nested }: { cause: Cause; selected: boolean; onPick: () => void; nested?: boolean }) {
  return (
    <button type="button" onClick={onPick} data-testid="cause" className={cn("flex w-full items-start gap-3 py-2.5 pr-4 text-left hover:bg-muted/60", nested ? "pl-10" : "pl-4", selected && "bg-muted")}>
      <span className={cn("w-8 shrink-0 text-right tabular-nums", nested ? "text-sm text-muted-foreground" : "text-sm font-medium")}>{cause.claim.corrected}×</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("line-clamp-2 text-sm leading-snug", !nested && cause.children.length > 0 && "font-medium")}>{cause.claim.title || cause.claim.text}</span>
        <span className="text-xs text-muted-foreground">{cause.claim.concept}</span>
      </span>
      <Standing cause={cause} />
    </button>
  );
}

/** The causes as circles: area is how often it was corrected, a group holds its claims, and the fill is where it stands. */
function Graph({ causes, selected, onPick }: { causes: Cause[]; selected: string | null; onPick: (id: string) => void }) {
  const W = 800, H = 640;
  const nodes = useMemo(() => {
    type N = { cause?: Cause; children?: N[] };
    const root = hierarchy<N>({ children: causes.map((c) => ({ cause: c, ...(c.children.length ? { children: c.children.map((k) => ({ cause: k })) } : {}) })) })
      .sum((d) => (d.cause && !d.children ? Math.max(1, d.cause.claim.corrected) : 0))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return pack<N>().size([W, H]).padding((d) => (d.depth === 0 ? 22 : 8))(root).descendants().filter((d) => d.data.cause);
  }, [causes]);
  const tones = new Set(nodes.filter((n) => !n.data.cause!.children.length).map((n) => n.data.cause!.fix === "back" ? "back" : n.data.cause!.fix === "none" && !n.data.cause!.fresh ? "plain" : n.data.cause!.fix === "held" ? "held" : "new"));
  const dot = "size-2.5 rounded-full border";
  return (
    <div className="flex h-full min-h-[24rem] flex-col gap-3 p-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="min-h-0 w-full flex-1" role="img" aria-label="Causes, sized by how often each was corrected">
        {nodes.map((n) => {
          const c = n.data.cause!;
          const group = c.children.length > 0;
          const sel = selected === c.claim.id;
          const text = c.claim.title || c.claim.text;
          const back = c.fix === "back";
          const fill = back ? "fill-foreground stroke-foreground" : c.fix === "held" ? "fill-background stroke-foreground/40" : c.fix === "none" && !c.fresh ? "fill-muted stroke-border" : "fill-foreground/15 stroke-foreground/50";
          const side = n.r * 1.5;
          return (
            <g key={c.claim.id} onClick={() => onPick(c.claim.id)} className="cursor-pointer">
              <title>{`${c.claim.corrected}× ${text}`}</title>
              {group ? (
                <circle cx={n.x} cy={n.y} r={n.r} className={cn("fill-muted/30", sel ? "stroke-foreground" : "stroke-border")} strokeWidth={sel ? 2 : 1} />
              ) : (
                <>
                  <circle cx={n.x} cy={n.y} r={n.r} strokeWidth={1.25} className={cn("transition-opacity duration-100 hover:opacity-80", fill)} />
                  {sel && <circle cx={n.x} cy={n.y} r={n.r + 4} className="fill-none stroke-foreground" strokeWidth={1.5} />}
                  {n.r >= 34 ? (
                    <foreignObject x={n.x - side / 2} y={n.y - side / 2} width={side} height={side} className="pointer-events-none">
                      <div className={cn("flex h-full flex-col items-center justify-center gap-0.5 text-center", back ? "text-background" : "text-foreground")}>
                        <span className="text-sm font-semibold tabular-nums">{c.claim.corrected}×</span>
                        <span className={cn("text-[11px] leading-tight", n.r >= 70 ? "line-clamp-4" : "line-clamp-2")}>{text}</span>
                      </div>
                    </foreignObject>
                  ) : n.r > 11 && (
                    <text x={n.x} y={n.y} textAnchor="middle" dominantBaseline="central" className={cn("pointer-events-none text-[11px] font-medium tabular-nums", back ? "fill-background" : "fill-foreground")}>{c.claim.corrected}×</text>
                  )}
                </>
              )}
            </g>
          );
        })}
        {/* A group's name, drawn last so no circle covers it: a label sitting on the group's top edge. */}
        {nodes.filter((n) => n.data.cause!.children.length > 0).map((n) => {
          const c = n.data.cause!;
          return (
            <foreignObject key={`t${c.claim.id}`} x={n.x - 170} y={n.y - n.r - 13} width={340} height={26} className="pointer-events-none overflow-visible">
              <div className="flex h-full items-center justify-center">
                <button type="button" onClick={() => onPick(c.claim.id)} className={cn("pointer-events-auto max-w-full truncate rounded-full border bg-background px-2.5 py-0.5 text-xs font-medium", selected === c.claim.id ? "border-foreground" : "border-foreground/40")}>
                  <span className="tabular-nums">{c.claim.corrected}×</span> {c.claim.title || c.claim.text}
                </button>
              </div>
            </foreignObject>
          );
        })}
      </svg>
      <p className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {tones.has("back") && <span className="inline-flex items-center gap-1.5"><span className={cn(dot, "border-foreground bg-foreground")} /> Came back</span>}
        {tones.has("new") && <span className="inline-flex items-center gap-1.5"><span className={cn(dot, "border-foreground/50 bg-foreground/15")} /> New or changed</span>}
        {tones.has("held") && <span className="inline-flex items-center gap-1.5"><span className={cn(dot, "border-foreground/40")} /> Held</span>}
        {tones.has("plain") && <span className="inline-flex items-center gap-1.5"><span className={cn(dot, "bg-muted")} /> Heard, not in memory yet</span>}
      </p>
    </div>
  );
}

function CauseDetail({ cause, model, onRun, onCause }: { cause: Cause; model: Model; onRun: (id: string) => void; onCause: (id: string) => void }) {
  type Item = { at: string; order: number; said?: { row: SaidRow; of: Cause }; fix?: Change };
  const leaves = cause.children.length ? cause.children : [cause];
  const items: Item[] = [
    ...leaves.flatMap((k) => k.said.map((row): Item => ({ at: row.at, order: 0, said: { row, of: k } }))),
    ...cause.fixes.map((fix): Item => ({ at: fix.run.startedAt, order: 1, fix })),
  ].sort((a, b) => b.at.localeCompare(a.at) || b.order - a.order);
  const written = inMemory(model, cause);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6" data-testid="cause-detail">
      <header className="flex flex-col gap-2">
        {cause.group && <button type="button" onClick={() => onCause(cause.group!.id)} className="w-fit text-left text-xs text-muted-foreground hover:text-foreground">{cause.group.title || cause.group.text}</button>}
        <h2 className="text-lg font-semibold leading-snug">{cause.claim.title || cause.claim.text}</h2>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span className="tabular-nums">Corrected {cause.claim.corrected}×{cause.claim.kept ? ` · followed ${cause.claim.kept}×` : ""}</span>
          <span>{cause.claim.concept}</span>
          <Standing cause={cause} />
        </p>
      </header>

      {written.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">In memory now</h3>
          {written.map((line, i) => <p key={i} className="break-words rounded bg-primary/10 px-2.5 py-1.5 text-sm">{line}</p>)}
        </section>
      )}

      {cause.children.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border">
          {cause.children.map((k) => <li key={k.claim.id}><CauseRow cause={k} selected={false} onPick={() => onCause(k.claim.id)} /></li>)}
        </ul>
      )}

      {items.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">History</h3>
          <ol className="flex flex-col divide-y rounded-md border">
            {items.map((it, i) =>
              it.fix ? (
                <li key={i} className="flex flex-col gap-2 bg-muted/30 px-4 py-3">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="font-medium">{it.fix.change.kind === "added" ? "Added" : "Changed"} {it.fix.change.name}</span>
                    {it.fix.change.proposed && <Chip tone="strong">Waiting for a yes</Chip>}
                    <button type="button" onClick={() => onRun(it.fix!.run.runId)} className="ml-auto whitespace-nowrap text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground">Dream {when(it.fix.run.startedAt)}</button>
                  </p>
                  <ChangeView change={it.fix} />
                </li>
              ) : (
                <li key={i} className="px-4 py-3">
                  <Said outcome said={it.said!.row} model={model} onRun={onRun} lead={cause.children.length ? <p className="text-xs text-muted-foreground">{it.said!.of.claim.title || it.said!.of.claim.text}</p> : undefined} />
                </li>
              ),
            )}
          </ol>
        </section>
      )}
    </div>
  );
}

// ── Dreams ──

/** What a dream noted without changing a Concept, by what it means for the reader. */
const GROUPS: Array<{ title: string; mixed?: boolean; has: (o: Outcome | undefined) => boolean }> = [
  { title: "New, not in memory yet", has: (o) => o === "missing" || !o },
  { title: "In memory, still got wrong", mixed: true, has: (o) => o === "not_opened" || o === "not_followed" || o === "contradicted" },
  { title: "Followed", has: (o) => o === "followed" },
];

const Rows = ({ title, lines }: { title: string; lines: string[] }) => (
  <section className="flex flex-col gap-2">
    <h3 className="text-sm font-semibold">{title}</h3>
    <ul className="flex flex-col divide-y rounded-md border text-sm text-muted-foreground">
      {lines.map((l, i) => <li key={i} className="break-words px-4 py-2">{l}</li>)}
    </ul>
  </section>
);

function RunDetail({ run, model, onCause }: { run: Run; model: Model; onCause: (id: string) => void }) {
  const out = run.output;
  const done = run.status !== "running" && run.status !== "paused";
  const found = foundBy(out.claims, run.runId);
  const changes = model.changes.filter((c) => c.run.runId === run.runId);
  const shown = new Set(changes.flatMap((c) => c.causes.map((w) => w.said)));
  const recorded = found.filter((f) => !shown.has(f.said));
  const passed = [...(out.unsorted ?? []), ...(out.unfixed ?? [])].map((x) => x.why).filter(Boolean);
  const text = typeof out.text === "string" ? out.text : "";
  const left = sectionsOf(text)?.find((s) => s.title === "Left alone")?.lines ?? [];
  const facts = typeof out.facts === "string" ? out.facts.trim() : "";
  const claimLink = (id: string, label: string) => (
    <button type="button" onClick={() => onCause(id)} className="w-fit text-left text-sm font-medium underline-offset-2 hover:underline">{label}</button>
  );
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6" data-testid="run-detail">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{headline(model, run)}</h2>
        <p className="flex flex-wrap items-center gap-x-2 text-sm tabular-nums text-muted-foreground">
          {(!done || run.error) && <RunStatus status={run.status} />}
          <span>{when(run.startedAt)}{done && !run.error ? ` · ${out.turns ?? 0} turns read · ${costText(out.cost)}` : ""}{done && out.more ? " · more turns waiting" : ""}</span>
        </p>
      </header>

      {run.error && <p className="break-words rounded-md border px-4 py-3 text-sm">{run.error}</p>}
      {!done && <p className="text-sm text-muted-foreground">What it found and changed appears when it finishes.</p>}

      {changes.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Memory changes</h3>
          <ul className="flex flex-col divide-y rounded-md border">
            {changes.map((c) => {
              const cause = c.change.claim ? model.byId.get(c.change.claim) : undefined;
              return (
                <li key={c.key} className="flex flex-col gap-4 px-4 py-3.5">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="font-medium">{c.change.name}</span>
                    <span className="text-muted-foreground">· {c.change.kind === "added" ? "added to memory" : c.change.kind === "removed" ? "removed from memory" : c.change.kind === "moved" ? "moved" : "changed"}</span>
                    {c.change.proposed && <Chip tone="strong">Waiting for a yes</Chip>}
                  </p>
                  <ChangeView change={c} />
                  {c.change.why && <p className="text-sm text-muted-foreground">{c.change.why}</p>}
                  {!c.causes.length && cause && claimLink(cause.claim.id, cause.claim.title || cause.claim.text)}
                  {c.causes.map((w, i) => <Said key={i} outcome said={w.said} model={model} lead={claimLink(w.claim.id, w.claim.title || w.claim.text)} />)}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {GROUPS.map((g) => {
        const rows = recorded.filter((f) => g.has(f.said.outcome));
        if (!rows.length) return null;
        return (
          <section key={g.title} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{g.title} <span className="font-normal tabular-nums text-muted-foreground">{rows.length}</span></h3>
            <ul className="flex flex-col divide-y rounded-md border">
              {rows.map((f, i) => (
                <li key={i} className="px-4 py-3.5"><Said said={f.said} model={model} outcome={!!g.mixed} lead={claimLink(f.claim.id, f.claim.title || f.claim.text)} /></li>
              ))}
            </ul>
          </section>
        );
      })}

      {facts && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Facts</h3>
          <div className="rounded-md border px-4 py-3"><DocumentView text={facts} kind="markdown" /></div>
        </section>
      )}

      {passed.length > 0 && <Rows title="Passed over" lines={passed} />}
      {left.length > 0 && <Rows title="Left alone" lines={left} />}

      {done && !run.error && !changes.length && !recorded.length && !left.length && !facts && text && <DocumentView text={text} kind="markdown" />}

      {/* An older, one-agent run kept its whole transcript at one path; a staged run's stages are in its run log. */}
      {done && (out.turns ?? 0) > 0 && !Array.isArray(out.changes) && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Every step it took</h3>
          <Transcript workflow={WORKFLOW} runId={run.runId} path={AGENT_PATH} />
        </section>
      )}
    </div>
  );
}

export default function App() {
  const { runs, loading, error } = useDreams();
  const model = useMemo(() => buildModel(runs), [runs]);
  const narrow = useNarrow();
  const [view, setView] = useState<"causes" | "dreams">("causes");
  const [causeId, setCauseId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [graph, setGraph] = useState(false);
  const toCause = (id: string) => { setCauseId(id); setView("causes"); setOpen(true); };
  const toRun = (id: string) => { setRunId(id); setView("dreams"); setOpen(true); };
  const cause = (causeId && model.byId.get(causeId)) || model.causes[0];
  const run = model.runs.find((r) => r.runId === runId) ?? model.runs[0];
  const empty = (text: string) => <p className="p-4 text-sm text-muted-foreground">{text}</p>;
  const none = error ?? (loading ? "Reading the dreams." : "No dream has run yet. Turn Dream on, or run it once, in Automations: what it finds shows here.");
  const tab = (v: "causes" | "dreams", label: string, n: number) => (
    <button type="button" onClick={() => { setView(v); setOpen(false); }} className={cn("-mb-px border-b-2 px-1 py-2.5 text-sm", view === v ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}>
      {label} <span className="tabular-nums text-muted-foreground">{n}</span>
    </button>
  );
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground" data-testid="dream-app">
      <header className="flex shrink-0 items-center gap-5 border-b px-4">
        <h1 className="text-sm font-semibold">Dream</h1>
        <nav className="flex gap-4">
          {tab("causes", "Causes", model.causes.length)}
          {tab("dreams", "Dreams", model.runs.length)}
        </nav>
        {view === "causes" && model.causes.length > 0 && (
          <div className="ml-auto py-1.5">
            <Segmented label="How the causes are shown" value={graph ? "graph" : "list"} onChange={(v) => setGraph(v === "graph")} options={[{ value: "list", label: "List" }, { value: "graph", label: "Graph" }]} />
          </div>
        )}
      </header>
      {!model.runs.length ? (
        empty(none)
      ) : view === "causes" ? (
        <Split
          narrow={narrow} open={open} onBack={() => setOpen(false)} wide={graph}
          list={
            graph && model.causes.length ? (
              <Graph causes={model.causes} selected={narrow ? null : (cause?.claim.id ?? null)} onPick={toCause} />
            ) : model.causes.length ? (
              <ul className="flex flex-col divide-y" data-testid="causes">
                {model.causes.map((c) => (
                  <li key={c.claim.id}>
                    <CauseRow cause={c} selected={!narrow && cause?.claim.id === c.claim.id} onPick={() => toCause(c.claim.id)} />
                    {c.children.map((k) => <CauseRow key={k.claim.id} cause={k} nested selected={!narrow && cause?.claim.id === k.claim.id} onPick={() => toCause(k.claim.id)} />)}
                  </li>
                ))}
              </ul>
            ) : (
              empty(loading ? "Reading the dreams." : "No corrections yet.")
            )
          }
          detail={cause ? <CauseDetail key={cause.claim.id} cause={cause} model={model} onRun={toRun} onCause={toCause} /> : null}
        />
      ) : (
        <Split
          narrow={narrow} open={open} onBack={() => setOpen(false)}
          list={
            <ul className="flex flex-col divide-y" data-testid="runs">
              {model.runs.map((r) => {
                const s = runSummary(model, r);
                const quiet = !s.found && !s.changed;
                return (
                  <li key={r.runId}>
                    <button type="button" onClick={() => toRun(r.runId)} className={cn("flex w-full flex-col gap-0.5 px-4 py-2.5 text-left hover:bg-muted/60", !narrow && run?.runId === r.runId && "bg-muted")}>
                      <span className={cn("text-sm", quiet ? "text-muted-foreground" : "font-medium")}>{headline(model, r)}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">{when(r.startedAt)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          }
          detail={run ? <RunDetail key={run.runId} run={run} model={model} onCause={toCause} /> : null}
        />
      )}
    </div>
  );
}
