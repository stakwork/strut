import { nodeText } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { nodeColor } from "../lib/colors";
import { errorText } from "../lib/format";
import { useNode, type GraphNode } from "../lib/graph";

export interface NodeCardProps {
  /** Read the node (`graph/graph-get-batched`, the importing app's grant)… */
  refId?: string;
  /** …or draw this one. */
  node?: GraphNode;
  /** Open it (a click on the card). */
  onOpen?: (node: GraphNode) => void;
  className?: string;
}

/** A graph node at a glance: its name and type, the start of its prose (a
 *  Concept's docs, a Document's content — `nodeText`), and its edges by type. */
export function NodeCard({ refId, node: given, onOpen, className }: NodeCardProps) {
  const q = useNode(given ? undefined : refId);
  const node = given ?? q.data;
  if (!node) {
    if (q.isError) return <p className={cn("text-sm text-destructive", className)}>{errorText(q.error)}</p>;
    return <Skeleton className={cn("h-28 w-full", className)} />;
  }
  const prose = nodeText(node.properties ?? {}).prose[0];
  const edges = Object.entries(node.edges ?? {}).sort((a, b) => b[1] - a[1]);
  const body = (
    <>
      <div className="flex items-start gap-2">
        <span className="mt-1.5 inline-block size-2.5 shrink-0 rounded-full" style={{ backgroundColor: nodeColor(node.node_type) }} />
        <div className="min-w-0 flex-1">
          <div className="break-words font-medium">{node.name || node.ref_id.slice(0, 8)}</div>
          <div className="font-mono text-xs text-muted-foreground">{node.ref_id}</div>
        </div>
        <Badge variant="outline" className="shrink-0 font-normal">{node.node_type}</Badge>
      </div>
      {prose && <p className="line-clamp-3 text-muted-foreground">{prose[1]}</p>}
      {edges.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {edges.slice(0, 8).map(([type, n]) => (
            <Badge key={type} variant="secondary" className="font-mono text-[10px] font-normal">
              {type} {n}
            </Badge>
          ))}
        </div>
      )}
    </>
  );
  const box = cn("flex flex-col gap-2 rounded-lg border bg-card p-3 text-left text-sm", className);
  return onOpen ? (
    <button type="button" className={cn(box, "hover:bg-muted/40")} onClick={() => onOpen(node)} data-testid="node-card">
      {body}
    </button>
  ) : (
    <div className={box} data-testid="node-card">{body}</div>
  );
}
