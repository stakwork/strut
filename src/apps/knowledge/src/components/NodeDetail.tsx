// The picked node, floating over the graph: its type, where it sits (a
// Concept's path in the tree), name and description, then what it is
// linked to, grouped by how ("Owned by", "Children"), each a chip to step
// to. Opened wide, its docs as markdown (strut/views' DocumentView) and
// where it came from. Read-only.
import { ArrowLeft, Maximize2, Minimize2, X } from "lucide-react";
import { DocumentView, useNode } from "strut/views";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useLinks } from "../lib/read";
import { textOf } from "../lib/ontology";
import type { ConceptTree } from "../lib/tree";
import { Chip, Dot, SectionLabel, type Picked } from "./bits";

export interface NodeDetailProps {
  id: string;
  tree?: ConceptTree;
  /** For a Concept: the path the outline shows it on, root first. */
  path?: string[];
  onSelect: (n: Picked) => void;
  onClose: () => void;
  /** Wide: the docs and where it came from too. */
  wide: boolean;
  onWide: (wide: boolean) => void;
  /** Narrow: the card has the page, so it goes Back to the graph and is always wide. */
  narrow?: boolean;
}

export function NodeDetail({ id, tree, path, onSelect, onClose, wide, onWide, narrow }: NodeDetailProps) {
  const q = useNode(id);
  const links = useLinks(id);
  if (q.isLoading) return <Skeleton className="m-4 h-32" />;
  if (!q.data) return <p className="p-4 text-sm text-muted-foreground">That node isn't in the graph any more.</p>;
  const n = q.data;
  const t = textOf(n.properties);
  const above = path && path.length > 1 ? path.slice(0, -1).map((p) => tree?.nodes[p]?.name ?? p).join(" › ") : null;
  const repo = typeof n.properties["repo"] === "string" ? (n.properties["repo"] as string) : null;
  const file = typeof n.properties["file"] === "string" ? (n.properties["file"] as string) : null;
  return (
    <article className="flex flex-col" data-testid="node-detail">
      <div className="flex items-center gap-1 border-b px-2 py-1">
        {narrow && (
          <button type="button" onClick={onClose} className="flex items-center gap-1 rounded px-1 py-0.5 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" /> Graph
          </button>
        )}
        <span className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
          <Dot type={n.node_type} />
          {n.node_type}
        </span>
        <span className="flex-1" />
        {!narrow && (
          <>
            <button type="button" onClick={() => onWide(!wide)} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground">
              {wide ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
              {wide ? "Less" : "Docs and more"}
            </button>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-muted-foreground hover:text-foreground">
              <X className="size-4" />
            </button>
          </>
        )}
      </div>
      <div className={cn("flex flex-col gap-4 p-4", wide && "gap-6 px-5")}>
        <header className="space-y-1">
          {above && <p className="truncate text-xs text-muted-foreground">{above}</p>}
          <h1 className={cn("break-words font-semibold tracking-tight", wide ? "text-xl" : "text-base")}>{n.name}</h1>
          {t.description && <p className="text-sm leading-relaxed text-muted-foreground">{t.description}</p>}
        </header>

        {wide && (
          <section className="space-y-2">
            <SectionLabel>Docs</SectionLabel>
            {t.docs ? (
              // The card scrolls, so the docs are not a box of their own.
              <DocumentView text={t.docs} kind="markdown" className="[&>div]:max-h-none [&>div]:overflow-visible [&>div]:border-0 [&>div]:p-0" />
            ) : (
              <p className="text-sm text-muted-foreground">Nothing written on this yet.</p>
            )}
          </section>
        )}

        <section className="space-y-3">
          {links.isLoading && <Skeleton className="h-16" />}
          {links.data?.length === 0 && <p className="text-xs text-muted-foreground">Not linked to anything yet.</p>}
          {links.data?.map((g) => (
            <div key={g.key} className="space-y-1.5">
              <SectionLabel>
                {g.label} <span className="tabular-nums">{g.nodes.length}</span>
              </SectionLabel>
              <div className="flex flex-wrap gap-1.5">
                {g.nodes.map((m) => (
                  <Chip key={m.ref_id} node={m} onSelect={onSelect} />
                ))}
              </div>
            </div>
          ))}
        </section>

        {wide && (repo || file) && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            {repo && (
              <>
                <dt className="text-muted-foreground">Repository</dt>
                <dd className="break-all font-mono">{repo}</dd>
              </>
            )}
            {file && (
              <>
                <dt className="text-muted-foreground">File</dt>
                <dd className="break-all font-mono">{file}</dd>
              </>
            )}
          </dl>
        )}
      </div>
    </article>
  );
}
