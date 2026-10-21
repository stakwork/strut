import { useCallback, useEffect, useMemo, useState } from "react";
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Loader2 } from "lucide-react";
import { useStrutClient } from "@strut/kit";
import { cn } from "@/lib/utils";
import { nodeColor } from "../lib/colors";
import { errorText } from "../lib/format";
import { getNeighbors, getNodes } from "../lib/graph";

export interface NodeGraphProps {
  /** The node to draw the neighbourhood of. */
  refId: string;
  /** Only these edge types (`["PARENT_OF"]`). */
  edgeTypes?: string[];
  /** A node was clicked (it is also expanded, once). */
  onSelect?: (node: { ref_id: string; node_type: string; name: string }) => void;
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
}

const RING = 230;
const ARC = 170;

/**
 * A node's neighbourhood in React Flow: the node in the middle, its
 * neighbours around it (`graph/graph-neighbors`), and a click on any of them
 * opens theirs outward — each read once, through the importing app's grants
 * (`graph/graph-get-batched` for the first node, `graph/graph-neighbors`).
 */
export function NodeGraph({ refId, edgeTypes, onSelect, height = 480, className }: NodeGraphProps) {
  const client = useStrutClient();
  const [placed, setPlaced] = useState<Map<string, Placed>>(new Map());
  const [edges, setEdges] = useState<Map<string, { source: string; target: string; type: string }>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const edgeKey = useMemo(() => (edgeTypes ?? []).join(","), [edgeTypes]);

  /** Read `id`'s neighbours and place the new ones around it, away from where it sits. */
  const expand = useCallback(
    async (id: string, at: Map<string, Placed>) => {
      setLoading(id);
      try {
        const around = await getNeighbors(client, id, { edgeTypes });
        const from = at.get(id)!;
        const fresh = around.filter((n) => !at.has(n.ref_id));
        const outward = from.x === 0 && from.y === 0 ? 0 : Math.atan2(from.y, from.x);
        const spread = from.x === 0 && from.y === 0 ? 2 * Math.PI : Math.PI;
        const radius = from.x === 0 && from.y === 0 ? RING : ARC;
        const next = new Map(at);
        fresh.forEach((n, i) => {
          const a = spread === 2 * Math.PI ? (i / Math.max(1, fresh.length)) * spread : outward - spread / 2 + ((i + 0.5) / fresh.length) * spread;
          next.set(n.ref_id, { ref_id: n.ref_id, node_type: n.node_type, name: n.name, x: from.x + Math.cos(a) * radius, y: from.y + Math.sin(a) * radius });
        });
        setPlaced(next);
        setEdges((prev) => {
          const e = new Map(prev);
          for (const n of around) {
            const [source, target] = n.direction === "forward" ? [id, n.ref_id] : [n.ref_id, id];
            e.set(`${source}|${n.edge_type}|${target}`, { source, target, type: n.edge_type });
          }
          return e;
        });
        setExpanded((prev) => new Set(prev).add(id));
        setError(null);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setLoading(null);
      }
    },
    [client, edgeKey],
  );

  useEffect(() => {
    let alive = true;
    setPlaced(new Map());
    setEdges(new Map());
    setExpanded(new Set());
    (async () => {
      try {
        const n = (await getNodes(client, [refId])).get(refId);
        if (!alive) return;
        if (!n || "error" in n) throw new Error(n && "error" in n ? n.error : `no node ${refId}`);
        const start = new Map([[refId, { ref_id: refId, node_type: n.node_type, name: n.name, x: 0, y: 0 }]]);
        setPlaced(start);
        await expand(refId, start);
      } catch (e) {
        if (alive) setError(errorText(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, refId, expand]);

  const flowNodes = useMemo<Node[]>(
    () =>
      [...placed.values()].map((p) => ({
        id: p.ref_id,
        position: { x: p.x, y: p.y },
        data: {
          label: (
            <span className="flex flex-col items-center gap-0.5">
              <span className="max-w-36 truncate text-xs font-medium">{p.name || p.ref_id.slice(0, 8)}</span>
              <span className="text-[10px] text-muted-foreground">{p.node_type}</span>
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
        },
      })),
    [placed, refId, loading],
  );
  const flowEdges = useMemo<Edge[]>(
    () =>
      [...edges.entries()].map(([id, e]) => ({
        id,
        source: e.source,
        target: e.target,
        label: e.type,
        labelStyle: { fontSize: 10 },
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { strokeWidth: 1.25 },
      })),
    [edges],
  );

  return (
    <div className={cn("relative rounded-lg border", className)} style={{ height }} data-testid="node-graph">
      {error && <p className="absolute left-3 top-3 z-10 rounded bg-card px-2 py-1 text-sm text-destructive shadow">{error}</p>}
      {loading && <Loader2 className="absolute right-3 top-3 z-10 size-4 animate-spin text-muted-foreground" />}
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        fitView
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_e, n) => {
          const p = placed.get(n.id);
          if (!p) return;
          onSelect?.({ ref_id: p.ref_id, node_type: p.node_type, name: p.name });
          if (!expanded.has(p.ref_id) && !loading) void expand(p.ref_id, placed);
        }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
