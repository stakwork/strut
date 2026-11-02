// The walk as a TREE, left to right: every node it discovered hung from the
// one it arrived from (`foldWalkGraph`: the edge each came by), the trail
// drawn as a thick line through it, kept nodes solid, dropped ones faded.
// A tidy tree, not a force layout: a walk reaches each node once, so it IS
// a tree. It is laid out ONCE, from the whole walk (`full`), and the nodes
// reached so far (`graph`) are drawn in place: a replay moves nothing and
// never changes the picture's size. Fitted to its container's width (never
// past 1:1); dragged to pan, pinched or ctrl-wheeled (or the buttons) to
// zoom, Fit to put it back. Every label is whole: a column is as wide as
// its longest label. A colour from a CSS variable goes in `style`: an SVG
// presentation attribute does not resolve `var()`.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { hierarchy, linkHorizontal, select, tree, zoom as d3Zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior } from "d3";
import type { WalkBrief, WalkGraphNode, WalkGraphState } from "@strut/kit";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { nodeColor } from "../../lib/colors";

const ROW_H = 26;
/** Room around the drawing when it is fitted. */
const PAD = 16;
/** A circle's centre from its column's start, and its label's start from the centre. */
const DOT = 7;
const LABEL_AT = 12;
/** From a column's longest label to the next column. */
const GAP = 36;
/** A label's room when it cannot be measured: a 12px sans character, over-estimated. */
const CHAR_W = 7.2;
const MIN_H = 200;
const MAX_H = 480;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

interface TNode {
  id: string;
  node: WalkGraphNode | null;
  children: TNode[];
}

interface Place {
  x: number;
  y: number;
}

const labelOf = (n: WalkGraphNode) => n.name || n.id.slice(0, 8);

let measurer: CanvasRenderingContext2D | null | undefined;
/**
 * The width a label is drawn at — 12px semibold on the trail, 11px off it
 * (the classes below) — in the page's own font, with room for its halo: a
 * column is as wide as this, so no label is cut and none is padded out.
 */
function labelWidth(text: string, onTrail: boolean): number {
  if (measurer === undefined) measurer = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!measurer) return text.length * CHAR_W;
  measurer.font = `${onTrail ? 600 : 400} ${onTrail ? 12 : 11}px ${getComputedStyle(document.body).fontFamily || "sans-serif"}`;
  return Math.ceil(measurer.measureText(text).width) + 4;
}

export function WalkTree({ graph, full, path, fullPath, header, moving, selected, onSelect }: {
  /** The walk as far as it is shown. */
  graph: WalkGraphState;
  /** The whole walk (as far as the log goes): what the tree is laid out from. */
  full: WalkGraphState;
  /** The chosen nodes in order: drawn as the trail. */
  path: WalkBrief[];
  /** The whole walk's chosen nodes: their labels are laid out bold. */
  fullPath: WalkBrief[];
  /** Beside the zoom controls, above the drawing (the breadcrumb). */
  header?: ReactNode;
  moving: boolean;
  selected: string | null;
  onSelect: (node: WalkBrief) => void;
}) {
  const layout = useMemo(() => {
    const root: TNode = { id: "", node: null, children: [] };
    const byId = new Map<string, TNode>();
    for (const n of full.nodes.values()) byId.set(n.id, { id: n.id, node: n, children: [] });
    for (const t of byId.values()) {
      const from = t.node?.via?.from;
      const parent = from && from !== t.id ? byId.get(from) : undefined;
      (parent ?? root).children.push(t);
    }
    if (!root.children.length) return null;
    const laid = tree<TNode>().nodeSize([ROW_H, 1])(hierarchy<TNode>(root, (d) => d.children));
    const nodes = laid.descendants().filter((d) => d.depth > 0);
    const bold = new Set(fullPath.map((n) => n.ref_id));
    // Each column as wide as its longest label.
    const widest = new Map<number, number>();
    let depth = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const d of nodes) {
      widest.set(d.depth, Math.max(widest.get(d.depth) ?? 0, labelWidth(labelOf(d.data.node!), bold.has(d.data.id))));
      depth = Math.max(depth, d.depth);
      minY = Math.min(minY, d.x);
      maxY = Math.max(maxY, d.x);
    }
    const column = new Map<number, number>();
    let x = 0;
    let width = 0;
    for (let k = 1; k <= depth; k++) {
      column.set(k, x);
      width = x + DOT + LABEL_AT + (widest.get(k) ?? 0);
      x = width + GAP;
    }
    const place = new Map<string, Place>(nodes.map((d) => [d.data.id, { x: column.get(d.depth)! + DOT, y: d.x - minY + ROW_H / 2 }]));
    const links = laid.links().filter((l) => l.source.depth > 0).map((l) => ({ source: l.source.data.id, target: l.target.data.id }));
    return { place, links, width, height: maxY - minY + ROW_H };
  }, [full, fullPath]);

  const box = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const view = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  /** The viewer has panned or zoomed: a walk that grows no longer refits under them. */
  const moved = useRef(false);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const w = entry!.contentRect.width;
      if (w >= 1) setWidth((prev) => (Math.abs(prev - w) < 1 ? prev : w));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The box's height: the whole walk fitted to the width, within bounds — so
  // it is the same at every step of a replay.
  const height = layout && width ? Math.round(Math.min(MAX_H, Math.max(MIN_H, layout.height * Math.min(1, (width - 2 * PAD) / layout.width) + 2 * PAD))) : MIN_H;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const behavior = d3Zoom<SVGSVGElement, unknown>()
      .scaleExtent([MIN_ZOOM, MAX_ZOOM])
      // A plain wheel scrolls the page; a pinch (ctrl-wheel) or ⌘-wheel zooms.
      .filter((event: Event & { button?: number; ctrlKey?: boolean; metaKey?: boolean }) =>
        event.type === "wheel" ? !!(event.ctrlKey || event.metaKey) : !event.button && !event.ctrlKey,
      )
      .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        if (event.sourceEvent) moved.current = true;
        view.current?.setAttribute("transform", event.transform.toString());
      });
    zoomRef.current = behavior;
    select(svg).call(behavior).on("dblclick.zoom", null);
    return () => {
      select(svg).on(".zoom", null);
    };
  }, [layout === null]);

  const fit = useCallback(() => {
    const svg = svgRef.current;
    const behavior = zoomRef.current;
    if (!svg || !behavior || !layout || !width) return;
    const k = Math.max(MIN_ZOOM, Math.min(1, (width - 2 * PAD) / layout.width, (height - 2 * PAD) / layout.height));
    select(svg).call(behavior.transform, zoomIdentity.translate(width / 2, height / 2).scale(k).translate(-layout.width / 2, -layout.height / 2));
  }, [layout, width, height]);

  useEffect(() => {
    if (!moved.current) fit();
  }, [fit]);

  const zoomBy = (factor: number) => {
    const svg = svgRef.current;
    if (!svg || !zoomRef.current) return;
    moved.current = true;
    select(svg).call(zoomRef.current.scaleBy, factor);
  };

  const onTrail = useMemo(() => new Set(path.map((n) => n.ref_id)), [path]);
  if (!layout) return <p className="text-sm text-muted-foreground">Nothing discovered yet.</p>;
  const current = moving ? path[path.length - 1]?.ref_id : undefined;
  const link = linkHorizontal<{ source: Place; target: Place }, [number, number]>()
    .source((l) => [l.source.x, l.source.y])
    .target((l) => [l.target.x, l.target.y]);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">{header}</div>
        <div className="flex shrink-0 gap-1">
          <Button variant="outline" size="icon" className="h-7 w-7" aria-label="Zoom in" onClick={() => zoomBy(1.4)}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" size="icon" className="h-7 w-7" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.4)}>
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            aria-label="Fit"
            title="Fit the whole walk"
            onClick={() => {
              moved.current = false;
              fit();
            }}
            data-testid="walk-tree-fit"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div ref={box} className="relative overflow-hidden rounded-lg border bg-card" style={{ height }} data-testid="walk-tree">
        <svg ref={svgRef} width="100%" height="100%" className="block cursor-grab touch-none font-sans active:cursor-grabbing">
          <g ref={view}>
            {layout.links.map(({ source, target }) => {
              const t = graph.nodes.get(target);
              if (!t || !graph.nodes.has(source)) return null;
              const trail = onTrail.has(source) && onTrail.has(target);
              return (
                <path
                  key={`${source}>${target}`}
                  d={link({ source: layout.place.get(source)!, target: layout.place.get(target)! }) ?? ""}
                  fill="none"
                  stroke={trail ? nodeColor(t.type) : "currentColor"}
                  strokeWidth={trail ? 3 : 1}
                  strokeDasharray={t.state === "dropped" ? "3 3" : undefined}
                  className={cn("transition-all duration-300", !trail && "text-border")}
                />
              );
            })}
            {[...layout.place].map(([id, p]) => {
              const n = graph.nodes.get(id);
              if (!n) return null;
              const color = nodeColor(n.type);
              const chosen = onTrail.has(n.id);
              const solid = chosen || n.state === "kept";
              const faded = n.state === "dropped" && !chosen;
              return (
                // The position as a CSS transform, so a node a growing walk moves eases there.
                <g
                  key={n.id}
                  style={{ transform: `translate(${p.x}px, ${p.y}px)`, transition: "transform .4s ease" }}
                  className={cn("cursor-pointer", faded && "opacity-45")}
                  onClick={() => onSelect({ ref_id: n.id, node_type: n.type, name: n.name })}
                  data-state={chosen ? "chosen" : n.state}
                  data-testid="walk-tree-node"
                >
                  <title>{`${n.name} · ${n.type}${n.relevance !== undefined ? ` · relevance ${n.relevance.toFixed(2)}` : ""} · ${chosen ? "chosen" : n.state}`}</title>
                  {current === n.id && <circle r={7} fill={color} className="sv-walk-ping" />}
                  <circle r={chosen ? 7 : 5} style={{ fill: solid ? color : "var(--card)" }} stroke={color} strokeWidth={2} strokeDasharray={n.state === "discovered" ? "2 2" : undefined} />
                  {selected === n.id && <circle r={11} fill="none" style={{ stroke: "var(--ring)" }} strokeWidth={2} />}
                  <text x={LABEL_AT} dy="0.32em" style={{ stroke: "var(--card)", strokeWidth: 3, paintOrder: "stroke" }} className={cn("fill-foreground text-[12px]", chosen ? "font-semibold" : "text-[11px]", faded && "fill-muted-foreground")}>
                    {labelOf(n)}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}
