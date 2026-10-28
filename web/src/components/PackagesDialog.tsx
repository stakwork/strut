import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { ago } from "./ClaimsPanel";
import { errorMessage } from "../helpers";
import { ConfirmButton } from "./ConfirmButton";
import { CopyButton } from "./CopyButton";

// ── Packages dialog ─────────────────────────────────────────────────────────
//
// What this strut shares and takes (plans/marketplace.md §12.1, §13;
// specs/API.md §16). "Published here" is the catalog it seals — each
// package's releases and what each channel holds; a person moves a channel
// or takes a package out of it. "Following" and "Installed" are a workspace
// strut's side, read only: the operator subscribes it (hive's cron), and
// what it installed is the fold of its versions. Publishing itself starts
// from a workflow's flyout (PublishPanel), never here.

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
    <div class="auto-card">
      <div class="auto-card-head">
        <span class="package-name">{props.name}</span>
      </div>
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

export function PackagesDialog(props: { onClose: () => void }) {
  const [catalog, setCatalog] = useState<api.Catalog | null | undefined>(undefined);
  const [publisher, setPublisher] = useState<api.PublisherInfo | null | undefined>(undefined);
  const [subs, setSubs] = useState<api.SubscriptionInfo[] | null>(null);
  const [installed, setInstalled] = useState<api.InstalledPackage[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const failed = (part: string) => (err: unknown) => setErrors((e) => ({ ...e, [part]: errorMessage(err) }));
  const loadCatalog = () => api.getCatalog().then(setCatalog, failed("catalog"));
  useEffect(() => {
    void loadCatalog();
    api.getPublisher().then(setPublisher, failed("catalog"));
    api.listSubscriptions().then(setSubs, failed("subs"));
    api.listInstalledPackages().then(setInstalled, failed("installed"));
  }, []);

  const names = catalog ? Object.keys(catalog.packages).sort() : [];

  return (
    <div class="dialog-backdrop" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class="dialog packages-dialog">
        <div class="dialog-title">Packages</div>

        <div class="flyout-section">
          <div class="flyout-section-title">Published here</div>
          {errors.catalog && <div class="auto-error">{errors.catalog}</div>}
          {publisher && (
            <div class="package-key">
              <span class="auto-meta">Publisher key</span>
              <code class="package-digest" title="What a subscribing strut follows">{publisher.key}</code>
              <CopyButton value={publisher.key} label="Copy the publisher key" />
            </div>
          )}
          {catalog === undefined && !errors.catalog && <div class="auto-hint">Loading…</div>}
          {catalog === null && (
            <div class="auto-hint">Nothing published from this strut yet. Publish a workflow from its Workflow flyout's Publish tab.</div>
          )}
          {catalog && <div class="auto-meta package-signed">Catalog signed {ago(catalog.seq / 1e6)}</div>}
          {catalog && names.map((n) => <CatalogPackage key={n} name={n} catalog={catalog} onChanged={() => void loadCatalog()} />)}
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

        <div class="dialog-actions">
          <button class="btn" onClick={props.onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
