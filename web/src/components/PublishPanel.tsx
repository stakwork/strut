import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { errorMessage } from "../helpers";
import { PACKAGE_NAME, nextVersion, packageOf } from "../package-release";
import { CatalogPackage, channelNames } from "./PackagesDialog";
import { CopyButton } from "./CopyButton";

// ── Publish panel (a Workflow flyout tab) ──────────────────────────────────
//
// A release of the workflow's PACKAGE to every strut that follows this one's
// catalog (plans/marketplace.md §12.1; `POST /packages/publish`). The
// package is the name's first two segments (`stakwork/tools/summarize` →
// `stakwork/tools`); the release holds the workflows checked here, each with
// everything it can execute — custom steps under the prefix go in, core,
// lib and seeded steps are the installing strut's. The server builds from
// the ACTIVE versions, signs the catalog, moves the channel and pings the
// peers on file. Publishing is a person's act: no builder tool does this.

export function PublishPanel(props: {
  workflow: string;
  /** Unpublished canvas edits: they are not in the release. */
  dirty: boolean;
  onOpenPackages: () => void;
  /** Changes when the catalog may have moved elsewhere: read it again. */
  catalogEpoch: number;
}) {
  const pkg = packageOf(props.workflow);
  const [upstream, setUpstream] = useState<api.Upstream | null | undefined>(undefined);
  const [catalog, setCatalog] = useState<api.Catalog | null | undefined>(undefined);
  const [siblings, setSiblings] = useState<string[]>([props.workflow]);
  const [chosen, setChosen] = useState<Set<string>>(new Set([props.workflow]));
  const [peers, setPeers] = useState<string[] | null>(null);
  const [version, setVersion] = useState("");
  const [channel, setChannel] = useState("stable");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<api.PublishResult | null>(null);

  const loadCatalog = () => api.getCatalog().then((c) => { setCatalog(c); return c; });

  useEffect(() => {
    api.getWorkflowMeta(props.workflow).then((m) => setUpstream(m.versions[m.active]?.upstream ?? null), () => setUpstream(null));
    if (!pkg) return;
    loadCatalog().then((c) => {
      const entry = c?.packages[pkg];
      setVersion(nextVersion(entry?.releases[0]?.version));
      setDescription(entry?.description ?? "");
    }, (err) => setError(errorMessage(err)));
    // Every workflow under the prefix goes in by default: a release holds
    // only what it names, and one it leaves out is removed from every strut
    // that follows the channel.
    api.listWorkflows().then((list) => {
      const under = list.map((w) => w.name).filter((n) => n.startsWith(`${pkg}/`)).sort();
      if (!under.includes(props.workflow)) under.unshift(props.workflow);
      setSiblings(under);
      setChosen(new Set(under));
    }, () => {});
    api.listPeers().then((p) => setPeers(p.map((x) => x.id)), () => setPeers([]));
  }, [props.workflow]);
  useEffect(() => {
    if (pkg && props.catalogEpoch) void loadCatalog().catch(() => {});
  }, [props.catalogEpoch]);

  const releases = pkg ? catalog?.packages[pkg]?.releases ?? [] : [];
  const taken = releases.some((r) => r.version === version.trim());

  const toggle = (name: string) => {
    const next = new Set(chosen);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setChosen(next);
  };

  const publish = async () => {
    if (!pkg) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.publishPackage({
        package: pkg,
        version: version.trim(),
        workflows: siblings.filter((n) => chosen.has(n)),
        ...(channel.trim() ? { channel: channel.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      setResult(r);
      setVersion(nextVersion(r.version));
      await loadCatalog();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const intro = (
    <div class="flyout-section">
      <span class="auto-hint">
        Release this workflow's package to every strut that follows this one's catalog. A later edit is published as a new
        version, and the struts on the channel move to it.
      </span>
    </div>
  );

  if (!pkg) {
    return (
      <div class="flyout-body">
        {intro}
        <div class="auto-hint">
          A workflow is published as part of a package, so its name starts with the package: <code>publisher/package/workflow</code>,
          such as <code>stakwork/tools/summarize</code>. Custom steps it uses go under the same prefix. <code>{props.workflow}</code>{" "}
          has no package prefix, so there is nothing to publish.
        </div>
      </div>
    );
  }
  if (!PACKAGE_NAME.test(pkg)) {
    return (
      <div class="flyout-body">
        {intro}
        <div class="auto-error">
          <code>{pkg}</code> is not a package name: a package is two lowercase segments, <code>[a-z][a-z0-9-]*</code> each.
        </div>
      </div>
    );
  }
  if (upstream === undefined) return <div class="flyout-body">{intro}<div class="auto-hint">Loading…</div></div>;
  if (upstream) {
    return (
      <div class="flyout-body">
        {intro}
        <div class="auto-hint">
          Installed from <strong>{upstream.package} {upstream.version}</strong>. A package is published from the strut it was made on;
          an edit here is this strut's own.
        </div>
      </div>
    );
  }

  return (
    <div class="flyout-body">
      {intro}
      <div class="flyout-field">
        <label>Package</label>
        <div class="package-name">{pkg}</div>
      </div>
      <div class="flyout-field">
        <label>Version</label>
        <input type="text" value={version} placeholder="1.0.0" onInput={(e) => setVersion((e.target as HTMLInputElement).value)} />
        {taken && <div class="flyout-field-note">{version.trim()} is already a release of {pkg}.</div>}
      </div>
      <div class="flyout-field">
        <label>Channel</label>
        <input type="text" value={channel} list="publish-channels" placeholder="stable"
          onInput={(e) => setChannel((e.target as HTMLInputElement).value)} />
        <datalist id="publish-channels">
          {channelNames(catalog ?? null).map((ch) => <option key={ch} value={ch} />)}
        </datalist>
        {!channel.trim() && <div class="flyout-field-note">No channel: the release is listed, and no strut moves to it.</div>}
      </div>
      <div class="flyout-field">
        <label>Description</label>
        <input type="text" value={description} placeholder="What the package does (optional)"
          onInput={(e) => setDescription((e.target as HTMLInputElement).value)} />
      </div>
      <div class="flyout-field">
        <label>Workflows in the release</label>
        {siblings.map((n) => (
          <label class="auto-check package-workflow" key={n}>
            <input type="checkbox" checked={chosen.has(n)} disabled={n === props.workflow} onChange={() => toggle(n)} />
            {n}
          </label>
        ))}
        <div class="flyout-field-note">A workflow the last release had and this one leaves out is removed from the struts that follow the channel.</div>
      </div>
      {props.dirty && (
        <div class="auto-error">This workflow has unpublished changes on the canvas. The release is built from the active version: publish them first.</div>
      )}
      <div class="auto-hint">
        {peers === null ? "" : peers.length > 0
          ? <>Publishing pings {peers.map((p, i) => <span key={p}>{i > 0 && ", "}<code>{p}</code></span>)}, so the struts that follow this catalog read it now.</>
          : "No peers on file: struts that follow this catalog pick the release up at their next poll."}
      </div>
      <div class="package-publish-actions">
        <button class="btn btn-primary" disabled={busy || !version.trim() || chosen.size === 0} onClick={() => void publish()}>
          {busy ? "Publishing…" : "Publish release"}
        </button>
      </div>
      {error && <div class="auto-error package-refusal">{error}</div>}
      {result && (
        <div class="auto-card is-active-version">
          <div class="auto-card-head">
            <span class="package-name">Published {result.package} {result.version}</span>
            {result.channel && <span class="badge badge-accent">{result.channel}</span>}
          </div>
          <div class="package-key">
            <span class="auto-meta">Digest</span>
            <code class="package-digest">{result.digest}</code>
            <CopyButton value={result.digest} label="Copy the digest" />
          </div>
          <div class="auto-hint">
            {result.requires.secrets?.length
              ? <>Each strut that installs it needs the secret{result.requires.secrets.length === 1 ? "" : "s"} {result.requires.secrets.map((s, i) => <span key={s}>{i > 0 && ", "}<code>{s}</code></span>)}.</>
              : "It reads no secrets."}
            {result.requires.binaries?.length ? <> It runs {result.requires.binaries.join(", ")}.</> : null}
            {result.requires.runtimes?.length ? <> Runtimes: {result.requires.runtimes.map((r) => r.name).join(", ")}.</> : null}
            {result.requires.packages?.length ? <> It requires {result.requires.packages.map((p) => p.package).join(", ")}.</> : null}
          </div>
          {result.warnings.map((w, i) => <div class="auto-hint package-warning" key={i}>{w}</div>)}
          <details class="package-files">
            <summary>{result.files.length} file{result.files.length === 1 ? "" : "s"}</summary>
            <ul>{result.files.map((f) => <li key={f}>{f}</li>)}</ul>
          </details>
        </div>
      )}
      <div class="flyout-section package-releases-section">
        <div class="flyout-section-title">Releases</div>
        {catalog === undefined && <div class="auto-hint">Loading…</div>}
        {catalog !== undefined && releases.length === 0 && <div class="auto-hint">{pkg} has no release yet.</div>}
        {catalog && releases.length > 0 && <CatalogPackage name={pkg} catalog={catalog} onChanged={() => void loadCatalog()} />}
        <button class="auto-link" onClick={props.onOpenPackages}>All packages</button>
      </div>
    </div>
  );
}
