import { useEffect, useMemo, useState } from "preact/hooks";
import * as api from "../api";
import { ago } from "./ClaimsPanel";
import { errorMessage } from "../helpers";
import { localPackages, nextVersion, packageLabel } from "../package-release";
import { ConfirmButton } from "./ConfirmButton";
import { CopyButton } from "./CopyButton";

// ── Packages dialog ─────────────────────────────────────────────────────────
//
// The npm shape (plans/packages-ux.md). At its head this strut's PUBLISHER:
// a name set once — the first segment of every package published here,
// which nobody types again — beside the key subscribers follow. Then the
// packages HERE: every `publisher/package` prefix a workflow is named
// under (its name carries its package, plans/marketplace.md §1), one row
// each — the package segment and, once published, its newest version,
// nothing more — and a click opens the PACKAGE PAGE: what the release
// holds, version, channel, Publish, and the releases with what each
// channel holds. Below, read only, what this strut FOLLOWS and has
// INSTALLED (specs/API.md §16). A package is published from here, never
// from a workflow's flyout: a release holds the whole package, and a
// workflow left out of it is retired on every subscriber. Publishing is
// a person's act; no builder tool does it.

const secs = (iso?: string) => (iso ? Date.parse(iso) / 1000 : undefined);
/** A digest, short: the first 12 hex. The full one rides in the title. */
export const shortDigest = (digest: string) => digest.replace(/^sha256:/, "").slice(0, 12);

/** The channels to offer: every one the catalog names, and `stable`, the
 *  one a subscription follows by default — a channel that holds nothing is
 *  dropped from the card. */
export function channelNames(catalog: api.Catalog | null): string[] {
  return [...new Set(["stable", ...Object.keys(catalog?.channels ?? {})])].sort();
}

/** One package in this strut's catalog: what each channel holds, and every
 *  release newest first. A channel moves to any release — an earlier one is
 *  a rollback — and taking the package out of a channel uninstalls it from
 *  every strut that follows the channel. Each move pings the peers on file. */
export function CatalogPackage(props: { name: string; catalog: api.Catalog; onChanged: () => void }) {
  const entry = props.catalog.packages[props.name];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!entry) return null;
  const channels = channelNames(props.catalog);
  const held = (ch: string) => props.catalog.channels?.[ch]?.[props.name];
  const versionAt = (digest: string) => entry.releases.find((r) => r.digest === digest)?.version ?? shortDigest(digest);
  const holding = channels.filter((ch) => held(ch));

  const move = async (channel: string, digest: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await api.moveChannel(channel, props.name, digest);
      props.onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="package-releases-section">
      {entry.description && <div class="auto-hint">{entry.description}</div>}
      {error && <div class="auto-error">{error}</div>}
      {holding.length === 0 && <div class="auto-hint">On no channel: no strut that follows a channel installs it.</div>}
      {holding.map((ch) => (
        <div class="auto-card-actions package-channel" key={ch}>
          <span class="package-channel-name"><span class="badge badge-accent">{ch}</span> holds {versionAt(held(ch)!)}</span>
          <ConfirmButton class="btn" label="Take out" disabled={busy}
            note={`Take ${props.name} out of ${ch}? Every strut that follows ${ch} uninstalls it (items edited there are kept).`}
            confirmLabel="Take out" onConfirm={() => void move(ch, null)} />
        </div>
      ))}
      <div class="package-releases">
        {entry.releases.map((r) => {
          const on = channels.filter((ch) => held(ch) === r.digest);
          const offer = channels.filter((ch) => held(ch) !== r.digest);
          return (
            <div class="package-release" key={r.digest}>
              <div class="package-release-head">
                <span class="package-version">{r.version}</span>
                {on.map((ch) => <span class="badge badge-accent" key={ch}>{ch}</span>)}
                {r.yanked && <span class="badge badge-warning" title={r.yanked}>yanked</span>}
                <code class="package-digest" title={r.digest}>{shortDigest(r.digest)}</code>
                {r.requires?.secrets?.length ? <span class="auto-meta">needs {r.requires.secrets.join(", ")}</span> : null}
              </div>
              {offer.length > 0 && (
                <div class="auto-card-actions">
                  {offer.map((ch) => (
                    <ConfirmButton key={ch} class="btn" label={`Put on ${ch}`} disabled={busy} tone="primary"
                      note={held(ch)
                        ? `Move ${ch} from ${versionAt(held(ch)!)} to ${r.version}? Every strut that follows ${ch} moves with it.`
                        : `Put ${r.version} on ${ch}? Every strut that follows ${ch} installs it.`}
                      confirmLabel={`Put on ${ch}`} onConfirm={() => void move(ch, r.digest)} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The publisher's name, set once (`PUT /publisher`), beside the key. */
function PublisherHead(props: { publisher: api.PublisherInfo | null | undefined; onChanged: (p: api.PublisherInfo) => void }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = props.publisher?.name;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      props.onChanged(await api.setPublisherName(draft.trim()));
      setDraft("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div class="publisher-head">
        <span class="auto-meta">Publisher</span>
        {name ? (
          <span class="package-name" title="The first segment of every package published here">{name}</span>
        ) : (
          <>
            <input type="text" value={draft} placeholder="stakwork" disabled={busy || props.publisher === undefined}
              onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) void save(); }} />
            <button class="btn btn-primary" disabled={busy || !draft.trim()} onClick={() => void save()}>Set</button>
          </>
        )}
        {props.publisher && (
          <span class="package-key">
            <code class="package-digest" title="The key a subscribing strut follows">{props.publisher.key}</code>
            <CopyButton value={props.publisher.key} label="Copy the publisher key" />
          </span>
        )}
      </div>
      {!name && props.publisher !== undefined && (
        <div class="auto-hint publisher-hint">
          The publisher is the first segment of every package published here (<code>stakwork</code> in <code>stakwork/tools</code>). Set it once.
        </div>
      )}
      {error && <div class="auto-error">{error}</div>}
    </>
  );
}

/** One package's page: what a release holds, the form, and its releases.
 *  In the dialog behind a row (`onBack`), and the canvas area's view of a
 *  selected package (PackagePanel.tsx). */
export function PackagePage(props: {
  pkg: string;
  publisher?: string;
  catalog: api.Catalog | null;
  /** Every workflow here, by name. */
  workflows: string[];
  peers: string[] | null;
  onBack?: () => void;
  onChanged: () => void;
}) {
  const entry = props.catalog?.packages[props.pkg];
  const under = useMemo(() => props.workflows.filter((n) => n.startsWith(`${props.pkg}/`)).sort(), [props.workflows, props.pkg]);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(under));
  const [version, setVersion] = useState(() => nextVersion(entry?.releases[0]?.version));
  const [channel, setChannel] = useState("stable");
  const [description, setDescription] = useState(entry?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<api.PublishResult | null>(null);
  const taken = (entry?.releases ?? []).some((r) => r.version === version.trim());

  const toggle = (name: string) => {
    const next = new Set(chosen);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setChosen(next);
  };
  const publish = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.publishPackage({
        package: props.pkg,
        version: version.trim(),
        workflows: under.filter((n) => chosen.has(n)),
        ...(channel.trim() ? { channel: channel.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      setResult(r);
      setVersion(nextVersion(r.version));
      props.onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div class="package-page-head">
        {props.onBack && <button class="auto-link" onClick={props.onBack}>← Packages</button>}
        <span class="package-name" title={props.pkg}>{packageLabel(props.pkg, props.publisher)}</span>
        {entry?.releases[0] && <span class="package-version">{entry.releases[0].version}</span>}
      </div>
      <div class="dialog-field">
        <label>In the release</label>
        {under.length === 0 && <div class="auto-hint">No workflow is named under <code>{props.pkg}/</code> any more.</div>}
        {under.map((n) => (
          <label class="package-workflow" key={n}>
            <input type="checkbox" checked={chosen.has(n)} onChange={() => toggle(n)} />
            {n.slice(props.pkg.length + 1)}
          </label>
        ))}
        <div class="auto-hint">
          Each with the custom steps it runs. The release is built from the active versions; a workflow the last release had and this one leaves out is removed from the struts that follow the channel.
        </div>
      </div>
      <div class="dialog-field">
        <label>Version</label>
        <input type="text" value={version} placeholder="1.0.0" onInput={(e) => setVersion((e.target as HTMLInputElement).value)} />
        {taken && <div class="auto-hint">{version.trim()} is already a release.</div>}
      </div>
      <div class="dialog-field">
        <label>Channel</label>
        <input type="text" value={channel} list="publish-channels" placeholder="stable"
          onInput={(e) => setChannel((e.target as HTMLInputElement).value)} />
        <datalist id="publish-channels">
          {channelNames(props.catalog).map((ch) => <option key={ch} value={ch} />)}
        </datalist>
        {!channel.trim() && <div class="auto-hint">No channel: the release is listed, and no strut moves to it.</div>}
      </div>
      <div class="dialog-field">
        <label>Description</label>
        <input type="text" value={description} placeholder="What the package does (optional)"
          onInput={(e) => setDescription((e.target as HTMLInputElement).value)} />
      </div>
      <div class="auto-hint">
        {props.peers === null ? "" : props.peers.length > 0
          ? <>Publishing pings {props.peers.map((p, i) => <span key={p}>{i > 0 && ", "}<code>{p}</code></span>)}, so the struts that follow this catalog read it now.</>
          : "No peers on file: struts that follow this catalog pick the release up at their next poll."}
      </div>
      <div class="package-publish-actions">
        <button class="btn btn-primary" disabled={busy || !version.trim() || chosen.size === 0} onClick={() => void publish()}>
          {busy ? "Publishing…" : "Publish"}
        </button>
      </div>
      {error && <div class="auto-error package-refusal">{error}</div>}
      {result && (
        <div class="auto-card is-active-version">
          <div class="auto-card-head">
            <span class="package-name">Published {packageLabel(result.package, props.publisher)} {result.version}</span>
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
      <div class="flyout-section">
        <div class="flyout-section-title">Releases</div>
        {!entry && <div class="auto-hint">Not published yet.</div>}
        {props.catalog && entry && <CatalogPackage name={props.pkg} catalog={props.catalog} onChanged={props.onChanged} />}
      </div>
    </>
  );
}

export function PackagesDialog(props: {
  onClose: () => void;
  /** Draft packages this browser keeps (segments under the publisher):
   *  empty groups until a workflow lands in them (plans/packages-ux.md §1). */
  drafts?: string[];
  /** A new draft: the name typed under "Here". */
  onNewPackage?: (segment: string) => void;
}) {
  const [catalog, setCatalog] = useState<api.Catalog | null | undefined>(undefined);
  const [publisher, setPublisher] = useState<api.PublisherInfo | null | undefined>(undefined);
  const [workflows, setWorkflows] = useState<string[]>([]);
  const [peers, setPeers] = useState<string[] | null>(null);
  const [subs, setSubs] = useState<api.SubscriptionInfo[] | null>(null);
  const [installed, setInstalled] = useState<api.InstalledPackage[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [newPkg, setNewPkg] = useState("");

  const failed = (part: string) => (err: unknown) => setErrors((e) => ({ ...e, [part]: errorMessage(err) }));
  const loadCatalog = () => api.getCatalog().then(setCatalog, failed("catalog"));
  useEffect(() => {
    void loadCatalog();
    api.getPublisher().then(setPublisher, failed("catalog"));
    api.listWorkflows().then((list) => setWorkflows(list.map((w) => w.name)), failed("catalog"));
    api.listPeers().then((p) => setPeers(p.map((x) => x.id)), () => setPeers([]));
    api.listSubscriptions().then(setSubs, failed("subs"));
    api.listInstalledPackages().then(setInstalled, failed("installed"));
  }, []);

  // The packages here: off the workflow names, plus what the catalog holds
  // (a package whose workflows were deleted still has its releases).
  const here = useMemo(() => {
    const names = localPackages(workflows, {
      ...(publisher?.name ? { publisher: publisher.name } : {}),
      installed: (installed ?? []).map((p) => p.package),
    });
    const drafts = publisher?.name ? (props.drafts ?? []).map((seg) => `${publisher.name}/${seg}`) : [];
    return [...new Set([...names, ...Object.keys(catalog?.packages ?? {}), ...drafts])].sort();
  }, [workflows, publisher, installed, catalog, props.drafts]);
  const segmentOk = /^[a-z][a-z0-9-]{0,63}$/.test(newPkg.trim());
  const newest = (pkg: string) => catalog?.packages[pkg]?.releases[0]?.version;

  return (
    <div class="dialog-backdrop" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class="dialog packages-dialog">
        <div class="dialog-title">Packages</div>

        {open ? (
          <PackagePage pkg={open} publisher={publisher?.name} catalog={catalog ?? null} workflows={workflows} peers={peers}
            onBack={() => setOpen(null)} onChanged={() => void loadCatalog()} />
        ) : (
          <>
            <div class="flyout-section">
              <PublisherHead publisher={publisher} onChanged={setPublisher} />
              {errors.catalog && <div class="auto-error">{errors.catalog}</div>}
              <div class="flyout-section-title">Here</div>
              {catalog === undefined && !errors.catalog && <div class="auto-hint">Loading…</div>}
              {catalog !== undefined && here.length === 0 && (
                <div class="auto-hint">
                  No packages yet. A workflow named <code>{publisher?.name ?? "publisher"}/&lt;package&gt;/&lt;workflow&gt;</code> is in that package, with the custom steps it runs.
                </div>
              )}
              {here.map((pkg) => (
                <button class="package-row" key={pkg} onClick={() => setOpen(pkg)} title={pkg}>
                  <span class="package-name">{packageLabel(pkg, publisher?.name)}</span>
                  {newest(pkg) && <span class="package-version">{newest(pkg)}</span>}
                </button>
              ))}
              {publisher?.name && props.onNewPackage && (
                <div class="package-new">
                  <input type="text" value={newPkg} placeholder="New package"
                    onInput={(e) => setNewPkg((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && segmentOk) { props.onNewPackage!(newPkg.trim()); setNewPkg(""); } }} />
                  <button class="btn" disabled={!segmentOk} onClick={() => { props.onNewPackage!(newPkg.trim()); setNewPkg(""); }}>Add</button>
                </div>
              )}
              {catalog && <div class="auto-meta package-signed">Catalog signed {ago(catalog.seq / 1e6)}</div>}
            </div>

            <div class="flyout-section">
              <div class="flyout-section-title">Following</div>
              {errors.subs && <div class="auto-error">{errors.subs}</div>}
              {subs === null && !errors.subs && <div class="auto-hint">Loading…</div>}
              {subs?.length === 0 && <div class="auto-hint">This strut follows no catalog.</div>}
              {subs?.map((s) => (
                <div class="auto-card" key={s.id}>
                  <div class="auto-card-head">
                    <span class="package-name">{s.id}</span>
                    <span class="badge">{s.channel ?? "newest releases"}</span>
                  </div>
                  <div class="auto-meta">
                    <span class="package-url">{s.url}</span>
                    {s.checkedAt && <span title={new Date(s.checkedAt).toLocaleString()}>checked {ago(secs(s.checkedAt))}</span>}
                    {s.applied && <span title={new Date(s.applied.at).toLocaleString()}>applied {ago(secs(s.applied.at))}</span>}
                  </div>
                  {s.error && <div class="auto-error">{s.error}</div>}
                  {s.warnings?.map((w, i) => <div class="auto-hint" key={i}>{w}</div>)}
                  {s.packages.length === 0 && <div class="auto-hint">Nothing installed from it yet.</div>}
                  {s.packages.map((p) => (
                    <div class="package-release-head" key={p.package}>
                      <span class="package-version">{p.package}</span>
                      {p.version && <span>{p.version}</span>}
                      {p.digest && <code class="package-digest" title={p.digest}>{shortDigest(p.digest)}</code>}
                      {p.diverged.length > 0 && (
                        <span class="badge badge-warning" title={`Edited here, so the release's version sits beside it: ${p.diverged.join(", ")}`}>
                          {p.diverged.length} edited here
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>

            <div class="flyout-section">
              <div class="flyout-section-title">Installed</div>
              {errors.installed && <div class="auto-error">{errors.installed}</div>}
              {installed === null && !errors.installed && <div class="auto-hint">Loading…</div>}
              {installed?.length === 0 && <div class="auto-hint">No packages installed.</div>}
              {installed?.map((p) => (
                <div class="auto-card" key={p.package}>
                  <div class="auto-card-head">
                    <span class="package-name">{p.package} {p.version && <span class="package-version">{p.version}</span>}</span>
                    {p.door && (
                      <span class="badge" title={p.door === "distro" ? "A subscription installed it: only the distro updates or removes it" : "A person installed it"}>
                        {p.door}
                      </span>
                    )}
                  </div>
                  <div class="auto-meta">
                    {p.source && <span class="package-url">{p.source.ref}</span>}
                    {p.digest && <code class="package-digest" title={p.digest}>{shortDigest(p.digest)}</code>}
                    {p.secrets?.length ? <span>reads {p.secrets.join(", ")}</span> : null}
                  </div>
                  <ul class="package-items">
                    {p.items.map((it) => (
                      <li key={`${it.kind}:${it.name}`}>
                        <span class="package-item-kind">{it.helper ? "helper" : it.kind}</span>
                        <span class="package-item-name">{it.name}</span>
                        {it.active && <span class="auto-meta">{it.active}</span>}
                        {it.modified && <span class="badge badge-warning" title={`Edited here: installed ${it.installed ?? "?"}, active ${it.active ?? "?"}`}>edited here</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </>
        )}

        <div class="dialog-actions">
          <button class="btn" onClick={props.onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
