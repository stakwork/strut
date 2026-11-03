// Ported from hive (src/components/strut-run-graph/RunGraphCanvas); strut's
// own since: a highlight that dims the rest without moving it, "+N" nodes
// for what the layout folded, and names only where they are asked for.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { select, zoom as d3Zoom, zoomIdentity, zoomTransform, type D3ZoomEvent, type ZoomBehavior } from "d3";
import { Focus, LocateFixed, Maximize } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clipName } from "../../lib/format";
import { LABEL_LINE, placeLabels, type LabelBox, type LabelRequest } from "./labels";
import {
  linkState,
  RUN_GRAPH_NODE_RADIUS,
  type RunGraphLayout,
  type RunGraphLink,
  type RunGraphLinkState,
  type RunGraphPlace,
  type RunGraphPoint,
} from "@strut/kit";

export interface RunGraphCanvasNode {
  id: string;
  name: string;
  type: string;
  /** The peer workspace whose graph holds it, drawn under the node; absent for the run's own graph. */
  peer?: string;
  /** A "+N" node the layout folded: how many it holds hidden, how many of them are highlighted, whether a click folds them back. */
  cluster?: { hidden: number; highlighted: number; open: boolean };
}

interface RunGraphCanvasProps {
  layout: RunGraphLayout;
  nodes: RunGraphCanvasNode[];
  links: RunGraphLink[];
  colorMap: Record<string, string>;
  /** Nodes the step's own call touched: ringed in the cell that call is in. */
  activeIds: ReadonlySet<string>;
  /** The picked node: ringed wherever it is drawn. */
  selectedId?: string | null;
  /** Nodes to stand out: the rest dims where it is, nothing moves. Empty: none dims. */
  highlight?: ReadonlySet<string>;
  /** The replay's step; null = the whole run. */
  step: number | null;
  /** The call whose new nodes the view keeps in its middle, at the zoom the viewer chose: the replay's step, or a live run's newest call. Null: nothing to follow. */
  follow?: number | null;
  /** A steady play: the view pans across the lanes at one speed, from `step`, and each call is handed on (`onStep`) as the pan reaches its place in its lane; null at the end. */
  playing?: boolean;
  speed?: number;
  onStep?: (step: number | null) => void;
  /** A count the viewer's replay buttons bump (Play, back, forward): each bump follows the replay again after a drag stopped it. */
  refollow?: number;
  /** Each call's time (epoch ms): a steady play hands on where it is between two calls, frame by frame, as a time (`onFrame`). */
  times?: ReadonlyArray<number | null>;
  onFrame?: (at: number) => void;
  /** Width at the right of the canvas that something else is drawn over. */
  insetRight?: number;
  onNodeClick: (id: string) => void;
  /** Show only one branch of the run, by its segment under the root (`003-produce`, `ingest#3`). */
  onFocus?: (path: string) => void;
  /** Draw a stacked loop's iterations side by side (its "×N"). */
  onOpenLane?: (key: string) => void;
}

const FIT_PADDING = 32;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;
/** A step that touched more than this names none of them: the rest would be a smear. */
const MAX_NAMED_ACTIVE = 12;
/** What is not highlighted, while something is. */
const DIM = 0.18;
/** Below this zoom a "+N" node is a plain node: its name would be a speck. It shows on hover. */
const GROUP_NAMES_FROM_ZOOM = 0.6;
/** Room around the highlight when the view is fitted to it, and the least box it is fitted into, in the layout's units. */
const FOCUS_PADDING = 90;
const FOCUS_MIN = 360;
/** Where a cell's names start under its name: a lane's under the stage, an iteration's under "#n". */
const LANE_NAME_ROOM = 50;
const CELL_NAME_ROOM = 28;
/** Shorter cuts of a name, tried where the 30-character one fits nowhere. */
const SHORTER_NAMES = [16, 10];
/** Following, the view pans to a lane in this long. */
const FOLLOW_MS = 320;
/** The steady play's pan on screen at 1×, in pixels a second, and how soon the view catches up with it (a start, a follow turned back on). */
const PLAY_PX_PER_S = 160;
const PLAY_EASE_S = 0.35;
/** How far ahead of the view's middle a call is shown, as a share of its width: nodes appear in front of the pan, not behind it. */
const PLAY_LEAD = 0.15;
/** The view opens with a lane this share of the canvas's height — never zoomed past LANES_MAX_ZOOM. */
const LANES_SHARE = 0.62;
const LANES_MAX_ZOOM = 2;

/** Where the view's middle goes on one axis at zoom `k`: `at`, but never past the run's edge — on an axis where the whole run fits, the run's middle. */
function centred(at: number, extent: number, view: number, k: number): number {
  const half = view / (2 * k);
  return extent + 2 * FIT_PADDING <= 2 * half ? extent / 2 : Math.min(Math.max(at, half - FIT_PADDING), extent + FIT_PADDING - half);
}

/** A text's width in ems of the names' font, measured once per text. */
const emWidths = new Map<string, number>();
let measurer: CanvasRenderingContext2D | null | undefined;
function emWidth(text: string, fontFamily: string): number {
  const key = `${fontFamily}\u0000${text}`;
  let em = emWidths.get(key);
  if (em === undefined) {
    if (measurer === undefined) measurer = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    if (measurer) {
      measurer.font = `500 100px ${fontFamily}`;
      em = measurer.measureText(text).width / 100;
    } else em = text.length * 0.6;
    emWidths.set(key, em);
  }
  return em;
}

/** A node's name as drawn: one line, cut at 30 characters; a "+N" node's what it holds. */
function labelOf(node: RunGraphCanvasNode): string {
  if (!node.cluster) return clipName(node.name);
  const head = node.cluster.open && node.cluster.hidden === 0 ? "show fewer" : `+${node.cluster.hidden.toLocaleString("en-US")} more`;
  return node.cluster.highlighted ? `${head} · ${node.cluster.highlighted} highlighted` : head;
}

/** Gap between a node and the end of a link that points at it. */
const ARROW_GAP = 3;

// Text and arrowheads hold their size on screen while the graph zooms under
// them (`--k` is the zoom), up to a size that still fits where they sit.
const NAME_FONT = "clamp(11px, calc(11px / var(--k)), 26px)";
const LANE_FONT = "clamp(14px, calc(13px / var(--k)), 34px)";
const CELL_FONT = "clamp(11px, calc(11px / var(--k)), 20px)";
const ARROW_SCALE = "scale(calc(1 / max(var(--k), 0.25)))";

const LINK_CLASS: Record<Exclude<RunGraphLinkState, "hidden">, string> = {
  edge: "stroke-muted-foreground/70",
  walked: "stroke-sky-500",
  current: "stroke-sky-400",
};
const LINK_WIDTH: Record<Exclude<RunGraphLinkState, "hidden">, number> = { edge: 1.25, walked: 1.75, current: 2.75 };
const ARROW_CLASS: Record<"walked" | "current", string> = { walked: "fill-sky-500", current: "fill-sky-400" };

/** A lane's or cell's name; with a branch to open and someone to open it, a button to show only that branch. */
function BranchLabel({
  x,
  y,
  className,
  fontSize,
  path,
  onFocus,
  testId,
  children,
}: {
  x: number;
  y: number;
  className: string;
  fontSize: string;
  path: string | null;
  onFocus?: (path: string) => void;
  testId: string;
  children: React.ReactNode;
}) {
  if (path === null || !onFocus) {
    return (
      <text x={x} y={y} className={className} style={{ fontSize }} data-testid={testId}>
        {children}
      </text>
    );
  }
  const open = () => onFocus(path);
  return (
    <text
      x={x}
      y={y}
      className={`${className} cursor-pointer hover:underline focus-visible:underline focus-visible:outline-none`}
      style={{ fontSize }}
      role="button"
      tabIndex={0}
      aria-label={`Show only ${path}`}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
      data-testid={testId}
    >
      {children}
    </text>
  );
}

interface DrawnLink {
  key: string;
  link: RunGraphLink;
  state: Exclude<RunGraphLinkState, "hidden">;
  from: RunGraphPoint;
  to: RunGraphPoint;
  /** Direction of the link, in degrees. */
  angle: number;
}

/**
 * A run's nodes where `layout` put them: the stages as lanes, a looping
 * stage's iterations as cells, and in each cell the graph's edges and the
 * run's hops between the nodes drawn there. Pans and zooms; opens showing
 * all of it. A lane's name, or a cell's number, opens that branch of the
 * run on its own, as the crosshair in the tree does.
 */
export function RunGraphCanvas({
  layout,
  nodes,
  links,
  colorMap,
  activeIds,
  selectedId = null,
  highlight,
  step,
  follow = null,
  playing = false,
  speed = 1,
  onStep,
  refollow = 0,
  times,
  onFrame,
  insetRight = 0,
  onNodeClick,
  onFocus,
  onOpenLane,
}: RunGraphCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const viewRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  /** The viewer has panned or zoomed: a run that grows no longer refits under them. */
  const movedRef = useRef(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  /** The zoom, as the names are placed for it: a frame after it settles. */
  const [zoomK, setZoomK] = useState(1);
  const zoomFrame = useRef(0);
  /** The view follows `follow`'s new nodes; the viewer dragging it elsewhere stops that, zooming does not. */
  const [following, setFollowing] = useState(true);
  /** The lane the view last panned to: the replay's other calls in it move nothing. */
  const followedLane = useRef<string | null>(null);
  useEffect(() => {
    if (refollow === 0) return;
    followedLane.current = null;
    setFollowing(true);
  }, [refollow]);
  const panFrame = useRef(0);
  const lastK = useRef(1);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const behavior = d3Zoom<SVGSVGElement, unknown>()
      .scaleExtent([MIN_ZOOM, MAX_ZOOM])
      .extent((): [[number, number], [number, number]] => [
        [0, 0],
        [sizeRef.current.width, sizeRef.current.height],
      ])
      .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        const source = event.sourceEvent as Event | null;
        if (source) {
          movedRef.current = true;
          cancelAnimationFrame(panFrame.current);
          // A drag moves the view and keeps the zoom: the viewer went to look elsewhere.
          if (source.type !== "wheel" && source.type !== "dblclick" && event.transform.k === lastK.current) setFollowing(false);
        }
        lastK.current = event.transform.k;
        viewRef.current?.setAttribute("transform", event.transform.toString());
        svg.style.setProperty("--k", String(event.transform.k));
        cancelAnimationFrame(zoomFrame.current);
        const k = event.transform.k;
        zoomFrame.current = requestAnimationFrame(() => setZoomK(k));
      });
    zoomRef.current = behavior;
    select(svg).call(behavior);
    return () => {
      select(svg).on(".zoom", null);
    };
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width < 1 || height < 1) return;
      sizeRef.current = { width, height };
      setSize((prev) =>
        prev && Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1 ? prev : { width, height },
      );
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  /**
   * What the view fits: the lanes, a lane half its height — at the run's start
   * the first time (or the highlight's middle), else where the view is; the
   * whole run; or, while there is one, the highlight with some room around it.
   */
  const focusRef = useRef<"lanes" | "all" | "highlight">("lanes");
  const firstFitRef = useRef(true);
  /** The places drawn now, for the fit to read without refitting at every step of a replay. */
  const shownRef = useRef<Map<string, Map<string, RunGraphPlace>>>(new Map());

  /** The view's width the graph is drawn in: too narrow to give the inset up, under it. */
  const viewWidth = size ? size.width - (size.width > 3 * insetRight ? insetRight : 0) : 0;

  const fit = useCallback(() => {
    const svg = svgRef.current;
    const behavior = zoomRef.current;
    if (!svg || !behavior || !size || layout.width <= 0 || layout.height <= 0) return;
    cancelAnimationFrame(panFrame.current);
    const width = viewWidth;
    let box = { x: 0, y: 0, width: layout.width, height: layout.height };
    if (highlight?.size && (focusRef.current === "highlight" || (focusRef.current === "lanes" && firstFitRef.current))) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const cell of shownRef.current.values()) {
        for (const p of cell.values()) {
          if (!highlight.has(p.id) && !(nodesRef.current.get(p.id)?.cluster?.highlighted ?? 0)) continue;
          x0 = Math.min(x0, p.x);
          y0 = Math.min(y0, p.y);
          x1 = Math.max(x1, p.x);
          y1 = Math.max(y1, p.y);
        }
      }
      if (x0 <= x1) {
        const w = Math.max(FOCUS_MIN, x1 - x0 + 2 * FOCUS_PADDING);
        const h = Math.max(FOCUS_MIN, y1 - y0 + 2 * FOCUS_PADDING);
        box = { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, width: w, height: h };
      }
    }
    if (focusRef.current === "lanes") {
      const k = Math.max(MIN_ZOOM, Math.min(LANES_MAX_ZOOM, (LANES_SHARE * size.height) / layout.height));
      const now = zoomTransform(svg);
      const at = !firstFitRef.current ? (width / 2 - now.x) / now.k : box.width < layout.width ? box.x + box.width / 2 : 0;
      firstFitRef.current = false;
      select(svg).call(
        behavior.transform,
        zoomIdentity
          .translate(width / 2, size.height / 2)
          .scale(k)
          .translate(-centred(at, layout.width, width, k), -centred(layout.height / 2, layout.height, size.height, k)),
      );
      return;
    }
    firstFitRef.current = false;
    const k = Math.max(MIN_ZOOM, Math.min(1, width / (box.width + 2 * FIT_PADDING), size.height / (box.height + 2 * FIT_PADDING)));
    // Centred on the box, but never past the run's edge: on an axis where the
    // whole run fits, it is drawn whole; else the view stops at its border.
    const transform = zoomIdentity
      .translate(width / 2, size.height / 2)
      .scale(k)
      .translate(-centred(box.x + box.width / 2, layout.width, width, k), -centred(box.y + box.height / 2, layout.height, size.height, k));
    select(svg).call(behavior.transform, transform);
  }, [size, viewWidth, layout.width, layout.height, highlight]);

  // A lens changed: fit to what it highlights (or, with none, the whole run).
  const highlightKey = useMemo(() => [...(highlight ?? [])].sort().join("|"), [highlight]);
  useEffect(() => {
    focusRef.current = highlightKey && !firstFitRef.current ? "highlight" : "lanes";
    movedRef.current = false;
  }, [highlightKey]);

  useEffect(() => {
    if (!movedRef.current) fit();
  }, [fit, highlightKey]);

  const refit = useCallback(
    (focus: "lanes" | "all" | "highlight") => {
      focusRef.current = focus;
      movedRef.current = false;
      fit();
    },
    [fit],
  );

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const nodesRef = useRef(nodeById);
  nodesRef.current = nodeById;

  /** The cell of the step's call, where its nodes are ringed. */
  const activeCell = step === null ? null : (layout.callCells[step] ?? null);

  // What is in the picture at this step: a place from the first call that put it there.
  // A stacked loop shows one iteration: the step's own, when the step is in
  // it; else the first that holds something highlighted; else its first.
  // Its other iterations' places are left out.
  const litCells = useMemo(() => {
    const cells = new Set<string>();
    if (!highlight?.size) return cells;
    for (const place of layout.places.values()) if (highlight.has(place.id)) cells.add(place.cell);
    return cells;
  }, [layout.places, highlight]);
  const hiddenCells = useMemo(() => {
    const hidden = new Set<string>();
    for (const lane of layout.lanes) {
      if (!lane.stacked) continue;
      const keys = lane.cells.map((c) => `${lane.key}#${c.iteration ?? ""}`);
      const showing = activeCell !== null && keys.includes(activeCell) ? activeCell : (keys.find((k) => litCells.has(k)) ?? keys[0]);
      for (const k of keys) if (k !== showing) hidden.add(k);
    }
    return hidden;
  }, [layout.lanes, activeCell, litCells]);

  const shown = useMemo(() => {
    const byCell = new Map<string, Map<string, RunGraphPlace>>();
    for (const place of layout.places.values()) {
      if (step !== null && place.since > step) continue;
      if (hiddenCells.has(place.cell)) continue;
      let cell = byCell.get(place.cell);
      if (!cell) {
        cell = new Map();
        byCell.set(place.cell, cell);
      }
      cell.set(place.id, place);
    }
    return byCell;
  }, [layout.places, step, hiddenCells]);
  shownRef.current = shown;

  /** The lane each cell is drawn in, by the cell's key (a call's `layout.callCells`). */
  const laneOfCell = useMemo(() => {
    const lanes = new Map<string, RunGraphLayout["lanes"][number]>();
    for (const lane of layout.lanes) for (const cell of lane.cells) lanes.set(`${lane.key}#${cell.iteration ?? ""}`, lane);
    return lanes;
  }, [layout.lanes]);

  // Following: the lane the call is in is panned into the middle, at the
  // viewer's zoom — once, as the replay enters it; its other calls move
  // nothing. While the whole run fits, nothing moves.
  useEffect(() => {
    const svg = svgRef.current;
    const behavior = zoomRef.current;
    if (!following || playing || follow === null || !svg || !behavior || !size) return;
    const lane = laneOfCell.get(layout.callCells[follow] ?? "");
    if (!lane || lane.key === followedLane.current) return;
    followedLane.current = lane.key;
    const now = zoomTransform(svg);
    const cx = lane.x + lane.width / 2;
    const cy = lane.y + lane.height / 2;
    const k = now.k;
    const to = zoomIdentity
      .translate(viewWidth / 2, size.height / 2)
      .scale(k)
      .translate(-centred(cx, layout.width, viewWidth, k), -centred(cy, layout.height, size.height, k));
    if (Math.abs(to.x - now.x) < 1 && Math.abs(to.y - now.y) < 1) return;
    cancelAnimationFrame(panFrame.current);
    const started = performance.now();
    const frame = (time: number) => {
      const u = Math.min(1, (time - started) / FOLLOW_MS);
      const e = u * (2 - u);
      select(svg).call(behavior.transform, zoomIdentity.translate(now.x + (to.x - now.x) * e, now.y + (to.y - now.y) * e).scale(k));
      if (u < 1) panFrame.current = requestAnimationFrame(frame);
    };
    panFrame.current = requestAnimationFrame(frame);
  }, [following, playing, follow, laneOfCell, layout.callCells, layout.width, layout.height, size, viewWidth]);
  useEffect(() => () => cancelAnimationFrame(panFrame.current), []);

  /**
   * Each call's place along the run for the steady play: its lane's left
   * edge, with the lane's calls spread over its width in their order — never
   * left of the call before (calls of lanes running side by side stay where
   * the pan is). `end`: the right edge of the last lane the pan reaches.
   */
  const marks = useMemo(() => {
    const laneOf = laneOfCell;
    const count = new Map<string, number>();
    for (const cell of layout.callCells) {
      const lane = laneOf.get(cell);
      if (lane) count.set(lane.key, (count.get(lane.key) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    const at: number[] = [];
    let last = 0;
    let end = 0;
    for (const cell of layout.callCells) {
      const lane = laneOf.get(cell);
      if (lane) {
        const j = seen.get(lane.key) ?? 0;
        seen.set(lane.key, j + 1);
        last = Math.max(last, lane.x + ((j + 0.5) / (count.get(lane.key) ?? 1)) * lane.width);
        end = Math.max(end, lane.x + lane.width);
      }
      at.push(last);
    }
    return { at, end: Math.max(end, last) };
  }, [laneOfCell, layout.callCells]);

  // The steady play's clock, read through a ref so a step or a zoom never restarts it.
  const playRef = useRef({ step, speed, onStep, marks, following, viewWidth, layoutWidth: layout.width, times, onFrame });
  playRef.current = { step, speed, onStep, marks, following, viewWidth, layoutWidth: layout.width, times, onFrame };
  useEffect(() => {
    const svg = svgRef.current;
    const behavior = zoomRef.current;
    if (!playing || !svg || !behavior) return;
    let index = playRef.current.step ?? 0;
    let head = playRef.current.marks.at[index] ?? 0;
    let last = performance.now();
    let frame = 0;
    const tick = (time: number) => {
      const p = playRef.current;
      const dt = Math.min(0.1, (time - last) / 1000);
      last = time;
      const now = zoomTransform(svg);
      // One speed on screen, whatever the zoom.
      head += (PLAY_PX_PER_S * p.speed * dt) / now.k;
      const { at, end } = p.marks;
      const lead = (PLAY_LEAD * p.viewWidth) / now.k;
      let next = index;
      while (next + 1 < at.length && at[next + 1] <= head) next++;
      if (next !== index) {
        index = next;
        p.onStep?.(index);
      }
      // Where the play is between this call and the next, as a time.
      const t0 = p.times?.[index];
      if (p.onFrame && t0 != null) {
        const t1 = p.times?.[index + 1];
        const a = at[index] ?? head;
        const b = at[index + 1];
        const f = b !== undefined && b > a ? Math.min(1, Math.max(0, (head - a) / (b - a))) : 0;
        p.onFrame(t1 != null ? t0 + (t1 - t0) * f : t0);
      }
      if (index >= at.length - 1 && head >= end) {
        p.onStep?.(null);
        return;
      }
      if (p.following && p.viewWidth > 0) {
        const target = centred(head - lead, p.layoutWidth, p.viewWidth, now.k);
        const from = (p.viewWidth / 2 - now.x) / now.k;
        const x = from + (target - from) * (1 - Math.exp(-dt / PLAY_EASE_S));
        select(svg).call(behavior.transform, zoomIdentity.translate(p.viewWidth / 2 - x * now.k, now.y).scale(now.k));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const drawn = useMemo<DrawnLink[]>(() => {
    const list: DrawnLink[] = [];
    for (const [cellKey, cell] of shown) {
      for (const link of links) {
        if (!cell.has(link.source) || !cell.has(link.target)) continue;
        // Only the hops this cell's own calls took are drawn in it.
        const hops = link.hops.filter((hop) => layout.callCells[hop.call] === cellKey);
        const { state, hop } = linkState({ ...link, hops }, step);
        if (state === "hidden") continue;
        const source = cell.get(hop?.source ?? link.source);
        const target = cell.get(hop?.target ?? link.target);
        if (!source || !target) continue;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const length = Math.hypot(dx, dy);
        const reach = RUN_GRAPH_NODE_RADIUS + ARROW_GAP;
        if (length <= 2 * reach) continue;
        const ux = dx / length;
        const uy = dy / length;
        list.push({
          key: `${cellKey}|${link.source}|${link.edgeType ?? ""}|${link.target}`,
          link,
          state,
          from: { x: source.x + ux * RUN_GRAPH_NODE_RADIUS, y: source.y + uy * RUN_GRAPH_NODE_RADIUS },
          to: { x: target.x - ux * reach, y: target.y - uy * reach },
          angle: (Math.atan2(dy, dx) * 180) / Math.PI,
        });
      }
    }
    // The run's own path is drawn over the edges it did not take.
    const order: Record<DrawnLink["state"], number> = { edge: 0, walked: 1, current: 2 };
    return list.sort((a, b) => order[a.state] - order[b.state]);
  }, [shown, links, layout.callCells, step]);

  const highlighting = (highlight?.size ?? 0) > 0;
  /** Stands out under a highlight: highlighted itself, or a "+N" node holding some of it. */
  const lights = (id: string) => highlight?.has(id) === true || (nodeById.get(id)?.cluster?.highlighted ?? 0) > 0;

  /** What each cell's names stay inside: an iteration's box under its header, else the lane under its name. */
  const cellBounds = useMemo(() => {
    const bounds = new Map<string, LabelBox>();
    for (const lane of layout.lanes) {
      for (const cell of lane.cells) {
        const key = `${lane.key}#${cell.iteration ?? ""}`;
        bounds.set(
          key,
          cell.iteration === null
            ? { x0: lane.x + 6, y0: lane.y + LANE_NAME_ROOM, x1: lane.x + lane.width - 6, y1: lane.y + lane.height - 6 }
            : { x0: cell.x + 4, y0: cell.y + CELL_NAME_ROOM, x1: cell.x + cell.width - 4, y1: cell.y + cell.height - 4 },
        );
      }
    }
    return bounds;
  }, [layout.lanes]);

  /** The font the names are drawn in, for measuring them. */
  const [fontFamily, setFontFamily] = useState("system-ui, sans-serif");
  useEffect(() => {
    if (svgRef.current) setFontFamily(getComputedStyle(svgRef.current).fontFamily || "system-ui, sans-serif");
  }, []);

  /**
   * The names drawn: the hovered node's, the selected one's, the step's own
   * few, what is highlighted, the "+N" nodes — in that order, each beside its
   * node where it stays in its cell and covers no name placed before it and
   * no node, at this zoom (`placeLabels`). Highlighted names that fit nowhere
   * are said as one "+N highlighted" per group, listing them on hover; any
   * other name left out shows on hover.
   */
  const labels = useMemo(() => {
    // A name's size in the layout's units: its screen size over the zoom, as NAME_FONT clamps it.
    const font = Math.min(Math.max(11 / zoomK, 11), 26);
    const requests: LabelRequest[] = [];
    const drawnNodes: Array<{ key: string; x: number; y: number }> = [];
    for (const cell of shown.values()) {
      for (const place of cell.values()) {
        const node = nodeById.get(place.id);
        if (!node) continue;
        const key = `${place.cell}|${place.id}`;
        drawnNodes.push({ key, x: place.x, y: place.y });
        const stepNode = activeIds.has(place.id) && (activeCell === null || place.cell === activeCell) && activeIds.size <= MAX_NAMED_ACTIVE;
        const rank =
          place.id === hoverId ? 6
          : place.id === selectedId ? 5
          : stepNode ? 4
          : highlight?.has(place.id) ? 3
          : node.cluster && zoomK >= GROUP_NAMES_FROM_ZOOM ? (node.cluster.highlighted ? 2 : 1)
          : 0;
        if (rank === 0) continue;
        requests.push({
          key,
          cell: place.cell,
          x: place.x,
          y: place.y,
          text: labelOf(node),
          ...(node.cluster ? {} : { variants: SHORTER_NAMES.filter((n) => node.name.length > n).map((n) => clipName(node.name, n)) }),
          ...(node.peer ? { sub: `@${clipName(node.peer)}` } : {}),
          rank,
          ...(rank === 6 ? { forced: true } : {}),
          ...(highlight?.has(place.id) && !node.cluster ? { fold: node.name } : {}),
        });
      }
    }
    return placeLabels({
      requests,
      nodes: drawnNodes,
      bounds: cellBounds,
      radius: RUN_GRAPH_NODE_RADIUS,
      font,
      // The name's 3px outline and a pixel of air, on screen.
      pad: Math.min(2.5 / zoomK, font * 0.3),
      width: (text) => emWidth(text, fontFamily) * font,
      foldText: (n) => [`+${n} highlighted`, `+${n}`],
    });
  }, [shown, nodeById, hoverId, selectedId, activeIds, activeCell, highlight, zoomK, cellBounds, fontFamily]);

  /** The nodes in the order they are painted: what stands out last, on top, where a click finds it. */
  const paintOrder = useMemo(() => {
    const all = [...shown.values()].flatMap((cell) => [...cell.values()]);
    const top = (p: RunGraphPlace) =>
      p.id === selectedId || activeIds.has(p.id) || highlight?.has(p.id) === true || (nodeById.get(p.id)?.cluster?.highlighted ?? 0) > 0;
    return [...all.filter((p) => !top(p)), ...all.filter(top)];
  }, [shown, selectedId, activeIds, highlight, nodeById]);

  const beside = useMemo(() => {
    if (!hoverId) return null;
    const ids = new Set([hoverId]);
    for (const { link } of drawn) {
      if (link.source === hoverId) ids.add(link.target);
      if (link.target === hoverId) ids.add(link.source);
    }
    return ids;
  }, [hoverId, drawn]);

  const isActive = (place: RunGraphPlace) =>
    place.id === selectedId || (activeIds.has(place.id) && (activeCell === null || place.cell === activeCell));
  const opacityOf = (place: RunGraphPlace, active: boolean) =>
    beside && !beside.has(place.id) ? 0.25 : highlighting && !lights(place.id) && !active ? DIM : 1;

  return (
    <div className="absolute inset-0">
      <svg
        ref={svgRef}
        className="h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
        data-testid="run-graph-svg"
      >
        <g ref={viewRef}>
          <g data-testid="run-graph-lanes">
            {layout.lanes.map((lane) => (
              <g key={lane.key} data-testid="run-graph-lane" data-stage={lane.stage} data-key={lane.key}>
                <title>
                  {lane.stage}: {lane.calls} calls, {lane.nodes} nodes
                </title>
                <rect
                  x={lane.x}
                  y={lane.y}
                  width={lane.width}
                  height={lane.height}
                  rx={16}
                  className="fill-muted/30 stroke-border"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                <BranchLabel
                  x={lane.x + 20}
                  y={lane.y + 40}
                  className="fill-foreground font-medium"
                  fontSize={LANE_FONT}
                  path={lane.path}
                  onFocus={onFocus}
                  testId="run-graph-lane-name"
                >
                  {lane.stage}
                </BranchLabel>
                {lane.cells
                  .filter((cell) => cell.iteration !== null && !hiddenCells.has(`${lane.key}#${cell.iteration}`))
                  .map((cell) => (
                    <g key={cell.iteration} data-testid="run-graph-cell" data-cell={`${lane.key}#${cell.iteration}`}>
                      <rect
                        x={cell.x}
                        y={cell.y}
                        width={cell.width}
                        height={cell.height}
                        rx={10}
                        className="fill-card stroke-border"
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                      />
                      <BranchLabel
                        x={cell.x + 12}
                        y={cell.y + 22}
                        className="fill-muted-foreground font-mono"
                        fontSize={CELL_FONT}
                        path={cell.path}
                        onFocus={onFocus}
                        testId="run-graph-cell-name"
                      >
                        #{cell.iteration}
                      </BranchLabel>
                      {lane.stacked && (
                        <text
                          x={cell.x + cell.width - 12}
                          y={cell.y + 22}
                          textAnchor="end"
                          className={`fill-muted-foreground font-mono ${onOpenLane ? "cursor-pointer hover:underline" : ""}`}
                          style={{ fontSize: CELL_FONT }}
                          role={onOpenLane ? "button" : undefined}
                          tabIndex={onOpenLane ? 0 : undefined}
                          aria-label={`Show all ${lane.cells.length} iterations of ${lane.stage}`}
                          onClick={() => onOpenLane?.(lane.key)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              onOpenLane?.(lane.key);
                            }
                          }}
                          data-testid="run-graph-stack"
                        >
                          ×{lane.cells.length}
                        </text>
                      )}
                    </g>
                  ))}
              </g>
            ))}
          </g>

          <g data-testid="run-graph-links" fill="none" strokeLinecap="round">
            {drawn.map(({ key, link, state, from, to, angle }) => {
              const hovered = link.source === hoverId || link.target === hoverId;
              const lit = !highlighting || (lights(link.source) && lights(link.target));
              const opacity = hoverId !== null ? (hovered ? 1 : 0.12) : lit ? 1 : DIM;
              return (
                <g
                  key={key}
                  data-testid="run-graph-link"
                  data-state={state}
                  opacity={opacity}
                  className="pointer-events-none"
                >
                  <line
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    className={LINK_CLASS[state]}
                    strokeWidth={LINK_WIDTH[state]}
                    vectorEffect="non-scaling-stroke"
                  />
                  {state !== "edge" && (
                    <g transform={`translate(${to.x},${to.y}) rotate(${angle})`}>
                      <path
                        d="M2 0L-9 -4.5L-9 4.5Z"
                        className={ARROW_CLASS[state]}
                        stroke="none"
                        style={{ transform: ARROW_SCALE }}
                      />
                    </g>
                  )}
                </g>
              );
            })}
          </g>

          <g data-testid="run-graph-nodes">
            {paintOrder.map((place) => {
                const node = nodeById.get(place.id);
                if (!node) return null;
                const active = isActive(place);
                return (
                  <g
                    key={`${place.cell}|${place.id}`}
                    transform={`translate(${place.x},${place.y})`}
                    opacity={opacityOf(place, active)}
                    className="cursor-pointer"
                    data-testid={node.cluster ? "run-graph-cluster" : "run-graph-node"}
                    data-cell={place.cell}
                    data-node={place.id}
                    data-active={active}
                    data-highlighted={highlight?.has(place.id) === true}
                    onClick={() => onNodeClick(place.id)}
                    onMouseEnter={() => setHoverId(place.id)}
                    onMouseLeave={() => setHoverId((id) => (id === place.id ? null : id))}
                  >
                    <title>
                      {node.cluster ? `${node.cluster.hidden.toLocaleString("en-US")} more ${node.type || "nodes"} here — click to show them` : `${node.name} · ${node.type}`}
                    </title>
                    {node.cluster ? (
                      <circle
                        r={RUN_GRAPH_NODE_RADIUS}
                        className={node.cluster.highlighted ? "fill-card stroke-foreground" : "fill-card stroke-muted-foreground"}
                        strokeWidth={node.cluster.highlighted ? 2.5 : 1.5}
                        strokeDasharray="3 3"
                        vectorEffect="non-scaling-stroke"
                      />
                    ) : (
                      <circle
                        r={RUN_GRAPH_NODE_RADIUS}
                        fill={colorMap[node.type] ?? "#6b7280"}
                        className={active ? "stroke-foreground" : highlight?.has(place.id) ? "stroke-foreground/70" : "stroke-card"}
                        strokeWidth={active ? 3 : highlight?.has(place.id) ? 2.5 : 1.5}
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                  </g>
                );
              })}
          </g>

          {/* The names over every node: a crowded cell never paints a circle across a name. */}
          <g data-testid="run-graph-names" className="pointer-events-none">
            {paintOrder.map((place) => {
              const node = nodeById.get(place.id);
              const at = labels.placed.get(`${place.cell}|${place.id}`);
              if (!node || !at) return null;
              return (
                <g key={`${place.cell}|${place.id}`} transform={`translate(${place.x},${place.y})`} opacity={opacityOf(place, isActive(place))} data-cell={place.cell} data-node={place.id}>
                  <text
                    x={at.dx}
                    y={at.dy}
                    textAnchor={at.anchor}
                    className={`stroke-card font-medium ${node.cluster ? "fill-muted-foreground" : "fill-foreground"}`}
                    strokeWidth={3}
                    strokeLinejoin="round"
                    paintOrder="stroke"
                    vectorEffect="non-scaling-stroke"
                    style={{ fontSize: NAME_FONT }}
                    data-testid="run-graph-name"
                    data-cluster={node.cluster ? true : undefined}
                  >
                    {at.text}
                  </text>
                  {node.peer && (
                    <text
                      x={at.dx}
                      y={at.dy}
                      dy={`${LABEL_LINE}em`}
                      textAnchor={at.anchor}
                      className="fill-muted-foreground stroke-card"
                      strokeWidth={3}
                      strokeLinejoin="round"
                      paintOrder="stroke"
                      vectorEffect="non-scaling-stroke"
                      style={{ fontSize: NAME_FONT }}
                      data-testid="run-graph-canvas-peer"
                    >
                      @{clipName(node.peer)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>

          {/* Highlighted names that fit nowhere near one another: one "+N" each group, its names on hover. */}
          <g data-testid="run-graph-folds">
            {labels.folded.map((f) => (
              <g key={f.key} transform={`translate(${f.x},${f.y})`} data-cell={f.cell}>
                <text
                  x={f.dx}
                  y={f.dy}
                  textAnchor={f.anchor}
                  className="cursor-help stroke-card font-medium fill-foreground"
                  strokeWidth={3}
                  strokeLinejoin="round"
                  paintOrder="stroke"
                  vectorEffect="non-scaling-stroke"
                  style={{ fontSize: NAME_FONT }}
                  data-testid="run-graph-name"
                  data-fold={f.names.length}
                >
                  <title>{f.names.join("\n")}</title>
                  {f.text}
                </text>
              </g>
            ))}
          </g>
        </g>
      </svg>
      <div className="absolute right-3 top-3 flex gap-1">
        {follow !== null && (
          <Button
            variant={following ? "secondary" : "outline"}
            size="icon"
            className="h-7 w-7"
            aria-pressed={following}
            aria-label={following ? "Stop following the replay" : "Follow the replay"}
            title={following ? "Following the replay: zoom in to watch it move across the run; drag to look elsewhere" : "Follow the replay"}
            onClick={() => {
              followedLane.current = null;
              setFollowing((f) => !f);
            }}
            data-testid="run-graph-follow"
          >
            <LocateFixed className="h-3.5 w-3.5" />
          </Button>
        )}
        {highlightKey && (
          <Button variant="outline" size="icon" className="h-7 w-7" aria-label="Fit the highlight" title="Fit the highlight" onClick={() => refit("highlight")} data-testid="run-graph-fit-highlight">
            <Focus className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button variant="outline" size="icon" className="h-7 w-7" aria-label="Show all of it" title="Show the whole run" onClick={() => refit("all")} data-testid="run-graph-fit">
          <Maximize className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
