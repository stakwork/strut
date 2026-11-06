import { BaseEdge, EdgeLabelRenderer, getStraightPath, useInternalNode, type EdgeProps, type InternalNode } from "@xyflow/react";

/** Where the line from `a`'s centre towards `b`'s centre leaves `a`'s box. */
function border(a: InternalNode, b: InternalNode): { x: number; y: number } {
  const w = (a.measured.width ?? 0) / 2;
  const h = (a.measured.height ?? 0) / 2;
  const ax = a.internals.positionAbsolute.x + w;
  const ay = a.internals.positionAbsolute.y + h;
  const bx = b.internals.positionAbsolute.x + (b.measured.width ?? 0) / 2;
  const by = b.internals.positionAbsolute.y + (b.measured.height ?? 0) / 2;
  const dx = bx - ax;
  const dy = by - ay;
  if (!dx && !dy) return { x: ax, y: ay };
  // Scale the direction until it meets the nearer side.
  const t = Math.min(w ? Math.abs(w / dx || Infinity) : Infinity, h ? Math.abs(h / dy || Infinity) : Infinity);
  return { x: ax + dx * t, y: ay + dy * t };
}

/**
 * A straight edge between two nodes' borders, whichever side faces the
 * other — nodes placed round a ring never meet top-to-bottom, so a
 * handle-to-handle edge loops round them.
 */
export function FloatingEdge({ id, source, target, markerEnd, style, label }: EdgeProps) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t) return null;
  const from = border(s, t);
  const to = border(t, s);
  const [path, lx, ly] = getStraightPath({ sourceX: from.x, sourceY: from.y, targetX: to.x, targetY: to.y });
  return (
    <>
      <BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} {...(style ? { style } : {})} />
      {label ? (
        <EdgeLabelRenderer>
          <span
            className="nodrag nopan absolute rounded bg-background px-1 text-[10px] text-muted-foreground"
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
          >
            {label}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
