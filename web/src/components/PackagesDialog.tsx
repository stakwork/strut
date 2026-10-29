import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import * as api from "../api";
import { ago } from "./ClaimsPanel";
import { errorMessage } from "../helpers";
import { PACKAGE_SEGMENT, comesAlong, isHostsStamp, isInstalledName, nextVersion, packageLabel, pickerGroups, picksFromRelease } from "../package-release";
import { canWords, indexIdOf, type InstallLink } from "../store-links";
import { ConfirmButton } from "./ConfirmButton";
import { CopyButton } from "./CopyButton";

// ── Packages dialog ─────────────────────────────────────────────────────────
//
// Packages live here and nowhere else (plans/packages-ux.md): names stay
// bare where they are made, the sidebar knows nothing of packages, and a
// package is what a person PICKS on its page. At the head, this strut's
// PUBLISHER: a name set once — the first segment of every package published
// here, which nobody types again — beside the key subscribers follow. Then
// the packages published HERE, one row each with its newest version, and
// "New package": a name, then the page. The PACKAGE PAGE lists every
// workflow here by category (an installed package's and the host's left
// out), apps and Concepts, starts from what the newest release held, shows
// what a dry build carries along with the picks, and publishes; below, the
// releases with what each channel holds. Then FIND: a search over the
// indexes this strut follows and its peers' installs, a hit installed by
// its NAME (the index's signed card names the key, so nothing in a search
// answer is trusted as is). Then, read only, what this strut FOLLOWS and has
// INSTALLED (specs/API.md §16). Publishing and installing are a person's
// acts; no builder tool does either.

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
export function CatalogPackage(props: { name: string; catalog: api.Catalog; publicChannels: string[]; onChanged: () => void }) {
  const entry = props.catalog.packages[props.name];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!entry) return null;
  const channels = channelNames(props.catalog);
  const held = (ch: string) => props.catalog.channels?.[ch]?.[props.name];
  const versionAt = (digest: string) => entry.releases.find((r) => r.digest === digest)?.version ?? shortDigest(digest);
  const holding = channels.filter((ch) => held(ch));
  const isPublic = (ch: string) => props.publicChannels.includes(ch);
  // A release is public once a public channel holds it, and stays so.
  const everPublic = (digest: string) => props.publicChannels.some((ch) => held(ch) === digest);

  const move = async (channel: string, digest: string | null, opts: { public?: boolean } = {}) => {
    setBusy(true);
    setError(null);
    try {
      await api.moveChannel(channel, props.name, digest, opts);
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
          <span class="package-channel-name"><ChannelBadge name={ch} public={isPublic(ch)} /> holds {versionAt(held(ch)!)}</span>
          <ConfirmButton class="btn" label="Take out" disabled={busy}
            note={isPublic(ch)
              ? `Take ${props.name} out of ${ch}? Its public catalog no longer offers it on ${ch}; what was published stays published.`
              : `Take ${props.name} out of ${ch}? Every strut that follows ${ch} uninstalls it (items edited there are kept).`}
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
                {on.map((ch) => <ChannelBadge key={ch} name={ch} public={isPublic(ch)} />)}
                {r.yanked && <span class="badge badge-warning" title={r.yanked}>yanked</span>}
                <code class="package-digest" title={r.digest}>{shortDigest(r.digest)}</code>
                {r.requires?.secrets?.length ? <span class="auto-meta">needs {r.requires.secrets.join(", ")}</span> : null}
              </div>
              {(offer.length > 0 || !everPublic(r.digest)) && (
                <div class="auto-card-actions">
                  {offer.map((ch) => (
                    <ConfirmButton key={ch} class="btn" label={`Put on ${ch}`} disabled={busy} tone="primary"
                      note={isPublic(ch)
                        ? `Put ${r.version} on ${ch}, a public channel? Anyone may install it from this strut's public catalog, and what was published stays published.`
                        : held(ch)
                          ? `Move ${ch} from ${versionAt(held(ch)!)} to ${r.version}? Every strut that follows ${ch} moves with it.`
                          : `Put ${r.version} on ${ch}? Every strut that follows ${ch} installs it.`}
                      confirmLabel={`Put on ${ch}`} onConfirm={() => void move(ch, r.digest)} />
                  ))}
                  {!everPublic(r.digest) && !channels.includes(api.PUBLIC_CHANNEL) && (
                    <ConfirmButton class="btn" label="Make public" disabled={busy} tone="primary"
                      note={`Make ${r.version} public? It is listed in this strut's PUBLIC catalog, sealed by a second key, on the channel ${api.PUBLIC_CHANNEL} — for anyone to install. What was published stays published.`}
                      confirmLabel="Make public" onConfirm={() => void move(api.PUBLIC_CHANNEL, r.digest, { public: true })} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A channel's badge: a public one says so. */
function ChannelBadge(props: { name: string; public: boolean }) {
  return (
    <span class={`badge ${props.public ? "badge-warning" : "badge-accent"}`} title={props.public ? "A public channel: in the public catalog, for anyone" : "A private channel: in the fleet catalog, for the struts that follow it"}>
      {props.name}{props.public && " · public"}
    </span>
  );
}

/** The publisher's name, set once (`PUT /publisher`), beside the keys. */
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
            <span class="auto-meta">fleet</span>
            <code class="package-digest" title="The FLEET key: what a subscribing strut follows">{props.publisher.key}</code>
            <CopyButton value={props.publisher.key} label="Copy the fleet key" />
          </span>
        )}
      </div>
      {props.publisher?.public && (
        <div class="publisher-head">
          <span class="package-key">
            <span class="auto-meta">public</span>
            <code class="package-digest" title="The PUBLIC key: seals the public catalog, the only key the world sees">{props.publisher.public}</code>
            <CopyButton value={props.publisher.public} label="Copy the public key" />
          </span>
        </div>
      )}
      {!name && props.publisher !== undefined && (
        <div class="auto-hint publisher-hint">
          The publisher is the first segment of every package published here (<code>stakwork</code> in <code>stakwork/tools</code>). Set it once.
        </div>
      )}
      {error && <div class="auto-error">{error}</div>}
    </>
  );
}

/** One package's page: what it holds, picked from everything here; what a
 *  dry build carries along; the form; and its releases. */
function PackagePage(props: {
  pkg: string;
  publisher?: string;
  catalog: api.Catalog | null;
  /** The channels in the public catalog (`GET /publisher`). */
  publicChannels: string[];
  workflows: api.WorkflowEntry[];
  apps: api.AppListEntry[];
  /** The installed packages' names: their items are someone else's. */
  installed: string[];
  /** Whether this strut has Concepts to offer (a graph). */
  concepts: boolean;
  peers: string[] | null;
  onBack: () => void;
  onChanged: () => void;
}) {
  const entry = props.catalog?.packages[props.pkg];
  const newest = entry?.releases[0];
  const [workflows, setWorkflows] = useState<Set<string>>(() => new Set());
  const [apps, setApps] = useState<Set<string>>(() => new Set());
  const [concepts, setConcepts] = useState<string[]>([]);
  const [conceptDraft, setConceptDraft] = useState("");
  const [conceptHits, setConceptHits] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [preview, setPreview] = useState<{ result?: api.BuildPreview; error?: string; busy?: boolean } | null>(null);
  const [version, setVersion] = useState(() => nextVersion(newest?.version));
  const [channel, setChannel] = useState("stable");
  const [description, setDescription] = useState(entry?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<api.PublishResult | null>(null);
  const taken = (entry?.releases ?? []).some((r) => r.version === version.trim());

  const groups = useMemo(() => pickerGroups(props.workflows, { installed: props.installed, q }), [props.workflows, props.installed, q]);
  const pickableApps = useMemo(
    () => props.apps.filter((a) => !a.peer && !isInstalledName(a.name, props.installed) && !isHostsStamp(a.publisher)).sort((a, b) => a.name.localeCompare(b.name)),
    [props.apps, props.installed],
  );

  // The boxes start as the newest release left them, once the lists are in.
  const seeded = useRef(!newest);
  useEffect(() => {
    if (seeded.current || !newest || props.workflows.length === 0) return;
    seeded.current = true;
    api.getPackageItems(props.pkg, newest.digest).then(
      (r) => {
        const picks = picksFromRelease(props.pkg, r.items, {
          workflows: new Set(props.workflows.map((w) => w.name)),
          apps: new Set(props.apps.map((a) => a.name)),
        });
        setWorkflows(new Set(picks.workflows));
        setApps(new Set(picks.apps));
        setConcepts(picks.concepts);
      },
      () => {},
    );
  }, [props.pkg, newest?.digest, props.workflows, props.apps]);

  // What a build of the picks carries, refused as a publish would be.
  const picks = useMemo(
    () => ({ workflows: [...workflows].sort(), apps: [...apps].sort(), concepts: [...concepts].sort() }),
    [workflows, apps, concepts],
  );
  const empty = picks.workflows.length + picks.apps.length + picks.concepts.length === 0;
  useEffect(() => {
    if (empty) {
      setPreview(null);
      return;
    }
    let live = true;
    setPreview((p) => ({ ...p, busy: true }));
    const t = setTimeout(() => {
      api.previewPackage({ package: props.pkg, version: "preview", ...picks }).then(
        (r) => live && setPreview({ result: r }),
        (err) => live && setPreview({ error: errorMessage(err) }),
      );
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [props.pkg, picks, empty]);
  const along = preview?.result ? comesAlong(props.pkg, preview.result.files, picks) : null;

  // Concept names, as typed: the graph's own names offered as they match.
  useEffect(() => {
    if (!props.concepts || !conceptDraft.trim()) {
      setConceptHits([]);
      return;
    }
    let live = true;
    void api.searchNodes("Concept", conceptDraft.trim(), 8).then((hits) => live && setConceptHits(hits.map((h) => h.name)));
    return () => {
      live = false;
    };
  }, [conceptDraft, props.concepts]);
  const addConcept = () => {
    const name = conceptDraft.trim();
    if (name && !concepts.includes(name)) setConcepts([...concepts, name]);
    setConceptDraft("");
  };

  const toggle = (set: Set<string>, put: (s: Set<string>) => void, name: string) => {
    const next = new Set(set);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    put(next);
  };
  const publish = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.publishPackage({
        package: props.pkg,
        version: version.trim(),
        workflows: picks.workflows,
        ...(picks.apps.length ? { apps: picks.apps } : {}),
        ...(picks.concepts.length ? { concepts: picks.concepts } : {}),
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
        <button class="auto-link" onClick={props.onBack}>← Packages</button>
        <span class="package-name" title={props.pkg}>{packageLabel(props.pkg, props.publisher)}</span>
        {newest && <span class="package-version">{newest.version}</span>}
      </div>
      <div class="dialog-field">
        <label>Workflows</label>
        {props.workflows.length > 8 && (
          <input type="text" class="package-filter" value={q} placeholder="Filter by name or category"
            onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        )}
        {groups.length === 0 && <div class="auto-hint">{q ? "Nothing matches." : "No workflows here yet."}</div>}
        {groups.map((g) => (
          <div class="package-group" key={g.category ?? ""}>
            <div class="package-group-title">{g.category ?? "No category"}</div>
            {g.names.map((n) => (
              <label class="package-workflow" key={n}>
                <input type="checkbox" checked={workflows.has(n)} onChange={() => toggle(workflows, setWorkflows, n)} />
                {n}
              </label>
            ))}
          </div>
        ))}
      </div>
      {pickableApps.length > 0 && (
        <div class="dialog-field">
          <label>Apps</label>
          {pickableApps.map((a) => (
            <label class="package-workflow" key={a.name} title={a.name}>
              <input type="checkbox" checked={apps.has(a.name)} onChange={() => toggle(apps, setApps, a.name)} />
              {a.title || a.name}
            </label>
          ))}
        </div>
      )}
      {props.concepts && (
        <div class="dialog-field">
          <label>Concepts</label>
          {concepts.length > 0 && (
            <div class="package-chips">
              {concepts.map((c) => (
                <span class="badge package-chip" key={c}>
                  {c}
                  <button class="auto-link" aria-label={`Remove ${c}`} onClick={() => setConcepts(concepts.filter((x) => x !== c))}>×</button>
                </span>
              ))}
            </div>
          )}
          <input type="text" value={conceptDraft} list="package-concepts" placeholder="A Concept page, with the pages under it"
            onInput={(e) => setConceptDraft((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === "Enter") addConcept(); }} />
          <datalist id="package-concepts">
            {conceptHits.map((h) => <option key={h} value={h} />)}
          </datalist>
        </div>
      )}
      {!empty && (
        <div class="package-along">
          {preview?.error ? (
            <div class="auto-error package-refusal">{preview.error}</div>
          ) : along ? (
            <>
              {along.steps.length + along.workflows.length + along.apps.length > 0 && (
                <div class="auto-hint">
                  Comes along: {[
                    ...along.workflows.map((w) => `the workflow ${w}`),
                    ...along.steps.map((x) => `the step ${x}`),
                    ...along.apps.map((x) => `the app ${x}`),
                  ].join(", ")}.
                </div>
              )}
              {along.leftOut.length > 0 && (
                <div class="auto-hint">
                  Not carried, since every strut has its own: {along.leftOut.join(", ")}.
                </div>
              )}
              {preview?.result?.requires.secrets?.length ? (
                <div class="auto-hint">Needs the secret{preview.result.requires.secrets.length === 1 ? "" : "s"} {preview.result.requires.secrets.join(", ")}.</div>
              ) : null}
              {preview?.result?.warnings.map((w, i) => <div class="auto-hint package-warning" key={i}>{w}</div>)}
            </>
          ) : (
            <div class="auto-hint">Reading what comes along…</div>
          )}
        </div>
      )}
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
        {props.publicChannels.includes(channel.trim()) && <div class="auto-hint">{channel.trim()} is public: the release is listed in the public catalog, for anyone.</div>}
      </div>
      <div class="dialog-field">
        <label>Description</label>
        <input type="text" value={description} placeholder="What the package does (optional)"
          onInput={(e) => setDescription((e.target as HTMLInputElement).value)} />
      </div>
      <div class="auto-hint">
        {newest ? "A workflow the last release held and this one leaves out is removed from the struts that follow the channel. " : ""}
        {props.peers === null ? "" : props.peers.length > 0
          ? <>Publishing pings {props.peers.map((p, i) => <span key={p}>{i > 0 && ", "}<code>{p}</code></span>)}, so the struts that follow this catalog read it now.</>
          : "No peers on file: struts that follow this catalog pick the release up at their next poll."}
      </div>
      <div class="package-publish-actions">
        <button class="btn btn-primary" disabled={busy || !version.trim() || empty} onClick={() => void publish()}>
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
        {props.catalog && entry && <CatalogPackage name={props.pkg} catalog={props.catalog} publicChannels={props.publicChannels} onChanged={props.onChanged} />}
      </div>
    </>
  );
}

/** "New package": a name, one segment, under this strut's publisher — then
 *  its page. A name already published opens that package. */
function NewPackage(props: { publisher?: string; onOpen: (pkg: string) => void }) {
  const [draft, setDraft] = useState("");
  const name = draft.trim();
  const ok = PACKAGE_SEGMENT.test(name);
  const open = () => {
    if (props.publisher && ok) props.onOpen(`${props.publisher}/${name}`);
  };
  return (
    <div class="package-new">
      <input type="text" value={draft} placeholder={props.publisher ? "tools" : "Set the publisher first"} disabled={!props.publisher}
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === "Enter") open(); }} />
      <button class="btn" disabled={!props.publisher || !ok} onClick={open}>New package</button>
      {name && !ok && <div class="auto-hint">Lowercase letters, digits and dashes, starting with a letter.</div>}
    </div>
  );
}

/** Find a package: the indexes this strut follows and the peers' installs.
 *  `initial` is the store front's link (`?install=`, ../store-links.ts): the
 *  search starts on that name, and when the link names an index this strut
 *  does not follow, following it comes first — one tap, the key the signed
 *  card will be checked against being the link's. */
function FindPackages(props: { installed: string[]; initial?: InstallLink | null; onInstalled: () => void }) {
  const [indexes, setIndexes] = useState<api.PackageIndexInfo[] | null>(null);
  const [q, setQ] = useState(props.initial?.pkg ?? "");
  const [found, setFound] = useState<api.PackageSearch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ pkg: string; text: string; ok: boolean } | null>(null);
  const [following, setFollowing] = useState<string | null>(null);
  const [searchSeq, setSearchSeq] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    api.listPackageIndexes().then(setIndexes, (err) => setError(errorMessage(err)));
  }, []);
  // A search per pause in the typing; only the newest answer is shown.
  useEffect(() => {
    const mine = ++seq.current;
    const t = setTimeout(() => {
      api.searchPackages(q.trim()).then(
        (r) => { if (seq.current === mine) { setFound(r); setError(null); } },
        (err) => { if (seq.current === mine) setError(errorMessage(err)); },
      );
    }, 250);
    return () => clearTimeout(t);
  }, [q, searchSeq]);

  // The link's index, when this strut follows no index with that key.
  const linkedIndex = props.initial?.index;
  const unfollowed = linkedIndex && indexes !== null && !indexes.some((ix) => ix.key === linkedIndex.key) ? linkedIndex : null;
  const follow = async () => {
    if (!unfollowed) return;
    setFollowing("…");
    try {
      const id = indexIdOf(unfollowed.url);
      const r = await api.followPackageIndex(id, { key: unfollowed.key, urls: [unfollowed.url], label: id });
      setIndexes((all) => [...(all ?? []).filter((ix) => ix.id !== r.id), r]);
      setFollowing(r.error ? `Followed, but its card could not be read: ${r.error}` : null);
      setSearchSeq((n) => n + 1);
    } catch (err) {
      setFollowing(errorMessage(err));
    }
  };

  const install = async (pkg: string, index: string) => {
    setBusy(pkg);
    setOutcome(null);
    try {
      const r = await api.installPackage(pkg, { index });
      const needs = [...r.missing.secrets.map((s) => `secret ${s}`), ...r.missing.binaries, ...r.missing.runtimes];
      setOutcome({ pkg, ok: true, text: `Installed ${r.package}.${needs.length ? ` It needs ${needs.join(", ")}.` : ""}` });
      props.onInstalled();
    } catch (err) {
      setOutcome({ pkg, ok: false, text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const none = indexes !== null && indexes.length === 0;
  return (
    <div class="flyout-section">
      <div class="flyout-section-title">Find</div>
      {props.initial && (
        <div class="auto-card">
          <div class="auto-card-head"><span class="package-name">{props.initial.pkg}</span><span class="badge badge-accent">from the store</span></div>
          {unfollowed ? (
            <>
              <div class="auto-hint">The store that linked here is an index this strut does not follow yet: <span class="package-url">{unfollowed.url}</span>. Following it reads its signed card, which names the publisher's key an install is checked against.</div>
              <div class="auto-card-actions">
                <button class="btn btn-sm btn-primary" disabled={following === "…"} onClick={() => void follow()}>{following === "…" ? "Following…" : "Follow this index"}</button>
              </div>
              {following && following !== "…" && <div class="auto-error">{following}</div>}
            </>
          ) : (
            <div class="auto-hint">Install it below once it shows; its code will run on this strut.</div>
          )}
        </div>
      )}
      <input class="package-search" type="text" placeholder="Search packages" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      {indexes && (
        <div class="auto-meta">
          {none ? (
            <span>This strut follows no index: only the peers' installs are searched.</span>
          ) : (
            indexes.map((ix) => (
              <span key={ix.id} title={ix.error ?? ix.urls.join("\n")}>
                {ix.label ?? ix.id}{ix.error ? " (unreachable)" : ix.read ? ` · ${ix.read.publishers} publishers` : ""}
              </span>
            ))
          )}
        </div>
      )}
      {error && <div class="auto-error">{error}</div>}
      {found?.errors.map((e, i) => <div class="auto-hint" key={i}>{e.index ? `Index ${e.index}` : `@${e.peer}`}: {e.error}</div>)}
      {found && found.packages.length === 0 && found.peers.length === 0 && <div class="auto-hint">{q.trim() ? "Nothing matches." : "Nothing listed yet."}</div>}
      {found?.packages.map((h) => {
        const have = props.installed.includes(h.package);
        return (
          <div class="auto-card" key={`${h.index}:${h.package}`}>
            <div class="auto-card-head">
              <span class="package-name">{h.package} <span class="package-version">{h.version}</span></span>
              {have ? (
                <span class="badge">installed</span>
              ) : (
                <button class="btn btn-sm" disabled={busy !== null} onClick={() => void install(h.package, h.index)} title={`Installs ${h.package} from the catalog the index ${h.index} names for ${h.publisher}. Its code runs on this strut.`}>
                  {busy === h.package ? "Installing…" : "Install"}
                </button>
              )}
            </div>
            {h.description && <div class="auto-hint">{h.description}</div>}
            <div class="auto-meta">
              <span>{h.index}</span>
              {h.license && <span>{h.license}</span>}
              <code class="package-digest" title={h.digest}>{shortDigest(h.digest)}</code>
            </div>
            {h.detail && (
              <div class="auto-meta" title="Read off the release's archive by the index: what it brings, what running it reaches, the secrets it names">
                <span>brings {[h.detail.apps.length && `${h.detail.apps.length} app${h.detail.apps.length === 1 ? "" : "s"}`, h.detail.workflows && `${h.detail.workflows} workflow${h.detail.workflows === 1 ? "" : "s"}`, h.detail.steps && `${h.detail.steps} step${h.detail.steps === 1 ? "" : "s"}`, h.detail.concepts && `${h.detail.concepts} concept${h.detail.concepts === 1 ? "" : "s"}`].filter(Boolean).join(", ") || "nothing"}</span>
                <span>{canWords(h.detail.can).join(" · ")}</span>
                {h.detail.secrets.length > 0 && <span>needs {h.detail.secrets.join(", ")}</span>}
              </div>
            )}
            {outcome?.pkg === h.package && <div class={outcome.ok ? "auto-hint" : "auto-error"}>{outcome.text}</div>}
          </div>
        );
      })}
      {found && found.peers.length > 0 && (
        <>
          <div class="auto-meta">On the peers</div>
          {found.peers.map((p) => (
            <div class="package-release-head" key={`${p.peer}:${p.package}`}>
              <span class="package-version">{p.package}</span>
              {p.version && <span>{p.version}</span>}
              <span class="badge">@{p.peer}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export function PackagesDialog(props: { install?: InstallLink | null; onClose: () => void }) {
  const [catalog, setCatalog] = useState<api.Catalog | null | undefined>(undefined);
  const [publisher, setPublisher] = useState<api.PublisherInfo | null | undefined>(undefined);
  const [workflows, setWorkflows] = useState<api.WorkflowEntry[]>([]);
  const [apps, setApps] = useState<api.AppListEntry[]>([]);
  const [hasConcepts, setHasConcepts] = useState(false);
  const [peers, setPeers] = useState<string[] | null>(null);
  const [subs, setSubs] = useState<api.SubscriptionInfo[] | null>(null);
  const [installed, setInstalled] = useState<api.InstalledPackage[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);

  const failed = (part: string) => (err: unknown) => setErrors((e) => ({ ...e, [part]: errorMessage(err) }));
  const loadCatalog = () => api.getCatalog().then(setCatalog, failed("catalog"));
  useEffect(() => {
    void loadCatalog();
    api.getPublisher().then(setPublisher, failed("catalog"));
    api.listWorkflows().then(setWorkflows, failed("catalog"));
    api.listApps().then(setApps, () => setApps([]));
    void api.searchNodes("Concept", "", 1).then((hits) => setHasConcepts(hits.length > 0));
    api.listPeers().then((p) => setPeers(p.map((x) => x.id)), () => setPeers([]));
    api.listSubscriptions().then(setSubs, failed("subs"));
    api.listInstalledPackages().then(setInstalled, failed("installed"));
  }, []);

  // The packages published here: the catalog's.
  const here = useMemo(() => Object.keys(catalog?.packages ?? {}).sort(), [catalog]);
  const installedNames = useMemo(() => (installed ?? []).map((p) => p.package), [installed]);
  const newest = (pkg: string) => catalog?.packages[pkg]?.releases[0]?.version;

  return (
    <div class="dialog-backdrop" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class="dialog packages-dialog">
        <div class="dialog-title">Packages</div>

        {open ? (
          <PackagePage key={open} pkg={open} publisher={publisher?.name} catalog={catalog ?? null} publicChannels={publisher?.publicChannels ?? []}
            workflows={workflows} apps={apps} installed={installedNames} concepts={hasConcepts} peers={peers}
            onBack={() => setOpen(null)} onChanged={() => { void loadCatalog(); api.getPublisher().then(setPublisher, failed("catalog")); }} />
        ) : (
          <>
            <div class="flyout-section">
              <PublisherHead publisher={publisher} onChanged={setPublisher} />
              {errors.catalog && <div class="auto-error">{errors.catalog}</div>}
              <div class="flyout-section-title">Here</div>
              {catalog === undefined && !errors.catalog && <div class="auto-hint">Loading…</div>}
              {catalog !== undefined && here.length === 0 && (
                <div class="auto-hint">Nothing published from here yet. Name a package, then pick the workflows it holds.</div>
              )}
              {here.map((pkg) => (
                <button class="package-row" key={pkg} onClick={() => setOpen(pkg)} title={pkg}>
                  <span class="package-name">{packageLabel(pkg, publisher?.name)}</span>
                  {newest(pkg) && <span class="package-version">{newest(pkg)}</span>}
                </button>
              ))}
              <NewPackage publisher={publisher?.name} onOpen={setOpen} />
              {catalog && <div class="auto-meta package-signed">Catalog signed {ago(catalog.seq / 1e6)}</div>}
            </div>

            <FindPackages installed={installedNames} initial={props.install} onInstalled={() => api.listInstalledPackages().then(setInstalled, failed("installed"))} />

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
