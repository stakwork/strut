import { useMemo, useState } from "react";
import { GitFork, ListTree } from "lucide-react";
import {
  findWalks, foldWalkGraph, latestWalk, toolResultsByCall, useRunEvents, useTranscripts, walkBeats, walkFrame, walkHopStop, walkTrailSummary,
  type RunEvent, type WalkBrief, type WalkLogEvent, type WalkSource,
} from "@strut/kit";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { nodeColor } from "../../lib/colors";
import { errorText } from "../../lib/format";
import { useNode } from "../../lib/graph";
import { useReplay } from "../../lib/replay";
import { NodeCard } from "../NodeCard";
import { ReplayBar } from "../ReplayBar";
import { RunGraphNodeReader } from "../run-graph/NodeReader";
import { WALK_CSS, WalkBreadcrumb, WalkTrailSteps } from "./WalkTrail";
import { WalkTree } from "./WalkTree";

/** How often a live walk reads what its log gained. A walk hops every second
 *  or two; the replay paces whatever a read brings. */
export const WALK_VIEW_INTERVAL_MS = 3_000;

export type WalkViewMode = "trail" | "tree";

export interface WalkViewProps {
  /** Read the run's log (`run/events`) — the importing app's grant. */
  workflow?: string;
  runId?: string;
  /** Follow the run while it is in flight, reading only what its log gained. */
  live?: boolean;
  /** Or draw this log. */
  events?: RunEvent[];
  /** Which walk, by its step path, when the run took several; default the one that started last. */
  path?: string;
  /** A person picked another walk (the picker shows when there are several). */
  onPathChange?: (path: string) => void;
  /** A node opened from its card; by default the view opens it whole, docs and all. */
  onOpenNode?: (node: WalkBrief) => void;
  /** Start as the trail (default) or the tree. */
  mode?: WalkViewMode;
  /** A finished walk opens playing from its start, at the pace it ran, rather than at its end. */
  replay?: boolean;
  /** The replay's speed to start at (default 1×; the controls offer 0.5× to 4×). */
  speed?: number;
  /** How often a live walk polls (default 3 s). */
  intervalMs?: number;
  /** Read a finished agent's transcript for the candidates its log's previews cut (default true). */
  transcripts?: boolean;
  className?: string;
}

/**
 * A run's graph WALK as it plays out (`findWalks` → `walkFrame`): the path
 * as a trail that grows hop by hop, the node chosen at each hop drawn solid
 * and the candidates it considered beside it — kept ones outlined, dropped
 * ones faded — the newest hop pulsing. Reads a `graph/walk` step's hop
 * events, or an agent's own graph tool calls (a listing, then the node it
 * read next). Live and replay are one view: joined in flight it shows the
 * hops so far and follows, at a readable pace; the controls (RunGraph's:
 * a hop back, play/pause, a hop on, scrub, speed) step back through it, and
 * Live returns. A finished walk replays from its log alone, in its own order
 * and at its own pace. A click on a node shows its card. `mode="tree"` draws
 * the same walk as a tree of everything it discovered.
 */
export function WalkView({ workflow, runId, live, events: given, path, onPathChange, onOpenNode, mode: initialMode = "trail", replay: replayFromStart, speed, intervalMs, transcripts = true, className }: WalkViewProps) {
  const wf = workflow ?? "";
  const q = useRunEvents(wf, runId, { live, intervalMs: intervalMs ?? WALK_VIEW_INTERVAL_MS, enabled: !given && !!workflow && !!runId });
  const events = (given ?? q.data) as WalkLogEvent[] | undefined;

  // The walks from the log alone; then, for a finished agent's walk, again
  // with its transcript's whole tool results.
  const plain = useMemo(() => (events ? findWalks(events) : []), [events]);
  const [picked, setPicked] = useState<string | undefined>(path);
  const want = path ?? picked;
  const chosenPlain = plain.find((w) => w.path === want) ?? latestWalk(plain);
  const readPaths = useMemo(
    () => (transcripts && !given && chosenPlain?.kind === "agent" && chosenPlain.status !== "running" ? [chosenPlain.path] : []),
    [transcripts, given, chosenPlain?.kind, chosenPlain?.status, chosenPlain?.path],
  );
  const read = useTranscripts(wf, runId, readPaths, { enabled: readPaths.length > 0 });
  const walks = useMemo(() => {
    if (!events || !read.size) return plain;
    const results = new Map<string, unknown>();
    for (const t of read.values()) for (const [id, r] of toolResultsByCall(t.messages)) results.set(id, r);
    return findWalks(events, { results });
  }, [events, plain, read]);
  const walk: WalkSource | undefined = walks.find((w) => w.path === want) ?? latestWalk(walks);

  const running = walk?.status === "running";
  const beats = useMemo(() => (walk ? walkBeats(walk.hops) : []), [walk]);
  const times = useMemo(() => beats.map((b) => b.at), [beats]);
  const replay = useReplay(walk?.path, times, running, { replay: replayFromStart, speed });
  const moving = replay.moving;
  const frame = useMemo(() => walkFrame(walk?.hops ?? [], replay.at, beats), [walk, replay.at, beats]);
  const trail = frame.trail;
  const [mode, setMode] = useState<WalkViewMode>(initialMode);
  const graph = useMemo(() => (mode === "tree" ? foldWalkGraph(walk?.hops.slice(0, replay.at) ?? []) : null), [mode, walk, replay.at]);

  const [selected, setSelected] = useState<WalkBrief | null>(null);
  const [reading, setReading] = useState(false);
  const node = useNode(reading ? selected?.ref_id : undefined);

  if (!events) {
    if (q.isError) return <p className={cn("text-sm text-destructive", className)}>{errorText(q.error)}</p>;
    return <Skeleton className={cn("h-40 w-full", className)} />;
  }
  if (!walk) {
    const settled = events.some((e) => e.type === "run.end" || e.type === "run.error" || e.type === "run.cancelled");
    return <p className={cn("text-sm text-muted-foreground", className)}>{settled || !live ? "The run took no walk through the graph." : "Waiting for the walk to start…"}</p>;
  }

  const pick = (p: string) => {
    setPicked(p);
    setSelected(null);
    onPathChange?.(p);
  };
  const done = replay.at >= replay.total && !running;
  const summary = walkTrailSummary(trail, {
    live: running && replay.following && !walk.error,
    replaying: replay.playing && !replay.following,
    scored: walk.kind === "walk",
    ...(walk.stopped && done ? { stopped: walk.stopped } : {}),
    ...(walk.error && done ? { error: walk.error } : {}),
  });

  return (
    <div className={cn("flex flex-col gap-3 text-sm", className)} data-testid="walk-view">
      <style>{WALK_CSS}</style>
      <div className="flex flex-wrap items-center gap-2">
        {running && (
          <span className={cn("inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold", replay.following ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
            <span className={cn("size-2 rounded-full", replay.following ? "bg-emerald-500 motion-safe:animate-pulse" : "bg-muted-foreground")} />
            {replay.following ? "live" : replay.playing ? "live · replaying" : "live · paused"}
          </span>
        )}
        {walks.length > 1 ? (
          <select value={walk.path} onChange={(e) => pick(e.target.value)} title={sourceOf(walk)} className="rounded-md border bg-background px-2 py-1 font-mono text-xs" aria-label="Which walk">
            {walks.map((w) => (
              <option key={w.path} value={w.path} title={sourceOf(w)}>
                {w.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="font-mono text-xs font-semibold" title={sourceOf(walk)}>{walk.label}</span>
        )}
        <span className={cn("font-mono text-xs text-muted-foreground", walk.error && done && "text-destructive")} data-testid="walk-summary">{summary}</span>
        <span className="ml-auto inline-flex rounded-md border p-0.5" role="group" aria-label="View">
          {([["trail", ListTree, "Trail"], ["tree", GitFork, "Tree"]] as const).map(([m, Icon, label]) => (
            <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m} className={cn("inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs", mode === m ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}>
              <Icon className="size-3.5" aria-hidden /> {label}
            </button>
          ))}
        </span>
      </div>
      {walk.goal && <p className="text-muted-foreground"><span className="font-medium text-foreground">Goal</span> · {walk.goal}</p>}

      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <WalkBreadcrumb steps={trail.steps} moving={moving} selected={selected?.ref_id ?? null} onSelect={setSelected} />
          {mode === "tree" && graph ? (
            <WalkTree graph={graph} path={trail.path} moving={moving} selected={selected?.ref_id ?? null} onSelect={setSelected} />
          ) : trail.steps.length ? (
            <WalkTrailSteps trail={trail} moving={moving} selected={selected?.ref_id ?? null} onSelect={setSelected} />
          ) : (
            <p className="text-muted-foreground">{running ? "Walking…" : "No hop yet."}</p>
          )}
        </div>
        {selected && (
          <aside className="flex shrink-0 flex-col gap-2 lg:w-80" data-testid="walk-node">
            <NodeCard
              key={selected.ref_id}
              refId={selected.ref_id}
              onOpen={(n) => (onOpenNode ? onOpenNode({ ref_id: n.ref_id, node_type: n.node_type, name: n.name }) : setReading(true))}
            />
            <button type="button" onClick={() => setSelected(null)} className="self-end text-xs text-muted-foreground hover:text-foreground">close</button>
          </aside>
        )}
      </div>

      {beats.length > 0 && (
        <div className="flex flex-col gap-1 rounded-md border px-2 py-1.5" data-testid="walk-replay">
          <ReplayBar
            position={replay.at}
            total={replay.total}
            playing={replay.playing}
            onPlay={replay.play}
            onPause={replay.pause}
            onStepBack={() => replay.seek(walkHopStop(beats, replay.at, -1))}
            onStepForward={() => replay.seek(walkHopStop(beats, replay.at, 1))}
            onSeek={replay.seek}
            speed={replay.speed}
            onSpeed={replay.setSpeed}
            unit="hop"
            label={`hop ${frame.hop} / ${frame.hops}`}
            {...(running ? { live: { following: replay.following, onLive: replay.live } } : {})}
          />
          {frame.beat && <p className="truncate px-1 font-mono text-[11px] text-muted-foreground" data-testid="walk-beat">{frame.beat.label}</p>}
        </div>
      )}

      {reading && selected && node.data && (
        <RunGraphNodeReader
          node={{ ref_id: node.data.ref_id, node_type: node.data.node_type, name: node.data.name || selected.name, namespace: null, found: true }}
          body={{ ref_id: node.data.ref_id, node_type: node.data.node_type, labels: [], properties: node.data.properties }}
          color={nodeColor(node.data.node_type)}
          open
          onOpenChange={(o) => !o && setReading(false)}
        />
      )}
    </div>
  );
}

/** Where a walk came from, for a tooltip: the view draws every walk the same. */
function sourceOf(w: WalkSource): string {
  return w.kind === "walk" ? `${w.path}: a graph/walk step` : `${w.path}: an agent's own graph calls`;
}
