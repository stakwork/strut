// strut/dream (plans/dream.md): what the dream did. On the left its runs,
// newest first, and a button to run one now. On the right the picked run,
// read from the outcome back to how it got there: what it changed (its
// report), the claims as they stood after it, grouped, with what was said for
// each and what the assistant did there, then every step the agent took. Everything is read from the run
// (`grants.workflows: [dream]`), so the page shows what the dream's own run
// could read and nothing more. Narrow, the list and the run take the page in
// turn.
import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Play } from "lucide-react";
import { useLaunch, useRun, useRuns, type RunSummary } from "@strut/kit";
import { DocumentView, RunList, RunStatus, Transcript } from "strut/views";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { OUTCOME_TEXT, costText, nest, sectionsOf, whenText, type Claim, type DreamOutput } from "./lib/report";

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

const SectionLabel = ({ children }: { children: ReactNode }) => <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</h3>;

/** The report, a section at a time; one the agent did not shape that way is drawn as it wrote it. */
function Report({ text }: { text: string }) {
  const sections = sectionsOf(text);
  if (!sections) return <DocumentView text={text} kind="markdown" />;
  return (
    <div className="flex flex-col gap-4" data-testid="report">
      {sections.map((s) => (
        <section key={s.title} className="flex flex-col gap-1.5">
          <SectionLabel>{s.title}</SectionLabel>
          {s.lines.length ? (
            <ul className="flex flex-col gap-1 text-sm">
              {s.lines.map((l, i) => (
                <li key={i} className="rounded-md border px-3 py-1.5">{l}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing.</p>
          )}
        </section>
      ))}
    </div>
  );
}

/** A claim with what was said for it: the words, when, where, and what the assistant did there. */
function ClaimCard({ claim, nested }: { claim: Claim; nested?: boolean }) {
  return (
    <li className={cn("flex flex-col gap-2 rounded-md border p-3", nested && "border-dashed")} data-testid="claim">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-medium">{claim.title || claim.text}</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          corrected {claim.corrected}× · kept {claim.kept}×
        </span>
        <span className="text-xs text-muted-foreground">on {claim.concept}</span>
      </div>
      {claim.title && claim.title !== claim.text && <p className="text-sm text-muted-foreground">{claim.text}</p>}
      <ul className="flex flex-col gap-1.5">
        {claim.evidence.map((e, i) => (
          <li key={i} className="grid grid-cols-[7.5rem_1fr] gap-x-3 text-xs">
            <span className="tabular-nums text-muted-foreground">{whenText(e.at)}</span>
            <span className="min-w-0">
              <span className={cn("break-words", e.outcome === "followed" && "text-muted-foreground")}>“{e.excerpt}”</span>
              <span className="block text-muted-foreground">
                {e.outcome ? OUTCOME_TEXT[e.outcome] : "not sorted"}
                {e.denies ? " · says the claim is wrong" : ""} · {e.said_by ? `${e.said_by} · ` : ""}
                {e.session} · turn {e.turn}
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
function ClaimGroup({ claim, children }: { claim: Claim; children: Claim[] }) {
  if (!children.length) return <ClaimCard claim={claim} />;
  return (
    <li className="flex flex-col gap-2 rounded-md border p-3" data-testid="claim-group">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-semibold">{claim.title || claim.text}</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          corrected {claim.corrected}× · kept {claim.kept}× · {children.length} claim{children.length === 1 ? "" : "s"}
        </span>
        <span className="text-xs text-muted-foreground">on {claim.concept}</span>
      </div>
      <ul className="flex flex-col gap-2">
        {children.map((c) => (
          <ClaimCard key={c.id} claim={c} nested />
        ))}
      </ul>
    </li>
  );
}

function RunDetail({ runId, lead }: { runId: string; lead?: ReactNode }) {
  const run = useRun(WORKFLOW, runId, { live: true });
  const r = run.data;
  const out = (r?.output && typeof r.output === "object" ? r.output : {}) as DreamOutput;
  const claims = nest(Array.isArray(out.claims) ? out.claims : []);
  const done = !!r && r.status !== "running" && r.status !== "paused";
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="run-detail">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-3">
        {lead}
        <RunStatus status={r?.status ?? "…"} />
        <span className="text-sm tabular-nums text-muted-foreground">{r?.startedAt ? whenText(r.startedAt) : ""}</span>
        {done && typeof out.turns === "number" && <span className="text-sm tabular-nums text-muted-foreground">{out.turns} turn{out.turns === 1 ? "" : "s"} read{out.more ? ", more waiting" : ""}</span>}
        {done && <span className="text-sm tabular-nums text-muted-foreground">{costText(out.cost)}</span>}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
        {run.isError && <p className="text-sm text-muted-foreground">{run.error instanceof Error ? run.error.message : String(run.error)}</p>}
        {r?.error && <p className="rounded-md border px-3 py-2 text-sm">{r.error.message}</p>}
        {!done && r && <p className="text-sm text-muted-foreground">Dreaming. The report appears when it finishes; the steps below fill in as it works.</p>}
        {done && typeof out.text === "string" && out.text && (
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">What it changed</h2>
            <Report text={out.text} />
          </section>
        )}
        {done && (
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">Claims after this dream{out.root ? `, on ${out.root}` : ""}</h2>
            {claims.length ? (
              <ul className="flex flex-col gap-2">
                {claims.map((c) => (
                  <ClaimGroup key={c.claim.id} claim={c.claim} children={c.children} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No claims yet.</p>
            )}
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
  const launcher = useLaunch(WORKFLOW);
  const [picked, setPicked] = useState<string | null>(null);
  const [showList, setShowList] = useState(true);
  const list: RunSummary[] | undefined = runs.data;
  // Wide, the newest run is open from the start; narrow, the list is the page until one is picked.
  const runId = picked ?? (narrow ? null : (list?.[0]?.runId ?? null));
  const open = (id: string) => {
    setPicked(id);
    setShowList(false);
  };
  const runNow = async () => {
    const r = await launcher.launch({});
    if (r?.runId) open(r.runId);
  };
  const listPane = (
    <aside className={cn("flex min-h-0 shrink-0 flex-col", narrow ? "flex-1" : "w-80 border-r")} data-testid="runs">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
        <h1 className="text-sm font-semibold">Dream</h1>
        <Button size="sm" onClick={runNow} disabled={launcher.pending}>
          <Play />
          Run now
        </Button>
      </header>
      {launcher.error && <p className="border-b px-4 py-2 text-xs text-muted-foreground">{launcher.error.message}</p>}
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
    <p className="p-4 text-sm text-muted-foreground">{list && !list.length ? "No dream has run yet. Run one now to see what it finds." : "Pick a run."}</p>
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
