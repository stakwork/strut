import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { searchWorkflows } from "../../../src/search.js";
import * as api from "../api";
import { formatBytes } from "../attachments";
import { errorMessage } from "../helpers";
import { GAME_ALLOW, GAME_SANDBOX, declaredAllow } from "../frame-permissions";
import { load, remove, save } from "../storage";
import { ArrowRightIcon, ChevronRightIcon, SearchIcon } from "../icons";
import { appsOf, canWords, conceptChildren, conceptRoots, installLink, liveAppUrl, liveBase, normalizeStrutUrl, parseStoreView, shortKey, storeQuery, type InstallLink, type LiveKind, type StoreView } from "../store-links";
import { CopyButton } from "./CopyButton";
import { Markdown } from "./Markdown";
import { shortDigest } from "./PackagesPanel";
import { ConfigField } from "./ConfigField";
import { PaymentSheet } from "./PaymentSheet";
import { callPaying, formatSats, formatUsd, type ClaimEnd, type PayOutcome, type PaymentRequired } from "../visitor-pay";
import { bodyOf, errorOf, httpCallResult, inputOf, newLaunchKey, priceBadge, priceNotes, priceWords, runEnded, runFields, runFileUrl, type LaunchedRun, type LiveRunnableItem } from "../store-run";
import { payWith, storePurse } from "../store-purse";
import { remoteAppHref } from "../remote-app";

// ── The store front (plans/marketplace.md §7) ───────────────────────────────
//
// `?store=1`: the public face of an INDEX strut, for anyone, with no
// credential — the apps across the publishers it lists first, then the
// packages, the Concept pages as a wiki, the publishers off the signed
// card. Everything on it is DERIVED (src/packages/index.ts reads each
// release's archive at the crawl, src/packages/detail.ts) and nothing on it
// is trusted by an install: "Install" is a link into the visitor's OWN strut
// (`?install=<name>`, store-links.ts), whose Publish dialog (Packages tab) re-verifies
// the package against the publisher's own catalog. The visitor names their
// strut once ("Your strut", kept in this browser); without one the button
// shows the name to paste. On a strut that is not an index the page says
// so. Rendered alone, in place of the shell (app.tsx), so none of the
// shell's loads run behind it.
//
// LIVE items (plans/public-surface.md §8): an index row may name where a
// publisher server's PUBLIC VIEW is served. The index lists what each view
// shows (`/index/live`); the item itself is read from the publisher, in the
// visitor's browser, with no credential — an app framed from its server
// (`?app=&solo=1&public=1`), a workflow, step or Concept page drawn here from
// its `/public` JSON. Nothing to install: it is the publisher's, live.
//
// A live workflow or step that anyone may RUN (plans/paid-runs.md §10 "The
// store") shows its price, what recent runs were charged, and a Run form
// drawn from its input (`RunPanel`). The run happens on the publisher's
// server, launched from this browser with no credential of anyone's; a
// priced one is paid here — the invoice as a QR code, claimed until it
// settles even after the sheet closes (../store-purse), the credit kept per
// server in this page's sessionStorage, never in a URL.

const TARGET_KEY = "store.strut";

function useView(): [StoreView, (v: StoreView) => void] {
  const [view, setView] = useState<StoreView>(() => parseStoreView(location.search));
  useEffect(() => {
    const onPop = () => setView(parseStoreView(location.search));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const go = (v: StoreView) => {
    history.pushState(null, "", `${location.pathname}${storeQuery(v)}`);
    setView(v);
    scrollTo(0, 0);
  };
  return [view, go];
}

export function Store() {
  const [view, go] = useView();
  // undefined: loading; null: not an index (or unreachable), `cardError` says why.
  const [card, setCard] = useState<api.IndexCard | null | undefined>(undefined);
  const [cardError, setCardError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(() => load<string | null>(TARGET_KEY, null));
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api.storeCatalog().then(setCard, (err) => {
      setCard(null);
      setCardError(errorMessage(err));
    });
  }, []);
  useEffect(() => {
    document.title =
      view.view === "package" ? `${view.pkg} · strut store`
      : view.view === "concept" ? `${view.concept || "Concepts"} · strut store`
      : view.view === "live" ? `${view.name} · ${view.publisher} · strut store`
      : "strut store";
  }, [view]);
  // "/" puts the cursor in the search box, from anywhere but another field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      search.current?.focus();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  const setStrut = (url: string | null) => {
    if (url) save(TARGET_KEY, url);
    else remove(TARGET_KEY);
    setTarget(url);
  };
  const index = card ? { key: card.key, url: api.storeCatalogUrl(card) } : undefined;
  const link = (pkg: string): InstallLink => (index ? { pkg, index } : { pkg });

  return (
    <div class="store">
      <header class="store-top">
        <button class="store-brand" onClick={() => go({ view: "browse" })} title="The store">
          <span class="brand-dot" /> strut <span class="store-brand-sub">store</span>
        </button>
        <nav class="store-nav">
          <button class={`store-nav-link${view.view === "browse" || view.view === "package" || view.view === "live" ? " is-active" : ""}`} onClick={() => go({ view: "browse" })}>Apps & packages</button>
          <button class={`store-nav-link${view.view === "concept" ? " is-active" : ""}`} onClick={() => go({ view: "concept", concept: "" })} title="The knowledge the listed packages carry">Concepts</button>
        </nav>
        <form
          class="store-search"
          onSubmit={(e) => {
            e.preventDefault();
            const q = (new FormData(e.currentTarget as HTMLFormElement).get("q") as string) ?? "";
            go(q.trim() ? { view: "browse", q: q.trim() } : { view: "browse" });
          }}
        >
          <SearchIcon size={14} />
          <input ref={search} name="q" type="search" placeholder="Search packages and concepts" defaultValue={view.view === "browse" ? view.q ?? "" : ""} key={view.view === "browse" ? view.q ?? "" : "x"} aria-label="Search packages and concepts" />
          <kbd title="Press / to search">/</kbd>
        </form>
        <YourStrut target={target} onChange={setStrut} />
      </header>

      <main class="store-main">
        {card === null && (
          <div class="store-empty">
            <div class="store-empty-title">Not a store</div>
            <div class="auto-hint">{cardError ?? "This strut is not an index."}</div>
          </div>
        )}
        {card !== null && view.view === "browse" && <Browse q={view.q} card={card} go={go} />}
        {card !== null && view.view === "package" && <PackagePage pkg={view.pkg} target={target} link={link} go={go} onNeedStrut={setStrut} />}
        {card !== null && view.view === "concept" && <ConceptView name={view.concept} target={target} link={link} go={go} onNeedStrut={setStrut} />}
        {card !== null && view.view === "live" && <LivePage publisher={view.publisher} kind={view.kind} name={view.name} card={card} go={go} target={target} onNeedStrut={setStrut} />}
      </main>

      <footer class="store-foot">
        <span>Everything here is derived from publishers' signed catalogs and archives. An install re-verifies against the publisher, never against this page.</span>
        <span class="store-foot-meta">
          {card && (
            <span title={card.key}>
              index <code>{shortKey(card.key)}</code> · seq {card.seq}
            </span>
          )}
          <a href="llms.txt">llms.txt</a>
          <span>
            MCP <code>/index/mcp</code>
          </span>
        </span>
      </footer>
    </div>
  );
}

/** Where the visitor's strut is: set once, kept in this browser. */
function YourStrut(props: { target: string | null; onChange: (url: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.target ?? "");
  const [bad, setBad] = useState(false);
  const keep = () => {
    const url = normalizeStrutUrl(draft);
    if (!url) return setBad(true);
    props.onChange(url);
    setEditing(false);
    setBad(false);
  };
  if (!editing) {
    return (
      <button class={`store-strut${props.target ? " is-set" : ""}`} onClick={() => { setDraft(props.target ?? ""); setEditing(true); }} title={props.target ? `Install opens ${props.target}` : "Name your strut server once: Install then opens it"}>
        <span class="store-strut-dot" />
        {props.target ? props.target.replace(/^https?:\/\//, "") : "Your strut server"}
      </button>
    );
  }
  return (
    <form class="store-strut-form" onSubmit={(e) => { e.preventDefault(); keep(); }}>
      <input type="text" value={draft} placeholder="http://localhost:3000" onInput={(e) => { setDraft((e.target as HTMLInputElement).value); setBad(false); }} aria-label="Your strut's address" autoFocus />
      <button class="btn btn-sm btn-primary" type="submit">Keep</button>
      {props.target && <button class="btn btn-sm" type="button" onClick={() => { props.onChange(null); setEditing(false); }}>Forget</button>}
      <button class="btn btn-sm" type="button" onClick={() => setEditing(false)}>Cancel</button>
      {bad && <span class="auto-error">Not an address.</span>}
    </form>
  );
}

/** "Install into your strut": the link out, or the name to paste. */
function InstallButton(props: { pkg: string; target: string | null; link: (pkg: string) => InstallLink; onNeedStrut: (url: string | null) => void; big?: boolean }) {
  const [asking, setAsking] = useState(false);
  const [draft, setDraft] = useState("");
  const open = (url: string) => {
    location.href = installLink(url, props.link(props.pkg));
  };
  if (props.target && !asking) {
    return (
      <a class={`btn btn-primary${props.big ? " btn-lg" : " btn-sm"}`} href={installLink(props.target, props.link(props.pkg))} title={`Opens ${props.target} on this package. The install is checked there against the publisher's own catalog.`}>
        Install into your strut server
      </a>
    );
  }
  return (
    <div class="store-install-ask">
      {!asking ? (
        <button class={`btn btn-primary${props.big ? " btn-lg" : " btn-sm"}`} onClick={() => setAsking(true)}>Install into your strut server</button>
      ) : (
        <form class="store-strut-form" onSubmit={(e) => { e.preventDefault(); const url = normalizeStrutUrl(draft); if (url) { props.onNeedStrut(url); open(url); } }}>
          <input type="text" value={draft} placeholder="Where is your strut server? http://localhost:3000" onInput={(e) => setDraft((e.target as HTMLInputElement).value)} aria-label="Your strut server's address" autoFocus />
          <button class="btn btn-sm btn-primary" type="submit" disabled={!normalizeStrutUrl(draft)}>Open</button>
          <button class="btn btn-sm" type="button" onClick={() => setAsking(false)}>Cancel</button>
        </form>
      )}
      <div class="store-paste">
        Or find <code>{props.pkg}</code> <CopyButton value={props.pkg} label="Copy the package name" /> in your strut server's Publish dialog, on the Packages tab.
      </div>
    </div>
  );
}

function CanChips(props: { can: api.PackageCan; title?: string }) {
  return (
    <span class="store-can" title={props.title ?? "What running it reaches: spends = a model is called; acts = a step changes something outside the run; code = TypeScript runs in your strut server; reads = none of those"}>
      {canWords(props.can).map((w) => <span key={w} class={`badge store-can-${w}`}>{w}</span>)}
    </span>
  );
}

function AppTile(props: { app: { name: string; title: string; icon?: string } }) {
  const initials = props.app.title.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return <span class="store-app-tile" title={props.app.icon ? `icon: ${props.app.icon}` : undefined}>{initials}</span>;
}

/** While a read is out: the shape of what comes, never a bare word. */
function Loading() {
  return <div class="store-skel" role="status" aria-label="Loading"><span /><span /><span /></div>;
}

function SectionHead(props: { title: string; count?: number; children?: ComponentChildren }) {
  return (
    <div class="store-section-head">
      <h2>{props.title}{props.count !== undefined && <span class="store-count">{props.count}</span>}</h2>
      {props.children}
    </div>
  );
}

/** One number of a stat strip; with `onClick`, a jump to what it counts. */
function Stat(props: { n: number | undefined; label: string; onClick?: () => void }) {
  const body = (
    <>
      <span class="store-stat-n">{props.n === undefined ? "–" : props.n.toLocaleString()}</span>
      <span class="store-stat-l">{props.label}</span>
    </>
  );
  return props.onClick ? <button class="store-stat" onClick={props.onClick}>{body}</button> : <div class="store-stat">{body}</div>;
}

// ── Concepts, as rows and as a tree ─────────────────────────────────────────

type ConceptLine = { name: string; description?: string };
type TreeConcept = ConceptLine & { parents?: readonly string[] };
const LIST_CAP = 24;

/** A page: its name, and as much of its description as the line holds. */
function ConceptRow(props: { c: ConceptLine; go: (v: StoreView) => void }) {
  return (
    <button class="store-node-link" onClick={() => props.go({ view: "concept", concept: props.c.name })} title={props.c.description}>
      <span class="store-node-name">{props.c.name}</span>
      {props.c.description && <span class="store-node-desc">{props.c.description}</span>}
    </button>
  );
}

/** Pages as rows, the first `LIST_CAP`; the rest behind one button. */
function ConceptList(props: { items: readonly ConceptLine[]; go: (v: StoreView) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? props.items : props.items.slice(0, LIST_CAP);
  return (
    <div class="store-nodes">
      {shown.map((c) => <ConceptRow key={c.name} c={c} go={props.go} />)}
      {shown.length < props.items.length && <button class="store-more" onClick={() => setAll(true)}>Show all {props.items.length}</button>}
    </div>
  );
}

/** One page of the tree: a leaf opens its page; a branch opens in place,
 *  its own page a click away. Children are drawn only once it is open. */
function TreeNode(props: { c: TreeConcept; kids: Map<string, TreeConcept[]>; go: (v: StoreView) => void; count?: number; open?: boolean; path: readonly string[] }) {
  // A page already on the way down is not drawn again under itself.
  const children = (props.kids.get(props.c.name) ?? []).filter((k) => !props.path.includes(k.name));
  const [open, setOpen] = useState(!!props.open);
  if (children.length === 0) return <div class="store-node"><ConceptRow c={props.c} go={props.go} /></div>;
  return (
    <div class={`store-node is-branch${open ? " is-open" : ""}`}>
      <div class="store-node-row">
        <button class="store-node-link" onClick={() => setOpen(!open)} aria-expanded={open} title={props.c.description}>
          <ChevronRightIcon size={14} class="store-node-chev" />
          <span class="store-node-name">{props.c.name}</span>
          <span class="store-count">{props.count ?? children.length}</span>
          {props.c.description && <span class="store-node-desc">{props.c.description}</span>}
        </button>
        <button class="store-node-open" onClick={() => props.go({ view: "concept", concept: props.c.name })} title={`Read ${props.c.name}`}>Read <ArrowRightIcon size={12} /></button>
      </div>
      {open && (
        <div class="store-node-kids">
          {children.map((k) => <TreeNode key={k.name} c={k} kids={props.kids} go={props.go} path={[...props.path, props.c.name]} />)}
        </div>
      )}
    </div>
  );
}

/** Concept pages as the tree their parents declare, a level at a time, with
 *  a filter over all of them: 750 pages are four rows until one is opened. */
function ConceptTree(props: { concepts: TreeConcept[]; go: (v: StoreView) => void; open?: boolean }) {
  const [q, setQ] = useState("");
  const roots = useMemo(() => conceptRoots(props.concepts), [props.concepts]);
  const kids = useMemo(() => conceptChildren(props.concepts), [props.concepts]);
  const found = useMemo(() => (q.trim() ? searchWorkflows(props.concepts, q) : null), [props.concepts, q]);
  return (
    <div class="store-tree">
      {props.concepts.length > 12 && (
        <label class="store-filter">
          <SearchIcon size={13} />
          <input type="search" value={q} placeholder={`Filter ${props.concepts.length.toLocaleString()} concepts`} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Filter concepts" />
          {found && <span class="store-count">{found.length}</span>}
        </label>
      )}
      {found ? (
        found.length ? <ConceptList key={q} items={found} go={props.go} /> : <div class="auto-hint">No concept matches “{q.trim()}”.</div>
      ) : (
        <div class="store-nodes">
          {roots.map(({ root, pages }) => <TreeNode key={root.name} c={root} kids={kids} go={props.go} count={pages} open={props.open} path={[]} />)}
        </div>
      )}
    </div>
  );
}

// ── Browse ──────────────────────────────────────────────────────────────────

function Browse(props: { q?: string; card: api.IndexCard | undefined; go: (v: StoreView) => void }) {
  const [hits, setHits] = useState<api.StoreHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Every Concept page; with a search, the pages that match it.
  const [concepts, setConcepts] = useState<api.StoreConcept[] | null>(null);
  const [live, setLive] = useState<api.StoreLiveItem[]>([]);
  useEffect(() => {
    setHits(null);
    setConcepts(null);
    setError(null);
    api.storeSearch(props.q ?? "").then(setHits, (err) => setError(errorMessage(err)));
    api.storeConcepts(props.q ?? "").then(setConcepts, () => setConcepts([]));
    api.storeLive(props.q ?? "").then(setLive, () => setLive([]));
  }, [props.q]);
  const liveApps = live.filter((i) => i.kind === "app");
  const liveFlows = live.filter((i) => i.kind === "workflow" || i.kind === "step");
  const apps = useMemo(() => (hits ? appsOf(hits) : []), [hits]);
  const roots = useMemo(() => (concepts && !props.q ? conceptRoots(concepts) : []), [concepts, props.q]);
  const publishers = Object.entries(props.card?.publishers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const count = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
  const mcp = api.storeCatalogUrl(props.card ?? null).replace(/\/index\/catalog$/, "/index/mcp");
  const add = `claude mcp add --transport http strut-store ${mcp}`;
  return (
    <>
      {!props.q && (
        <section class="store-hero">
          <div class="store-eyebrow"><span class="store-pulse" /> Signed package index</div>
          <h1>Apps, workflows and knowledge <span class="store-grad">for your strut server</span></h1>
          <div class="store-stats">
            <Stat n={hits ? apps.length : undefined} label={apps.length === 1 ? "App" : "Apps"} />
            <Stat n={hits?.length} label={hits?.length === 1 ? "Package" : "Packages"} />
            <Stat n={concepts?.length} label={concepts?.length === 1 ? "Concept" : "Concepts"} onClick={() => props.go({ view: "concept", concept: "" })} />
            <Stat n={props.card ? publishers.length : undefined} label={publishers.length === 1 ? "Publisher" : "Publishers"} />
          </div>
        </section>
      )}
      {props.q && (
        <div class="store-results-head">
          <h1>Results for “{props.q}”</h1>
          <button class="auto-link" onClick={() => props.go({ view: "browse" })}>Clear</button>
        </div>
      )}
      {error && <div class="auto-error">{error}</div>}
      {hits === null && !error && <Loading />}

      {liveApps.length > 0 && (
        <section>
          <SectionHead title="Live apps" />
          <div class="store-grid">
            {liveApps.map((a) => (
              <button class="store-card" key={`${a.publisher}/${a.name}`} onClick={() => props.go({ view: "live", publisher: a.publisher, kind: "app", name: a.name })}>
                <div class="store-card-head">
                  <AppTile app={{ name: a.name, title: a.title ?? a.name }} />
                  <div class="store-card-title">
                    <span class="store-card-name">{a.title ?? a.name}</span>
                    <span class="auto-meta">{a.publisher} · live {a.version}</span>
                  </div>
                </div>
                {a.description && <div class="store-card-desc">{a.description}</div>}
                <div class="store-card-foot"><span class="store-card-go">Open <ArrowRightIcon size={13} /></span></div>
              </button>
            ))}
          </div>
        </section>
      )}

      {liveFlows.length > 0 && (
        <section>
          <SectionHead title="Live workflows and steps" />
          <div class="store-lines">
            {liveFlows.map((i) => (
              <button class="store-line" key={`${i.publisher}/${i.kind}/${i.name}`} onClick={() => props.go({ view: "live", publisher: i.publisher, kind: i.kind as LiveKind, name: i.name })}>
                <span class="store-line-main">
                  <span class="store-line-title">
                    <span class="package-name">{i.name}</span>
                    <span class="badge">{i.kind}</span>
                    {i.run && (
                      <span class="badge badge-accent" title={`Anyone may run it there: ${priceWords({ kind: i.kind === "step" ? "step" : "workflow", ...i.run })}`}>
                        run · {priceBadge(i.run)}
                      </span>
                    )}
                    {i.runs && <span class="badge" title="Its runs are public too">with runs</span>}
                    <span class="auto-meta">{i.publisher}</span>
                  </span>
                  {i.description && <span class="store-line-desc">{i.description}</span>}
                </span>
                <ArrowRightIcon size={14} class="store-line-go" />
              </button>
            ))}
          </div>
        </section>
      )}

      {hits && apps.length > 0 && (
        <section>
          <SectionHead title="Apps" count={apps.length} />
          <div class="store-grid">
            {apps.map(({ pkg, version, app }) => (
              <button class="store-card" key={`${pkg}/${app.name}`} onClick={() => props.go({ view: "package", pkg })}>
                <div class="store-card-head">
                  <AppTile app={app} />
                  <div class="store-card-title">
                    <span class="store-card-name">{app.title}</span>
                    <span class="auto-meta"><code>{pkg}</code> {version}</span>
                  </div>
                </div>
                {app.description && <div class="store-card-desc">{app.description}</div>}
                <div class="store-card-foot">
                  <CanChips can={app.can} />
                  <span class="store-card-go">View <ArrowRightIcon size={13} /></span>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {hits && (
        <section>
          <SectionHead title="Packages" count={hits.length} />
          {hits.length === 0 && <div class="auto-hint">{props.q ? "No package matches." : "Nothing listed yet: the index has no publisher rows, or none has made a package public."}</div>}
          {hits.length > 0 && <div class="store-lines">
            {hits.map((h) => (
              <button class="store-line" key={h.package} onClick={() => props.go({ view: "package", pkg: h.package })}>
                <span class="store-line-main">
                  <span class="store-line-title">
                    <span class="package-name">{h.package}</span>
                    <span class="package-version">{h.version}</span>
                    {h.license && <span class="badge">{h.license}</span>}
                    {h.detail && <CanChips can={h.detail.can} />}
                  </span>
                  {h.description && <span class="store-line-desc">{h.description}</span>}
                  <span class="store-line-meta">
                    {h.detail
                      ? [count(h.detail.apps.length, "app"), count(h.detail.workflows, "workflow"), count(h.detail.steps, "tool"), count(h.detail.concepts, "concept")].map((t) => <span key={t}>{t}</span>)
                      : <span>archive not read yet</span>}
                    {h.detail?.secrets.length ? <span title={h.detail.secrets.join(", ")}>needs {count(h.detail.secrets.length, "secret")}</span> : null}
                  </span>
                </span>
                <ArrowRightIcon size={14} class="store-line-go" />
              </button>
            ))}
          </div>}
        </section>
      )}

      {props.q && concepts && concepts.length > 0 && (
        <section>
          <SectionHead title="Concepts" count={concepts.length} />
          <ConceptList key={props.q} items={concepts} go={props.go} />
        </section>
      )}

      {!props.q && roots.length > 0 && (
        <section>
          <SectionHead title="Knowledge">
            <button class="auto-link store-section-link" onClick={() => props.go({ view: "concept", concept: "" })}>Browse the tree <ArrowRightIcon size={12} /></button>
          </SectionHead>
          <div class="store-grid">
            {roots.map(({ root, pages }) => (
              <button class="store-card store-root" key={root.name} onClick={() => props.go({ view: "concept", concept: root.name })}>
                <span class="store-card-name">{root.name}</span>
                {root.description && <span class="store-card-desc">{root.description}</span>}
                <span class="store-card-foot">
                  <span class="auto-meta">{pages > 0 ? `${count(pages, "page")} under it` : "One page"}</span>
                  <span class="store-card-go">Read <ArrowRightIcon size={13} /></span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {!props.q && publishers.length > 0 && (
        <section>
          <SectionHead title="Publishers" count={publishers.length} />
          <div class="store-lines">
            {publishers.map(([prefix, row]) => (
              <div class="store-line is-static" key={prefix}>
                <span class="store-line-main">
                  <span class="store-line-title">
                    <span class="package-name">{prefix}</span>
                    {row.url && <a href={row.url} target="_blank" rel="noopener noreferrer" class="auto-link">{row.url.replace(/^https?:\/\//, "")}</a>}
                  </span>
                  {row.description && <span class="store-line-desc">{row.description}</span>}
                </span>
                <span class="store-key" title={row.key}>
                  <code>{shortKey(row.key)}</code> <CopyButton value={row.key} label="Copy the publisher's key" />
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {!props.q && props.card && (
        <section class="store-agents">
          <div class="store-agents-text">
            <h2>For agents</h2>
            <p>The same catalog as three read tools over MCP, and as one page at <a href="llms.txt">llms.txt</a>. Installing stays a person's decision.</p>
          </div>
          <div class="store-cmd">
            <span class="store-cmd-prompt">$</span>
            <code>{add}</code>
            <CopyButton value={add} label="Copy the command" />
          </div>
        </section>
      )}
    </>
  );
}

// ── A package ───────────────────────────────────────────────────────────────

function PackagePage(props: { pkg: string; target: string | null; link: (pkg: string) => InstallLink; go: (v: StoreView) => void; onNeedStrut: (url: string | null) => void }) {
  const [page, setPage] = useState<api.StorePackage | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPage(undefined);
    setError(null);
    api.storePackage(props.pkg).then(setPage, (err) => { setPage(null); setError(errorMessage(err)); });
  }, [props.pkg]);
  if (page === undefined) return <Loading />;
  if (!page) return <div class="store-empty"><div class="store-empty-title">{props.pkg}</div><div class="auto-error">{error}</div></div>;
  const d = page.detail;
  const newest = page.releases.find((r) => !r.yanked);
  const held = (digest: string) => Object.entries(page.channels).filter(([, dg]) => dg === digest).map(([ch]) => ch);
  const [publisher, name] = props.pkg.split("/");
  const steps = d?.steps.filter((s) => !s.helper).length ?? 0;
  const jump = (id: string) => () => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const n = (count: number, w: string) => `${count} ${w}${count === 1 ? "" : "s"}`;
  return (
    <article class="store-package">
      <nav class="store-crumbs">
        <button class="auto-link" onClick={() => props.go({ view: "browse" })}>Packages</button>
        <span>/</span>
        <button class="auto-link" onClick={() => props.go({ view: "browse", q: publisher! })}>{publisher}</button>
        <span>/</span>
        <span>{name}</span>
      </nav>
      <header class="store-package-head">
        <div class="store-package-title">
          <h1><span class="store-dim">{publisher}/</span>{name}</h1>
          {page.description && <p class="store-package-desc">{page.description}</p>}
          <div class="store-package-chips">
            {newest && <span class="badge badge-accent">{newest.version}{held(newest.digest).length ? ` · ${held(newest.digest).join(", ")}` : ""}</span>}
            {newest?.license && <span class="badge">{newest.license}</span>}
            {d && <CanChips can={d.can} />}
            {newest && <code class="package-digest" title={newest.digest}>{shortDigest(newest.digest)}</code>}
          </div>
        </div>
        <div class="store-package-install">
          <InstallButton pkg={props.pkg} target={props.target} link={props.link} onNeedStrut={props.onNeedStrut} big />
        </div>
      </header>

      {d && (
        <div class="store-stats">
          <Stat n={d.apps.length} label={d.apps.length === 1 ? "App" : "Apps"} onClick={d.apps.length ? jump("store-apps") : undefined} />
          <Stat n={d.workflows.length} label={d.workflows.length === 1 ? "Workflow" : "Workflows"} onClick={d.workflows.length ? jump("store-workflows") : undefined} />
          <Stat n={steps} label={steps === 1 ? "Tool" : "Tools"} onClick={d.steps.length ? jump("store-steps") : undefined} />
          <Stat n={d.concepts.length} label={d.concepts.length === 1 ? "Concept" : "Concepts"} onClick={d.concepts.length ? jump("store-concepts") : undefined} />
        </div>
      )}

      <div class="store-package-body">
        <div class="store-package-main">
          {!d && <div class="auto-hint">{page.detailError ?? "The archive has not been read yet; what it holds shows once the index has."}</div>}
          {d && d.apps.length > 0 && (
            <section id="store-apps">
              <SectionHead title="Apps" count={d.apps.length} />
              <div class="store-grid">
                {d.apps.map((a) => (
                  <div class="store-card is-static" key={a.name}>
                    <div class="store-card-head">
                      <AppTile app={a} />
                      <div class="store-card-title">
                        <span class="store-card-name">{a.title}</span>
                        <span class="auto-meta"><code>{a.name}</code> · {a.files} files</span>
                      </div>
                    </div>
                    {a.description && <div class="store-card-desc">{a.description}</div>}
                    <div class="store-card-foot">
                      <CanChips can={a.can} />
                      {a.grants.workflows.length > 0 && <span class="auto-meta">over {a.grants.workflows.map((w) => <code key={w}>{w} </code>)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
          {d && d.workflows.length > 0 && (
            <section id="store-workflows">
              <SectionHead title="Workflows" count={d.workflows.length} />
              <div class="store-lines">
                {d.workflows.map((w) => (
                  <details class="store-acc" key={w.name}>
                    <summary class="store-line">
                      <ChevronRightIcon size={14} class="store-node-chev" />
                      <span class="store-line-main">
                        <span class="store-line-title">
                          <span class="package-name">{w.name}</span>
                          {w.peer && <span class="badge" title="Another strut may launch it">peer{w.peer === "person" ? ": person" : ""}</span>}
                          {w.sealed && <span class="badge badge-warning" title="The builder may never run or read it">sealed</span>}
                        </span>
                        {w.description && <span class="store-line-desc">{w.description}</span>}
                      </span>
                      <CanChips can={w.can} />
                      <span class="store-line-side">{n(w.inputs.length, "input")} · {n(w.steps.length, "step")}</span>
                    </summary>
                    <div class="store-acc-body">
                      {w.error && <div class="auto-error">{w.error}</div>}
                      <div>
                        <h3>Inputs</h3>
                        {w.inputs.length === 0 ? <span class="auto-meta">any</span> : w.inputs.map((i) => (
                          <div key={i.name} class="store-input" title={i.description}>
                            <code>{i.name}</code> <span class="auto-meta">{i.type}{i.required ? "" : " · optional"}</span>
                          </div>
                        ))}
                      </div>
                      <div>
                        <h3>Steps</h3>
                        <div class="store-steps">{w.steps.map((s) => <code key={s}>{s}</code>)}</div>
                        {w.grants.length > 0 && (
                          <>
                            <h3 title="The tools its agents may call">Agent tools</h3>
                            <div class="store-steps">{w.grants.map((g) => <code key={g}>{g}</code>)}</div>
                          </>
                        )}
                        {w.secrets.length > 0 && <div class="auto-meta store-acc-note">needs {w.secrets.join(", ")}</div>}
                        {w.claims !== undefined && <div class="auto-meta store-acc-note">{w.claims} claim{w.claims === 1 ? "" : "s"} declared</div>}
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            </section>
          )}
          {d && d.steps.length > 0 && (
            <section id="store-steps">
              <SectionHead title="Tools" count={steps} />
              <div class="store-lines">
                {d.steps.map((s) => (
                  <div class="store-line is-static" key={s.name}>
                    <span class="store-line-main">
                      <span class="store-line-title">
                        <span class="package-name">{s.name}</span>
                        {s.helper && <span class="badge">helper</span>}
                        {s.effect && <span class="badge" title="As the step declares it">{s.effect === "write" ? "acts" : "reads"}</span>}
                        {s.secrets.map((k) => <code key={k} class="store-secret" title="A secret it reads">{k}</code>)}
                      </span>
                      {s.description && <span class="store-line-desc" title={s.description}>{s.description}</span>}
                      {s.lint.length > 0 && (
                        <details class="store-lint">
                          <summary class="badge badge-warning">{s.lint.length} lint finding{s.lint.length === 1 ? "" : "s"}</summary>
                          <ul>{s.lint.map((l, i) => <li key={i}>{l}</li>)}</ul>
                        </details>
                      )}
                    </span>
                    {s.lint.length === 0 && <span class="badge badge-ok" title="Nothing past ctx.services: no child_process, fs, net, process.env or global fetch">clean</span>}
                    <span class="store-line-side">{formatBytes(s.bytes)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
          {d && d.concepts.length > 0 && (
            <section id="store-concepts">
              <SectionHead title="Concepts" count={d.concepts.length} />
              <ConceptTree concepts={d.concepts} go={props.go} />
            </section>
          )}
          {d?.readme && (
            <section>
              <SectionHead title="README" />
              <Markdown source={d.readme} class="md-view store-readme" />
            </section>
          )}
        </div>

        <aside class="store-package-aside">
          <section>
            <h3>Needs</h3>
            <dl class="store-facts">
              <dt>Secrets</dt>
              <dd>{d?.secrets.length ? d.secrets.map((s) => <code key={s}>{s} </code>) : newest?.requires?.secrets?.length ? newest.requires.secrets.map((s) => <code key={s}>{s} </code>) : <span class="auto-meta">none</span>}</dd>
              {newest?.requires?.binaries?.length ? <><dt>Binaries</dt><dd>{newest.requires.binaries.map((b) => <code key={b}>{b} </code>)}</dd></> : null}
              {newest?.requires?.runtimes?.length ? <><dt>Runtimes</dt><dd>{newest.requires.runtimes.map((r) => <code key={r}>{r} </code>)}</dd></> : null}
              {newest?.requires?.packages?.length ? (
                <><dt>Packages</dt><dd>{newest.requires.packages.map((p) => <button class="auto-link" key={p.package} onClick={() => props.go({ view: "package", pkg: p.package })}>{p.package}</button>)}</dd></>
              ) : null}
              {d && <><dt>Size</dt><dd class="auto-meta">{d.files} files, {formatBytes(d.bytes)}</dd></>}
            </dl>
          </section>
          <section>
            <h3>Publisher</h3>
            <dl class="store-facts">
              <dt>Prefix</dt><dd><code>{page.publisher}</code></dd>
              <dt>Key</dt><dd><code class="package-digest" title={page.key}>{shortKey(page.key)}</code> <CopyButton value={page.key} label="Copy the publisher's key" /></dd>
              <dt>Catalog</dt><dd class="auto-meta store-wrap">{page.urls.map((u) => u.replace(/^https?:\/\//, "")).join(", ")}</dd>
            </dl>
            <div class="auto-hint">Your install pins this key. A new row with another key is followed only when you say so.</div>
          </section>
          <section>
            <h3>Releases</h3>
            <ul class="store-releases">
              {page.releases.map((r) => (
                <li key={r.digest} class={r.yanked ? "is-yanked" : ""} title={r.yanked ? `Yanked: ${r.yanked}` : r.digest}>
                  <span class="package-version">{r.version}</span>
                  <code class="package-digest">{shortDigest(r.digest)}</code>
                  {held(r.digest).map((ch) => <span class="badge badge-accent" key={ch}>{ch}</span>)}
                  {r.yanked && <span class="badge badge-danger">yanked</span>}
                </li>
              ))}
            </ul>
            <div class="auto-meta">Catalog read {new Date(page.readAt).toLocaleString()}</div>
          </section>
        </aside>
      </div>
    </article>
  );
}

// ── Concepts ────────────────────────────────────────────────────────────────

/** With a name: that page. Without: the whole tree. */
function ConceptView(props: { name: string; target: string | null; link: (pkg: string) => InstallLink; go: (v: StoreView) => void; onNeedStrut: (url: string | null) => void }) {
  if (!props.name) return <ConceptIndex go={props.go} />;
  return <ConceptPage {...props} />;
}

function ConceptIndex(props: { go: (v: StoreView) => void }) {
  const [concepts, setConcepts] = useState<api.StoreConcept[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.storeConcepts().then(setConcepts, (err) => setError(errorMessage(err)));
  }, []);
  return (
    <section class="store-concepts">
      <div class="store-results-head">
        <h1>Concepts{concepts && concepts.length > 0 && <span class="store-count">{concepts.length.toLocaleString()}</span>}</h1>
      </div>
      <p class="store-package-desc">The knowledge the listed packages carry: pages an agent reads before it works, kept as a tree. Open a branch, or filter by words.</p>
      {error && <div class="auto-error">{error}</div>}
      {concepts === null && !error && <Loading />}
      {concepts?.length === 0 && <div class="auto-hint">No package listed here carries a Concept page yet.</div>}
      {concepts && concepts.length > 0 && <ConceptTree concepts={concepts} go={props.go} open />}
    </section>
  );
}

/** A page's text without a first heading that only repeats its name: the
 *  page already has it as its title. */
function withoutTitle(docs: string, name: string): string {
  const m = /^\s*#\s+(.+?)\s*(?:\n|$)/.exec(docs);
  return m && m[1]!.toLowerCase() === name.toLowerCase() ? docs.slice(m[0].length) : docs;
}

function ConceptPage(props: { name: string; target: string | null; link: (pkg: string) => InstallLink; go: (v: StoreView) => void; onNeedStrut: (url: string | null) => void }) {
  const [page, setPage] = useState<api.StoreConceptPage | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // A page only a publisher's public view holds: its docs are read there, live.
  const [liveDocs, setLiveDocs] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setPage(undefined);
    setError(null);
    setLiveDocs(undefined);
    api.storeConcept(props.name).then(setPage, (err) => { setPage(null); setError(errorMessage(err)); });
  }, [props.name]);
  useEffect(() => {
    const from = page?.live?.[0];
    if (!page || page.docs || !from) return;
    api.liveJSON<api.LiveConceptPage>(from.url, `/public/concepts/${encodeURIComponent(page.name)}`).then(
      (p) => setLiveDocs(typeof p.properties?.["docs"] === "string" ? (p.properties["docs"] as string) : null),
      () => setLiveDocs(null),
    );
  }, [page]);
  if (page === undefined) return <Loading />;
  if (!page) return <div class="store-empty"><div class="store-empty-title">{props.name}</div><div class="auto-error">{error}</div></div>;
  const first = page.packages[0];
  const docs = page.docs ?? liveDocs ?? undefined;
  return (
    <article class="store-concept">
      <nav class="store-crumbs">
        <button class="auto-link" onClick={() => props.go({ view: "concept", concept: "" })}>Concepts</button>
        {[...page.parents].reverse().flatMap((p) => [
          <span key={`/${p.name}`}>/</span>,
          <button key={p.name} class="auto-link" onClick={() => props.go({ view: "concept", concept: p.name })} title={p.description}>{p.name}</button>,
        ])}
        <span>/</span>
        <span>{page.name}</span>
      </nav>
      <div class="store-package-body">
        <div class="store-package-main">
          <header class="store-concept-head">
            <h1>{page.name}</h1>
            {page.description && <p class="store-package-desc">{page.description}</p>}
            {page.packages.length > 0 && (
              <div class="auto-meta">
                From {page.packages.map((p, i) => <span key={p.package}>{i > 0 && ", "}<button class="auto-link" onClick={() => props.go({ view: "package", pkg: p.package })}>{p.package}</button> {p.version}</span>)}
                {page.packages.length > 1 && " — the first's text is shown; installed side by side, each keeps its own page"}
              </div>
            )}
            {page.live?.length ? (
              <div class="auto-meta">Live on {page.live.map((l) => l.publisher).join(", ")}{!page.docs ? " — read from its server as it is now" : ""}</div>
            ) : null}
          </header>
          {docs ? <Markdown source={withoutTitle(docs, page.name)} class="md-view store-prose" /> : liveDocs === undefined && page.live?.length && !page.docs ? <div class="auto-hint">Reading it from its server…</div> : <div class="auto-hint">This page has a name and a place in the tree, and no text yet.</div>}
          {page.children.length > 0 && (
            <section>
              <SectionHead title="Under this page" count={page.children.length} />
              <ConceptList key={page.name} items={page.children} go={props.go} />
            </section>
          )}
        </div>
        <aside class="store-package-aside">
          {first && (
            <section>
              <h3>Have it in your graph</h3>
              <div class="auto-hint">Installing the package puts this page, and the tree it sits in, under your strut server's Concepts, where the builder and the job agents read it.</div>
              <InstallButton pkg={first.package} target={props.target} link={props.link} onNeedStrut={props.onNeedStrut} />
            </section>
          )}
          {page.live?.length ? (
            <section>
              <h3>Live</h3>
              <div class="auto-hint">Kept on {page.live.map((l) => l.publisher).join(", ")}'s server and edited there: what you read here is the page as it is now.</div>
            </section>
          ) : null}
          {page.packages.length > 0 && <section>
            <h3>In packages</h3>
            <ul class="store-releases">
              {page.packages.map((p) => (
                <li key={p.package}>
                  <button class="auto-link" onClick={() => props.go({ view: "package", pkg: p.package })}>{p.package}</button>
                  <span class="package-version">{p.version}</span>
                </li>
              ))}
            </ul>
          </section>}
        </aside>
      </div>
    </article>
  );
}

// ── A live item ─────────────────────────────────────────────────────────────

/** One item of a publisher's public view, read from its server now: an app
 *  framed as a visitor sees it, a workflow's inputs, steps and recent runs,
 *  a step's fields and source. */
function LivePage(props: { publisher: string; kind: LiveKind; name: string; card: api.IndexCard | undefined; go: (v: StoreView) => void; target: string | null; onNeedStrut: (url: string | null) => void }) {
  const base = liveBase(props.card, props.publisher);
  const crumbs = (
    <nav class="store-crumbs">
      <button class="auto-link" onClick={() => props.go({ view: "browse" })}>Store</button>
      <span>/</span>
      <span>{props.publisher}</span>
      <span>/</span>
      <span>{props.name}</span>
    </nav>
  );
  if (props.card === undefined) return <Loading />;
  if (!base) {
    return (
      <div class="store-empty">
        <div class="store-empty-title">{props.name}</div>
        <div class="auto-hint">{props.publisher} has no live row in this index.</div>
      </div>
    );
  }
  return (
    <article class="store-live">
      {crumbs}
      {props.kind === "app" && <LiveApp base={base} name={props.name} publisher={props.publisher} target={props.target} onNeedStrut={props.onNeedStrut} />}
      {props.kind === "workflow" && <LiveWorkflow base={base} name={props.name} publisher={props.publisher} />}
      {props.kind === "step" && <LiveStep base={base} name={props.name} publisher={props.publisher} />}
    </article>
  );
}

function useLive<T>(base: string, path: string): { data?: T; error?: string } {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  useEffect(() => {
    setState({});
    api.liveJSON<T>(base, path).then((data) => setState({ data }), (err) => setState({ error: errorMessage(err) }));
  }, [base, path]);
  return state;
}

function LiveApp(props: { base: string; name: string; publisher: string; target: string | null; onNeedStrut: (url: string | null) => void }) {
  const info = useLive<{ name: string; version: string; title: string; description?: string; permissions?: string[] }>(props.base, `/public/apps/${encodeURIComponent(props.name)}`);
  const page = liveAppUrl(props.base, props.name);
  // Whether the publisher's server can be hosted by another strut UI: an
  // older one says nothing, and the button would only fail there.
  const listing = useLive<{ host?: { remote?: unknown } }>(props.base, "/public");
  const hostable = typeof listing.data?.host?.remote === "number" && listing.data.host.remote >= 1;
  // The publisher's page frames the app, and a frame gets only what every
  // frame above it was granted: what every app's frame has for a game, and
  // what the version declared, go on this one too (../frame-permissions).
  // The frame waits for the listing, since the browser reads these when it
  // loads the page. `allow-forms` for the same reason: the app's frame has
  // it, so a `<form onSubmit>` fires its handler, and without it here the
  // browser refuses the submit event in every frame below (the app's CSP
  // still sends no form anywhere).
  const sandbox = ["allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads allow-forms", ...GAME_SANDBOX].join(" ");
  const allow = [...GAME_ALLOW, ...declaredAllow(info.data?.permissions)].join("; ");
  return (
    <>
      <div class="store-live-head">
        <div>
          <h1>{info.data?.title ?? props.name}</h1>
          {info.data?.description && <p class="store-package-desc">{info.data.description}</p>}
          <div class="auto-meta">
            {props.publisher} · live {info.data?.version ?? ""} · read-only: you can look around, not start a run
          </div>
        </div>
        <div class="store-live-open">
          {hostable && <OpenInYourStrut base={props.base} name={props.name} target={props.target} onNeedStrut={props.onNeedStrut} />}
          <a class="btn" href={page} target="_blank" rel="noopener">Open full page</a>
        </div>
      </div>
      {info.error && <div class="auto-error">{info.error}</div>}
      {(info.data || info.error) && (
        <iframe
          class="store-live-frame"
          src={page}
          title={info.data?.title ?? props.name}
          sandbox={sandbox}
          allow={allow}
        />
      )}
    </>
  );
}

/** "Open in your strut": the app with the visitor's OWN strut UI as its host
 *  (../remote-app, specs/API.md §17.9) — what pays for a priced run there
 *  is that strut's page, not the publisher's copy of it (Peel's wallet, in
 *  Peel). A link, with no credential; without a strut named yet, the
 *  address is asked once and kept as the Install button keeps it. */
function OpenInYourStrut(props: { base: string; name: string; target: string | null; onNeedStrut: (url: string | null) => void }) {
  const [asking, setAsking] = useState(false);
  const [draft, setDraft] = useState("");
  const href = (strut: string) => remoteAppHref(strut, { from: props.base, name: props.name });
  if (props.target && !asking) {
    return (
      <a class="btn btn-primary" href={href(props.target)} target="_blank" rel="noopener" title={`Opens this app in ${props.target}, which hosts it and pays for its runs from your own wallet`}>
        Open in your strut
      </a>
    );
  }
  if (!asking) return <button class="btn btn-primary" onClick={() => setAsking(true)}>Open in your strut</button>;
  return (
    <form
      class="store-strut-form"
      onSubmit={(e) => {
        e.preventDefault();
        const url = normalizeStrutUrl(draft);
        if (!url) return;
        props.onNeedStrut(url);
        setAsking(false);
        window.open(href(url), "_blank", "noopener");
      }}
    >
      <input type="text" value={draft} placeholder="Where is your strut server? http://localhost:3000" onInput={(e) => setDraft((e.target as HTMLInputElement).value)} aria-label="Your strut server's address" autoFocus />
      <button class="btn btn-sm btn-primary" type="submit" disabled={!normalizeStrutUrl(draft)}>Open</button>
      <button class="btn btn-sm" type="button" onClick={() => setAsking(false)}>Cancel</button>
    </form>
  );
}

/** What anyone may run on a publisher's server: its `GET /public` listing's
 *  `runnable`, read fresh (the index's copy is for the lists). */
function useRunnable(base: string, kind: "workflow" | "step", name: string): { item?: LiveRunnableItem; loaded: boolean } {
  const listing = useLive<{ runnable?: LiveRunnableItem[] }>(base, "/public");
  const item = listing.data?.runnable?.find((r) => r.kind === kind && r.name === name);
  return { ...(item ? { item } : {}), loaded: listing.data !== undefined || listing.error !== undefined };
}

function LiveWorkflow(props: { base: string; name: string; publisher: string }) {
  const w = encodeURIComponent(props.name);
  const meta = useLive<{ name: string; active: string; runs: boolean; category?: string }>(props.base, `/public/workflows/${w}`);
  const flow = useLive<api.LiveWorkflowFlow>(props.base, `/public/workflows/${w}/flow`);
  const run = useRunnable(props.base, "workflow", props.name);
  const [runs, setRuns] = useState<api.LiveRunRow[] | null>(null);
  useEffect(() => {
    if (!meta.data?.runs) return;
    api.liveJSON<api.LiveRunRow[]>(props.base, `/public/workflows/${w}/runs?limit=10`).then(setRuns, () => setRuns([]));
  }, [meta.data?.runs, props.base, w]);
  const inputs = Object.entries(flow.data?.input ?? {});
  // Runnable and nothing else public: its definition is not shown (decision 11).
  const privateDefinition = !!run.item && !!meta.error;
  return (
    <div class="store-package-body">
      <div class="store-package-main">
        <h1>{props.name}</h1>
        {run.item?.description && <p class="store-package-desc">{run.item.description}</p>}
        <div class="auto-meta">
          {props.publisher}
          {meta.data ? ` · active ${meta.data.active}` : privateDefinition ? " · its steps are not public" : " · …"}
          {meta.data?.category ? ` · ${meta.data.category}` : ""}
        </div>
        {(meta.error || flow.error) && !privateDefinition && run.loaded && <div class="auto-error">{meta.error ?? flow.error}</div>}
        {run.item && <RunPanel base={props.base} item={run.item} />}
        {!run.item && inputs.length > 0 && (
          <section>
            <h2>Inputs</h2>
            <ul class="store-releases">
              {inputs.map(([k, f]) => (
                <li key={k}>
                  <code>{k}</code> <span class="auto-meta">{f.type ?? "string"}{f.required === false || f.default !== undefined ? ", optional" : ""}</span>
                  {f.description && <span class="auto-hint"> — {f.description}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
        {flow.data && (
          <section>
            <h2>Steps <span class="auto-meta">{flow.data.steps.length}</span></h2>
            <ol class="store-releases">
              {flow.data.steps.map((s) => <li key={s.id}><code>{s.id}</code> <span class="badge">{s.type}</span></li>)}
            </ol>
          </section>
        )}
      </div>
      <aside class="store-package-aside">
        {run.item && <PriceCard item={run.item} />}
        <section>
          <h3>Runs</h3>
          {!meta.data?.runs && <div class="auto-hint">Its runs are not public{run.item ? ": a run you start here is yours to read." : "."}</div>}
          {meta.data?.runs && runs === null && <div class="auto-hint">Loading…</div>}
          {runs?.length === 0 && <div class="auto-hint">No runs yet.</div>}
          <ul class="store-releases">
            {runs?.map((r) => (
              <li key={r.runId}>
                <span class={`badge${r.status === "error" ? " badge-warning" : ""}`}>{r.status}</span>
                <span class="auto-meta">{r.startedAt ? new Date(r.startedAt).toLocaleString() : r.runId}</span>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  );
}

function LiveStep(props: { base: string; name: string; publisher: string }) {
  const t = props.name.split("/").map(encodeURIComponent).join("/");
  const schema = useLive<api.LiveStepSchema>(props.base, `/public/steps/${t}/schema`);
  const source = useLive<api.LiveStepSource>(props.base, `/public/steps/${t}/source`);
  const run = useRunnable(props.base, "step", props.name);
  const privateDefinition = !!run.item && !!schema.error;
  const description = schema.data?.description ?? run.item?.description;
  return (
    <div class="store-package-body">
      <div class="store-package-main">
        <h1>{props.name}</h1>
        {description && <p class="store-package-desc">{description}</p>}
        <div class="auto-meta">
          {props.publisher}
          {schema.data?.effect ? ` · ${schema.data.effect === "read" ? "reads" : "acts"}` : ""}
          {schema.data?.secrets?.length ? ` · reads the secrets ${schema.data.secrets.join(", ")}` : ""}
          {privateDefinition ? " · its source is not public" : ""}
        </div>
        {(schema.error || source.error) && !privateDefinition && run.loaded && <div class="auto-error">{schema.error ?? source.error}</div>}
        {run.item && <RunPanel base={props.base} item={run.item} />}
        {!run.item && schema.data && schema.data.fields.length > 0 && (
          <section>
            <h2>Fields</h2>
            <ul class="store-releases">
              {schema.data.fields.map((f) => <li key={f.name}><code>{f.name}</code> <span class="auto-meta">{f.type}</span>{f.description && <span class="auto-hint"> — {f.description}</span>}</li>)}
            </ul>
          </section>
        )}
        {source.data?.source && (
          <section>
            <h2>Source</h2>
            <pre class="store-source">{source.data.source}</pre>
            {source.data.helpers.map((h) => (
              <div key={h.name}>
                <h3><code>{h.name}</code></h3>
                <pre class="store-source">{h.source}</pre>
              </div>
            ))}
          </section>
        )}
      </div>
      {run.item && (
        <aside class="store-package-aside">
          <PriceCard item={run.item} />
        </aside>
      )}
    </div>
  );
}

// ── Running a live item (plans/paid-runs.md §10 "The store") ────────────────

/** The price, the credit a run needs, what recent runs were charged, and
 *  the visitor's own credit on that server. */
function PriceCard(props: { item: LiveRunnableItem }) {
  const { item } = props;
  return (
    <section class="store-price" data-testid="store-price">
      <h3>Price</h3>
      <div class="store-price-main">{priceWords(item)}</div>
      {priceNotes(item).map((n) => <div class="auto-hint" key={n}>{n}</div>)}
      {(item.base > 0 || item.markup > 0) && <div class="auto-hint">Paid over Lightning: any wallet pays the invoice. A run that fails is charged what it cost, no more.</div>}
      <div class="auto-hint">
        {item.kind === "step"
          ? "It answers at once with what it returns."
          : `You read ${item.results === "run" ? "the whole run: its steps, transcripts and files" : "its output and the files it declares"}.`}
      </div>
    </section>
  );
}

/** The Run form: fields from the item's input, Run, the sheet when it is
 *  priced, the runs this tab started there. */
function RunPanel(props: { base: string; item: LiveRunnableItem }) {
  const { base, item } = props;
  const sp = useMemo(() => storePurse(base), [base]);
  const fields = useMemo(() => runFields(item), [item]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payment, setPayment] = useState<{ p: PaymentRequired; workflow: string; settled: Promise<ClaimEnd>; done: (o: PayOutcome) => void } | null>(null);
  const [runs, setRuns] = useState<LaunchedRun[]>(() => sp.runs().filter((r) => r.workflow === item.name));
  const [called, setCalled] = useState<{ output: unknown; credit?: Record<string, unknown> } | null>(null);
  const [credit, setCredit] = useState<{ remaining_usd: number; remaining_sats: number; held_usd: number; expires: string } | null>(null);
  const priced = item.base > 0 || item.markup > 0;

  const readCredit = () => {
    const cred = sp.purse.credential;
    if (!cred) return setCredit(null);
    api.liveCredit(base, cred).then(
      (a) => {
        const b = a.body as { remaining_usd?: number; remaining_sats?: number; held_usd?: number; expires?: string } | null;
        setCredit(a.status === 200 && b && typeof b.remaining_usd === "number" ? { remaining_usd: b.remaining_usd, remaining_sats: b.remaining_sats ?? 0, held_usd: b.held_usd ?? 0, expires: b.expires ?? "" } : null);
      },
      () => setCredit(null),
    );
  };
  useEffect(readCredit, [base]);

  const pay = useMemo(
    () =>
      payWith(sp, (p, workflow, settled) => {
        // Paid, sheet or no sheet: the credit line shows it.
        void settled.then(() => readCredit());
        return new Promise<PayOutcome>((resolve) => {
          setPayment({
            p,
            workflow,
            settled,
            done: (o) => {
              setPayment(null);
              resolve(o);
            },
          });
        });
      }),
    [sp],
  );

  const submit = async (e: Event) => {
    e.preventDefault();
    const got = inputOf(fields, values);
    if ("error" in got) return setError(got.error);
    setError(null);
    setCalled(null);
    setBusy(true);
    // One key per press: every retry of this launch — after a payment, after
    // a lost answer — is the same run while it is in flight.
    const key = newLaunchKey();
    const send = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const a = item.kind === "workflow"
            ? await api.liveLaunch(base, item.name, { input: got.input, key }, sp.purse.credential)
            : await api.liveCall(base, item.name, got.input, sp.purse.credential);
          return httpCallResult(a.status, a.body, a.retryAfter);
        } catch (err) {
          // A launch is sent again under its key; a call is never sent twice.
          if (item.kind === "step" || attempt >= 2) throw err;
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    };
    try {
      const result = await callPaying({ name: item.kind === "workflow" ? "run_workflow" : "call_tool" }, { call: send, purse: sp.purse, save: sp.save, pay, launch: { workflow: item.name } });
      const failed = errorOf(result);
      const body = bodyOf(result);
      if (failed) setError(failed);
      else if (item.kind === "workflow" && body && typeof body["runId"] === "string" && typeof body["token"] === "string") {
        sp.remember({ workflow: item.name, runId: body["runId"], token: body["token"], at: new Date().toISOString() });
        setRuns(sp.runs().filter((r) => r.workflow === item.name));
      } else if (item.kind === "step" && body) {
        setCalled({ output: body["output"], ...(body["credit"] && typeof body["credit"] === "object" ? { credit: body["credit"] as Record<string, unknown> } : {}) });
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      readCredit();
    }
  };

  return (
    <section class="store-run" data-testid="store-run">
      <h2>{item.kind === "workflow" ? "Run it" : "Call it"}</h2>
      <form class="store-run-form" onSubmit={(e) => void submit(e)}>
        {fields.map((f) => (
          <ConfigField key={f.name} field={f} value={values[f.name]} onChange={(v) => setValues((cur) => ({ ...cur, [f.name]: v }))} />
        ))}
        {fields.length === 0 && <div class="auto-hint">It takes no input.</div>}
        <div class="store-run-actions">
          <button type="submit" class="btn btn-primary" disabled={busy}>
            {busy ? "Starting…" : item.kind === "workflow" ? "Run" : "Call"}
          </button>
          <span class="auto-meta">{priceWords(item)}</span>
          {credit && priced && (
            <span class="auto-meta" title={credit.expires ? `Until ${new Date(credit.expires).toLocaleDateString()}` : undefined}>
              · your credit here: {formatUsd(credit.remaining_usd)} ({formatSats(credit.remaining_sats)}){credit.held_usd > 0 ? `, ${formatUsd(credit.held_usd)} set aside for a run in flight` : ""}
            </span>
          )}
          {!credit && priced && <span class="auto-meta">· you pay when you run it</span>}
        </div>
        {error && <div class="auto-error">{error}</div>}
      </form>
      {priced && <KeepCredit sp={sp} onChange={readCredit} />}
      {called && (
        <div class="store-run-result">
          <div class="store-run-head">
            <span class="badge badge-ok">done</span>
            {typeof called.credit?.["charged_usd"] === "number" && <span class="auto-meta">charged {formatUsd(called.credit["charged_usd"] as number)}</span>}
          </div>
          <pre class="store-source">{JSON.stringify(called.output, null, 2)}</pre>
        </div>
      )}
      {runs.length > 0 && (
        <div class="store-run-list">
          <h3>Your runs here</h3>
          {runs.map((r) => <RunView key={r.runId} base={base} run={r} onEnded={readCredit} />)}
        </div>
      )}
      {payment && <PaymentSheet payment={payment.p} workflow={payment.workflow} settled={payment.settled} onDone={payment.done} seller={props.base.replace(/^https?:\/\//, "")} />}
    </section>
  );
}

/** The visitor's credit on this server lives in this TAB (sessionStorage):
 *  to keep it beyond the tab, they copy the credential somewhere safe and
 *  paste it back in another tab or browser. Shown only on request, never in
 *  a URL; anyone holding it can spend it. */
function KeepCredit(props: { sp: ReturnType<typeof storePurse>; onChange: () => void }) {
  const { sp } = props;
  const [shown, setShown] = useState(false);
  const [pasted, setPasted] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const use = async () => {
    const cred = pasted.trim().replace(/^(?:L402|LSAT)\s+/i, "");
    if (!/^\S+:[0-9a-fA-F]{64}$/.test(cred)) return setNote("That is not a credential: it is <macaroon>:<64 hex characters>.");
    const a = await api.liveCredit(sp.base, cred).catch(() => null);
    const b = a?.body as { remaining_usd?: number; error?: string } | null | undefined;
    if (!a || a.status !== 200 || typeof b?.remaining_usd !== "number") return setNote(b?.error ?? "This server does not know that credential.");
    if (sp.purse.credential && sp.purse.credential !== cred && !sp.purse.spare.includes(sp.purse.credential)) sp.purse.spare.push(sp.purse.credential);
    sp.purse.spare = sp.purse.spare.filter((c) => c !== cred);
    sp.purse.credential = cred;
    sp.save();
    setPasted("");
    setNote(`Using it: ${formatUsd(b.remaining_usd)} left.`);
    props.onChange();
  };
  return (
    <details class="store-keep-credit">
      <summary>Your credit lives in this tab</summary>
      <p class="auto-hint">
        What you buy here is credit on this server for a year, kept in this browser tab (a reload keeps it; closing the tab does not). To keep it, copy your credential somewhere safe and paste it here in another tab or browser. Anyone who holds it can spend it.
      </p>
      {sp.purse.credential ? (
        shown ? (
          <div class="store-keep-row">
            <code class="store-credential" title="Your credential">{sp.purse.credential}</code>
            <CopyButton value={sp.purse.credential} label="Copy the credential" />
          </div>
        ) : (
          <button type="button" class="btn" onClick={() => setShown(true)}>Show my credential</button>
        )
      ) : (
        <div class="auto-hint">No credit bought in this tab yet.</div>
      )}
      <div class="store-keep-row">
        <input type="text" placeholder="Paste a credential you copied" value={pasted} onInput={(e) => setPasted((e.target as HTMLInputElement).value)} aria-label="A credential to use" />
        <button type="button" class="btn" disabled={!pasted.trim()} onClick={() => void use()}>Use it</button>
      </div>
      {note && <div class="auto-hint">{note}</div>}
    </details>
  );
}

/** One run this tab started on a publisher's server, read with its run
 *  token until it ends: its status, output, files, and what it was charged. */
function RunView(props: { base: string; run: LaunchedRun; onEnded?: () => void }) {
  const { base, run } = props;
  const [view, setView] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let pendingReads = 0;
    void (async () => {
      for (let i = 0; live; i++) {
        try {
          const a = await api.liveRun(base, run.workflow, run.runId, run.token, i === 0 || pendingReads > 0 ? 0 : 25);
          if (!live) return;
          const b = a.body as Record<string, unknown> | null;
          if (a.status !== 200 || !b) {
            setError(typeof b?.["error"] === "string" ? (b["error"] as string) : `${a.status}`);
            return;
          }
          setError(null);
          setView(b);
          // `charged` is there once it ended and was charged. Ended with its
          // charge pending (the ledger refused it for now; it is tried again):
          // ended, read a few more times, slowly — never "still running".
          if (b["charged"] !== undefined) {
            if (i > 0) props.onEnded?.();
            return;
          }
          if (runEnded(b)) {
            if (++pendingReads > 6) return;
            await new Promise((r) => setTimeout(r, 10_000));
            continue;
          }
        } catch {
          // A dropped request: read again shortly.
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [base, run.runId, run.token]);
  const status = String(view?.["status"] ?? "starting");
  const artifacts = (Array.isArray(view?.["artifacts"]) ? view!["artifacts"] : []) as Array<{ id: string; title: string; url?: string; content?: unknown }>;
  const output = view?.["output"];
  const err = (view?.["error"] as { message?: string } | undefined)?.message;
  return (
    <div class="store-run-result" data-testid="store-run-view">
      <div class="store-run-head">
        <span class={`badge${status === "success" ? " badge-ok" : status === "error" ? " badge-danger" : ""}`}>{status}</span>
        <span class="auto-meta">{new Date(run.at).toLocaleString()}</span>
        {typeof view?.["charged"] === "number" && <span class="auto-meta">· charged {formatUsd(view["charged"] as number)}</span>}
        {view && view["charged"] === undefined && runEnded(view) && <span class="auto-meta" title="The run ended; the server records its charge shortly">· charge pending</span>}
      </div>
      {error && <div class="auto-error">{error}</div>}
      {err && <div class="auto-error">{err}</div>}
      {artifacts.length > 0 && (
        <ul class="store-releases">
          {artifacts.map((a) => (
            <li key={a.id}>
              {a.url ? <a href={runFileUrl(base, a.url, run.token)} target="_blank" rel="noopener">{a.title}</a> : <span>{a.title}</span>}
            </li>
          ))}
        </ul>
      )}
      {output !== undefined && <pre class="store-source">{JSON.stringify(output, null, 2)}</pre>}
    </div>
  );
}
