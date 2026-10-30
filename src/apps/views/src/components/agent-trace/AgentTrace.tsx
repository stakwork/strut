import { useCallback, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";
import {
  foldAgentTrace, useRunEvents, useStrutClient, useTranscripts,
  type AccessedNode, type RunEvent, type RunGraphNodeBody, type TraceAgent, type TraceEvent, type TraceTranscripts,
} from "@strut/kit";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { nodeColor } from "../../lib/colors";
import { errorText, fmtCost, fmtDuration } from "../../lib/format";
import { getNodes } from "../../lib/graph-steps";
import { RunGraphNodeReader } from "../run-graph/NodeReader";
import { RunStatus } from "../RunStatus";
import { downloadHtml, fileName, snapshotHtml } from "./snapshot";
import { buildViewRows, Chip, LANE_TEXT, LANE_X, LanesSvg, MIN_W, ROW_H, TOP_PAD, TraceRowItem, pillKey, tokensOf } from "./TraceRows";

/** How often a live trace reads what its log gained: the server reads the
 *  whole log to answer, and a long run's agents move in minutes. */
export const AGENT_TRACE_INTERVAL_MS = 10_000;

export interface AgentTraceProps {
  /** Read the run's log (`run/events`) — the importing app's grant. */
  workflow?: string;
  runId?: string;
  /** Follow the run while it is in flight, reading only what its log gained. */
  live?: boolean;
  /** Or draw this log. */
  events?: RunEvent[];
  /** Each agent's transcript by its step path; by default each FINISHED
   *  agent's is read once (`run/transcript`) for the reasoning before its calls. */
  transcripts?: TraceTranscripts;
  /** Leave the transcripts unread: the calls without the reasoning. */
  reasoning?: boolean;
  /** The node types a read shows as a row (default `Concept`); null: every type. */
  readTypes?: readonly string[] | null;
  /** How often a live trace polls (default 10 s). */
  intervalMs?: number;
  className?: string;
}

type Peek = { node: AccessedNode; state: "reading" } | { node: AccessedNode; state: "read"; body: RunGraphNodeBody } | { node: AccessedNode; state: "failed"; error: string };

/**
 * A run's agents as a nested cascade (`foldAgentTrace`): one section per
 * `agent` step, the ones that ran at the same time side by side as a batch;
 * in each, the prompt, pills of tool calls that open into the calls and the
 * reasoning before them, the nodes a call read or wrote on the right (a click
 * opens one from the graph), sub-agents forking off on their own lane and
 * merging back, the response. Live, it grows as the log does. "Download HTML"
 * saves what is on screen as one file.
 */
export function AgentTrace({ workflow, runId, live, events: given, transcripts: givenTranscripts, reasoning = true, readTypes, intervalMs, className }: AgentTraceProps) {
  const wf = workflow ?? "";
  const q = useRunEvents(wf, runId, { live, intervalMs: intervalMs ?? AGENT_TRACE_INTERVAL_MS, enabled: !given && !!workflow && !!runId });
  const events = (given ?? q.data) as TraceEvent[] | undefined;
  const opts = useMemo(() => (readTypes === undefined ? {} : { readTypes }), [readTypes]);
  // The paths to read come from the log alone; the transcripts then refold it.
  const finished = useMemo(() => {
    if (!events || givenTranscripts || !reasoning) return [];
    return foldAgentTrace(events, undefined, opts).sessions.filter((s) => s.status !== "running" && s.transcript).map((s) => s.path);
  }, [events, givenTranscripts, reasoning, opts]);
  const read = useTranscripts(wf, runId, finished, { enabled: finished.length > 0 });
  const model = useMemo(() => (events ? foldAgentTrace(events, givenTranscripts ?? read, opts) : null), [events, givenTranscripts, read, opts]);

  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback((key: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (!next.delete(key)) next.add(key);
    return next;
  }), []);
  const allPills = useMemo(() => new Set(model?.agents.flatMap((a) => a.rows.flatMap((r) => (r.kind === "pill" ? [`pill:${pillKey(r)}`] : []))) ?? []), [model]);
  const allOpen = allPills.size > 0 && [...allPills].every((k) => open.has(k));

  const [reading, setReading] = useState<{ title: string; text: string } | null>(null);
  const onRead = useCallback((title: string, text: string) => setReading({ title, text }), []);

  const client = useStrutClient();
  const [peek, setPeek] = useState<Peek | null>(null);
  const bodies = useRef(new Map<string, RunGraphNodeBody>());
  const onPeek = useCallback(async (node: AccessedNode) => {
    if (node.peer) return;
    const known = bodies.current.get(node.ref_id);
    if (known) return setPeek({ node, state: "read", body: known });
    setPeek({ node, state: "reading" });
    try {
      const n = (await getNodes(client, [node.ref_id])).get(node.ref_id);
      if (!n || "error" in n) throw new Error(n && "error" in n ? n.error : "The graph has no such node.");
      const body: RunGraphNodeBody = { ref_id: n.ref_id, node_type: n.node_type, labels: [], properties: n.properties };
      bodies.current.set(node.ref_id, body);
      setPeek((p) => (p?.node.ref_id === node.ref_id ? { node: { ...node, name: n.name || node.name, node_type: n.node_type }, state: "read", body } : p));
    } catch (e) {
      setPeek((p) => (p?.node.ref_id === node.ref_id ? { node, state: "failed", error: errorText(e) } : p));
    }
  }, [client]);

  const root = useRef<HTMLDivElement>(null);

  if (!model) {
    if (q.isError) return <p className={cn("text-sm text-destructive", className)}>{errorText(q.error)}</p>;
    return <Skeleton className={cn("h-40 w-full", className)} />;
  }
  if (!model.agents.length) return <p className={cn("text-sm text-muted-foreground", className)}>{model.finished ? "The run started no agents." : "No agent has started yet."}</p>;

  const s = model.summary;
  const batches: TraceAgent[][] = [];
  for (const a of model.agents) {
    const last = batches[batches.length - 1];
    if (last && last[0]!.batch === a.batch) last.push(a);
    else batches.push([a]);
  }
  const section = (a: TraceAgent) => (
    <AgentSection key={a.session.path} agent={a} startMs={s.startedAt} open={open} onToggle={toggle} onRead={onRead} onPeek={onPeek} peeking={peek?.state === "reading" ? peek.node.ref_id : null} />
  );

  return (
    <div ref={root} className={cn("flex flex-col text-sm", className)} data-testid="agent-trace">
      <div className="flex flex-wrap items-center gap-2 py-2">
        {s.running && (
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
            <span className="size-2 rounded-full bg-emerald-500 motion-safe:animate-pulse" />
            running
          </span>
        )}
        <Chip label="agents" value={s.agents} />
        <Chip label="sub-agents" value={s.subAgents} />
        <Chip label="nodes" value={s.nodes} />
        <Chip label="tool calls" value={s.toolCalls} />
        {tokensOf(s.usage) && <Chip label="tok" value={tokensOf(s.usage)} />}
        {s.cost > 0 && <Chip label="cost" value={fmtCost(s.cost)} />}
        <span className="ml-auto inline-flex items-center gap-2" data-snapshot="omit">
          <button type="button" onClick={() => root.current && downloadHtml(snapshotHtml(root.current, `${model.workflow}${runId ? ` · ${runId}` : ""} · agents`), `${fileName(model.workflow, runId, "agents")}.html`)} className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1 font-mono text-[11px] text-muted-foreground hover:text-foreground">
            <Download className="size-3" /> Download HTML
          </button>
          <button type="button" onClick={() => setOpen(allOpen ? new Set() : new Set([...open, ...allPills]))} className="rounded-md border px-3 py-1 font-mono text-[11px] text-muted-foreground hover:text-foreground">
            {allOpen ? "collapse all" : "expand all"}
          </button>
        </span>
      </div>
      <div className="overflow-x-auto pb-2">
        <div className="flex flex-col gap-1" style={{ minWidth: MIN_W }}>
          {batches.map((batch) =>
            batch.length === 1 ? section(batch[0]!) : (
              <div key={`batch-${batch[0]!.batch}`} className="border-l-2 border-dashed pl-2" data-batch={batch[0]!.batch}>
                <div className="px-1 pt-2 font-mono text-[10px] tracking-[0.14em] text-muted-foreground/70 uppercase">∥ parallel ×{batch.length}</div>
                {batch.map(section)}
              </div>
            ),
          )}
        </div>
      </div>

      <Dialog open={reading !== null} onOpenChange={(o) => !o && setReading(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{reading?.title}</DialogTitle>
            <DialogDescription className="sr-only">The whole text, as the run's log keeps it.</DialogDescription>
          </DialogHeader>
          <pre className="font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">{reading?.text}</pre>
        </DialogContent>
      </Dialog>
      {peek?.state === "read" && (
        <RunGraphNodeReader
          node={{ ref_id: peek.node.ref_id, node_type: peek.node.node_type ?? "Node", name: peek.node.name || peek.node.ref_id.slice(0, 8), namespace: null, found: true }}
          body={peek.body}
          color={nodeColor(peek.node.node_type ?? "Node")}
          open
          onOpenChange={(o) => !o && setPeek(null)}
        />
      )}
      <Dialog open={peek?.state === "failed"} onOpenChange={(o) => !o && setPeek(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{peek?.node.name || peek?.node.ref_id}</DialogTitle>
            <DialogDescription>{peek?.state === "failed" ? peek.error : ""}</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AgentSection({ agent, startMs, open, onToggle, onRead, onPeek, peeking }: {
  agent: TraceAgent;
  startMs: number | null;
  open: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onRead: (title: string, text: string) => void;
  onPeek: (node: AccessedNode) => void;
  peeking: string | null;
}) {
  const s = agent.session;
  const rows = useMemo(() => buildViewRows(agent.rows, open), [agent.rows, open]);
  const height = TOP_PAD + rows.length * ROW_H + (agent.live ? 40 : 8);
  const took = s.startedAt !== null && s.endedAt !== null ? fmtDuration(s.endedAt - s.startedAt) : null;
  return (
    <section data-agent={s.path}>
      <div className="flex flex-wrap items-center gap-2 border-t px-1 pt-3 pb-1">
        <span className={cn("font-mono text-[10.5px] font-bold tracking-[0.1em] uppercase", LANE_TEXT[0])}>{s.label}</span>
        <RunStatus status={s.status} />
        {took && <span className="font-mono text-[10.5px] text-muted-foreground">· {took}</span>}
        <span className="ml-auto inline-flex flex-wrap items-center gap-2">
          <Chip label="calls" value={s.toolCalls} />
          {tokensOf(s.usage) && <Chip label="tok" value={tokensOf(s.usage)} />}
          {s.cost > 0 && <Chip label="cost" value={fmtCost(s.cost)} />}
          {s.model && <Chip label="model" value={s.model} />}
        </span>
      </div>
      <div className="relative" style={{ height }}>
        <LanesSvg rows={rows} height={height} live={agent.live} />
        {rows.map((vr, i) => (
          <TraceRowItem key={vr.key} vr={vr} index={i} startMs={startMs} open={open} onToggle={onToggle} onRead={onRead} onPeek={onPeek} peeking={peeking} />
        ))}
        {agent.live && (
          <div
            className="absolute size-2.5 rounded-full bg-cyan-600 motion-safe:animate-pulse dark:bg-cyan-400"
            style={{ left: LANE_X[0]! - 5, top: TOP_PAD + (rows.length - 1) * ROW_H + ROW_H / 2 + ROW_H * 0.8 - 5 }}
          />
        )}
      </div>
    </section>
  );
}
