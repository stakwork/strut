// A concept in the panel beside the graph (Hive's NodeDetails): its name and
// where it sits, its description, its docs as markdown (strut/views'
// DocumentView), its parents and children to step to, and where it came
// from. Read-only.
import type { ReactNode } from "react";
import { ArrowLeft, X } from "lucide-react";
import { DocumentView, useNode } from "strut/views";
import { Skeleton } from "@/components/ui/skeleton";
import { conceptOf, type ConceptTree } from "../lib/tree";

const SectionLabel = ({ children }: { children: ReactNode }) => (
  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</p>
);

function Chips({ label, ids, tree, onSelect }: { label: string; ids: string[]; tree: ConceptTree; onSelect: (id: string) => void }) {
  return (
    <div className="space-y-1.5">
      <SectionLabel>
        {label} <span className="tabular-nums">{ids.length}</span>
      </SectionLabel>
      {ids.length === 0 ? (
        <p className="text-xs text-muted-foreground">None</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {ids.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              className="max-w-full truncate rounded-md border px-2 py-0.5 text-xs hover:bg-accent"
              data-testid="concept-chip"
            >
              {tree.nodes[id]?.name ?? id}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface DetailProps {
  id: string;
  tree: ConceptTree;
  /** "Codebase › strut", or null for a root. */
  path: string[];
  onSelect: (id: string) => void;
  /** Close the panel (wide: ✕) or go back (narrow: ←). */
  onClose: () => void;
  narrow?: boolean;
}

export function Detail({ id, tree, path, onSelect, onClose, narrow }: DetailProps) {
  // Read fresh: the tree's copy is as old as the page.
  const q = useNode(id);
  const held = tree.nodes[id];
  const c = q.data ? conceptOf(q.data) : held;
  if (!c) return q.isLoading ? <Skeleton className="m-5 h-40" /> : null;
  const above = path.slice(0, -1).map((p) => tree.nodes[p]?.name ?? p);
  const parents = tree.parents[id] ?? [];
  const children = tree.children[id] ?? [];
  const where = above.length ? above.join(" › ") : children.length ? "Root" : parents.length ? null : "Not in any tree";
  return (
    <article className="flex flex-col gap-6 px-5 pt-4" data-testid="concept-detail">
      <header className="space-y-1">
        <div className="-mx-1 mb-1 flex items-center gap-1">
          {narrow && (
            <button type="button" onClick={onClose} className="flex items-center gap-1 rounded px-1 py-0.5 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="size-4" /> Back
            </button>
          )}
          {where && !narrow && <p className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground">{where}</p>}
          <span className="flex-1" />
          {!narrow && (
            <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-muted-foreground hover:text-foreground">
              <X className="size-4" />
            </button>
          )}
        </div>
        {where && narrow && <p className="truncate text-xs text-muted-foreground">{where}</p>}
        <h1 className="break-words text-xl font-semibold tracking-tight">{c.name}</h1>
        {c.description && <p className="text-sm leading-relaxed text-muted-foreground">{c.description}</p>}
      </header>

      <section className="space-y-2">
        <SectionLabel>Docs</SectionLabel>
        {c.docs ? (
          // The panel scrolls, so the docs are not a box of their own.
          <DocumentView text={c.docs} kind="markdown" className="[&>div]:max-h-none [&>div]:overflow-visible [&>div]:border-0 [&>div]:p-0" />
        ) : (
          <p className="text-sm text-muted-foreground">Nothing written on this concept yet.</p>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <Chips label="Parents" ids={parents} tree={tree} onSelect={onSelect} />
        <Chips label="Children" ids={children} tree={tree} onSelect={onSelect} />
      </section>

      {(c.repo || c.file) && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          {c.repo && (
            <>
              <dt className="text-muted-foreground">Repository</dt>
              <dd className="break-all font-mono">{c.repo}</dd>
            </>
          )}
          {c.file && (
            <>
              <dt className="text-muted-foreground">File</dt>
              <dd className="break-all font-mono">{c.file}</dd>
            </>
          )}
        </dl>
      )}
      <span className="pb-4" />
    </article>
  );
}
