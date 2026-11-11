// strut/knowledge (plans/knowledge-app.md): everything the org knows, not
// only its Concepts. The sidebar is one search over every type and, under
// it, the ontology: each type and how many, opening its nodes (Concepts as
// the tree). The graph is the page, drawn round what was picked and
// following every link; "Types" over it ticks node types on and off. The
// picked node floats on the right, the trail back along the bottom.
// `?input=node%3D<ref_id>` (or the older `concept%3D`) opens that node, and
// every pick is reported back so the host's address bar follows it. Narrow
// (a phone, a side panel), the sidebar and the graph take the page in turn.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, ChevronRight, History, Loader2, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { useAppLink, useAppState, useHost, useToolInput } from "@strut/kit";
import { NodeGraph } from "strut/views";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useChanges, useClaimed, useConceptTree, useOntology, useSearch } from "./lib/read";
import { changesByConcept, waitingAcross } from "./lib/learning";
import { opening, pathToRoot, rowKey, TREE_TYPE } from "./lib/tree";
import { typePlural } from "./lib/ontology";
import { Tree } from "./components/Tree";
import { TypeList } from "./components/TypeList";
import { TypesMenu } from "./components/TypesMenu";
import { NodeDetail } from "./components/NodeDetail";
import { Changes } from "./components/Changes";
import { WaitingMenu } from "./components/WaitingMenu";
import { Dot, NodeRow, type Picked } from "./components/bits";

/** Narrower than this, the sidebar and the graph take the page in turn. */
const NARROW = 768;
/** The trail keeps this many steps. */
const TRAIL = 8;

function useNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < NARROW);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < NARROW);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return narrow;
}

/** An element's height, followed — a callback ref, since the element mounts after the graph is read. */
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

/** What the box says, once typing pauses. */
function useTyped(text: string) {
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  return q;
}

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
  const ontology = useOntology();
  const types = ontology.data ?? [];
  // The learning loop: the dream's changes waiting on a person, and the claims not held.
  const proposed = useChanges();
  const claimed = useClaimed();
  const proposedFor = useMemo(() => changesByConcept(proposed.data ?? [], tree), [proposed.data, tree]);
  const waiting = useMemo(() => (tree ? waitingAcross(tree, proposedFor, claimed.data ?? []) : []), [tree, proposedFor, claimed.data]);
  const input = useToolInput<{ node?: string; concept?: string }>();
  const host = useHost();
  const link = useAppLink();
  const narrow = useNarrow();

  const [railOpen, setRailOpen] = useState(!narrow);
  useEffect(() => setRailOpen(!narrow), [narrow]);

  const [text, setText] = useState("");
  const typed = useTyped(text);
  const search = useSearch(typed);
  const searching = typed.length > 1;
  const [only, setOnly] = useState<string | null>(null);
  const hits = useMemo(() => (search.data ?? []).filter((h) => !only || h.node_type === only), [search.data, only]);
  const hitTypes = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of search.data ?? []) m.set(h.node_type, (m.get(h.node_type) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [search.data]);

  /** The picked node (in the card) and the node the graph is drawn round: a pick on the graph moves only the first. */
  const [sel, setSel] = useState<Picked | null>(null);
  const [centre, setCentre] = useState<string | null>(null);
  const [trail, setTrail] = useState<Picked[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [wide, setWide] = useState(false);
  /** The card is open (closing it keeps the pick marked on the graph). */
  const [card, setCard] = useState(false);
  /** The changes view in place of the graph: the tree between two moments, from the history. */
  const [changes, setChanges] = useState(false);
  /** The type open in the sidebar. */
  const [openType, setOpenType] = useState<string | null>(TREE_TYPE);
  /** The open tree rows, remembered per viewer; null until the viewer first folds or opens one. */
  const [openList, setOpenList, openState] = useAppState<string[] | null>("open", null);
  const open = useMemo(() => new Set(openList ?? tree?.roots.map((r) => rowKey([r])) ?? []), [openList, tree]);
  const [graphRef, graphH] = useHeight<HTMLElement>();

  const toggleRow = useCallback(
    (key: string) => {
      const next = new Set(open);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setOpenList([...next]);
    },
    [open, setOpenList],
  );

  const linked = input?.node ?? input?.concept;

  /** Pick `n`: into the card, the graph round it (unless picked on the graph), the trail, revealed in the sidebar, reported. */
  const pick = useCallback(
    (n: Picked, opts: { from?: "graph" | "link"; quiet?: boolean } = {}) => {
      setSel(n);
      setChanges(false);
      if (!opts.quiet) setCard(true);
      if (opts.from !== "graph") setCentre(n.ref_id);
      setTrail((t) => (t[t.length - 1]?.ref_id === n.ref_id ? t : [...t.filter((x) => x.ref_id !== n.ref_id), n].slice(-TRAIL)));
      if (n.node_type) setOpenType(n.node_type);
      if (n.node_type === TREE_TYPE && tree) {
        const above = opening(pathToRoot(tree, n.ref_id) ?? [n.ref_id]).filter((k) => !open.has(k));
        if (above.length) setOpenList([...open, ...above]);
      }
      if (narrow && opts.from !== "graph") setRailOpen(false);
      if (opts.from !== "link" && linked !== n.ref_id) {
        try {
          void host.openLink(link({ node: n.ref_id }));
        } catch {
          // No identity (a host's own client): nothing to report to.
        }
      }
    },
    [tree, open, setOpenList, narrow, host, link, linked],
  );

  // A deep link opens its node (the card says so when it is gone); with none, the first root concept.
  useEffect(() => {
    if (!tree || !openState.loaded) return;
    if (linked) {
      if (sel?.ref_id === linked) return;
      const c = tree.nodes[linked];
      pick({ ref_id: linked, node_type: c ? TREE_TYPE : "", name: c?.name ?? "" }, { from: "link" });
      return;
    }
    const first = tree.roots[0] ?? tree.unplaced[0];
    // Narrow, the start opens on the graph: the card would take the page.
    if (!sel && first) pick({ ref_id: first, node_type: TREE_TYPE, name: tree.nodes[first]!.name }, { from: "link", quiet: narrow });
    // Only a new link or a fresh tree moves the selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, linked, openState.loaded]);

  const selPath = useMemo(() => (sel && tree?.nodes[sel.ref_id] ? (pathToRoot(tree, sel.ref_id) ?? [sel.ref_id]) : null), [sel, tree]);
  const selKey = selPath ? rowKey(selPath) : null;
  const onPath = useMemo(() => new Set(selPath ?? []), [selPath]);
  const total = types.reduce((n, t) => n + t.count, 0);

  const sidebar = (
    <aside className={cn("flex min-h-0 shrink-0 flex-col border-r", narrow ? "w-full" : "w-80")} data-testid="sidebar">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <h1 className="text-sm font-semibold">Knowledge</h1>
        {total > 0 && <span className="text-xs tabular-nums text-muted-foreground">{total.toLocaleString()} nodes</span>}
        <span className="flex-1" />
        {(q.isFetching || ontology.isFetching) && tree && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        <button type="button" aria-label="Hide the sidebar" onClick={() => setRailOpen(false)} className="rounded p-1 text-muted-foreground hover:text-foreground">
          <PanelLeftClose className="size-4" />
        </button>
      </header>
      <div className="relative shrink-0 border-b p-3">
        <Search className="absolute left-5 top-5 size-4 text-muted-foreground" />
        <Input className="pl-8" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search people, docs, concepts…" aria-label="Search everything" />
        {search.isFetching && <Loader2 className="absolute right-5 top-5 size-4 animate-spin text-muted-foreground" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {searching ? (
          <div className="space-y-2 p-2" data-testid="search-results">
            {search.isError && <p className="px-2 text-sm text-muted-foreground">Couldn't search the graph.</p>}
            {hitTypes.length > 1 && (
              <div className="flex flex-wrap gap-1.5 px-1 pt-1">
                <button type="button" onClick={() => setOnly(null)} className={cn("rounded-md border px-2 py-0.5 text-xs", !only && "border-primary/50 bg-primary/10")}>
                  All <span className="tabular-nums text-muted-foreground">{search.data?.length ?? 0}</span>
                </button>
                {hitTypes.map(([t, c]) => (
                  <button key={t} type="button" onClick={() => setOnly(only === t ? null : t)} className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs", only === t && "border-primary/50 bg-primary/10")}>
                    <Dot type={t} />
                    {t} <span className="tabular-nums text-muted-foreground">{c}</span>
                  </button>
                ))}
              </div>
            )}
            {search.data && !hits.length && <p className="px-2 text-sm text-muted-foreground">Nothing matches “{typed}”.</p>}
            {hits.map((h) => (
              <NodeRow key={h.ref_id} node={h} selected={sel?.ref_id === h.ref_id} onSelect={(n) => pick(n)} />
            ))}
          </div>
        ) : (
          <nav className="py-2" aria-label="Ontology" data-testid="ontology">
            <p className="px-4 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Ontology</p>
            {ontology.isPending && <p className="px-4 text-xs text-muted-foreground">Reading the ontology…</p>}
            {ontology.isError && <p className="px-4 text-xs text-muted-foreground">Couldn't read the ontology.</p>}
            {types.map((t) => {
              const isOpen = openType === t.type;
              return (
                <div key={t.type}>
                  <button
                    type="button"
                    onClick={() => setOpenType(isOpen ? null : t.type)}
                    aria-expanded={isOpen}
                    className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm hover:bg-muted/60"
                    title={t.description || undefined}
                    data-testid="ontology-type"
                  >
                    <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform duration-150", isOpen && "rotate-90")} />
                    <Dot type={t.type} />
                    <span className="flex-1 font-medium">{typePlural(t.type)}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{t.count.toLocaleString()}</span>
                  </button>
                  {isOpen &&
                    (t.type === TREE_TYPE && tree ? (
                      <div className="pl-3">
                        <Tree
                          tree={tree}
                          open={open}
                          onToggle={toggleRow}
                          selectedKey={selKey}
                          onPath={onPath}
                          onSelect={(r) => pick({ ref_id: r.id, node_type: TREE_TYPE, name: tree.nodes[r.id]!.name })}
                        />
                      </div>
                    ) : (
                      <TypeList type={t.type} selected={sel?.ref_id ?? null} onSelect={(n) => pick(n)} />
                    ))}
                </div>
              );
            })}
          </nav>
        )}
      </div>
    </aside>
  );

  const showRail = !railOpen && (
    <button type="button" aria-label="Show the sidebar" onClick={() => setRailOpen(true)} className="flex h-9 items-center rounded-md border bg-background/95 px-2 text-muted-foreground shadow hover:text-foreground">
      <PanelLeftOpen className="size-4" />
    </button>
  );

  let canvas: React.ReactNode;
  if (changes) {
    canvas = <Changes tree={tree} narrow={narrow} onClose={() => setChanges(false)} lead={showRail} />;
  } else if (q.isPending) {
    canvas = (
      <Centered>
        <Loader2 className="size-4 animate-spin" />
        Reading the graph…
      </Centered>
    );
  } else if (q.isError) {
    canvas = (
      <Centered>
        <p className="text-foreground">Couldn't read the graph.</p>
        <p className="max-w-lg text-xs">{q.error instanceof Error ? q.error.message : String(q.error)}</p>
      </Centered>
    );
  } else if (!centre) {
    canvas = <Centered>{total ? "Pick something in the sidebar to start." : "Nothing in this graph yet."}</Centered>;
  } else {
    canvas = (
      <NodeGraph
        refId={centre}
        hiddenTypes={hidden}
        selected={sel?.ref_id ?? null}
        height={Math.max(320, graphH)}
        className="rounded-none border-0"
        onSelect={(n) => pick(n, { from: "graph" })}
      />
    );
  }

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-background text-foreground" data-testid="knowledge">
      {q.data?.truncated && <Notice>This graph is too big to read in full, so some concepts or links may be missing.</Notice>}
      <div className="flex min-h-0 flex-1">
        {railOpen && sidebar}
        {(!narrow || !railOpen) && (
          <main ref={graphRef} className="relative min-h-0 min-w-0 flex-1" data-testid="graph-pane">
            {canvas}

            {!changes && (
              <div className="absolute left-3 top-3 z-20 flex items-center gap-2">
                {showRail}
                {types.length > 1 && centre && <TypesMenu types={types} hidden={hidden} onHidden={setHidden} />}
                {tree && waiting.length > 0 && <WaitingMenu waiting={waiting} onOpen={(w) => pick({ ref_id: w.id, node_type: TREE_TYPE, name: w.name })} />}
                <button
                  type="button"
                  onClick={() => setChanges(true)}
                  className="flex h-9 items-center gap-1.5 rounded-md border bg-background/95 px-2.5 text-sm text-muted-foreground shadow hover:text-foreground"
                  title="What changed in the Concept tree, between two moments"
                  data-testid="open-changes"
                >
                  <History className="size-4" />
                  Changes
                </button>
              </div>
            )}

            {!changes && trail.length > 1 && (
              <div className="absolute bottom-3 left-1/2 z-10 flex max-w-[70%] -translate-x-1/2 items-center gap-2 rounded-lg border bg-background/95 px-2 py-1.5 text-xs shadow-lg backdrop-blur" data-testid="trail">
                <button
                  type="button"
                  aria-label="Back"
                  onClick={() => {
                    const prev = trail[trail.length - 2]!;
                    setTrail(trail.slice(0, -1));
                    setSel(prev);
                    setCentre(prev.ref_id);
                  }}
                  className="rounded p-1 text-muted-foreground hover:text-foreground"
                >
                  <ArrowLeft className="size-3.5" />
                </button>
                <div className="flex min-w-0 items-center gap-1 overflow-hidden text-muted-foreground">
                  {trail.map((t, i) => (
                    <span key={t.ref_id} className="flex min-w-0 items-center gap-1">
                      {i > 0 && <span>›</span>}
                      <button type="button" onClick={() => pick(t)} className={cn("inline-flex min-w-0 items-center gap-1 truncate hover:text-foreground", i === trail.length - 1 && "text-foreground")}>
                        {t.node_type && <Dot type={t.node_type} />}
                        {t.name || t.ref_id.slice(0, 8)}
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {!changes && sel && card && (
              <section
                className={cn(
                  "absolute z-30 flex flex-col overflow-hidden bg-background",
                  // Narrow, the card takes the page (Back returns to the graph); wide, it floats beside it.
                  narrow ? "inset-0" : cn("right-3 top-3 max-h-[calc(100%-4.5rem)] max-w-[60%] rounded-lg border bg-background/95 shadow-lg backdrop-blur", wide ? "w-[30rem]" : "w-80"),
                )}
                data-testid="node-pane"
              >
                <div className="min-h-0 overflow-y-auto">
                  <NodeDetail
                    key={sel.ref_id}
                    id={sel.ref_id}
                    tree={tree}
                    path={selPath ?? undefined}
                    wide={wide || narrow}
                    onWide={setWide}
                    narrow={narrow}
                    onSelect={(n) => pick(n)}
                    onClose={() => setCard(false)}
                    changes={proposedFor.get(sel.ref_id)}
                  />
                </div>
              </section>
            )}
          </main>
        )}
      </div>
    </div>
  );
}
