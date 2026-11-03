// Ported from hive (src/components/strut-run-graph/RunGraphCanvas); strut's
// own since: a highlight that dims the rest without moving it, "+N" nodes
// for what the layout folded, and names only where they are asked for.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { select, zoom as d3Zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior } from "d3";
import { Focus, Maximize } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clipName } from "../../lib/format";
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
        if (event.sourceEvent) movedRef.current = true;
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

  /** What the view fits: the whole run, or — while there is one — the highlight, with some room around it. */
  const focusRef = useRef<"all" | "highlight">("all");
  /** The places drawn now, for the fit to read without refitting at every step of a replay. */
  const shownRef = useRef<Map<string, Map<string, RunGraphPlace>>>(new Map());

  const fit = useCallback(() => {
    const svg = svgRef.current;
    const behavior = zoomRef.current;
    if (!svg || !behavior || !size || layout.width <= 0 || layout.height <= 0) return;
    // Too narrow to give the inset up: the graph is fitted under it.
    const width = size.width - (size.width > 3 * insetRight ? insetRight : 0);
    let box = { x: 0, y: 0, width: layout.width, height: layout.height };
    if (focusRef.current === "highlight" && highlight?.size) {
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
    const k = Math.max(MIN_ZOOM, Math.min(1, width / (box.width + 2 * FIT_PADDING), size.height / (box.height + 2 * FIT_PADDING)));
    // Centred on the box, but never past the run's edge: on an axis where the
    // whole run fits, it is drawn whole; else the view stops at its border.
    const centre = (at: number, extent: number, view: number) => {
      const half = view / (2 * k);
      return extent + 2 * FIT_PADDING <= 2 * half ? extent / 2 : Math.min(Math.max(at, half - FIT_PADDING), extent + FIT_PADDING - half);
    };
    const transform = zoomIdentity
      .translate(width / 2, size.height / 2)
      .scale(k)
      .translate(-centre(box.x + box.width / 2, layout.width, width), -centre(box.y + box.height / 2, layout.height, size.height));
    select(svg).call(behavior.transform, transform);
  }, [size, insetRight, layout.width, layout.height, highlight]);

  // A lens changed: fit to what it highlights (or, with none, the whole run).
  const highlightKey = useMemo(() => [...(highlight ?? [])].sort().join("|"), [highlight]);
  useEffect(() => {
    focusRef.current = highlightKey ? "highlight" : "all";
    movedRef.current = false;
  }, [highlightKey]);

  useEffect(() => {
    if (!movedRef.current) fit();
  }, [fit, highlightKey]);

  const refit = useCallback(
    (focus: "all" | "highlight") => {
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

  /**
   * The names drawn: the hovered node's, the selected one's, the step's own
   * few, what is highlighted, the "+N" nodes — in that order, each only where
   * it collides with none placed before it at this zoom. A name left out
   * shows on hover.
   */
  const labelled = useMemo(() => {
    // A name's size in the layout's units: its screen size over the zoom, as NAME_FONT clamps it.
    const font = Math.min(Math.max(11 / zoomK, 11), 26);
    const candidates: Array<{ key: string; place: RunGraphPlace; text: string; rank: number }> = [];
    for (const cell of shown.values()) {
      for (const place of cell.values()) {
        const node = nodeById.get(place.id);
        if (!node) continue;
        const stepNode = activeIds.has(place.id) && (activeCell === null || place.cell === activeCell) && activeIds.size <= MAX_NAMED_ACTIVE;
        const rank =
          place.id === hoverId ? 6
          : place.id === selectedId ? 5
          : stepNode ? 4
          : highlight?.has(place.id) ? 3
          : node.cluster && zoomK >= GROUP_NAMES_FROM_ZOOM ? (node.cluster.highlighted ? 2 : 1)
          : 0;
        if (rank > 0) candidates.push({ key: `${place.cell}|${place.id}`, place, text: labelOf(node), rank });
      }
    }
    candidates.sort((a, b) => b.rank - a.rank);
    const taken: Array<[number, number, number, number]> = [];
    const keep = new Set<string>();
    for (const c of candidates) {
      const w = c.text.length * font * 0.6;
      const bottom = c.place.y - (RUN_GRAPH_NODE_RADIUS + 6) + font * 0.25;
      const box: [number, number, number, number] = [c.place.x - w / 2, bottom - font * 1.1, c.place.x + w / 2, bottom];
      const hits = taken.some(([x0, y0, x1, y1]) => box[0] < x1 && x0 < box[2] && box[1] < y1 && y0 < box[3]);
      if (hits && c.rank < 6) continue;
      taken.push(box);
      keep.add(c.key);
    }
    return keep;
  }, [shown, nodeById, hoverId, selectedId, activeIds, activeCell, highlight, zoomK]);

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
              <g key={lane.key} data-testid="run-graph-lane" data-stage={lane.stage}>
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
                    <g key={cell.iteration} data-testid="run-graph-cell">
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
              if (!node || !labelled.has(`${place.cell}|${place.id}`)) return null;
              return (
                <g key={`${place.cell}|${place.id}`} transform={`translate(${place.x},${place.y})`} opacity={opacityOf(place, isActive(place))}>
                  <text
                    y={-(RUN_GRAPH_NODE_RADIUS + 6)}
                    textAnchor="middle"
                    className={`stroke-card font-medium ${node.cluster ? "fill-muted-foreground" : "fill-foreground"}`}
                    strokeWidth={3}
                    strokeLinejoin="round"
                    paintOrder="stroke"
                    vectorEffect="non-scaling-stroke"
                    style={{ fontSize: NAME_FONT }}
                    data-testid="run-graph-name"
                    data-cluster={node.cluster ? true : undefined}
                  >
                    {labelOf(node)}
                  </text>
                  {node.peer && (
                    <text
                      y={RUN_GRAPH_NODE_RADIUS + 4}
                      dominantBaseline="hanging"
                      textAnchor="middle"
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
        </g>
      </svg>
      <div className="absolute right-3 top-3 flex gap-1">
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
