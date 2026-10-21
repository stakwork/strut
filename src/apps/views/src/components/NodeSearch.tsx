import { useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { nodeColor } from "../lib/colors";
import { errorText } from "../lib/format";
import { useGraphSearch, type GraphHit } from "../lib/graph";

export interface NodeSearchProps {
  /** Only these node types: one, or a comma-separated list (`Concept,Document`). */
  type?: string;
  limit?: number;
  placeholder?: string;
  onSelect?: (hit: GraphHit) => void;
  className?: string;
}

/** Search the graph as you type (`graph/graph-search`, keyword + semantic,
 *  the importing app's grant): each hit with its type and the start of its
 *  description. */
export function NodeSearch({ type, limit = 10, placeholder = "Search the graph…", onSelect, className }: NodeSearchProps) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const r = useGraphSearch(q, { type, limit });
  return (
    <div className={cn("flex flex-col gap-2 text-sm", className)} data-testid="node-search">
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
        <Input className="pl-8" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} aria-label="Search the graph" />
        {r.isFetching && <Loader2 className="absolute right-2.5 top-2.5 size-4 animate-spin text-muted-foreground" />}
      </div>
      {r.isError && <p className="text-destructive">{errorText(r.error)}</p>}
      {r.data && !r.data.length && q && <p className="text-muted-foreground">Nothing matches “{q}”.</p>}
      {r.data && r.data.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border">
          {r.data.map((h) => (
            <li key={h.ref_id}>
              <button type="button" className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted/60" onClick={() => onSelect?.(h)}>
                <span className="mt-1.5 inline-block size-2 shrink-0 rounded-full" style={{ backgroundColor: nodeColor(h.node_type) }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{h.name || h.ref_id.slice(0, 8)}</span>
                  {h.description && <span className="line-clamp-2 text-xs text-muted-foreground">{h.description}</span>}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{h.node_type}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
