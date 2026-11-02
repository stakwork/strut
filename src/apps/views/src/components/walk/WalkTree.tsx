// The walk as a TREE, left to right: every node it discovered hung from the
// one it arrived from (`foldWalkGraph`: the edge each came by), the trail
// drawn as a thick line through it, kept nodes solid, dropped ones faded.
// A tidy tree, not a force layout: a walk reaches each node once, so it IS
// a tree, and a new hop only adds leaves — the drawing grows, never scatters.
// A colour from a CSS variable goes in `style`: an SVG presentation
// attribute does not resolve `var()`.
import { useEffect, useMemo, useRef } from "react";
import { hierarchy, linkHorizontal, tree, type HierarchyPointNode } from "d3";
import type { WalkBrief, WalkGraphNode, WalkGraphState } from "@strut/kit";
import { cn } from "@/lib/utils";
import { nodeColor } from "../../lib/colors";

const ROW_H = 26;
const COL_W = 175;
const LABEL_MAX = 36;
const PAD = 12;
/** Past the last column's circle, room for its label (LABEL_MAX characters). */
const LABEL_ROOM = 130;

interface TNode {
  id: string;
  node: WalkGraphNode | null;
  children: TNode[];
}

const short = (s: string) => (s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s);

export function WalkTree({ graph, path, moving, selected, onSelect }: {
  graph: WalkGraphState;
  /** The chosen nodes in order: drawn as the trail. */
  path: WalkBrief[];
  moving: boolean;
  selected: string | null;
  onSelect: (node: WalkBrief) => void;
}) {
  const layout = useMemo(() => {
    const root: TNode = { id: "", node: null, children: [] };
    const byId = new Map<string, TNode>();
    for (const n of graph.nodes.values()) byId.set(n.id, { id: n.id, node: n, children: [] });
    for (const t of byId.values()) {
      const from = t.node?.via?.from;
      const parent = from && from !== t.id ? byId.get(from) : undefined;
      (parent ?? root).children.push(t);
    }
    if (!root.children.length) return null;
    const h = hierarchy<TNode>(root, (d) => d.children);
    const laid = tree<TNode>().nodeSize([ROW_H, COL_W])(h);
    const nodes = laid.descendants().filter((d) => d.depth > 0);
    let minX = Infinity;
    let maxX = -Infinity;
    let maxY = 0;
    for (const d of nodes) {
      minX = Math.min(minX, d.x);
      maxX = Math.max(maxX, d.x);
      maxY = Math.max(maxY, d.y);
    }
    return { nodes, links: laid.links().filter((l) => l.source.depth > 0), minX, height: maxX - minX + 2 * PAD + ROW_H, width: maxY + LABEL_ROOM };
  }, [graph]);

  const onTrail = useMemo(() => new Set(path.map((n) => n.ref_id)), [path]);
  const current = moving ? path[path.length - 1]?.ref_id : undefined;
  // Keep the newest chosen node in view as the tree grows to the right.
  const box = useRef<HTMLDivElement>(null);
  const newest = path[path.length - 1]?.ref_id;
  const newestY = layout?.nodes.find((d) => d.data.id === newest)?.y;
  useEffect(() => {
    const el = box.current;
    if (!el || newestY === undefined) return;
    const right = newestY + LABEL_ROOM;
    if (right > el.scrollLeft + el.clientWidth || right < el.scrollLeft) el.scrollTo({ left: Math.max(0, right - el.clientWidth), behavior: "smooth" });
  }, [newestY]);
  if (!layout) return <p className="text-sm text-muted-foreground">Nothing discovered yet.</p>;
  const X = (d: HierarchyPointNode<TNode>) => d.y - COL_W + PAD + 8;
  const Y = (d: HierarchyPointNode<TNode>) => d.x - layout.minX + PAD + ROW_H / 2;
  const link = linkHorizontal<{ source: HierarchyPointNode<TNode>; target: HierarchyPointNode<TNode> }, [number, number]>()
    .source((l) => [X(l.source), Y(l.source)])
    .target((l) => [X(l.target), Y(l.target)]);

  return (
    <div ref={box} className="overflow-auto rounded-lg border bg-card" data-testid="walk-tree">
      <svg width={layout.width} height={layout.height} className="block font-sans">
        {layout.links.map((l) => {
          const trail = onTrail.has(l.source.data.id) && onTrail.has(l.target.data.id);
          const dropped = l.target.data.node?.state === "dropped";
          return (
            <path
              key={`${l.source.data.id}>${l.target.data.id}`}
              d={link(l) ?? ""}
              fill="none"
              stroke={trail ? nodeColor(l.target.data.node?.type ?? "") : "currentColor"}
              strokeWidth={trail ? 3 : 1}
              strokeDasharray={dropped ? "3 3" : undefined}
              className={cn("transition-all duration-300", !trail && "text-border")}
            />
          );
        })}
        {layout.nodes.map((d) => {
          const n = d.data.node!;
          const color = nodeColor(n.type);
          const chosen = onTrail.has(n.id);
          const solid = chosen || n.state === "kept";
          const faded = n.state === "dropped" && !chosen;
          return (
            // The position as a CSS transform, so a node a new hop moves eases there.
            <g
              key={n.id}
              style={{ transform: `translate(${X(d)}px, ${Y(d)}px)`, transition: "transform .4s ease" }}
              className={cn("cursor-pointer", faded && "opacity-45")}
              onClick={() => onSelect({ ref_id: n.id, node_type: n.type, name: n.name })}
              data-state={chosen ? "chosen" : n.state}
            >
              <title>{`${n.name} · ${n.type}${n.relevance !== undefined ? ` · relevance ${n.relevance.toFixed(2)}` : ""} · ${chosen ? "chosen" : n.state}`}</title>
              {current === n.id && <circle r={7} fill={color} className="sv-walk-ping" />}
              <circle r={chosen ? 7 : 5} style={{ fill: solid ? color : "var(--card)" }} stroke={color} strokeWidth={2} strokeDasharray={n.state === "discovered" ? "2 2" : undefined} />
              {selected === n.id && <circle r={11} fill="none" style={{ stroke: "var(--ring)" }} strokeWidth={2} />}
              <text x={12} dy="0.32em" style={{ stroke: "var(--card)", strokeWidth: 3, paintOrder: "stroke" }} className={cn("fill-foreground text-[12px]", chosen ? "font-semibold" : "text-[11px]", faded && "fill-muted-foreground")}>
                {short(n.name || n.id.slice(0, 8))}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
