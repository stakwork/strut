// The outline: each root and, under every open row, its children — Hive's
// tree node language in rows (the amber dot filled when the concept has
// docs, hollow when it has none; the selected row and its path to the root
// lit). Only open rows mount. ↑ ↓ move, ← → fold and open, ↵ selects.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { hasDocs, visibleRows, type ConceptTree, type Row } from "../lib/tree";

export interface TreeProps {
  tree: ConceptTree;
  /** The open rows, by path key. */
  open: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** The selected row's path key, and the ids on its path. */
  selectedKey: string | null;
  onPath: ReadonlySet<string>;
  onSelect: (row: Row) => void;
}

function TreeRow({ tree, row, selected, lit, focused, onToggle, onSelect }: {
  tree: ConceptTree;
  row: Row;
  selected: boolean;
  lit: boolean;
  focused: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const c = tree.nodes[row.id]!;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <div
      ref={ref}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={row.childCount ? row.open : undefined}
      aria-level={row.depth + 1}
      onClick={onSelect}
      className={cn(
        "group flex h-8 cursor-pointer items-center gap-1.5 rounded-md pr-2 text-sm",
        selected ? "bg-primary/10 font-medium text-foreground ring-1 ring-inset ring-primary/40" : lit ? "text-foreground" : "text-foreground/85 hover:bg-muted/60",
        focused && !selected && "bg-muted/60",
      )}
      style={{ paddingLeft: 4 + row.depth * 16 }}
      data-testid="tree-row"
      data-id={row.id}
    >
      {row.childCount ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={row.open ? `Fold ${c.name}` : `Open ${c.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={cn("size-3.5 transition-transform duration-150", row.open && "rotate-90")} />
        </button>
      ) : (
        <span className="size-5 shrink-0" />
      )}
      {/* Hollow: nothing written here for a reader yet. */}
      <span className={cn("size-2 shrink-0 rounded-full", hasDocs(c) ? "bg-amber-500" : "border border-amber-500")} />
      <span className="min-w-0 flex-1 truncate" title={c.name}>{c.name}</span>
      {row.childCount > 0 && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{row.childCount}</span>}
    </div>
  );
}

export function Tree({ tree, open, onToggle, selectedKey, onPath, onSelect }: TreeProps) {
  const rows = useMemo(() => visibleRows(tree, open), [tree, open]);
  const [unplacedOpen, setUnplacedOpen] = useState(false);
  const loose = useMemo(() => (unplacedOpen ? visibleRows(tree, new Set(), tree.unplaced) : []), [tree, unplacedOpen]);
  const all = useMemo(() => [...rows, ...loose], [rows, loose]);
  const [focus, setFocus] = useState<string | null>(null);
  const at = Math.max(0, all.findIndex((r) => r.key === (focus ?? selectedKey)));

  const onKey = (e: KeyboardEvent) => {
    const row = all[at];
    if (!row) return;
    const move = (i: number) => {
      const next = all[Math.min(all.length - 1, Math.max(0, i))];
      if (next) setFocus(next.key);
    };
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at - 1);
    else if (e.key === "ArrowRight" && row.childCount && !row.open) onToggle(row.key);
    else if (e.key === "ArrowLeft" && row.open) onToggle(row.key);
    else if (e.key === "Enter" || e.key === " ") onSelect(row);
    else return;
    e.preventDefault();
  };

  const draw = (r: Row) => (
    <TreeRow
      key={r.key}
      tree={tree}
      row={r}
      selected={r.key === selectedKey}
      lit={onPath.has(r.id)}
      focused={!!focus && r.key === focus}
      onToggle={() => onToggle(r.key)}
      onSelect={() => {
        setFocus(r.key);
        onSelect(r);
      }}
    />
  );

  return (
    <div role="tree" aria-label="Concepts" tabIndex={0} onKeyDown={onKey} onBlur={() => setFocus(null)} className="px-2 py-2 outline-none" data-testid="concept-tree">
      {rows.map(draw)}
      {tree.unplaced.length > 0 && (
        <div className="mt-3 border-t pt-2">
          <button
            type="button"
            onClick={() => setUnplacedOpen((v) => !v)}
            className="flex h-8 w-full items-center gap-1.5 rounded-md px-1 text-left text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            aria-expanded={unplacedOpen}
            data-testid="unplaced-toggle"
          >
            <ChevronRight className={cn("size-3.5 transition-transform duration-150", unplacedOpen && "rotate-90")} />
            Not in any tree <span className="tabular-nums">({tree.unplaced.length})</span>
          </button>
          {loose.map(draw)}
        </div>
      )}
    </div>
  );
}
