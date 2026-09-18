import { useEffect, useRef, useState } from "preact/hooks";
import { forceSimulation, forceLink, forceManyBody, forceX, forceY, forceCollide, type Simulation, type SimulationNodeDatum, type SimulationLinkDatum } from "d3-force";
import { select, type Selection } from "d3-selection";
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { drag as d3drag } from "d3-drag";
import type { WalkNode, WalkState } from "../walk-graph";

// A force graph of a graph_walk, ported from hive's GraphVisualization
// (plans/walk-chat-demo.md §4) with one change: hive rebuilds the simulation
// on every data change, which would re-scatter the layout every hop. Here ONE
// simulation lives as long as the component, its node objects are kept by
// id (their x/y/vx/vy survive a hop), a new node starts at the node it
// arrived from, and the SVG is updated with d3 joins rather than recreated.

type SimNode = SimulationNodeDatum & { id: string; data: WalkNode };
type SimLink = SimulationLinkDatum<SimNode> & { key: string; type: string };

/** Node-type → CSS custom property (components.css `--walk-*`). */
const TYPE_VAR: Record<string, string> = {
  StrutWorkflow: "--walk-workflow",
  StrutWorkflowVersion: "--walk-version",
  StrutRun: "--walk-run",
  StrutStep: "--walk-step",
  StrutStepVersion: "--walk-step",
  Claim: "--walk-claim",
  Check: "--walk-check",
  Evidence: "--walk-evidence",
};
const colorOf = (n: WalkNode) =>
  n.verdict === "refutes" ? "var(--danger)" : n.verdict === "supports" ? "var(--ok)" : `var(${TYPE_VAR[n.type] ?? "--walk-other"})`;
const radiusOf = (n: WalkNode) => (n.relevance === undefined ? 4 : 3 + 5 * n.relevance);
/** Kept nodes labeled at rest, most relevant first — the flyout is narrow. */
const LABELS = 8;
const LABEL_MAX = 28;
const clipLabel = (s: string) => (s.length > LABEL_MAX ? s.slice(0, LABEL_MAX - 1) + "…" : s);
/** Where the auto-fit keeps the graph: this much padding, never zoomed past 1.6×. */
const FIT_PAD = 24;
const FIT_MAX = 1.6;

export function WalkGraph(props: { state: WalkState; selected: string | null; onSelect: (id: string | null) => void; height?: number }) {
  const { state, selected, onSelect } = props;
  const height = props.height ?? 280;
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(0);
  // Everything d3 owns, created once.
  const g = useRef<{
    sim: Simulation<SimNode, SimLink>;
    nodes: Map<string, SimNode>;
    zoom: ZoomBehavior<SVGSVGElement, unknown>;
    root: Selection<SVGGElement, unknown, null, undefined>;
    links: Selection<SVGGElement, unknown, null, undefined>;
    dots: Selection<SVGGElement, unknown, null, undefined>;
    /** The user zoomed or panned: stop auto-fitting until "fit". */
    userZoomed: boolean;
    fit: (snap: boolean) => void;
  } | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Size from the container (the flyout is drag-resizable); skip the 0×0 pass
  // of a hidden container — laying out into it collapses every node.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry!.contentRect.width);
      if (w >= 1) setWidth((prev) => (Math.abs(prev - w) < 1 ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The simulation, zoom and layers — once.
  useEffect(() => {
    const svg = select(svgRef.current!);
    const root = svg.append("g");
    const links = root.append("g").attr("class", "walk-links");
    const dots = root.append("g").attr("class", "walk-nodes");
    const nodes = new Map<string, SimNode>();
    const sim = forceSimulation<SimNode, SimLink>([])
      .force("link", forceLink<SimNode, SimLink>([]).id((d) => d.id).distance(40))
      .force("charge", forceManyBody().strength(-80))
      .force("collide", forceCollide<SimNode>().radius((d) => radiusOf(d.data) + 4));
    let current: ZoomTransform = zoomIdentity;
    const zoom = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      // The graph sits in a scrolling chat: a plain wheel scrolls the chat;
      // ctrl/⌘-wheel (and a trackpad pinch, which sends ctrl) zooms.
      .filter((e: Event) => (e.type === "wheel" ? (e as WheelEvent).ctrlKey || (e as WheelEvent).metaKey : !(e as MouseEvent).button))
      .on("zoom", (e) => {
        current = e.transform;
        root.attr("transform", e.transform.toString());
        // Labels and strokes keep their screen size at any zoom (components.css).
        root.style("--walk-k", String(e.transform.k));
        if (e.sourceEvent && g.current) g.current.userZoomed = true;
      });
    svg.call(zoom).on("dblclick.zoom", null);
    svg.on("click", () => onSelectRef.current(null));

    /** Zoom so every node is in view — eased toward the target each tick,
     *  or at once (`snap`). */
    const fit = (snap: boolean) => {
      const el = svgRef.current;
      if (!el || nodes.size === 0) return;
      const w = el.clientWidth;
      const h = el.clientHeight;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of nodes.values()) {
        x0 = Math.min(x0, n.x!); y0 = Math.min(y0, n.y!); x1 = Math.max(x1, n.x!); y1 = Math.max(y1, n.y!);
      }
      const k = Math.min(FIT_MAX, (w - 2 * FIT_PAD) / Math.max(1, x1 - x0), (h - 2 * FIT_PAD) / Math.max(1, y1 - y0));
      const tx = w / 2 - k * (x0 + x1) / 2;
      const ty = h / 2 - k * (y0 + y1) / 2;
      const a = snap ? 1 : 0.12;
      const t = zoomIdentity
        .translate(current.x + (tx - current.x) * a, current.y + (ty - current.y) * a)
        .scale(current.k + (k - current.k) * a);
      svg.call(zoom.transform, t);
    };

    sim.on("tick", () => {
      links
        .selectAll<SVGLineElement, SimLink>("line")
        .attr("x1", (d) => (d.source as SimNode).x!)
        .attr("y1", (d) => (d.source as SimNode).y!)
        .attr("x2", (d) => (d.target as SimNode).x!)
        .attr("y2", (d) => (d.target as SimNode).y!);
      dots.selectAll<SVGGElement, SimNode>("g.walk-node").attr("transform", (d) => `translate(${d.x},${d.y})`);
      if (!g.current?.userZoomed) fit(false);
    });
    g.current = { sim, nodes, zoom, root, links, dots, userZoomed: false, fit };
    return () => {
      sim.stop();
      svg.on(".zoom", null);
      root.remove();
      g.current = null;
    };
  }, []);

  // Each new state: reuse node objects, seed new ones at their parent, join.
  useEffect(() => {
    const d3g = g.current;
    if (!d3g || !width) return;
    const { sim, nodes, links, dots } = d3g;
    // A weak pull to the middle rather than a center force: the seeds (one
    // per search hit) are unconnected, and would otherwise drift apart.
    sim.force("x", forceX<SimNode>(width / 2).strength(0.07)).force("y", forceY<SimNode>(height / 2).strength(0.1));

    let added = false;
    for (const n of state.nodes.values()) {
      const existing = nodes.get(n.id);
      if (existing) {
        existing.data = n;
        continue;
      }
      const parent = n.via ? nodes.get(n.via.from) : undefined;
      const jitter = () => (Math.random() - 0.5) * 20;
      nodes.set(n.id, {
        id: n.id,
        data: n,
        x: (parent?.x ?? width / 2) + jitter(),
        y: (parent?.y ?? height / 2) + jitter(),
      });
      added = true;
    }
    // A replay restarts from an empty walk.
    for (const id of [...nodes.keys()]) {
      if (state.nodes.has(id)) continue;
      nodes.delete(id);
      added = true;
    }
    const simNodes = [...nodes.values()];
    const simLinks: SimLink[] = state.edges
      .filter((e) => nodes.has(e.source) && nodes.has(e.target))
      .map((e) => ({ key: `${e.source}>${e.target}`, source: e.source, target: e.target, type: e.type }));
    sim.nodes(simNodes);
    (sim.force("link") as ReturnType<typeof forceLink<SimNode, SimLink>>).links(simLinks);
    sim.force("collide", forceCollide<SimNode>().radius((d) => radiusOf(d.data) + 4));

    links
      .selectAll<SVGLineElement, SimLink>("line")
      .data(simLinks, (d) => d.key)
      .join((enter) => {
        const line = enter.append("line").attr("class", "walk-link");
        line.append("title");
        return line;
      })
      .select("title")
      .text((d) => d.type);

    const node = dots
      .selectAll<SVGGElement, SimNode>("g.walk-node")
      .data(simNodes, (d) => d.id)
      .join((enter) => {
        const e = enter.append("g").attr("class", "walk-node");
        e.append("circle").attr("class", "walk-ring");
        e.append("circle").attr("class", "walk-dot");
        e.append("text").attr("class", "walk-badge");
        e.append("text").attr("class", "walk-label");
        e.append("title");
        e.on("click", (ev: MouseEvent, d) => {
          ev.stopPropagation();
          onSelectRef.current(d.id);
        });
        e.call(
          d3drag<SVGGElement, SimNode>()
            .on("start", (ev, d) => {
              if (!ev.active) sim.alphaTarget(0.3).restart();
              d.fx = d.x;
              d.fy = d.y;
            })
            .on("drag", (ev, d) => {
              d.fx = ev.x;
              d.fy = ev.y;
            })
            .on("end", (ev, d) => {
              if (!ev.active) sim.alphaTarget(0);
              d.fx = null;
              d.fy = null;
            }),
        );
        return e;
      });
    const labeled = new Set(
      [...state.nodes.values()]
        .filter((n) => n.state === "kept")
        .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
        .slice(0, LABELS)
        .map((n) => n.id),
    );
    node
      .attr("class", (d) => {
        const n = d.data;
        return [
          "walk-node",
          `is-${n.state}`,
          labeled.has(n.id) ? "is-labeled" : "",
          n.id === state.current ? "is-current" : "",
          n.id === state.next ? "is-next" : "",
          n.id === selected ? "is-selected" : "",
        ].filter(Boolean).join(" ");
      })
      .style("--c", (d) => colorOf(d.data));
    node.select<SVGCircleElement>("circle.walk-dot").attr("r", (d) => radiusOf(d.data));
    node.select<SVGCircleElement>("circle.walk-ring").attr("r", (d) => radiusOf(d.data) + 4);
    node
      .select<SVGTextElement>("text.walk-badge")
      .attr("x", (d) => radiusOf(d.data) + 1)
      .attr("y", (d) => -radiusOf(d.data))
      .text((d) => (d.data.mergedCount ? `+${d.data.mergedCount}` : ""));
    node
      .select<SVGTextElement>("text.walk-label")
      .attr("y", (d) => radiusOf(d.data))
      .attr("dy", "1.3em")
      .text((d) => clipLabel(d.data.name));
    node.select("title").text((d) => `${d.data.type}: ${d.data.name}`);

    if (added) sim.alpha(0.3).restart();
  }, [state, width, height, selected]);

  const fit = () => {
    if (!g.current) return;
    g.current.userZoomed = false;
    g.current.fit(true);
  };

  return (
    <div class="walk-graph" ref={wrapRef} style={{ height: `${height}px` }}>
      <svg ref={svgRef} width={width || undefined} height={height} />
      <button type="button" class="walk-fit" onClick={fit} title="Fit the graph in view">fit</button>
    </div>
  );
}
