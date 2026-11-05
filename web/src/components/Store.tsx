import { useEffect, useMemo, useState } from "preact/hooks";
import * as api from "../api";
import { formatBytes } from "../attachments";
import { errorMessage } from "../helpers";
import { load, remove, save } from "../storage";
import { appsOf, canWords, conceptRoots, installLink, liveAppUrl, liveBase, normalizeStrutUrl, parseStoreView, shortKey, storeQuery, type InstallLink, type LiveKind, type StoreView } from "../store-links";
import { CopyButton } from "./CopyButton";
import { Markdown } from "./Markdown";
import { shortDigest } from "./PackagesPanel";

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
          <button class={`store-nav-link${view.view === "browse" && !view.q ? " is-active" : ""}`} onClick={() => go({ view: "browse" })}>Apps & packages</button>
          <button class={`store-nav-link${view.view === "concept" ? " is-active" : ""}`} onClick={() => go({ view: "concept", concept: "" })} title="Every Concept page the listed packages carry">Concepts</button>
        </nav>
        <form
          class="store-search"
          onSubmit={(e) => {
            e.preventDefault();
            const q = (new FormData(e.currentTarget as HTMLFormElement).get("q") as string) ?? "";
            go(q.trim() ? { view: "browse", q: q.trim() } : { view: "browse" });
          }}
        >
          <input name="q" type="search" placeholder="Search packages" defaultValue={view.view === "browse" ? view.q ?? "" : ""} key={view.view === "browse" ? view.q ?? "" : "x"} aria-label="Search packages" />
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
        {card !== null && view.view === "live" && <LivePage publisher={view.publisher} kind={view.kind} name={view.name} card={card} go={go} />}
      </main>

      <footer class="store-foot">
        {card && (
          <span title={card.key}>
            Index <code>{shortKey(card.key)}</code> · card seq {card.seq}
          </span>
        )}
        <span>Everything on this page is derived from publishers' signed catalogs and archives. An install re-verifies against the publisher, never against this page.</span>
        <span>
          For an agent: <a href="llms.txt">llms.txt</a> · MCP at <code>/index/mcp</code>
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
      <button class="btn btn-sm store-strut" onClick={() => { setDraft(props.target ?? ""); setEditing(true); }} title={props.target ? `Install links open ${props.target}` : "Name your strut server once: Install then opens it"}>
        {props.target ? `Your strut · ${props.target.replace(/^https?:\/\//, "")}` : "Your strut"}
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
        Or, in your strut server's Publish dialog, on the Packages tab, find <code>{props.pkg}</code> <CopyButton value={props.pkg} label="Copy the package name" />
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

// ── Browse ──────────────────────────────────────────────────────────────────

function Browse(props: { q?: string; card: api.IndexCard | undefined; go: (v: StoreView) => void }) {
  const [hits, setHits] = useState<api.StoreHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [concepts, setConcepts] = useState<api.StoreConcept[] | null>(null);
  const [live, setLive] = useState<api.StoreLiveItem[]>([]);
  useEffect(() => {
    setHits(null);
    api.storeSearch(props.q ?? "").then(setHits, (err) => setError(errorMessage(err)));
    api.storeLive(props.q ?? "").then(setLive, () => setLive([]));
  }, [props.q]);
  const liveApps = live.filter((i) => i.kind === "app");
  const liveFlows = live.filter((i) => i.kind === "workflow" || i.kind === "step");
  useEffect(() => {
    if (!props.q) api.storeConcepts().then(setConcepts, () => setConcepts([]));
  }, [props.q]);
  const apps = useMemo(() => (hits ? appsOf(hits) : []), [hits]);
  const roots = useMemo(() => (concepts ? conceptRoots(concepts) : []), [concepts]);
  const publishers = Object.entries(props.card?.publishers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const count = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return (
    <>
      {!props.q && (
        <section class="store-hero">
          <h1>Apps, workflows and knowledge for your strut server</h1>
          <p>
            Each package is a publisher's own, signed with its key; this index is the phone book that lists them.
            {hits && concepts && ` ${count(apps.length, "app")}, ${count(hits.length, "package")}, ${count(concepts.length, "Concept page")}, ${count(publishers.length, "publisher")}.`}
          </p>
        </section>
      )}
      {props.q && (
        <div class="store-section-head">
          <h2>Packages matching “{props.q}”</h2>
          <button class="auto-link" onClick={() => props.go({ view: "browse" })}>Clear</button>
        </div>
      )}
      {error && <div class="auto-error">{error}</div>}
      {hits === null && !error && <div class="auto-hint">Loading…</div>}

      {liveApps.length > 0 && (
        <section>
          <div class="store-section-head"><h2>Live apps</h2><span class="auto-meta">On their publishers' servers, read-only: open one and look around</span></div>
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
              </button>
            ))}
          </div>
        </section>
      )}

      {liveFlows.length > 0 && (
        <section>
          <div class="store-section-head"><h2>Live workflows and steps</h2><span class="auto-meta">Read from their servers as they are now</span></div>
          <div class="store-list">
            {liveFlows.map((i) => (
              <button class="store-row" key={`${i.publisher}/${i.kind}/${i.name}`} onClick={() => props.go({ view: "live", publisher: i.publisher, kind: i.kind as LiveKind, name: i.name })}>
                <span class="store-row-main">
                  <span class="package-name">{i.name}</span>
                  <span class="badge">{i.kind}</span>
                  {i.runs && <span class="badge" title="Its runs are public too">with runs</span>}
                  <span class="auto-meta">{i.publisher}</span>
                </span>
                {i.description && <span class="store-row-desc">{i.description}</span>}
              </button>
            ))}
          </div>
        </section>
      )}

      {hits && apps.length > 0 && (
        <section>
          <div class="store-section-head"><h2>Apps</h2><span class="auto-meta">A package's face: install the package, open the app</span></div>
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
                <div class="store-card-foot"><CanChips can={app.can} /></div>
              </button>
            ))}
          </div>
        </section>
      )}

      {hits && (
        <section>
          <div class="store-section-head"><h2>Packages</h2></div>
          {hits.length === 0 && <div class="auto-hint">{props.q ? "Nothing matches." : "Nothing listed yet: the index has no publisher rows, or none has made a package public."}</div>}
          <div class="store-list">
            {hits.map((h) => (
              <button class="store-row" key={h.package} onClick={() => props.go({ view: "package", pkg: h.package })}>
                <span class="store-row-main">
                  <span class="package-name">{h.package}</span>
                  <span class="package-version">{h.version}</span>
                  {h.license && <span class="badge">{h.license}</span>}
                  {h.detail && <CanChips can={h.detail.can} />}
                </span>
                {h.description && <span class="store-row-desc">{h.description}</span>}
                <span class="auto-meta">
                  {h.detail ? [count(h.detail.apps.length, "app"), count(h.detail.workflows, "workflow"), count(h.detail.steps, "step"), count(h.detail.concepts, "concept")].join(" · ") : "archive not read yet"}
                  {h.detail?.secrets.length ? ` · needs ${h.detail.secrets.join(", ")}` : ""}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {!props.q && concepts && roots.length > 0 && (
        <section>
          <div class="store-section-head"><h2>Browse by concept</h2><span class="auto-meta">The knowledge the packages carry, as a tree</span></div>
          <div class="store-chips">
            {roots.map(({ root, pages }) => (
              <button class="store-chip" key={root.name} onClick={() => props.go({ view: "concept", concept: root.name })} title={root.description}>
                {root.name} {pages > 0 && <span class="auto-meta">{pages}</span>}
              </button>
            ))}
          </div>
        </section>
      )}

      {!props.q && publishers.length > 0 && (
        <section>
          <div class="store-section-head"><h2>Publishers</h2><span class="auto-meta">The rows of the signed index card</span></div>
          <div class="store-list">
            {publishers.map(([prefix, row]) => (
              <div class="store-row is-static" key={prefix}>
                <span class="store-row-main">
                  <span class="package-name">{prefix}</span>
                  <code class="package-digest" title={row.key}>{shortKey(row.key)}</code>
                  {row.url && <a href={row.url} target="_blank" rel="noopener noreferrer" class="auto-link">{row.url.replace(/^https?:\/\//, "")}</a>}
                </span>
                {row.description && <span class="store-row-desc">{row.description}</span>}
              </div>
            ))}
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
  if (page === undefined) return <div class="auto-hint">Loading…</div>;
  if (!page) return <div class="store-empty"><div class="store-empty-title">{props.pkg}</div><div class="auto-error">{error}</div></div>;
  const d = page.detail;
  const newest = page.releases.find((r) => !r.yanked);
  const held = (digest: string) => Object.entries(page.channels).filter(([, dg]) => dg === digest).map(([ch]) => ch);
  const [publisher, name] = props.pkg.split("/");
  return (
    <article class="store-package">
      <nav class="store-crumbs">
        <button class="auto-link" onClick={() => props.go({ view: "browse" })}>Packages</button>
        <span>›</span>
        <button class="auto-link" onClick={() => props.go({ view: "browse", q: publisher! })}>{publisher}</button>
        <span>›</span>
        <span>{name}</span>
      </nav>
      <header class="store-package-head">
        <div class="store-package-title">
          <h1>{props.pkg}</h1>
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

      <div class="store-package-body">
        <div class="store-package-main">
          {!d && <div class="auto-hint">{page.detailError ?? "The archive has not been read yet; what it holds shows once the index has."}</div>}
          {d && d.apps.length > 0 && (
            <section>
              <h2>Apps <span class="auto-meta">{d.apps.length}</span></h2>
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
            <section>
              <h2>Workflows <span class="auto-meta">{d.workflows.length}</span></h2>
              <table class="store-table">
                <thead><tr><th>Name</th><th>Does</th><th>Inputs</th><th>Steps</th></tr></thead>
                <tbody>
                  {d.workflows.map((w) => (
                    <tr key={w.name}>
                      <td>
                        <code>{w.name}</code>
                        {w.peer && <span class="badge" title="Another strut may launch it">peer{w.peer === "person" ? ": person" : ""}</span>}
                        {w.sealed && <span class="badge badge-warning" title="The builder may never run or read it">sealed</span>}
                        {w.description && <div class="auto-meta">{w.description}</div>}
                        {w.error && <div class="auto-error">{w.error}</div>}
                      </td>
                      <td>
                        <CanChips can={w.can} />
                        {w.secrets.length > 0 && <div class="auto-meta">needs {w.secrets.join(", ")}</div>}
                        {w.claims !== undefined && <div class="auto-meta">{w.claims} claim{w.claims === 1 ? "" : "s"} declared</div>}
                      </td>
                      <td>
                        {w.inputs.length === 0 ? <span class="auto-meta">any</span> : w.inputs.map((i) => (
                          <div key={i.name} class="store-input" title={i.description}>
                            <code>{i.name}</code> <span class="auto-meta">{i.type}{i.required ? "" : " · optional"}</span>
                          </div>
                        ))}
                      </td>
                      <td class="store-steps">{[...w.steps, ...w.grants.map((g) => `→ ${g}`)].map((s) => <code key={s}>{s}</code>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {d && d.steps.length > 0 && (
            <section>
              <h2>Steps <span class="auto-meta">{d.steps.filter((s) => !s.helper).length}</span></h2>
              <table class="store-table">
                <thead><tr><th>Name</th><th>Reads</th><th>Lint</th><th>Size</th></tr></thead>
                <tbody>
                  {d.steps.map((s) => (
                    <tr key={s.name}>
                      <td>
                        <code>{s.name}</code>
                        {s.helper && <span class="badge">helper</span>}
                        {s.effect && <span class="badge" title="As the step declares it">{s.effect === "write" ? "acts" : "reads"}</span>}
                        {s.description && <div class="auto-meta">{s.description}</div>}
                      </td>
                      <td>{s.secrets.length ? s.secrets.map((n) => <code key={n}>{n} </code>) : <span class="auto-meta">no secret</span>}</td>
                      <td>
                        {s.lint.length === 0 ? <span class="badge badge-ok" title="Nothing past ctx.services: no child_process, fs, net, process.env or global fetch">clean</span> : (
                          <details class="store-lint">
                            <summary class="badge badge-warning">{s.lint.length} finding{s.lint.length === 1 ? "" : "s"}</summary>
                            <ul>{s.lint.map((l, i) => <li key={i}>{l}</li>)}</ul>
                          </details>
                        )}
                      </td>
                      <td class="auto-meta">{formatBytes(s.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div class="auto-hint">A step is TypeScript that runs inside the installing strut's process. The lint is a reading of its source, not a sandbox.</div>
            </section>
          )}
          {d && d.concepts.length > 0 && (
            <section>
              <h2>Concepts <span class="auto-meta">{d.concepts.length}</span></h2>
              <div class="store-chips">
                {d.concepts.map((c) => (
                  <button class="store-chip" key={c.name} onClick={() => props.go({ view: "concept", concept: c.name })} title={c.description}>
                    {c.name}{c.parent && <span class="auto-meta"> under {c.parent}</span>}
                  </button>
                ))}
              </div>
            </section>
          )}
          {d?.readme && (
            <section>
              <h2>README</h2>
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

/** With a name: that page. Without: the tree's roots. */
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
  const roots = useMemo(() => (concepts ? conceptRoots(concepts) : []), [concepts]);
  const byParent = useMemo(() => {
    const m = new Map<string, api.StoreConcept[]>();
    for (const c of concepts ?? []) if (c.parent) m.set(c.parent, [...(m.get(c.parent) ?? []), c]);
    return m;
  }, [concepts]);
  return (
    <section>
      <div class="store-section-head"><h2>Concepts</h2><span class="auto-meta">The pages the listed packages carry, as the tree their front matter declares</span></div>
      {error && <div class="auto-error">{error}</div>}
      {concepts === null && !error && <div class="auto-hint">Loading…</div>}
      {concepts?.length === 0 && <div class="auto-hint">No package listed here carries a Concept page yet.</div>}
      <div class="store-tree">
        {roots.map(({ root }) => (
          <div class="store-tree-root" key={root.name}>
            <button class="store-tree-link is-root" onClick={() => props.go({ view: "concept", concept: root.name })}>{root.name}</button>
            {root.description && <span class="auto-meta"> {root.description}</span>}
            <div class="store-tree-children">
              {(byParent.get(root.name) ?? []).map((c) => (
                <button class="store-tree-link" key={c.name} onClick={() => props.go({ view: "concept", concept: c.name })} title={c.description}>
                  {c.name}{byParent.get(c.name)?.length ? <span class="auto-meta"> +{byParent.get(c.name)!.length}</span> : null}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
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
  if (page === undefined) return <div class="auto-hint">Loading…</div>;
  if (!page) return <div class="store-empty"><div class="store-empty-title">{props.name}</div><div class="auto-error">{error}</div></div>;
  const first = page.packages[0];
  const docs = page.docs ?? liveDocs ?? undefined;
  return (
    <article class="store-concept">
      <nav class="store-crumbs">
        <button class="auto-link" onClick={() => props.go({ view: "concept", concept: "" })}>Concepts</button>
        {[...page.parents].reverse().map((p) => (
          <span key={p.name}><span>›</span> <button class="auto-link" onClick={() => props.go({ view: "concept", concept: p.name })} title={p.description}>{p.name}</button></span>
        ))}
        <span>›</span>
        <span>{page.name}</span>
      </nav>
      <div class="store-package-body">
        <div class="store-package-main">
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
          {docs ? <Markdown source={docs} class="md-view store-readme" /> : liveDocs === undefined && page.live?.length && !page.docs ? <div class="auto-hint">Reading it from its server…</div> : <div class="auto-hint">This page has a name and a place in the tree, and no text yet.</div>}
          {page.children.length > 0 && (
            <section>
              <h2>Under this page <span class="auto-meta">{page.children.length}</span></h2>
              <div class="store-chips">
                {page.children.map((c) => (
                  <button class="store-chip" key={c.name} onClick={() => props.go({ view: "concept", concept: c.name })} title={c.description}>{c.name}</button>
                ))}
              </div>
            </section>
          )}
        </div>
        <aside class="store-package-aside">
          {first && (
            <section>
              <h3>Have it in your graph</h3>
              <div class="auto-hint">Installing the package puts this page, and the tree it sits in, under your strut server's Concepts — where the builder and the job agents read it.</div>
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
function LivePage(props: { publisher: string; kind: LiveKind; name: string; card: api.IndexCard | undefined; go: (v: StoreView) => void }) {
  const base = liveBase(props.card, props.publisher);
  const crumbs = (
    <nav class="store-crumbs">
      <button class="auto-link" onClick={() => props.go({ view: "browse" })}>Store</button>
      <span>›</span>
      <span>{props.publisher}</span>
      <span>›</span>
      <span>{props.name}</span>
    </nav>
  );
  if (props.card === undefined) return <div class="auto-hint">Loading…</div>;
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
      {props.kind === "app" && <LiveApp base={base} name={props.name} publisher={props.publisher} />}
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

function LiveApp(props: { base: string; name: string; publisher: string }) {
  const info = useLive<{ name: string; version: string; title: string; description?: string }>(props.base, `/public/apps/${encodeURIComponent(props.name)}`);
  const page = liveAppUrl(props.base, props.name);
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
        <a class="btn" href={page} target="_blank" rel="noopener">Open full page</a>
      </div>
      {info.error && <div class="auto-error">{info.error}</div>}
      <iframe
        class="store-live-frame"
        src={page}
        title={info.data?.title ?? props.name}
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
      />
    </>
  );
}

function LiveWorkflow(props: { base: string; name: string; publisher: string }) {
  const w = encodeURIComponent(props.name);
  const meta = useLive<{ name: string; active: string; runs: boolean; category?: string }>(props.base, `/public/workflows/${w}`);
  const flow = useLive<api.LiveWorkflowFlow>(props.base, `/public/workflows/${w}/flow`);
  const [runs, setRuns] = useState<api.LiveRunRow[] | null>(null);
  useEffect(() => {
    if (!meta.data?.runs) return;
    api.liveJSON<api.LiveRunRow[]>(props.base, `/public/workflows/${w}/runs?limit=10`).then(setRuns, () => setRuns([]));
  }, [meta.data?.runs, props.base, w]);
  const inputs = Object.entries(flow.data?.input ?? {});
  return (
    <div class="store-package-body">
      <div class="store-package-main">
        <h1>{props.name}</h1>
        <div class="auto-meta">{props.publisher} · {meta.data ? `active ${meta.data.active}` : "…"}{meta.data?.category ? ` · ${meta.data.category}` : ""}</div>
        {(meta.error || flow.error) && <div class="auto-error">{meta.error ?? flow.error}</div>}
        {inputs.length > 0 && (
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
        <section>
          <h3>Runs</h3>
          {!meta.data?.runs && <div class="auto-hint">Its runs are not public.</div>}
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
  return (
    <div class="store-package-main">
      <h1>{props.name}</h1>
      {schema.data?.description && <p class="store-package-desc">{schema.data.description}</p>}
      <div class="auto-meta">
        {props.publisher}
        {schema.data?.effect ? ` · ${schema.data.effect === "read" ? "reads" : "acts"}` : ""}
        {schema.data?.secrets?.length ? ` · reads the secrets ${schema.data.secrets.join(", ")}` : ""}
      </div>
      {(schema.error || source.error) && <div class="auto-error">{schema.error ?? source.error}</div>}
      {schema.data && schema.data.fields.length > 0 && (
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
  );
}
