// The gallery: every component of strut/views over fixtures (./fixtures/),
// through a client that answers the steps they call — so a person, and the
// builder, can see each one as it draws against a strut, with no grant.
import { useMemo, useState, type ReactNode } from "react";
import { StrutProvider, useStrutHost } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  ArtifactView, DocumentView, LaunchForm, RunHealth, NodeCard, NodeGraph, NodeSearch, RunGraph, RunList, RunStatus, RunTimeline, Transcript,
} from "./index";
import { createFixtureClient } from "./fixtures/client";
import { TRANSCRIPT_MARKS } from "./fixtures/content";
import { EXPLORE_PATH, REF, RUN_ID, WORKFLOW } from "./fixtures/runs";
import { REPORT_RUN_ID } from "./fixtures/report";

interface Entry {
  name: string;
  what: string;
  /** What the importing app grants for it. */
  grants: string;
  usage: string;
  demo: () => ReactNode;
}

function NodePicker() {
  const [ref, setRef] = useState<string>(REF.arrhythmia);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <NodeSearch onSelect={(h) => setRef(h.ref_id)} placeholder="Search: rhythm, pressure, trial…" />
      <NodeCard refId={ref} />
    </div>
  );
}

/** The same run folded, or every row at its depth with the foreach's iterations side by side. */
function TimelineDemo() {
  const [report, setReport] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1">
        {[false, true].map((r) => (
          <button key={String(r)} type="button" onClick={() => setReport(r)} className={cn("rounded-md border px-2.5 py-1 text-xs", report === r ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60")}>
            {r ? "tree split — a report's run" : "default"}
          </button>
        ))}
      </div>
      {report ? <RunTimeline key="report" workflow={WORKFLOW} runId={REPORT_RUN_ID} tree split /> : <RunTimeline key="default" workflow={WORKFLOW} runId={RUN_ID} />}
    </div>
  );
}

const ENTRIES: Entry[] = [
  {
    name: "RunTimeline",
    what: "The run at a glance: status, cost, model calls, time, and a row per step with the work it started (agents, llm calls, child runs), its tokens and cost. `tree` puts every row under the one that started it, at any depth; `split` gives a foreach's iterations a row each, so the ones that ran in parallel sit side by side.",
    grants: "grants.workflows: the run's workflow",
    usage: `<RunTimeline workflow="research" runId={runId} tree split onOpenRun={(wf, id) => …} />`,
    demo: () => <TimelineDemo />,
  },
  {
    name: "RunHealth",
    what: "What went wrong and what was done about it: the steps that failed, the ones tried again, the ones an onError fallback stood in for, skipped branches and which way each `if` went, what was cut off, the tool calls that failed by tool — and the log's own numbers.",
    grants: "grants.workflows: the run's workflow",
    usage: `<RunHealth workflow="research" runId={runId} onOpenStep={(path) => …} />`,
    demo: () => <RunHealth workflow={WORKFLOW} runId={REPORT_RUN_ID} />,
  },
  {
    name: "DocumentView",
    what: "A document a run produced — an HTML page, markdown, text — drawn in the page with the terms you give highlighted and the first scrolled to. An HTML page is drawn from its safe elements (SafeHtml): nothing of it runs, only text and plain elements survive, a link opens through the host.",
    grants: "grants.workflows: the run's workflow (run/files) · none: pass the text",
    usage: `<DocumentView workflow="research" runId={runId} path="memo.html" terms={["atrial fibrillation"]} />  <SafeHtml html={html} />`,
    demo: () => (
      <div className="grid gap-6 lg:grid-cols-2">
        <DocumentView workflow={WORKFLOW} runId={RUN_ID} path="memo.html" terms={["atrial fibrillation", "130/80"]} />
        <DocumentView workflow={WORKFLOW} runId={RUN_ID} path="report.md" terms={["hypertension"]} />
      </div>
    ),
  },
  {
    name: "RunGraph",
    what: "Every graph call the run made as a tree, the nodes laid out by stage under their lineage, a replay through the calls, child runs opened in place, a peer's nodes badged.",
    grants: "grants.workflows: the run's (and its child runs') workflows · grants.steps: graph/graph-get-batched, graph/graph-neighbors",
    usage: `<RunGraph workflow="research" runId={runId} live />`,
    demo: () => (
      <div className="h-[640px] overflow-hidden rounded-lg border">
        <RunGraph workflow={WORKFLOW} runId={RUN_ID} fill />
      </div>
    ),
  },
  {
    name: "LaunchForm",
    what: "A routine's face: the workflow's input: block as a form, a button that launches it deduped by key, the run it joined, the last run's status.",
    grants: "grants.workflows: the workflow",
    usage: `<LaunchForm workflow="research" onLaunched={({ runId }) => …} />`,
    demo: () => <LaunchForm workflow={WORKFLOW} initial={{ question: "What drives AF in hypertension?" }} />,
  },
  {
    name: "RunList",
    what: "A workflow's runs, newest first, live while one is in flight; where each came from.",
    grants: "grants.workflows: the workflow",
    usage: `<RunList workflow="research" onSelect={(run) => …} />`,
    demo: () => <RunList workflow={WORKFLOW} onSelect={() => {}} />,
  },
  {
    name: "RunStatus",
    what: "A run's status as a badge; given a run, it reads it live.",
    grants: "none (a status) · grants.workflows (a run)",
    usage: `<RunStatus status="running" />  <RunStatus workflow="research" runId={runId} />`,
    demo: () => (
      <div className="flex flex-wrap gap-2">
        {["running", "paused", "success", "error", "cancelled", "stale"].map((s) => <RunStatus key={s} status={s} />)}
      </div>
    ),
  },
  {
    name: "Transcript",
    what: "An agent's session: the person's messages, the model's markdown, tool calls with their results, the server's notices, turn marks. Read from a run's agent step, or drawn from messages you pass.",
    grants: "grants.workflows: the run's workflow (run/transcript) · none: pass the messages",
    usage: `<Transcript workflow="research" runId={runId} path="research/explore" />  <Transcript messages={messages} />`,
    demo: () => <Transcript workflow={WORKFLOW} runId={RUN_ID} path={EXPLORE_PATH} marks={TRANSCRIPT_MARKS} />,
  },
  {
    name: "ArtifactView",
    what: "A file a run produced, rendered: markdown, an HTML page (its safe elements, through DocumentView), images, video, sound, text, a walkthrough's frames to scrub; a PDF opens in strut.",
    grants: "grants.workflows: the run's workflow (run/files)",
    usage: `<ArtifactView workflow="research" runId={runId} path="report.md" />`,
    demo: () => (
      <div className="grid gap-6 lg:grid-cols-2">
        <ArtifactView workflow={WORKFLOW} runId={RUN_ID} path="report.md" />
        <ArtifactView workflow={WORKFLOW} runId={RUN_ID} path="walkthrough/walkthrough.json" />
        <ArtifactView workflow={WORKFLOW} runId={RUN_ID} path="memo.html" />
        <ArtifactView workflow={WORKFLOW} runId={RUN_ID} path="/artifacts/1790000000100/chart.svg" />
        <div className="flex flex-col gap-4">
          <ArtifactView workflow={WORKFLOW} runId={RUN_ID} path="notes.txt" />
          <ArtifactView workflow={WORKFLOW} runId={RUN_ID} path="report.pdf" />
        </div>
      </div>
    ),
  },
  {
    name: "NodeSearch · NodeCard",
    what: "Search the graph as you type; a node at a glance — its type, the start of its prose, its edges.",
    grants: "grants.steps: graph/graph-search, graph/graph-get-batched",
    usage: `<NodeSearch type="Concept" onSelect={(hit) => …} />  <NodeCard refId={hit.ref_id} />`,
    demo: () => <NodePicker />,
  },
  {
    name: "NodeGraph",
    what: "A node's neighbourhood in React Flow; a click opens a neighbour's outward.",
    grants: "grants.steps: graph/graph-get-batched, graph/graph-neighbors",
    usage: `<NodeGraph refId={refId} onSelect={(n) => …} />`,
    demo: () => <NodeGraph refId={REF.cardiology} />,
  },
];

export default function App() {
  const host = useStrutHost();
  const client = useMemo(() => createFixtureClient(), []);
  const [shown, setShown] = useState(ENTRIES[0]!.name);
  const entry = ENTRIES.find((e) => e.name === shown) ?? ENTRIES[0]!;
  return (
    <StrutProvider client={client} host={host}>
      <div className="flex min-h-screen flex-col bg-background text-foreground md:flex-row">
        <nav className="flex shrink-0 flex-col gap-0.5 border-b p-3 md:w-60 md:border-r md:border-b-0" aria-label="Components">
          <div className="px-2 pb-2">
            <div className="font-semibold">strut/views</div>
            <div className="text-xs text-muted-foreground">import {"{ … }"} from "strut/views"</div>
          </div>
          {ENTRIES.map((e) => (
            <button
              key={e.name}
              type="button"
              onClick={() => setShown(e.name)}
              className={cn("rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted", shown === e.name && "bg-muted font-medium")}
            >
              {e.name}
            </button>
          ))}
        </nav>
        <main className="flex min-w-0 flex-1 flex-col gap-4 p-6" data-testid="gallery">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-xl font-semibold">{entry.name}</h1>
            <p className="text-sm text-muted-foreground">{entry.what}</p>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline" className="font-normal">needs</Badge>
              <span className="text-muted-foreground">{entry.grants}</span>
            </div>
            <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">{entry.usage}</pre>
          </div>
          <section key={entry.name}>{entry.demo()}</section>
        </main>
      </div>
    </StrutProvider>
  );
}
