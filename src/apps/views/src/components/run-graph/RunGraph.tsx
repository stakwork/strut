// The run graph (plans/apps.md §3.3), ported from hive
// (src/components/strut-run-graph/index.tsx): the tree of graph calls, the
// replay, the lanes and lineage, the child runs and peers — unchanged. What
// moved is the data path: hive fetched a trace its server built; here the
// page builds it (./reader.ts) from `run/events` and `graph/graph-get-batched`
// / `graph/graph-neighbors`, through the one client, on the importing app's
// grants. Hive's Graph Explorer link is gone (strut has no explorer page).
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  ChevronRight,
  Crosshair,
  Eye,
  ListTree,
  Loader2,
  Pause,
  PenLine,
  Play,
  SkipBack,
  SkipForward,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import {
  ancestorsOf,
  buildRunGraphTree,
  callLabel,
  childToLoad,
  distinctNodeRefs,
  eventsSettled,
  keepGraphRead,
  launchSections,
  layoutRunGraph,
  lineageParents,
  nodeText,
  parseQualifiedRef,
  projectWithLaunches,
  replayFrame,
  runGraphHops,
  runGraphLinks,
  scopeCalls,
  scopeOfBranch,
  segmentLabel,
  useStrutClient,
  withChildCalls,
  withChildGraph,
  type RunEvent,
  type RunGraphAccess,
  type RunGraphCall,
  type RunGraphEdge,
  type RunGraphLaunch,
  type RunGraphLink,
  type RunGraphNode,
  type RunGraphNodeBody,
  type RunGraphPeer,
  type RunGraphTrace,
  type RunGraphTreeNode,
} from "@strut/kit";
import { isProvenanceType, runGraphColorMap } from "../../lib/colors";
import { errorText } from "../../lib/format";
import { getNodes } from "../../lib/graph";
import { RunGraphNodeReader } from "./NodeReader";
import { RunGraphCanvas, type RunGraphCanvasNode } from "./RunGraphCanvas";
import { RunGraphReader } from "./reader";

/** Refresh cadence while the run is still going. */
const LIVE_POLL_MS = 10_000;
/** A run that touched fewer nodes than this opens the runs it launched on its own. */
const AUTO_OPEN_BELOW = 10;
/** One call per tick when playing. */
const PLAY_INTERVAL_MS = 800;

/** Width the legend takes at the right of the canvas: `w-52` and its margin. */
const LEGEND_INSET = 232;

const ACCESS_LABEL: Record<RunGraphAccess, string> = { read: "Reads", write: "Writes" };

function AccessIcon({ access, className }: { access: RunGraphAccess; className?: string }) {
  const Icon = access === "write" ? PenLine : Eye;
  return <Icon className={className} aria-label={access} />;
}

/** The one thing a call asked for, for its row in the tree. */
function querySummary(call: RunGraphCall): string {
  const { query } = call;
  const value =
    query.q ?? query.query ?? query.name ?? query.file ?? query.ref_id ?? query.source_ref_id ?? query.ref_ids;
  if (value === undefined) return "";
  return Array.isArray(value) ? `${value.length} refs` : String(value);
}

/** What a call came back with: the nodes it read or wrote, or what a search matched. */
function answerSummary(call: RunGraphCall): string {
  if (call.hits === undefined) return String(call.nodes.length);
  return call.hits === 1 ? "1 hit" : `${call.hits} hits`;
}

/** `a` → `b` → calls reads as one row, `a / b`, when `a` holds nothing else. */
function compress(node: RunGraphTreeNode): { label: string; node: RunGraphTreeNode } {
  let label = node.label;
  let current = node;
  while (current.callIndex === null && current.children.length === 1 && current.children[0].callIndex === null) {
    current = current.children[0];
    label = `${label} / ${current.label}`;
  }
  return { label, node: current };
}

function TreeBranch({
  node,
  depth,
  calls,
  step,
  expanded,
  onToggle,
  onPick,
  onFocus,
  childState,
  onOpenChild,
}: {
  node: RunGraphTreeNode;
  depth: number;
  calls: RunGraphCall[];
  step: number | null;
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onPick: (index: number) => void;
  /** Show only this branch. */
  onFocus: (path: string) => void;
  /** Where loading the run a launching call started stands, by the call's path in the tree. */
  childState: (path: string) => ChildState | undefined;
  /** Load the run a launching call started, by the call's path in the tree. */
  onOpenChild: (path: string) => void | Promise<void>;
}) {
  const indent = { paddingLeft: `${depth * 14 + 8}px` };

  if (node.callIndex !== null) {
    const call = calls[node.callIndex];
    const current = step === node.callIndex;
    const past = step === null || node.callIndex < step;
    const pickButton = (
      <button
        type="button"
        onClick={() => onPick(node.callIndex as number)}
        style={indent}
        data-testid="run-graph-call"
        data-current={current}
        className={`flex min-w-0 flex-1 items-center gap-2 py-1 pr-2 text-left text-xs transition-colors hover:bg-muted/60 ${
          current ? "bg-muted font-medium" : past ? "" : "text-muted-foreground/60"
        }`}
      >
        <AccessIcon access={call.access} className="h-3 w-3 shrink-0" />
        <span className="shrink-0 font-mono">{callLabel(node.label)}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{querySummary(call)}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{answerSummary(call)}</span>
      </button>
    );
    if (!call.child) return pickButton;
    // A call that ran a workflow as its own run: its calls are loaded when opened, and take its place.
    const state = childState(node.path);
    const where = call.child.peer ? ` on @${call.child.peer}` : "";
    return (
      <div className="flex w-full items-center">
        {pickButton}
        <button
          type="button"
          onClick={() => void onOpenChild(node.path)}
          disabled={state?.state === "loading"}
          aria-label={`Open the ${call.child.workflow} run${where}`}
          title={state?.state === "failed" ? state.error : `Open the ${call.child.workflow} run${where}`}
          data-testid="run-graph-open-child"
          className={`mr-1 shrink-0 rounded p-0.5 hover:text-foreground ${
            state?.state === "failed" ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {state?.state === "loading" ? <Loader2 className="h-3 w-3 animate-spin" /> : <ListTree className="h-3 w-3" />}
        </button>
      </div>
    );
  }

  const { label, node: branch } = compress(node);
  const open = expanded.has(branch.path);
  return (
    <div>
      <div className="group flex items-center pr-2 transition-colors hover:bg-muted/60" style={indent}>
        <button
          type="button"
          onClick={() => onToggle(branch.path)}
          aria-expanded={open}
          data-testid="run-graph-branch"
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-xs font-medium"
        >
          <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
          <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground">{branch.callCount}</span>
        </button>
        {depth > 0 && (
          <button
            type="button"
            onClick={() => onFocus(node.path)}
            aria-label={`Show only ${label}`}
            title="Show only this"
            data-testid="run-graph-focus"
            className="ml-1 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Crosshair className="h-3 w-3" />
          </button>
        )}
      </div>
      {open &&
        branch.children.map((child) => (
          <TreeBranch
            key={child.path}
            node={child}
            depth={depth + 1}
            calls={calls}
            step={step}
            expanded={expanded}
            onToggle={onToggle}
            onPick={onPick}
            onFocus={onFocus}
            childState={childState}
            onOpenChild={onOpenChild}
          />
        ))}
    </div>
  );
}

/** Where loading a launching call's run stands. */
type ChildState =
  | { state: "loading" }
  | { state: "loaded"; calls: RunGraphCall[]; nodes: RunGraphNode[]; edges: RunGraphEdge[] }
  | { state: "failed"; error: string };

/** A node's body, as the graph has answered for it so far. */
type NodeBodyState =
  | { state: "reading" }
  | { state: "read"; body: RunGraphNodeBody }
  | { state: "failed"; error: string };

/** The node's text in the panel: a few lines of its first prose, and the way to read it all. */
function NodeTextSection({
  state,
  onRead,
  onOpen,
}: {
  state: NodeBodyState | undefined;
  onRead: () => void;
  onOpen: () => void;
}) {
  if (!state || state.state === "reading") {
    return (
      <p className="flex items-center gap-1.5 text-muted-foreground" data-testid="run-graph-node-text">
        <Loader2 className="h-3 w-3 animate-spin" />
        Reading the node…
      </p>
    );
  }
  if (state.state === "failed") {
    return (
      <p className="flex flex-wrap items-center gap-2 text-muted-foreground" data-testid="run-graph-node-text">
        {state.error}
        <Button variant="outline" size="sm" className="h-6 text-xs" onClick={onRead}>
          Ask again
        </Button>
      </p>
    );
  }
  const first = nodeText(state.body.properties).prose[0];
  return (
    <div className="flex flex-col gap-1" data-testid="run-graph-node-text">
      {first ? (
        <>
          <p className="font-medium">{first[0]}</p>
          <p className="line-clamp-4 whitespace-pre-wrap text-muted-foreground">{first[1]}</p>
        </>
      ) : (
        <p className="text-muted-foreground">The graph stores no text on this node.</p>
      )}
      <Button
        variant="outline"
        size="sm"
        className="h-6 w-fit gap-1 text-xs"
        onClick={onOpen}
        data-testid="run-graph-node-read"
      >
        <BookOpen className="h-3 w-3" />
        Read
      </Button>
    </div>
  );
}

function NodeDetail({
  node,
  color,
  peer,
  calls,
  links,
  nodeById,
  graphAnswered,
  unreadReason,
  body,
  onRead,
  onPick,
  onSelect,
  onClose,
}: {
  node: RunGraphNode;
  color: string;
  /** For a node in a peer workspace's graph: that workspace, and whether its graph was read for this viewer. */
  peer?: RunGraphPeer;
  /** False when the graph did not answer for the nodes, which is not a node it no longer holds. */
  graphAnswered: boolean;
  /** Why it did not, in parentheses, or empty. */
  unreadReason: string;
  calls: RunGraphCall[];
  links: RunGraphLink[];
  nodeById: ReadonlyMap<string, RunGraphNode>;
  /** The node's body, once asked for; undefined before. */
  body: NodeBodyState | undefined;
  /** Ask the graph for the body (again). */
  onRead: () => void;
  onPick: (index: number) => void;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [reading, setReading] = useState(false);
  /** The node's id in its own graph. */
  const refId = parseQualifiedRef(node.ref_id).refId;
  const touchedBy = useMemo(
    () => calls.flatMap((call, index) => (call.nodes.some((n) => n.ref_id === node.ref_id) ? [{ call, index }] : [])),
    [calls, node.ref_id],
  );
  const linked = useMemo(
    () =>
      links.flatMap((link) => {
        const out = link.source === node.ref_id;
        if (!out && link.target !== node.ref_id) return [];
        const other = nodeById.get(out ? link.target : link.source);
        return other ? [{ link, out, other }] : [];
      }),
    [links, node.ref_id, nodeById],
  );
  return (
    <div
      className="absolute left-3 top-3 z-10 flex max-h-[85%] w-72 flex-col gap-2 overflow-y-auto rounded-lg border bg-card p-3 text-xs shadow-md"
      data-testid="run-graph-node-detail"
    >
      <div className="flex items-start gap-2">
        <span className="mt-1 inline-block size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-semibold">{node.name}</p>
          <p className="text-muted-foreground">{node.node_type}</p>
          {node.peer && (
            <Badge variant="outline" className="mt-1 font-normal" data-testid="run-graph-node-peer">
              @{node.peer}
            </Badge>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {node.namespace && (
        <p className="text-muted-foreground">
          Namespace <span className="font-mono text-foreground">{node.namespace}</span>
        </p>
      )}
      <p className="break-all font-mono text-muted-foreground">{refId}</p>
      {!node.found && (
        <p className="text-muted-foreground" data-testid="run-graph-node-unresolved">
          {node.peer
            ? peer?.read
              ? `@${node.peer}'s graph no longer holds this node.`
              : `In @${node.peer}'s graph, not read here${peer?.reason ? ` (${peer.reason})` : ""}, so this is only what the run's log says of the node.`
            : graphAnswered
              ? "The graph no longer holds this node."
              : `The graph did not answer${unreadReason}, so this is only what the run's log says of the node.`}
        </p>
      )}
      {node.found && <NodeTextSection state={body} onRead={onRead} onOpen={() => setReading(true)} />}
      {linked.length > 0 && (
        <div data-testid="run-graph-node-links">
          <p className="mb-1 font-medium">{linked.length === 1 ? "1 link" : `${linked.length} links`}</p>
          <ul className="space-y-0.5">
            {linked.map(({ link, out, other }) => (
              <li key={`${link.source}|${link.edgeType ?? ""}|${link.target}`}>
                <button
                  type="button"
                  onClick={() => onSelect(other.ref_id)}
                  className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-muted/60"
                >
                  <ArrowRight
                    className={`h-3 w-3 shrink-0 ${out ? "" : "rotate-180"} ${
                      link.hops.length > 0 ? "text-sky-500" : "text-muted-foreground"
                    }`}
                    aria-label={out ? "to" : "from"}
                  />
                  <span className="shrink-0 font-mono text-muted-foreground">{link.edgeType ?? "hop"}</span>
                  <span className="min-w-0 flex-1 truncate">{other.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {touchedBy.length === 0 ? (
        <p className="text-muted-foreground" data-testid="run-graph-node-ancestor">
          No call touched this node. It is drawn as the lineage of nodes the run read.
        </p>
      ) : (
        <div>
          <p className="mb-1 font-medium">
            Touched by {touchedBy.length === 1 ? "1 call" : `${touchedBy.length} calls`}
          </p>
          <ul className="space-y-0.5">
            {touchedBy.map(({ call, index }) => (
              <li key={call.path}>
                <button
                  type="button"
                  onClick={() => onPick(index)}
                  className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-muted/60"
                >
                  <AccessIcon access={call.access} className="h-3 w-3 shrink-0" />
                  <span className="tabular-nums text-muted-foreground">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {callLabel(call.path.split("/").pop() ?? "")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {body?.state === "read" && (
        <RunGraphNodeReader node={node} body={body.body} color={color} open={reading} onOpenChange={setReading} />
      )}
    </div>
  );
}

function CurrentCall({ call, index, total }: { call: RunGraphCall; index: number; total: number }) {
  const query = Object.entries(call.query);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-testid="run-graph-current-call">
      <span className="tabular-nums text-muted-foreground">
        Call {index + 1} of {total}
      </span>
      <Badge variant={call.access === "write" ? "default" : "secondary"}>{call.access}</Badge>
      <span className="font-mono">{call.tool}</span>
      <span className="text-muted-foreground">by the {call.by}</span>
      {call.hits !== undefined && (
        <span className="text-muted-foreground" data-testid="run-graph-call-hits">
          {answerSummary(call)}, drawn only where the run went on to read them
        </span>
      )}
      {query.map(([key, value]) => (
        <span key={key} className="max-w-xs truncate text-muted-foreground">
          {key}{" "}
          <span className="font-mono text-foreground">{Array.isArray(value) ? value.join(", ") : String(value)}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * The graph trace of a strut run: every call that touched the knowledge
 * graph as a tree under the run, the touched nodes laid out by the stages
 * of the run that touched them — each under the lineage it descends from —
 * and a replay that steps through the calls in the order the run made them.
 *
 * Generic over workflows: give it a run (`workflow` + `runId`). The importing
 * app needs the run's workflow — and the workflow of any child run it opens —
 * in `grants.workflows`, and `graph/graph-get-batched` and
 * `graph/graph-neighbors` in `grants.steps`; without the graph steps the
 * nodes are drawn as the run's log named them.
 *
 * A branch of the tree can be shown on its own — the crosshair on its row,
 * or `scope` — one iteration of a loop, or one subflow of it: its calls
 * alone, its own steps as the lanes, and a breadcrumb back out.
 *
 * Needs no workspace context: it is drawn on a workspace's pages and in the
 * org chat's artifact panel alike.
 */
export function RunGraph({
  workflow,
  runId,
  events: givenEvents,
  live = false,
  fill = false,
  scope: scopeProp = null,
}: {
  workflow: string;
  runId: string;
  /** Draw this log instead of reading it (`run/events`); the nodes are still read. */
  events?: RunEvent[];
  /** Read the log again every 10 s until it settles. */
  live?: boolean;
  /** Take the height of the container (the artifact panel) instead of a fixed one. */
  fill?: boolean;
  /**
   * The branch to open on: its path under the run (`loop#1/run`). The
   * reader can climb out of it and into another; a change to it is followed.
   */
  scope?: string | null;
}) {
  const [trace, setTrace] = useState<RunGraphTrace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<RunGraphAccess, boolean>>({ read: true, write: true });
  const [typeOverrides, setTypeOverrides] = useState<Record<string, boolean>>({});
  /** Index of the current call; null = the whole run. */
  const [step, setStep] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  /** The branch shown, as its path under the run; null = the whole run. */
  const [scope, setScope] = useState<string | null>(scopeProp);

  const client = useStrutClient();
  /** What has been read of the graph for this run (./reader.ts); "Ask again" starts a new one. */
  const [generation, setGeneration] = useState(0);
  const reader = useMemo(() => new RunGraphReader(client), [client, workflow, runId, generation]);
  /** The run each launching call started, by the call's full path: where a child run is read from. */
  const launchesRef = useRef(new Map<string, RunGraphLaunch>());
  useEffect(() => launchesRef.current.clear(), [workflow, runId]);
  const [settled, setSettled] = useState(false);

  const load = useCallback(async () => {
    try {
      const events = givenEvents ?? (await client.run<RunEvent[]>("run/events", { workflow, runId }));
      const { calls, launches } = projectWithLaunches(events);
      for (const [path, launch] of launches) launchesRef.current.set(path, launch);
      await reader.read(distinctNodeRefs(calls));
      const next: RunGraphTrace = { calls, ...reader.snapshot() };
      setTrace((prev) => keepGraphRead(prev, next));
      setSettled(eventsSettled(events));
      setError(null);
    } catch (e) {
      setError(errorText(e) || "Could not load the graph trace");
    }
  }, [client, reader, workflow, runId, givenEvents]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!live || settled) return;
    const timer = setInterval(() => void load(), LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [live, settled, load]);

  /** The runs launching calls started, by the launching call's full path: loaded when opened, never before. */
  const [children, setChildren] = useState<Record<string, ChildState>>({});
  const loadedChildren = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(children).flatMap(([path, c]) => (c.state === "loaded" ? [[path, c.calls]] : [])),
      ) as Record<string, RunGraphCall[]>,
    [children],
  );
  const allCalls = useMemo(() => withChildCalls(trace?.calls ?? [], loadedChildren), [trace?.calls, loadedChildren]);
  /** The trace's nodes and edges with what the opened child runs brought: the files they read. */
  const graph = useMemo(
    () =>
      withChildGraph(
        trace?.nodes ?? [],
        trace?.edges ?? [],
        Object.values(children).flatMap((c) => (c.state === "loaded" ? [c] : [])),
      ),
    [trace?.nodes, trace?.edges, children],
  );
  /** Every launching call, loaded or not, by its path in the whole run: each draws its run in a lane of its own. */
  const launches = useMemo(
    () => [...(trace?.calls ?? []), ...Object.values(loadedChildren).flat()].filter((call) => call.child !== undefined),
    [trace?.calls, loadedChildren],
  );
  const sections = useMemo(() => launchSections(launches, scope), [launches, scope]);
  const inScope = useMemo(() => scopeCalls(allCalls, scope), [allCalls, scope]);
  const calls = useMemo(() => inScope.filter((call) => shown[call.access]), [inScope, shown]);
  const current = step !== null && step < calls.length ? step : null;

  const tree = useMemo(() => buildRunGraphTree(calls), [calls]);
  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.ref_id, n])), [graph.nodes]);

  // A node's body is read when it is first selected and kept, so coming back to it asks nothing.
  const [bodies, setBodies] = useState<Record<string, NodeBodyState>>({});
  const readNode = useCallback(
    async (refId: string) => {
      // Read with the trace already, unless it came in as an ancestor.
      const known = reader.bodies.get(refId);
      if (known) return setBodies((prev) => ({ ...prev, [refId]: { state: "read", body: known } }));
      setBodies((prev) => ({ ...prev, [refId]: { state: "reading" } }));
      try {
        const n = (await getNodes(client, [refId])).get(refId);
        if (!n || "error" in n) throw new Error(n && "error" in n ? n.error : "Could not read the node");
        const body: RunGraphNodeBody = { ref_id: refId, node_type: n.node_type, labels: [], properties: n.properties };
        setBodies((prev) => ({ ...prev, [refId]: { state: "read", body } }));
      } catch (e) {
        const error = errorText(e) || "Could not read the node";
        setBodies((prev) => ({ ...prev, [refId]: { state: "failed", error } }));
      }
    },
    [client, reader],
  );
  useEffect(() => {
    if (!selectedId || bodies[selectedId] || !nodeById.get(selectedId)?.found) return;
    void readNode(selectedId);
  }, [selectedId, bodies, nodeById, readNode]);

  // Everything the shown calls touched, whatever its type, and the lineage above it — the legend counts these.
  const touched = useMemo(() => {
    const ids = new Set(calls.flatMap((call) => call.nodes.map((n) => n.ref_id)));
    return graph.nodes.filter((n) => ids.has(n.ref_id));
  }, [calls, graph.nodes]);
  const parents = useMemo(() => lineageParents(graph.edges), [graph.edges]);
  const lineage = useMemo(() => {
    const above = new Set(
      ancestorsOf(
        touched.map((n) => n.ref_id),
        parents,
      ),
    );
    return graph.nodes.filter((n) => above.has(n.ref_id));
  }, [touched, parents, graph.nodes]);
  const drawn = useMemo(() => [...touched, ...lineage], [touched, lineage]);

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of drawn) counts.set(node.node_type, (counts.get(node.node_type) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [drawn]);

  const colorMap = useMemo(() => runGraphColorMap(typeCounts.map(([type]) => type)), [typeCounts]);
  const typeVisible = useCallback((type: string) => typeOverrides[type] ?? !isProvenanceType(type), [typeOverrides]);

  const graphNodes = useMemo<RunGraphCanvasNode[]>(
    () =>
      drawn
        .filter((n) => typeVisible(n.node_type))
        .map((n) => ({ id: n.ref_id, name: n.name, type: n.node_type, ...(n.peer ? { peer: n.peer } : {}) })),
    [drawn, typeVisible],
  );
  const links = useMemo(() => {
    const ids = new Set(graphNodes.map((n) => n.id));
    return runGraphLinks(graph.edges, runGraphHops(calls)).filter((l) => ids.has(l.source) && ids.has(l.target));
  }, [graphNodes, graph.edges, calls]);
  const hopCount = useMemo(() => links.filter((l) => l.hops.length > 0).length, [links]);
  const layout = useMemo(
    () =>
      layoutRunGraph(
        calls,
        graphNodes.map((n) => n.id),
        links,
        parents,
        sections,
      ),
    [calls, graphNodes, links, parents, sections],
  );

  const frame = useMemo(() => replayFrame(calls, current ?? calls.length), [calls, current]);

  // The current call's branch is always open.
  useEffect(() => {
    if (current === null) return;
    const segments = calls[current].path.split("/");
    setExpanded((prev) => {
      const next = new Set(prev);
      for (let i = 1; i < segments.length; i++) next.add(segments.slice(0, i).join("/"));
      return next.size === prev.size ? prev : next;
    });
  }, [current, calls]);

  // The root is always open: the branch it compresses into, when it holds one thing.
  useEffect(() => {
    if (!tree) return;
    const root = compress(tree).node.path;
    setExpanded((prev) => (prev.has(root) ? prev : new Set(prev).add(root)));
  }, [tree]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setStep((s) => (s === null || s + 1 >= calls.length ? null : s + 1));
    }, PLAY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing, calls.length]);

  // Playing starts on a call, so the whole run while playing is the end of the replay.
  useEffect(() => {
    if (playing && current === null) setPlaying(false);
  }, [playing, current]);

  const pick = useCallback((index: number) => {
    setPlaying(false);
    setStep(index);
  }, []);
  const showAll = useCallback(() => {
    setPlaying(false);
    setStep(null);
  }, []);
  const togglePlay = useCallback(() => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (current === null) setStep(0);
    setPlaying(true);
  }, [playing, current]);
  /** Load the run the launching call at `full` (its path in the whole run) started, once; its calls, when this call loaded them. */
  const openChild = useCallback(
    async (full: string): Promise<RunGraphCall[] | null> => {
      if (children[full] && children[full].state !== "failed") return null;
      setChildren((prev) => ({ ...prev, [full]: { state: "loading" } }));
      try {
        // The run the call started, by the `runId` its output named; its calls go under the call's path.
        const launch = launchesRef.current.get(full);
        if (!launch) throw new Error("The run's log names no run this call started");
        if (launch.peer) throw new Error(`It ran on @${launch.peer}: its calls are read on that strut`);
        const events = await client.run<RunEvent[]>("run/events", { workflow: launch.workflow, runId: launch.runId });
        const { calls: loaded, launches } = projectWithLaunches(events, { prefix: full });
        for (const [path, l] of launches) launchesRef.current.set(path, l);
        await reader.read(distinctNodeRefs(loaded));
        const { nodes, edges } = reader.snapshot();
        // The indices of the replay move, so it starts over; the launch opens as a branch in the tree.
        setPlaying(false);
        setStep(null);
        setChildren((prev) => ({ ...prev, [full]: { state: "loaded", calls: loaded, nodes, edges } }));
        return loaded;
      } catch (e) {
        const error = errorText(e) || "Could not load the run";
        setChildren((prev) => ({ ...prev, [full]: { state: "failed", error } }));
        return null;
      }
    },
    [children, client, reader],
  );
  /** A path in the tree as drawn (re-rooted at the branch shown) → its path in the whole run. */
  const fullPath = useCallback(
    (treePath: string) => `${allCalls[0]?.path.split("/")[0] ?? ""}/${scopeOfBranch(scope, treePath)}`,
    [allCalls, scope],
  );
  const childState = useCallback((treePath: string) => children[fullPath(treePath)], [children, fullPath]);
  const openChildAt = useCallback(
    async (treePath: string) => {
      const full = fullPath(treePath);
      const loaded = await openChild(full);
      if (!loaded) return;
      // Opened from its row, the run opens down to its calls: every branch between the launch and each call.
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const call of loaded) {
          const segments = call.path.slice(full.length).split("/").filter(Boolean);
          for (let i = 0; i < segments.length; i++) next.add([treePath, ...segments.slice(0, i)].join("/"));
        }
        return next;
      });
    },
    [fullPath, openChild],
  );
  // A branch shown inside a run not loaded yet (a link to it, or a lane of one) loads that run.
  useEffect(() => {
    const path = childToLoad(allCalls, scope);
    if (path && !children[path]) void openChild(path);
  }, [allCalls, scope, children, openChild]);

  // A run that touched little opens what it launched: the launches are where its work went.
  useEffect(() => {
    if (distinctNodeRefs(allCalls).length >= AUTO_OPEN_BELOW) return;
    for (const call of allCalls) if (call.child && !children[call.path]) void openChild(call.path);
  }, [allCalls, children, openChild]);

  const toggleBranch = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);
  /** Show one branch of the run (null: all of it), from the start of its replay. */
  const focus = useCallback((next: string | null) => {
    setPlaying(false);
    setStep(null);
    setSelectedId(null);
    setExpanded(new Set());
    setScope(next);
  }, []);
  const focusBranch = useCallback((path: string) => focus(scopeOfBranch(scope, path)), [focus, scope]);
  /** A lane or cell of the canvas names its branch by its segment under the root of the tree. */
  const focusLane = useCallback(
    (segment: string) => {
      if (tree) focusBranch(`${tree.path}/${segment}`);
    },
    [tree, focusBranch],
  );
  useEffect(() => {
    focus(scopeProp);
  }, [scopeProp, focus]);

  if (error && !trace) {
    return (
      <p className="p-4 text-sm text-destructive" data-testid="run-graph-error">
        {error}
      </p>
    );
  }
  if (!trace) {
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground" data-testid="run-graph-loading">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading the run…
      </p>
    );
  }
  if (trace.calls.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground" data-testid="run-graph-empty">
        {live ? "The run has not touched the graph yet." : "This run did not touch the graph."}
      </p>
    );
  }

  const selected = selectedId ? nodeById.get(selectedId) : undefined;
  const last = calls.length - 1;
  const unreadReason = trace.unreadReason ? ` (${trace.unreadReason})` : "";
  const scopeLabel = scope === null ? "" : scope.split("/").map(segmentLabel).join(" / ");
  const crumbs =
    scope === null
      ? []
      : [
          { label: segmentLabel(trace.calls[0].path.split("/")[0]), scope: null as string | null },
          ...scope.split("/").map((label, i, segments) => ({ label: segmentLabel(label), scope: segments.slice(0, i + 1).join("/") })),
        ];

  return (
    <div className={cn("flex flex-col", fill && "h-full min-h-0")} data-testid="run-graph">
      <div className="flex flex-col gap-2 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              aria-label="Previous call"
              disabled={calls.length === 0 || current === 0}
              onClick={() => pick(current === null ? last : current - 1)}
            >
              <SkipBack className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              aria-label={playing ? "Pause" : "Play"}
              disabled={calls.length === 0}
              onClick={togglePlay}
              data-testid="run-graph-play"
            >
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              aria-label="Next call"
              disabled={current === null}
              onClick={() => (current === null || current >= last ? showAll() : pick(current + 1))}
            >
              <SkipForward className="h-3.5 w-3.5" />
            </Button>
          </div>
          <Slider
            className="min-w-40 flex-1"
            min={0}
            max={calls.length}
            step={1}
            value={[current ?? calls.length]}
            onValueChange={([value]) => (value >= calls.length ? showAll() : pick(value))}
            aria-label="Replay position"
            data-testid="run-graph-slider"
          />
          <div className="flex items-center gap-1">
            {(Object.keys(ACCESS_LABEL) as RunGraphAccess[]).map((access) => (
              <Button
                key={access}
                variant={shown[access] ? "secondary" : "ghost"}
                size="sm"
                className="h-7 gap-1.5 text-xs"
                aria-pressed={shown[access]}
                onClick={() => {
                  showAll();
                  setShown((prev) => ({ ...prev, [access]: !prev[access] }));
                }}
              >
                <AccessIcon access={access} className="h-3 w-3" />
                {ACCESS_LABEL[access]}
              </Button>
            ))}
          </div>
        </div>
        {current !== null ? (
          <CurrentCall call={calls[current]} index={current} total={calls.length} />
        ) : scope !== null && inScope.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="run-graph-summary">
            Nothing under {scopeLabel} touched the graph.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="run-graph-summary">
            {calls.length} calls{scope !== null ? ` under ${scopeLabel}` : ""} read or wrote {touched.length} nodes
            {live && !settled ? " so far" : ""}
            {lineage.length > 0
              ? `, under the ${lineage.length === 1 ? "1 node" : `${lineage.length} nodes`} they descend from`
              : ""}
            , along {hopCount === 1 ? "1 hop" : `${hopCount} hops`}. Step through them, or pick one in the tree.
            {trace.truncated ? " The run touched more than are shown." : ""}
          </p>
        )}
        {(trace.nodesRead === false || trace.edgesRead === false || trace.lineageRead === false) && (
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="run-graph-unread">
            {trace.nodesRead === false
              ? `The graph did not answer${unreadReason}, so the nodes are as the run's log named them and only the hops the run took are drawn.`
              : trace.edgesRead === false
                ? `The graph did not answer for the edges among these nodes${unreadReason}, so only the hops the run took are drawn.`
                : `The graph did not answer for the lineage of these nodes${unreadReason}, so they are drawn without the nodes they descend from.`}
            <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => setGeneration((g) => g + 1)}>
              Ask again
            </Button>
          </p>
        )}
      </div>

      <div className={cn("grid grid-cols-[minmax(220px,260px)_1fr]", fill ? "min-h-0 flex-1" : "h-[640px]")}>
        <div className="overflow-y-auto border-r py-1" data-testid="run-graph-tree">
          {scope !== null && (
            <nav
              aria-label="The branch shown"
              className="mb-1 flex flex-wrap items-center gap-y-0.5 border-b px-2 pb-1.5 text-xs"
              data-testid="run-graph-scope"
            >
              {crumbs.map((crumb, i) =>
                i < crumbs.length - 1 ? (
                  <React.Fragment key={crumb.scope ?? ""}>
                    <button
                      type="button"
                      onClick={() => focus(crumb.scope)}
                      data-testid="run-graph-crumb"
                      className="rounded px-1 py-0.5 font-mono text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                    >
                      {crumb.label}
                    </button>
                    <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                  </React.Fragment>
                ) : (
                  <span key={crumb.scope ?? ""} className="px-1 py-0.5 font-mono font-medium">
                    {crumb.label}
                  </span>
                ),
              )}
            </nav>
          )}
          {tree && (
            <TreeBranch
              childState={childState}
              onOpenChild={openChildAt}
              node={tree}
              depth={0}
              calls={calls}
              step={current}
              expanded={expanded}
              onToggle={toggleBranch}
              onPick={pick}
              onFocus={focusBranch}
            />
          )}
        </div>
        <div className="relative min-w-0 overflow-hidden" data-testid="run-graph-canvas">
          {graphNodes.length > 0 && (
            <RunGraphCanvas
              layout={layout}
              nodes={graphNodes}
              links={links}
              colorMap={colorMap}
              activeIds={frame.active}
              selectedId={selectedId}
              step={current}
              insetRight={LEGEND_INSET}
              onNodeClick={setSelectedId}
              onFocus={focusLane}
            />
          )}
          {selected && (
            <NodeDetail
              node={selected}
              color={colorMap[selected.node_type] ?? "#6b7280"}
              peer={
                selected.peer
                  ? (trace.peers?.find((p) => p.slug === selected.peer) ?? { slug: selected.peer, read: false })
                  : undefined
              }
              calls={calls}
              links={links}
              nodeById={nodeById}
              graphAnswered={trace.nodesRead !== false}
              unreadReason={unreadReason}
              body={bodies[selected.ref_id]}
              onRead={() => void readNode(selected.ref_id)}
              onPick={pick}
              onSelect={setSelectedId}
              onClose={() => setSelectedId(null)}
            />
          )}
          <ul
            className="absolute bottom-3 right-3 flex max-h-[60%] w-52 flex-col gap-0.5 overflow-y-auto rounded-lg border bg-card p-2 text-xs"
            data-testid="run-graph-legend"
          >
            {typeCounts.map(([type, count]) => {
              const visible = typeVisible(type);
              return (
                <li key={type}>
                  <button
                    type="button"
                    aria-pressed={visible}
                    onClick={() => setTypeOverrides((prev) => ({ ...prev, [type]: !visible }))}
                    className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-muted/60 ${
                      visible ? "" : "text-muted-foreground line-through"
                    }`}
                  >
                    <span
                      className="inline-block size-2.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor: visible ? colorMap[type] : "transparent",
                        border: `1px solid ${colorMap[type]}`,
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate">{type}</span>
                    <span className="tabular-nums text-muted-foreground">{count}</span>
                  </button>
                </li>
              );
            })}
            <li className="mt-1 flex items-center gap-2 border-t px-1 pt-1.5 text-muted-foreground">
              <span className="inline-block h-px w-2.5 shrink-0 bg-muted-foreground" />
              An edge of the graph
            </li>
            <li className="flex items-center gap-2 px-1 text-muted-foreground">
              <ArrowRight className="-mx-px h-3 w-3 shrink-0 text-sky-500" />A hop the run took
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
