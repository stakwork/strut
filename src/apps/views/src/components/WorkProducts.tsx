import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AppWindow, AudioLines, BookOpenText, Braces, CalendarClock, Clapperboard, ExternalLink, File, FileCode, FileDiff, FileSpreadsheet, FileText,
  Film, GitPullRequest, Globe, Image as ImageIcon, Network, ScrollText, Table2, X, type LucideIcon,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  parseTimeline, productView, sourcesOf, useHost, useStrutClient, useWorkProducts,
  type WorkProduct,
} from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { errorText } from "../lib/format";
import { GET_BATCHED, getNodes, type GraphNode } from "../lib/graph";
import { nodeColor } from "../lib/colors";
import { relPath, useRunFile } from "../lib/run-file";
import { ArtifactView } from "./ArtifactView";
import { DocumentView } from "./DocumentView";
import { SheetView } from "./SheetView";

/** What a page's own viewer for a kind is handed. */
export interface WorkProductRendererProps {
  product: WorkProduct;
  /** The run it came from: its files are `run/files { workflow, runId, path }`. */
  workflow: string;
  runId: string;
}

export type WorkProductRenderer = (props: WorkProductRendererProps) => ReactNode;

export interface WorkProductsProps {
  /** The run whose products to show (`run/events`, the importing app's grant)… */
  workflow: string;
  runId: string;
  /** …or these, already folded (`foldWorkProducts`). */
  products?: WorkProduct[];
  /** Follow the run while it goes (default true): products appear as steps declare them. */
  live?: boolean;
  /** How often the log is read while the run goes — and an open sheet, while the run writes it. */
  intervalMs?: number;
  /** A kind's viewer of the page's own, in place of the shelf's (a sheet or a table is SheetView's by default). */
  renderers?: Partial<Record<string, WorkProductRenderer>>;
  /** Read the nodes each product was made from (`graph/graph-get-batched`) to
   *  name them and count its Concepts; false: count the refs only. */
  sources?: boolean;
  /** A node a product draws on was clicked. */
  onOpenNode?: (refId: string) => void;
  /** The open product's id, when the page holds it; and when it changes. */
  open?: string | null;
  onOpenChange?: (id: string | null) => void;
  className?: string;
}

const ICON: Record<string, LucideIcon> = {
  markdown: FileText, html: Globe, docx: FileText, redline: FileDiff, diff: FileDiff,
  sheet: FileSpreadsheet, table: Table2, timeline: CalendarClock,
  image: ImageIcon, video: Film, audio: AudioLines, pdf: BookOpenText, walkthrough: Clapperboard,
  code: FileCode, json: Braces, log: ScrollText, pull_request: GitPullRequest, app: AppWindow, url: ExternalLink,
};

const KIND_LABEL: Record<string, string> = {
  markdown: "Document", html: "Page", docx: "Word document", redline: "Redline", sheet: "Sheet", table: "Table", timeline: "Timeline",
  pull_request: "Pull request", walkthrough: "Walkthrough", url: "Link",
};

const kindLabel = (k: string) => KIND_LABEL[k] ?? k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " ");

/** Who made it, in a few words: a tool by its name, a step by its id, the run as such. */
function madeBy(p: WorkProduct): string {
  if (p.stepType?.startsWith("tool:")) return p.stepType.slice(5);
  if (!p.stepType) return "the run";
  return p.step.split("/").pop()?.replace(/#\d+$/, "") ?? p.step;
}

/** The nodes every product draws on, in one read — or nothing, without the grant. */
function useSourceNodes(products: WorkProduct[], enabled: boolean) {
  const client = useStrutClient();
  const refs = useMemo(() => [...new Set(products.flatMap((p) => p.from))].sort(), [products]);
  return useQuery({
    queryKey: ["strut", GET_BATCHED, "work-products", refs],
    queryFn: () => getNodes(client, refs),
    enabled: enabled && refs.length > 0,
    retry: false,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
}

type Nodes = ReadonlyMap<string, GraphNode | { ref_id: string; error: string }> | undefined;

/** "3 Concepts · 2 Excerpts" — Concepts first, then each other type —
 *  or "5 sources" while (or when) the nodes are not read. */
function drawsOn(from: string[], nodes: Nodes): string | null {
  if (!from.length) return null;
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  const byType = new Map<string, number>();
  let unread = 0;
  for (const r of from) {
    const node = nodes?.get(r);
    if (node && !("error" in node)) byType.set(node.node_type, (byType.get(node.node_type) ?? 0) + 1);
    else unread++;
  }
  if (!byType.size) return n(from.length, "source");
  const types = [...byType].sort((a, b) => Number(b[0] === "Concept") - Number(a[0] === "Concept") || b[1] - a[1]);
  return [...types.map(([t, k]) => n(k, t)), ...(unread ? [n(unread, "source")] : [])].join(" · ");
}

/**
 * A run's WORK PRODUCTS — the memos, sheets, redlines and timelines it
 * declared (plans/work-products.md) — as a shelf of cards that fills as the
 * run goes: an icon by kind, the title and summary, which step made it and
 * what it draws on. A card opens the product under the shelf in the viewer
 * its kind reads in: a document (a .docx or a redline through its HTML
 * render, `<ins>` / `<del>` kept), media and walkthroughs (ArtifactView), a
 * timeline as a dated list, a table; anything else as its link. A page
 * plugs its own viewer in per kind (`renderers`).
 */
export function WorkProducts({ workflow, runId, products: given, live = true, intervalMs, renderers, sources = true, onOpenNode, open: controlled, onOpenChange, className }: WorkProductsProps) {
  const q = useWorkProducts(workflow, runId, { live, intervalMs, enabled: !given });
  const products = given ?? q.products;
  const nodes = useSourceNodes(products, sources).data;
  const [own, setOwn] = useState<string | null>(null);
  const openId = controlled !== undefined ? controlled : own;
  const setOpen = (id: string | null) => (onOpenChange ? onOpenChange(id) : setOwn(id));
  const opened = products.find((p) => p.id === openId);

  if (!given && q.events.isError) return <p className={cn("text-sm text-destructive", className)}>{errorText(q.events.error)}</p>;
  if (!given && q.events.isPending) return <Skeleton className={cn("h-24 w-full", className)} />;
  return (
    <div className={cn("flex flex-col gap-4", className)} data-testid="work-products">
      {products.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No work products yet.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {products.map((p) => (
            <ProductCard key={p.id} product={p} nodes={nodes} active={p.id === openId} onOpen={() => setOpen(p.id === openId ? null : p.id)} />
          ))}
        </div>
      )}
      {opened && (
        <section className="flex flex-col gap-3 rounded-lg border bg-card p-4" data-testid="work-product" data-kind={opened.kind}>
          <header className="flex items-start gap-2">
            <KindIcon kind={opened.kind} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <h3 className="font-medium">{opened.title}</h3>
              {opened.summary && <p className="text-sm text-muted-foreground">{opened.summary}</p>}
            </div>
            <Button variant="ghost" size="icon" className="size-7" aria-label="Close" onClick={() => setOpen(null)}>
              <X />
            </Button>
          </header>
          <ProductBody product={opened} workflow={workflow} runId={runId} renderers={renderers} intervalMs={intervalMs} onOpenNode={onOpenNode} />
          <MadeFrom from={opened.from} nodes={nodes} onOpenNode={onOpenNode} />
        </section>
      )}
    </div>
  );
}

function KindIcon({ kind, className }: { kind: string; className?: string }) {
  const Icon = ICON[kind] ?? File;
  return <Icon className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
}

/** One product: it eases in when it first appears, and glows a moment each time a step declares a newer version. */
function ProductCard({ product: p, nodes, active, onOpen }: { product: WorkProduct; nodes: Nodes; active: boolean; onOpen: () => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const f = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(f);
  }, []);
  const seen = useRef(p.versions);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (p.versions === seen.current) return;
    seen.current = p.versions;
    setFresh(true);
    const t = setTimeout(() => setFresh(false), 1500);
    return () => clearTimeout(t);
  }, [p.versions]);
  const draws = drawsOn(p.from, nodes);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={active}
      data-testid="work-product-card"
      data-id={p.id}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border bg-card p-3 text-left text-sm transition-all duration-500 hover:bg-muted/40",
        shown ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
        active && "border-primary/60 bg-muted/40",
        fresh && "ring-2 ring-primary/30",
      )}
    >
      <div className="flex items-start gap-2">
        <KindIcon kind={p.kind} className="mt-0.5" />
        <span className="min-w-0 flex-1 font-medium break-words">{p.title}</span>
        <Badge variant="outline" className="shrink-0 font-normal">{p.label ?? kindLabel(p.kind)}</Badge>
      </div>
      {p.summary && <p className="line-clamp-2 text-muted-foreground">{p.summary}</p>}
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-muted-foreground">
        <span className="truncate">by {madeBy(p)}</span>
        {draws && (
          <span className="flex items-center gap-1">
            <Network className="size-3" />
            {draws}
          </span>
        )}
        {p.versions > 1 && <span>v{p.versions}</span>}
      </div>
    </button>
  );
}

function ProductBody({ product, workflow, runId, renderers, intervalMs, onOpenNode }: WorkProductRendererProps & { renderers?: Partial<Record<string, WorkProductRenderer>>; intervalMs?: number; onOpenNode?: (refId: string) => void }) {
  // A newer version of a product is a newer file behind the same path: read it again.
  const qc = useQueryClient();
  useEffect(() => {
    if (product.versions < 2) return;
    for (const p of [product.path, product.render]) if (p) void qc.invalidateQueries({ queryKey: ["strut", "run/files", workflow, runId, relPath(p)] });
  }, [product.versions]);
  const own = renderers?.[product.kind];
  if (own) return <>{own({ product, workflow, runId })}</>;
  const v = productView(product);
  switch (v.view) {
    case "document":
      return <DocumentView workflow={workflow} runId={runId} path={v.path} kind={v.as} />;
    case "inline":
      return <DocumentView text={v.text} kind={v.as} />;
    case "file":
      return <ArtifactView workflow={workflow} runId={runId} path={v.path} />;
    case "timeline":
      return <TimelineView product={product} workflow={workflow} runId={runId} />;
    case "sheet":
      // Read again while the run writes it, and when a step declares a newer version.
      return (
        <SheetView
          {...(v.spreadsheet ? { spreadsheet: v.spreadsheet } : v.path ? { path: relPath(v.path) } : { rows: v.rows })}
          workflow={workflow}
          runId={runId}
          intervalMs={intervalMs}
          refresh={product.versions}
          sources={sourcesOf(product.content)}
          onOpenNode={onOpenNode && ((n) => onOpenNode(n.ref_id))}
        />
      );
    case "link":
      return <OpenLink url={v.url} />;
    default:
      return <p className="text-sm text-muted-foreground">Nothing to show for this product here.</p>;
  }
}

function OpenLink({ url }: { url: string }) {
  const host = useHost();
  return (
    <div className="flex items-center gap-3 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{url}</span>
      <Button variant="outline" size="sm" onClick={() => void host.openLink(url)}>
        <ExternalLink />
        Open
      </Button>
    </div>
  );
}

/** The product's text: the file `path` names, read through `run/files`, or — no path — its content. */
function useProductText(workflow: string, runId: string, path: string | undefined) {
  const inline = path === undefined;
  const file = useRunFile(inline ? "" : workflow, inline ? "" : runId, path ? relPath(path) : "");
  return { inline, file };
}

function TimelineView({ product, workflow, runId }: WorkProductRendererProps) {
  const { inline, file } = useProductText(workflow, runId, product.content !== undefined ? undefined : product.path ?? product.url);
  const entries = useMemo(() => parseTimeline(inline ? product.content : file.data?.text), [inline, product.content, file.data]);
  if (!inline && file.isPending) return <Skeleton className="h-32 w-full" />;
  if (!inline && file.isError) return <p className="text-sm text-destructive">{errorText(file.error)}</p>;
  if (!entries) return <p className="text-sm text-muted-foreground">Not a timeline.</p>;
  return (
    <ol className="flex flex-col gap-0 text-sm" data-testid="timeline">
      {entries.map((e) => (
        <li key={e.index} className="relative flex gap-3 border-l pb-4 pl-4 last:pb-0">
          <span className="absolute top-1.5 -left-[5px] size-2.5 rounded-full border-2 border-background bg-primary" />
          <time className="w-24 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{e.date}</time>
          <div className="min-w-0 flex-1">
            <div className="font-medium">{e.title}</div>
            {e.detail && <p className="text-muted-foreground">{e.detail}</p>}
            {e.sources.length > 0 && <p className="text-xs text-muted-foreground">{e.sources.length} source{e.sources.length === 1 ? "" : "s"}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The nodes a product was made from, named when they could be read. */
function MadeFrom({ from, nodes, onOpenNode }: { from: string[]; nodes: Nodes; onOpenNode?: (refId: string) => void }) {
  if (!from.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t pt-3 text-xs" data-testid="made-from">
      <span className="text-muted-foreground">Made from</span>
      {from.map((ref) => {
        const n = nodes?.get(ref);
        const node = n && !("error" in n) ? n : undefined;
        const chip = (
          <>
            <span className="inline-block size-2 shrink-0 rounded-full" style={{ backgroundColor: node ? nodeColor(node.node_type) : "currentColor" }} />
            <span className="max-w-48 truncate">{node?.name || ref.slice(0, 8)}</span>
            {node && <span className="text-muted-foreground">{node.node_type}</span>}
          </>
        );
        return onOpenNode ? (
          <button key={ref} type="button" onClick={() => onOpenNode(ref)} className="flex items-center gap-1 rounded-full border px-2 py-0.5 hover:bg-muted">
            {chip}
          </button>
        ) : (
          <span key={ref} className="flex items-center gap-1 rounded-full border px-2 py-0.5">{chip}</span>
        );
      })}
    </div>
  );
}
