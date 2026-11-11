// strut/dream (plans/dream.md): what the dream did. On the left its runs,
// newest first. The page starts none: a dream runs from its automation, as
// one of strut's own jobs, since a run a page launches reads only what an
// app may and could not see a private tree. On the right the picked run,
// read from the outcome back to how it got there: what it changed (the tree
// before against the tree after, with the words that caused each change),
// the causes (claims, grouped, most corrected first, each with where it
// stands), the tree as it stands, then every step the agent took. Everything is read from the run
// (`grants.workflows: [dream]`), so the page shows what the dream's own run
// could read and nothing more. Narrow, the list and the run take the page in
// turn.
import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { useRun, useRuns, type RunSummary } from "@strut/kit";
import { DocumentView, RunList, RunStatus, Transcript } from "strut/views";
import { cn } from "@/lib/utils";
import {
  OUTCOME_TEXT, costText, foundBy, nest, pageChanges, sectionsOf, standingOf, summaryOf, whenText,
  type Claim, type ClaimTone, type DreamOutput, type PageChange, type SaidRow, type TreePage,
} from "./lib/report";

const WORKFLOW = "dream";
/** The agent step's path in a run of the workflow: its transcript. */
const AGENT_PATH = "dream/dream";
const NARROW = 768;

function useNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < NARROW);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < NARROW);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return narrow;
}

const Stat = ({ label, value }: { label: string; value: number }) => (
  <div className="rounded-md bg-muted/50 px-3 py-2">
    <p className="text-xs text-muted-foreground">{label}</p>
    <p className="text-xl font-medium tabular-nums">{value}</p>
  </div>
);

/** Where what was said was said, and what the assistant did there. */
const saidWhere = (e: SaidRow) => `${e.said_by ? `${e.said_by} · ` : ""}${e.session} · turn ${e.turn} · ${e.outcome ? OUTCOME_TEXT[e.outcome] : "not sorted"}`;

/** A page the dream changed: the lines it lost and gained, and the words that caused it. */
function ChangeRow({ change, causes }: { change: PageChange; causes: Array<{ claim: Claim; said: SaidRow }> }) {
  const what =
    change.kind === "added" ? `page added${change.to ? ` under ${change.to}` : ""}`
    : change.kind === "removed" ? "page removed"
    : change.kind === "moved" ? `moved from ${change.from || "the top"} to ${change.to || "the top"}`
    : `${change.added.length && change.removed.length ? "line changed" : change.added.length ? "line added" : change.removed.length ? "line removed" : "description changed"}${change.from !== undefined ? `, moved to ${change.to || "the top"}` : ""}`;
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5" data-testid="change">
      <p className="text-sm">
        <span className="font-medium">{change.name}</span> <span className="text-muted-foreground">· {what}</span>
      </p>
      {change.description && (
        <div className="flex flex-col gap-1" data-testid="description-change">
          <p className="text-xs text-muted-foreground">Description</p>
          {change.description.was && <p className="break-words rounded bg-muted/50 px-2 py-1 text-xs text-muted-foreground line-through">{change.description.was}</p>}
          {change.description.is && <p className="break-words rounded bg-primary/10 px-2 py-1 text-xs">{change.description.is}</p>}
        </div>
      )}
      {change.removed.map((l, i) => (
        <p key={`r${i}`} className="break-words rounded bg-muted/50 px-2 py-1 font-mono text-xs text-muted-foreground line-through">{l}</p>
      ))}
      {change.added.map((l, i) => (
        <p key={`a${i}`} className="break-words rounded bg-primary/10 px-2 py-1 font-mono text-xs">{l}</p>
      ))}
      {causes.map((c, i) => (
        <p key={i} className="text-xs text-muted-foreground">
          Said: “{c.said.excerpt}” · {saidWhere(c.said)}
        </p>
      ))}
    </li>
  );
}

const TONE: Record<ClaimTone, string> = {
  back: "border border-foreground/50 text-foreground",
  new: "bg-primary/10 text-foreground",
  kept: "bg-muted text-muted-foreground",
  quiet: "bg-muted text-muted-foreground",
};

/** A claim: how often it was corrected, where it stands, and what was said for it. */
function ClaimCard({ claim, runId, now, nested }: { claim: Claim; runId: string; now: number; nested?: boolean }) {
  const standing = standingOf(claim, runId, now);
  return (
    <li className={cn("flex flex-col gap-2", nested ? "border-t px-3 py-2.5 pl-12" : "px-3 py-2.5")} data-testid="claim">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={cn("w-8 shrink-0 tabular-nums", nested ? "text-sm text-muted-foreground" : "text-base font-medium")}>{claim.corrected}×</span>
        <span className={cn("min-w-0 flex-1 text-sm", !nested && "font-medium")}>{claim.title || claim.text}</span>
        <span className="text-xs text-muted-foreground">on {claim.concept}</span>
        <span className={cn("rounded px-1.5 py-0.5 text-xs", TONE[standing.tone])}>{standing.label}</span>
      </div>
      {claim.title && claim.title !== claim.text && <p className="pl-11 text-sm text-muted-foreground">{claim.text}</p>}
      <ul className="flex flex-col gap-1.5 pl-11">
        {claim.evidence.map((e, i) => (
          <li key={i} className="grid grid-cols-[7.5rem_1fr] gap-x-3 text-xs">
            <span className="tabular-nums text-muted-foreground">{whenText(e.at)}</span>
            <span className="min-w-0">
              <span className={cn("break-words", e.outcome === "followed" && "text-muted-foreground")}>“{e.excerpt}”</span>
              <span className="block text-muted-foreground">
                {saidWhere(e)}
                {e.denies ? " · says the claim is wrong" : ""}
                {e.why ? ` · ${e.why}` : ""}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}

/** A group: its sentence and its counts (its claims' added up), with those claims under it. */
function ClaimGroup({ claim, children, runId, now }: { claim: Claim; children: Claim[]; runId: string; now: number }) {
  if (!children.length) return <ClaimCard claim={claim} runId={runId} now={now} />;
  return (
    <li className="flex flex-col" data-testid="claim-group">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2.5">
        <span className="w-8 shrink-0 text-base font-medium tabular-nums">{claim.corrected}×</span>
        <span className="min-w-0 flex-1 text-sm font-medium">{claim.title || claim.text}</span>
        <span className="text-xs text-muted-foreground">
          {children.length} claim{children.length === 1 ? "" : "s"} · on {claim.concept}
        </span>
      </div>
      <ul className="flex flex-col">
        {children.map((c) => (
          <ClaimCard key={c.id} claim={c} runId={runId} now={now} nested />
        ))}
      </ul>
    </li>
  );
}

/** The tree as it stands after the dream, each page marked with what the dream did to it and how many claims it holds. */
function TreeView({ pages, changes, claims }: { pages: TreePage[]; changes: PageChange[]; claims: Claim[] }) {
  const changed = new Map(changes.map((c) => [c.ref_id, c.kind]));
  const held = new Map<string, number>();
  for (const c of claims) held.set(c.about, (held.get(c.about) ?? 0) + 1);
  return (
    <ul className="flex flex-col rounded-md border py-1.5 text-sm" data-testid="tree">
      {pages.map((p) => (
        <li key={p.ref_id} className="flex flex-wrap items-baseline gap-x-2 px-3 py-1" style={{ paddingLeft: `${0.75 + p.depth * 1.25}rem` }}>
          <span className={cn(p.depth === 0 && "font-medium")}>{p.name}</span>
          {changed.has(p.ref_id) && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs">{changed.get(p.ref_id)} in this dream</span>}
          {held.has(p.ref_id) && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {held.get(p.ref_id)} claim{held.get(p.ref_id) === 1 ? "" : "s"}
            </span>
          )}
          {p.description && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{p.description}</span>}
        </li>
      ))}
    </ul>
  );
}

/** The parts of the report the page does not draw from the run's data: facts changed, and what was left alone. */
function Notes({ text, only }: { text: string; only: string[] }) {
  const sections = (sectionsOf(text) ?? []).filter((s) => only.includes(s.title) && s.lines.length);
  if (!sections.length) return null;
  return (
    <>
      {sections.map((s) => (
        <section key={s.title} className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">{s.title}</h2>
          <ul className="flex flex-col divide-y rounded-md border text-sm">
            {s.lines.map((l, i) => (
              <li key={i} className="px-3 py-2">{l}</li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function RunDetail({ runId, lead }: { runId: string; lead?: ReactNode }) {
  const run = useRun(WORKFLOW, runId, { live: true });
  const r = run.data;
  const out = (r?.output && typeof r.output === "object" ? r.output : {}) as DreamOutput;
  const all = Array.isArray(out.claims) ? out.claims : [];
  const claims = nest(all);
  const tree = Array.isArray(out.tree) ? out.tree : [];
  const changes = pageChanges(Array.isArray(out.before) ? out.before : undefined, tree);
  const found = foundBy(all, runId);
  const sum = summaryOf(out, runId);
  const done = !!r && r.status !== "running" && r.status !== "paused";
  const now = r?.startedAt ? Date.parse(r.startedAt) : Date.now();
  const text = typeof out.text === "string" ? out.text : "";
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="run-detail">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-3">
        {lead}
        <RunStatus status={r?.status ?? "…"} />
        <span className="text-sm tabular-nums text-muted-foreground">{r?.startedAt ? whenText(r.startedAt) : ""}</span>
        {done && out.root && <span className="text-sm text-muted-foreground">on {out.root}</span>}
        {done && <span className="text-sm tabular-nums text-muted-foreground">{costText(out.cost)}</span>}
        {done && out.more && <span className="text-sm text-muted-foreground">more turns waiting</span>}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
        {run.isError && <p className="text-sm text-muted-foreground">{run.error instanceof Error ? run.error.message : String(run.error)}</p>}
        {r?.error && <p className="rounded-md border px-3 py-2 text-sm">{r.error.message}</p>}
        {!done && r && <p className="text-sm text-muted-foreground">Dreaming. What it changed appears when it finishes; the steps below fill in as it works.</p>}
        {done && !r?.error && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="summary">
            <Stat label="Turns read" value={sum.turns} />
            <Stat label="Corrections found" value={sum.found} />
            <Stat label="Pages changed" value={sum.pages} />
            <Stat label="Came back" value={sum.back} />
          </div>
        )}
        {done && !r?.error && (
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">What changed</h2>
            {changes.length ? (
              <ul className="flex flex-col divide-y rounded-md border">
                {changes.map((c) => (
                  <ChangeRow key={c.ref_id} change={c} causes={found.filter((f) => f.claim.about === c.ref_id)} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{sum.turns ? "No page changed." : text || "Nothing new to read."}</p>
            )}
          </section>
        )}
        {done && text && <Notes text={text} only={["Facts changed"]} />}
        {done && !r?.error && (
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">Causes, most corrected first</h2>
            {claims.length ? (
              <ul className="flex flex-col divide-y rounded-md border">
                {claims.map((c) => (
                  <ClaimGroup key={c.claim.id} claim={c.claim} children={c.children} runId={runId} now={now} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No claims yet.</p>
            )}
          </section>
        )}
        {done && tree.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">The tree after this dream</h2>
            <TreeView pages={tree} changes={changes} claims={all} />
          </section>
        )}
        {done && text && <Notes text={text} only={["Left alone"]} />}
        {done && text && !sectionsOf(text) && sum.turns > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">Its report</h2>
            <DocumentView text={text} kind="markdown" />
          </section>
        )}
        <section className="flex flex-col gap-2 pb-4">
          <h2 className="text-sm font-semibold">Every step it took</h2>
          <Transcript workflow={WORKFLOW} runId={runId} path={AGENT_PATH} live={!done} />
        </section>
      </div>
    </div>
  );
}

export default function App() {
  const narrow = useNarrow();
  const runs = useRuns(WORKFLOW, { limit: 30, live: true });
  const [picked, setPicked] = useState<string | null>(null);
  const [showList, setShowList] = useState(true);
  const list: RunSummary[] | undefined = runs.data;
  // Wide, the newest run is open from the start; narrow, the list is the page until one is picked.
  const runId = picked ?? (narrow ? null : (list?.[0]?.runId ?? null));
  const open = (id: string) => {
    setPicked(id);
    setShowList(false);
  };
  const listPane = (
    <aside className={cn("flex min-h-0 shrink-0 flex-col", narrow ? "flex-1" : "w-80 border-r")} data-testid="runs">
      <header className="flex shrink-0 flex-col gap-0.5 border-b px-4 py-3">
        <h1 className="text-sm font-semibold">Dream</h1>
        <p className="text-xs text-muted-foreground">Runs from its automation. Turn it on or run it once in Automations.</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {runs.isError ? (
          <p className="text-sm text-muted-foreground">{runs.error instanceof Error ? runs.error.message : String(runs.error)}</p>
        ) : (
          <RunList workflow={WORKFLOW} {...(list ? { runs: list } : {})} selected={runId} onSelect={(r) => open(r.runId)} />
        )}
      </div>
    </aside>
  );
  const back = narrow ? (
    <button type="button" onClick={() => setShowList(true)} aria-label="Back to the runs" className="rounded p-1 text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" />
    </button>
  ) : undefined;
  const detail = runId ? (
    <RunDetail key={runId} runId={runId} lead={back} />
  ) : (
    <p className="p-4 text-sm text-muted-foreground">{list && !list.length ? "No dream has run yet. Turn Dream on, or run it once, in Automations: its runs show here." : "Pick a run."}</p>
  );
  return (
    <div className="flex h-dvh min-h-0 bg-background text-foreground" data-testid="dream-app">
      {narrow ? (showList || !runId ? listPane : detail) : (
        <>
          {listPane}
          <main className="flex min-w-0 flex-1 flex-col">{detail}</main>
        </>
      )}
    </div>
  );
}
