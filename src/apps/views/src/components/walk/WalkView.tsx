import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitFork, ListTree, X } from "lucide-react";
import {
  findWalks, foldWalkGraph, foldWalkTrail, latestWalk, toolResultsByCall, useRunEvents, useTranscripts, walkBeats, walkFrame, walkHopStop, walkTrailSummary,
  type RunEvent, type WalkBrief, type WalkLogEvent, type WalkSource,
} from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { nodeColor } from "../../lib/colors";
import { errorText } from "../../lib/format";
import { useNode } from "../../lib/graph";
import { useReplay } from "../../lib/replay";
import { ReplayBar } from "../ReplayBar";
import { NodeReaderBody } from "../run-graph/NodeReader";
import { WALK_CSS, WalkBreadcrumb, WalkTrailSteps } from "./WalkTrail";
import { WalkTree } from "./WalkTree";

/** How often a live walk reads what its log gained. A walk hops every second
 *  or two; the replay paces whatever a read brings. */
export const WALK_VIEW_INTERVAL_MS = 3_000;

export type WalkViewMode = "trail" | "tree";

/** The node drawer's height: the walk is at least DRAWER_MIN_H tall while it is open, the drawer never past DRAWER_MAX_H. */
const DRAWER_MIN_H = 352;
const DRAWER_MAX_H = 448;
/** The drawer's width beside the walk. A walk narrower than DRAWER_W + BESIDE_MIN gets a drawer across its whole width instead: nothing is ever half under it. */
const DRAWER_W = 416;
const BESIDE_MIN = 340;

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
  /** A node was clicked. Given, the app shows it its own way and the view opens no drawer. */
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
 * and the candidates it considered behind "+N considered" — kept ones
 * outlined, dropped ones faded — the newest hop pulsing. Reads a
 * `graph/walk` step's hop events, or an agent's own graph tool calls, and
 * draws both the same. Live and replay are one view: joined in flight it
 * shows the hops so far and follows, at a readable pace; the controls above
 * the walk (RunGraph's: a hop back, play/pause, a hop on, scrub, speed) step
 * back through it, and Live returns. The walk is laid out whole and the
 * hops shown are drawn in place, so scrubbing never changes the view's
 * height. A click on a node opens it in a drawer over the walk (Esc, ✕ or a
 * click outside closes it), unless the app takes it (`onOpenNode`).
 * `mode="tree"` draws the walk as a tree of everything it discovered,
 * fitted to the view's width. Sized by its container, never the viewport.
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
  // The whole walk (as far as the log goes): what the trail and the tree are laid out from.
  const fullTrail = useMemo(() => foldWalkTrail(walk?.hops ?? []), [walk]);
  const [mode, setMode] = useState<WalkViewMode>(initialMode);
  const fullGraph = useMemo(() => (mode === "tree" ? foldWalkGraph(walk?.hops ?? []) : null), [mode, walk]);
  const graph = useMemo(() => (mode === "tree" ? foldWalkGraph(walk?.hops.slice(0, replay.at) ?? []) : null), [mode, walk, replay.at]);

  // The node open in the drawer, and where the drawer sits: by the node the
  // click came from, so it opens in sight however long the walk is (a host
  // grows the frame to its content, so the page scrolls, not the view).
  const [opened, setOpened] = useState<{ node: WalkBrief; top: number; height: number; beside: boolean } | null>(null);
  const selected = opened?.node ?? null;
  const area = useRef<HTMLDivElement>(null);
  const clickedAt = useRef(0);
  const close = useCallback(() => setOpened(null), []);
  const open = useCallback(
    (n: WalkBrief) => {
      if (onOpenNode) return onOpenNode(n);
      const tall = Math.max(area.current?.clientHeight ?? 0, DRAWER_MIN_H);
      const height = Math.min(tall, DRAWER_MAX_H);
      // Room for it beside the walk, which then reflows to its left; else across the whole walk.
      const beside = (area.current?.clientWidth ?? 0) >= DRAWER_W + BESIDE_MIN;
      setOpened({ node: n, height, beside, top: Math.max(0, Math.min(clickedAt.current - 24, tall - height)) });
    },
    [onOpenNode],
  );

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
    setOpened(null);
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
    <div className={cn("flex min-w-0 flex-col gap-3 text-sm", className)} data-testid="walk-view">
      <style>{WALK_CSS}</style>
      {/* One line, whatever the summary says: a replay never wraps it. */}
      <div className="flex min-w-0 items-center gap-2">
        {running && (
          <span className={cn("inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] font-semibold", replay.following ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
            <span className={cn("size-2 rounded-full", replay.following ? "bg-emerald-500 motion-safe:animate-pulse" : "bg-muted-foreground")} />
            {replay.following ? "live" : replay.playing ? "live · replaying" : "live · paused"}
          </span>
        )}
        {walks.length > 1 ? (
          <select value={walk.path} onChange={(e) => pick(e.target.value)} title={sourceOf(walk)} className="min-w-0 max-w-[40%] shrink rounded-md border bg-background px-2 py-1 font-mono text-xs" aria-label="Which walk">
            {walks.map((w) => (
              <option key={w.path} value={w.path} title={sourceOf(w)}>
                {w.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="max-w-[40%] shrink-0 truncate font-mono text-xs font-semibold" title={sourceOf(walk)}>{walk.label}</span>
        )}
        <span className={cn("min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground", walk.error && done && "text-destructive")} title={summary} data-testid="walk-summary">{summary}</span>
        <span className="inline-flex shrink-0 rounded-md border p-0.5" role="group" aria-label="View">
          {([["trail", ListTree, "Trail"], ["tree", GitFork, "Tree"]] as const).map(([m, Icon, label]) => (
            <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m} className={cn("inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs", mode === m ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}>
              <Icon className="size-3.5" aria-hidden /> {label}
            </button>
          ))}
        </span>
      </div>
      {walk.goal && <p className="line-clamp-2 text-muted-foreground" title={walk.goal}><span className="font-medium text-foreground">Goal</span> · {walk.goal}</p>}

      {beats.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1 rounded-md border px-2 py-1.5" data-testid="walk-replay">
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
          {/* Always a line, so the first beat never pushes the walk down. */}
          <p className="truncate px-1 font-mono text-[11px] text-muted-foreground" data-testid="walk-beat">{frame.beat?.label ?? " "}</p>
        </div>
      )}

      {/* The walk, and over it the node a click opened. */}
      <div
        ref={area}
        className="relative min-w-0"
        style={opened ? { minHeight: DRAWER_MIN_H } : undefined}
        onClickCapture={(e) => {
          const box = area.current?.getBoundingClientRect();
          if (box) clickedAt.current = (e.target as Element).getBoundingClientRect().top - box.top;
        }}
        data-testid="walk-area"
      >
        <div style={opened?.beside ? { paddingRight: DRAWER_W + 12 } : undefined}>
          {mode === "tree" && graph && fullGraph ? (
            <WalkTree
              graph={graph}
              full={fullGraph}
              path={trail.path}
              fullPath={fullTrail.path}
              header={<WalkBreadcrumb steps={trail.steps} full={fullTrail.steps} moving={moving} selected={selected?.ref_id ?? null} onSelect={open} />}
              moving={moving}
              selected={selected?.ref_id ?? null}
              onSelect={open}
            />
          ) : fullTrail.steps.length ? (
            <WalkTrailSteps trail={trail} full={fullTrail} moving={moving} selected={selected?.ref_id ?? null} onSelect={open} />
          ) : (
            <p className="text-muted-foreground">{running ? "Walking…" : "No hop yet."}</p>
          )}
        </div>
        {/* Across a narrow walk, the rows above and below it are veiled, never cut in half. */}
        {opened && !opened.beside && <div className="absolute inset-0 z-10 rounded-lg bg-background/90" aria-hidden data-testid="walk-node-scrim" />}
        {opened && <NodeDrawer node={opened.node} top={opened.top} height={opened.height} width={opened.beside ? DRAWER_W : "100%"} onClose={close} />}
      </div>
    </div>
  );
}

/**
 * A node's page in a drawer by the node it opened from: beside the walk,
 * which reflows to its left, when the walk is wide enough, else across the
 * walk's whole width — so no label is ever half under it. Opaque, its text
 * scrolling inside. ✕, Esc or a press anywhere outside it closes it; a
 * press on another node opens that one instead.
 */
function NodeDrawer({ node: brief, top, height, width, onClose }: { node: WalkBrief; top: number; height: number; width: number | string; onClose: () => void }) {
  const q = useNode(brief.ref_id);
  const node = q.data;
  const box = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPress = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPress, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPress, true);
    };
  }, [onClose]);
  const type = node?.node_type ?? brief.node_type;
  return (
    <aside
      ref={box}
      role="dialog"
      aria-label={node?.name || brief.name || brief.ref_id}
      className="absolute right-0 z-20 flex flex-col overflow-hidden rounded-lg border bg-background text-foreground shadow-xl"
      style={{ top, height, width }}
      data-testid="walk-node"
    >
      <div className="flex shrink-0 items-start gap-2 border-b bg-background p-3">
        <span className="mt-1.5 inline-block size-2.5 shrink-0 rounded-full" style={{ backgroundColor: nodeColor(type) }} />
        <div className="min-w-0 flex-1">
          <div className="break-words font-medium">{node?.name || brief.name || brief.ref_id.slice(0, 8)}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">{brief.ref_id}</div>
        </div>
        <Badge variant="outline" className="shrink-0 font-normal">{type}</Badge>
        <button ref={closeButton} type="button" onClick={onClose} aria-label="Close" className="-mt-0.5 -mr-1 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" data-testid="walk-node-close">
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-background p-3">
        {node ? (
          <NodeReaderBody properties={node.properties ?? {}} />
        ) : q.isError ? (
          <p className="text-sm text-destructive">{errorText(q.error)}</p>
        ) : (
          <Skeleton className="h-28 w-full" />
        )}
      </div>
    </aside>
  );
}

/** Where a walk came from, for a tooltip: the view draws every walk the same. */
function sourceOf(w: WalkSource): string {
  return w.kind === "walk" ? `${w.path}: a graph/walk step` : `${w.path}: an agent's own graph calls`;
}
