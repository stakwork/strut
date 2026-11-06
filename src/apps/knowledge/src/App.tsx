// strut/knowledge (plans/knowledge-app.md): the org's knowledge — the
// Concept tree — in place of Hive's org graph view. The outline on the left
// (search at its top), the graph in the middle around the concept picked
// there, and the concept a click picks in a panel on the right. `?input=concept%3D<ref_id>` opens that concept, and every
// selection is reported back so the host's address bar follows it. Narrow
// (a phone, a side panel beside the page) the graph, the outline and the
// concept take the page in turn.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ListTree, Loader2, Network } from "lucide-react";
import { useAppLink, useAppState, useHost, useToolInput } from "@strut/kit";
import { NodeGraph, NodeSearch } from "strut/views";
import { cn } from "@/lib/utils";
import { useConceptTree } from "./lib/read";
import { opening, pathToRoot, rowKey, TREE_EDGE, type ConceptTree } from "./lib/tree";
import { Tree } from "./components/Tree";
import { Detail } from "./components/Detail";

/** The graph walks the tree's own edge only, so every node in it is a Concept. */
const GRAPH_EDGES = [TREE_EDGE];

/** Narrower than this, the tree and the concept take the page in turn. */
const NARROW = 768;

function useNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < NARROW);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < NARROW);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return narrow;
}

/** An element's height, followed — a callback ref, since the element mounts after the tree is read. */
function useHeight<T extends HTMLElement>() {
  const [h, setH] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    observer.current = new ResizeObserver(() => setH(el.clientHeight));
    observer.current.observe(el);
    setH(el.clientHeight);
  }, []);
  return [ref, h] as const;
}

/** Narrow, one at a time: the graph (the start), the outline, or a concept. */
type Page = "graph" | "tree" | "concept";

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 border-b px-4 py-1.5 text-xs text-muted-foreground">
      <AlertCircle className="size-3.5 shrink-0" />
      {children}
    </p>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-sm text-muted-foreground">{children}</div>;
}

export default function App() {
  const q = useConceptTree();
  const tree = q.data?.tree;
  const input = useToolInput<{ concept?: string }>();
  const host = useHost();
  const link = useAppLink();
  const narrow = useNarrow();

  /** The concept in the panel and the row it was picked on (a concept with two parents is two rows). */
  const [sel, setSel] = useState<{ id: string; key: string } | null>(null);
  /** The concept the graph is drawn around: a pick outside the graph moves it, a click inside it does not. */
  const [centre, setCentre] = useState<string | null>(null);
  /** Wide: the panel is open. */
  const [panel, setPanel] = useState(false);
  const [page, setPage] = useState<Page>("graph");
  const [missing, setMissing] = useState<string | null>(null);
  /** The open rows, remembered per viewer; null until the viewer first folds or opens one. */
  const [openList, setOpenList, openState] = useAppState<string[] | null>("open", null);
  const open = useMemo(() => new Set(openList ?? tree?.roots.map((r) => rowKey([r])) ?? []), [openList, tree]);
  const [searchKey, setSearchKey] = useState(0);

  const toggle = useCallback(
    (key: string) => {
      const next = new Set(open);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setOpenList([...next]);
    },
    [open, setOpenList],
  );

  /** Select `id`: reveal it in the tree (on `key`'s row, else its first path), and report it. */
  const select = useCallback(
    (t: ConceptTree, id: string, opts: { key?: string; from?: "graph" | "link" } = {}) => {
      if (!t.nodes[id]) return false;
      const path = opts.key ? opts.key.split("/") : pathToRoot(t, id) ?? [id];
      const key = rowKey(path);
      const above = opening(path).filter((k) => !open.has(k));
      if (above.length) setOpenList([...open, ...above]);
      setSel({ id, key });
      if (opts.from !== "graph") setCentre(id);
      setPanel(true);
      setPage("concept");
      setMissing(null);
      if (opts.from !== "link" && input?.concept !== id) {
        try {
          void host.openLink(link({ concept: id }));
        } catch {
          // No identity (a host's own client): nothing to report to.
        }
      }
      return true;
    },
    [open, setOpenList, host, link, input?.concept],
  );

  // A deep link opens its concept; with none, the graph round the first root (and, wide, the root in the panel).
  const linked = input?.concept;
  useEffect(() => {
    if (!tree || !openState.loaded) return;
    if (linked) {
      if (sel?.id === linked) return;
      if (!select(tree, linked, { from: "link" })) setMissing(linked);
      return;
    }
    const first = tree.roots[0] ?? tree.unplaced[0];
    if (!sel && first) {
      setSel({ id: first, key: rowKey([first]) });
      setCentre(first);
      setPanel(!narrow);
    }
    // Only a new link or a fresh tree moves the selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, linked, openState.loaded, narrow]);

  const onPath = useMemo(() => new Set(sel ? sel.key.split("/") : []), [sel]);
  const [graphRef, graphH] = useHeight<HTMLElement>();
  const count = tree ? Object.keys(tree.nodes).length : 0;

  const header = (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
      <h1 className="text-sm font-semibold">Knowledge</h1>
      {tree && <span className="text-xs tabular-nums text-muted-foreground">{count.toLocaleString()} concepts</span>}
      <span className="flex-1" />
      {q.isFetching && tree && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      {narrow && tree && count > 0 && page !== "concept" && (
        <button
          type="button"
          onClick={() => setPage(page === "tree" ? "graph" : "tree")}
          className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          data-testid="page-toggle"
        >
          {page === "tree" ? <Network className="size-3.5" /> : <ListTree className="size-3.5" />}
          {page === "tree" ? "Graph" : "Concepts"}
        </button>
      )}
    </header>
  );

  let body: React.ReactNode;
  if (q.isPending) {
    body = (
      <Centered>
        <Loader2 className="size-4 animate-spin" />
        Reading the graph…
      </Centered>
    );
  } else if (q.isError) {
    body = (
      <Centered>
        <p className="text-foreground">Couldn't read the graph.</p>
        <p className="max-w-lg text-xs">{q.error instanceof Error ? q.error.message : String(q.error)}</p>
      </Centered>
    );
  } else if (!count) {
    body = <Centered>No concepts in this graph yet.</Centered>;
  } else {
    const t = tree!;
    const showTree = !narrow || page === "tree";
    const showGraph = !narrow || page === "graph";
    const showPanel = !!sel && (narrow ? page === "concept" : panel);
    body = (
      <div className="flex min-h-0 flex-1">
        {showTree && (
          <aside className={cn("flex min-h-0 flex-col", narrow ? "w-full" : "w-72 shrink-0 border-r")} data-testid="tree-pane">
            <div className="relative shrink-0 border-b p-3">
              <NodeSearch
                key={searchKey}
                type="Concept"
                limit={8}
                placeholder="Search concepts…"
                className="[&>ul]:absolute [&>ul]:inset-x-3 [&>ul]:top-[calc(100%-0.25rem)] [&>ul]:z-20 [&>ul]:max-h-80 [&>ul]:overflow-auto [&>ul]:bg-popover [&>ul]:shadow-lg [&>p]:absolute [&>p]:inset-x-3 [&>p]:top-[calc(100%-0.25rem)] [&>p]:z-20 [&>p]:rounded-md [&>p]:border [&>p]:bg-popover [&>p]:px-3 [&>p]:py-2 [&>p]:shadow-lg"
                onSelect={(hit) => {
                  if (select(t, hit.ref_id)) setSearchKey((k) => k + 1);
                  else setMissing(hit.ref_id);
                }}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <Tree tree={t} open={open} onToggle={toggle} selectedKey={sel?.key ?? null} onPath={onPath} onSelect={(r) => select(t, r.id, { key: r.key })} />
            </div>
          </aside>
        )}
        {showGraph && (
          <main ref={graphRef} className="min-h-0 min-w-0 flex-1" data-testid="graph-pane">
            {centre ? (
              <NodeGraph
                refId={centre}
                edgeTypes={GRAPH_EDGES}
                selected={sel?.id ?? null}
                height={Math.max(320, graphH)}
                className="rounded-none border-0"
                onSelect={(n) => {
                  if (n.node_type === "Concept") select(t, n.ref_id, { from: "graph" });
                }}
              />
            ) : (
              <Centered>Pick a concept.</Centered>
            )}
          </main>
        )}
        {showPanel && (
          <section
            className={cn("min-h-0 overflow-y-auto", narrow ? "w-full" : "w-[26rem] max-w-[45%] shrink-0 border-l")}
            data-testid="concept-pane"
          >
            <Detail
              key={sel.id}
              id={sel.id}
              tree={t}
              path={sel.key.split("/")}
              narrow={narrow}
              onSelect={(id) => select(t, id)}
              onClose={() => {
                if (narrow) setPage("graph");
                else setPanel(false);
              }}
            />
          </section>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-background text-foreground" data-testid="knowledge">
      {header}
      {q.data?.truncated && <Notice>This graph is too big to read in full, so some concepts or links may be missing.</Notice>}
      {missing && <Notice>That concept isn't in the tree any more.</Notice>}
      {body}
    </div>
  );
}
