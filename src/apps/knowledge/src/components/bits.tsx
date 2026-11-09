// The small pieces every part of the page draws a node with: its type's
// dot, a section label, a chip to step to it, a row in a list.
import type { ReactNode } from "react";
import { nodeColor } from "strut/views";
import { cn } from "@/lib/utils";

export interface Picked {
  ref_id: string;
  node_type: string;
  name: string;
}

export const Dot = ({ type, className }: { type: string; className?: string }) => (
  <span className={cn("inline-block size-2 shrink-0 rounded-full", className)} style={{ backgroundColor: nodeColor(type) }} />
);

export const SectionLabel = ({ children }: { children: ReactNode }) => (
  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</p>
);

export function Chip({ node, onSelect }: { node: Picked; onSelect: (n: Picked) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(node)}
      className="inline-flex max-w-full items-center gap-1.5 truncate rounded-md border px-2 py-0.5 text-xs hover:bg-accent"
      title={`${node.node_type}: ${node.name}`}
      data-testid="node-chip"
    >
      <Dot type={node.node_type} />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

/** A search hit or a type's row: dot, name, the start of its description, and its type where the list mixes them. */
export function NodeRow({ node, selected, onSelect, showType = true }: { node: Picked & { description?: string }; selected?: boolean; onSelect: (n: Picked) => void; showType?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(node)}
      className={cn("flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60", selected && "bg-primary/10 ring-1 ring-inset ring-primary/40")}
      data-testid="node-row"
    >
      <Dot type={node.node_type} className="mt-1.5" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{node.name || node.ref_id.slice(0, 8)}</span>
        {node.description && <span className="line-clamp-2 text-xs text-muted-foreground">{node.description}</span>}
      </span>
      {showType && <span className="shrink-0 pt-0.5 text-[11px] text-muted-foreground">{node.node_type}</span>}
    </button>
  );
}
