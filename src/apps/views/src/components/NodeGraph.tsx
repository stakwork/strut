import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, MarkerType, ReactFlow, type Edge, type EdgeTypes, type Node, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ChevronsDownUp, ChevronsUpDown, Loader2 } from "lucide-react";
import { useHost, useStrutClient } from "@strut/kit";
import { cn } from "@/lib/utils";
import { nodeColor } from "../lib/colors";
import { errorText } from "../lib/format";
import { getNeighbors, getNodes } from "../lib/graph";
import { FloatingEdge } from "./FloatingEdge";

const EDGE_TYPES: EdgeTypes = { floating: FloatingEdge };

export interface NodeGraphProps {
  /** The node to draw the neighbourhood of. */
  refId: string;
  /** Only these edge types (`["PARENT_OF"]`). */
  edgeTypes?: string[];
  /** A node was clicked. Its chip opens or folds its neighbours instead. */
  onSelect?: (node: { ref_id: string; node_type: string; name: string }) => void;
  /** The node to mark as picked (beyond `refId`'s bold border). */
  selected?: string | null;
  /** The canvas's height in px. */
  height?: number;
  className?: string;
}

interface Placed {
  ref_id: string;
  node_type: string;
  name: string;
  x: number;
  y: number;
  /** Its edges, of `edgeTypes` where given: what opening it could show. */
  degree: number;
  /** The node whose opening placed it; none for the centre. */
  from?: string;
}

interface Link {
  source: string;
  target: string;
  type: string;
}

const RING = 230;
const ARC = 230;

const degreeOf = (edges: Record<string, number> | undefined, only?: string[]) =>
  Object.entries(edges ?? {}).reduce((n, [t, c]) => (!only?.length || only.includes(t) ? n + c : n), 0);

/** `id` and every node its openings placed, down the `from` chain. */
function placedUnder(placed: Map<string, Placed>, id: string): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of placed.values()) {
      if (p.from && (p.from === id || out.has(p.from)) && !out.has(p.ref_id)) {
        out.add(p.ref_id);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * A node's neighbourhood in React Flow: the node in the middle, its
 * neighbours around it (`graph/graph-neighbors`). Each node's + opens its
 * neighbours outward, its collapse chip folds away what that opening (and the openings
 * past it) placed; a click on a node is `onSelect`'s. Every read goes
 * through the importing app's grants (`graph/graph-get-batched` for the
 * first node, `graph/graph-neighbors`).
 */
export function NodeGraph({ refId, edgeTypes, onSelect, selected, height = 480, className }: NodeGraphProps) {
  const client = useStrutClient();
  const { theme } = useHost();
  const [placed, setPlaced] = useState<Map<string, Placed>>(new Map());
  const [links, setLinks] = useState<Map<string, Link>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const edgeKey = useMemo(() => (edgeTypes ?? []).join(","), [edgeTypes]);
  const flow = useRef<ReactFlowInstance | null>(null);
  /** Opening places nodes: fit them in once React Flow has measured them (`onNodesChange`). */
  const fitPending = useRef(false);
  const fit = useCallback(() => requestAnimationFrame(() => void flow.current?.fitView({ duration: 300, maxZoom: 1, padding: 0.15 })), []);

  /** Read `id`'s neighbours and place the new ones around it, away from where it sits. */
  const expand = useCallback(
    async (id: string, at: Map<string, Placed>) => {
      setLoading(id);
      try {
        const around = await getNeighbors(client, id, { edgeTypes });
        const from = at.get(id)!;
        const fresh = around.filter((n) => !at.has(n.ref_id));
        const centre = from.x === 0 && from.y === 0;
        const outward = centre ? 0 : Math.atan2(from.y, from.x);
        const spread = centre ? 2 * Math.PI : Math.PI;
        const radius = centre ? RING : ARC;
        const next = new Map(at);
        fresh.forEach((n, i) => {
          const a = centre ? (i / Math.max(1, fresh.length)) * spread : outward - spread / 2 + ((i + 0.5) / fresh.length) * spread;
          next.set(n.ref_id, {
            ref_id: n.ref_id,
            node_type: n.node_type,
            name: n.name,
            x: from.x + Math.cos(a) * radius,
            y: from.y + Math.sin(a) * radius,
            degree: degreeOf(n.edges, edgeTypes),
            from: id,
          });
        });
        setPlaced(next);
        setLinks((prev) => {
          const e = new Map(prev);
          for (const n of around) {
            const [source, target] = n.direction === "forward" ? [id, n.ref_id] : [n.ref_id, id];
            e.set(`${source}|${n.edge_type}|${target}`, { source, target, type: n.edge_type });
          }
          return e;
        });
        setExpanded((prev) => new Set(prev).add(id));
        if (fresh.length) fitPending.current = true;
        setError(null);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setLoading(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, edgeKey],
  );

  /** Fold `id`: what its opening placed goes, and so does what those openings placed. */
  const collapse = useCallback(
    (id: string) => {
      const gone = placedUnder(placed, id);
      setPlaced(new Map([...placed].filter(([k]) => !gone.has(k))));
      setExpanded((prev) => new Set([...prev].filter((k) => k !== id && !gone.has(k))));
      fit();
    },
    [placed, fit],
  );

  useEffect(() => {
    let alive = true;
    setPlaced(new Map());
    setLinks(new Map());
    setExpanded(new Set());
    (async () => {
      try {
        const n = (await getNodes(client, [refId])).get(refId);
        if (!alive) return;
        if (!n || "error" in n) throw new Error(n && "error" in n ? n.error : `no node ${refId}`);
        const start = new Map([[refId, { ref_id: refId, node_type: n.node_type, name: n.name, x: 0, y: 0, degree: degreeOf(n.edges, edgeTypes) }]]);
        setPlaced(start);
        await expand(refId, start);
      } catch (e) {
        if (alive) setError(errorText(e));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, refId, expand]);

  /** The edges both of whose ends are on the canvas. */
  const shown = useMemo(() => [...links.entries()].filter(([, e]) => placed.has(e.source) && placed.has(e.target)), [links, placed]);

  const flowNodes = useMemo<Node[]>(() => {
    const drawn = new Map<string, number>();
    for (const [, e] of shown) {
      drawn.set(e.source, (drawn.get(e.source) ?? 0) + 1);
      drawn.set(e.target, (drawn.get(e.target) ?? 0) + 1);
    }
    return [...placed.values()].map((p) => {
      const open = expanded.has(p.ref_id);
      const more = p.degree - (drawn.get(p.ref_id) ?? 0);
      const canFold = open && [...placed.values()].some((q) => q.from === p.ref_id);
      const toggle = canFold || (!open && more > 0);
      return {
        id: p.ref_id,
        position: { x: p.x, y: p.y },
        data: {
          label: (
            <span className="flex flex-col items-center gap-0.5">
              <span className="max-w-36 truncate text-xs font-medium">{p.name || p.ref_id.slice(0, 8)}</span>
              <span className="text-[10px] text-muted-foreground">{p.node_type}</span>
              {toggle && (
                <button
                  type="button"
                  className="nodrag absolute -bottom-2.5 left-1/2 flex h-5 min-w-5 -translate-x-1/2 items-center justify-center gap-0.5 rounded-full border bg-card px-1 text-[10px] tabular-nums text-muted-foreground shadow-sm hover:text-foreground"
                  aria-label={canFold ? `Fold ${p.name}` : `Open ${p.name}'s ${more} more`}
                  title={canFold ? "Fold" : `Open ${more} more`}
                  data-testid="node-toggle"
                  disabled={!!loading}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (canFold) collapse(p.ref_id);
                    else void expand(p.ref_id, placed);
                  }}
                >
                  {canFold ? <ChevronsDownUp className="size-3" /> : (
                    <>
                      <ChevronsUpDown className="size-3" />
                      {more}
                    </>
                  )}
                </button>
              )}
            </span>
          ),
        },
        style: {
          borderColor: nodeColor(p.node_type),
          borderWidth: p.ref_id === refId ? 3 : 1.5,
          background: "var(--card)",
          color: "var(--card-foreground)",
          width: 168,
          opacity: loading === p.ref_id ? 0.6 : 1,
          ...(p.ref_id === selected ? { boxShadow: `0 0 0 4px color-mix(in oklab, ${nodeColor(p.node_type)} 30%, transparent)` } : {}),
        },
      };
    });
  }, [placed, shown, expanded, refId, loading, selected, collapse, expand]);

  const flowEdges = useMemo<Edge[]>(() => {
    // One edge type throughout says nothing per edge: no labels.
    const labelled = new Set(shown.map(([, e]) => e.type)).size > 1;
    return shown.map(([id, e]) => ({
      id,
      type: "floating",
      source: e.source,
      target: e.target,
      ...(labelled ? { label: e.type } : {}),
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      style: { strokeWidth: 1.25 },
    }));
  }, [shown]);

  return (
    // No handles: nothing is connected by hand, and edges meet the border (FloatingEdge).
    <div className={cn("relative rounded-lg border [&_[data-handlepos]]:invisible", className)} style={{ height }} data-testid="node-graph">
      {error && <p className="absolute left-3 top-3 z-10 rounded bg-card px-2 py-1 text-sm text-destructive shadow">{error}</p>}
      {loading && <Loader2 className="absolute right-3 top-3 z-10 size-4 animate-spin text-muted-foreground" />}
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        edgeTypes={EDGE_TYPES}
        fitView
        colorMode={theme === "dark" ? "dark" : "light"}
        // Fitted while only the first node is placed: never closer than life size.
        fitViewOptions={{ maxZoom: 1 }}
        onInit={(i) => {
          flow.current = i;
        }}
        onNodesChange={(changes) => {
          if (fitPending.current && changes.some((c) => c.type === "dimensions")) {
            fitPending.current = false;
            fit();
          }
        }}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_e, n) => {
          const p = placed.get(n.id);
          if (p) onSelect?.({ ref_id: p.ref_id, node_type: p.node_type, name: p.name });
        }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
