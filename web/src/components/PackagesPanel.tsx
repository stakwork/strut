import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import * as api from "../api";
import { EarningsLine, useEarnings } from "./EarningsLine";
import { ago } from "./ClaimsPanel";
import { errorMessage } from "../helpers";
import { PACKAGE_SEGMENT, byNamespace, comesAlong, installProgressText, isHostsStamp, isInstalledName, nextVersion, packageLabel, pickerGroups, picksFromRelease } from "../package-release";
import { canWords, indexIdOf, type InstallLink } from "../store-links";
import { ConfirmButton } from "./ConfirmButton";
import { CopyButton } from "./CopyButton";

// ── Packages (the Publish dialog's Packages tab) ────────────────────────────
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
                        ? `Put ${r.version} on ${ch}, a public channel? Anyone may install it from this strut server's public catalog, and what was published stays published.`
                        : held(ch)
                          ? `Move ${ch} from ${versionAt(held(ch)!)} to ${r.version}? Every strut that follows ${ch} moves with it.`
                          : `Put ${r.version} on ${ch}? Every strut that follows ${ch} installs it.`}
                      confirmLabel={`Put on ${ch}`} onConfirm={() => void move(ch, r.digest)} />
                  ))}
                  {!everPublic(r.digest) && !channels.includes(api.PUBLIC_CHANNEL) && (
                    <ConfirmButton class="btn" label="Make public" disabled={busy} tone="primary"
                      note={`Make ${r.version} public? It is listed in this strut server's PUBLIC catalog, sealed by a second key, on the channel ${api.PUBLIC_CHANNEL} — for anyone to install. What was published stays published.`}
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

/** Why a listing request waits for the index's operator, in words. */
export const WAIT_WORDS: Record<api.PendingListing["reason"], string> = {
  host: "this server's host is not one the index lists with no person",
  "second name": "this key already holds another name there",
  "same host": "this server's host already holds a name there",
  move: "the name is moving to another host",
  takeover: "another key holds the name",
  "live row": "the name already shows a server's public view there, listed by the index's operator",
};

/** Where this server is reached, as a listing names it: the page's origin and its mount. */
const defaultBase = () => `${location.origin}${api.API_BASE}`.replace(/\/+$/, "");

/** The indexes this strut could be listed on (plans/index-listing.md §1):
 *  one line each — listed (read off the index's signed card), waiting for
 *  its operator, refused — with List, Change and Take off. Each ask is a
 *  request sealed by the PUBLIC key, sent from this server. */
function ListingLines(props: { publisher: api.PublisherInfo }) {
  const [lines, setLines] = useState<api.ListingLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ index: string; base: string; description: string; url: string; live: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const load = () => api.listListings().then(setLines, (err) => setError(errorMessage(err)));
  useEffect(() => {
    void load();
  }, [props.publisher.public, props.publisher.name]);
  if (!props.publisher.public || !props.publisher.name || !lines?.length) return error ? <div class="auto-error">{error}</div> : null;

  const open = (l: api.ListingLine) =>
    setForm({
      index: l.index,
      base: l.asked?.base ?? defaultBase(),
      description: l.asked?.description ?? l.row?.description ?? "",
      url: l.asked?.url ?? l.row?.url ?? "",
      live: l.asked?.live ?? false,
    });
  const send = async () => {
    if (!form) return;
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      // `live` only when it says something: on, or off after this server asked
      // for it. Left out, the index leaves a live row under the name alone.
      const askedLive = lines?.find((l) => l.index === form.index)?.asked?.live === true;
      const live = form.live ? { live: true } : askedLive ? { live: false } : {};
      const r = await api.askListing({ index: form.index, base: form.base.trim(), ...(form.description.trim() ? { description: form.description.trim() } : {}), ...(form.url.trim() ? { url: form.url.trim() } : {}), ...live });
      setSaid(r.status === "listed" ? "Listed." : `Sent: waiting for the index's operator — ${WAIT_WORDS[r.reason as api.PendingListing["reason"]] ?? r.reason}.`);
      setForm(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      void load();
    }
  };
  const takeOff = async (index: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.withdrawListing(index);
      setSaid("Taken off the index.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      void load();
    }
  };

  return (
    <div class="listing-lines">
      {lines.map((l) => {
        const name = l.label ?? l.index;
        const waiting = !l.listed && l.asked?.status === "pending";
        return (
          <div class="listing-line" key={l.index}>
            <span class="auto-meta">{name}</span>
            {l.listed ? (
              <span class="badge badge-accent" title={`${props.publisher.name} is on ${name}'s signed card with this server's public key`}>Listed</span>
            ) : l.heldBy ? (
              <span class="badge badge-warning" title={`Another key holds ${props.publisher.name} there: ${l.heldBy}`}>Name held by another key</span>
            ) : waiting ? (
              <span class="badge" title={l.asked?.reason ? WAIT_WORDS[l.asked.reason as api.PendingListing["reason"]] ?? l.asked.reason : undefined}>Waiting for approval</span>
            ) : l.asked?.status === "refused" ? (
              <span class="badge badge-warning" title={l.asked.reason}>Refused</span>
            ) : null}
            {!l.requests ? (
              <span class="auto-hint">Its card is a file: ask its operator to list this server.</span>
            ) : l.listed ? (
              <>
                <button class="btn btn-sm" disabled={busy} onClick={() => open(l)}>Change</button>
                <ConfirmButton class="btn btn-sm btn-danger" label="Take off" note={`Take ${props.publisher.name} off ${name}: new installs stop finding it by name. Copies already installed keep working.`} confirmLabel="Take off" tone="danger" disabled={busy} onConfirm={() => void takeOff(l.index)} />
              </>
            ) : waiting ? (
              <button class="btn btn-sm" disabled={busy} onClick={() => void takeOff(l.index)}>Withdraw</button>
            ) : (
              <button class="btn btn-sm btn-primary" disabled={busy} onClick={() => open(l)}>List on {name}</button>
            )}
            {l.asked?.status === "refused" && l.asked.reason && <div class="auto-error">{l.asked.reason.replace(/^listing_refused: /, "Refused: ")}</div>}
            {l.asked?.status === "error" && l.asked.reason && !l.listed && <div class="auto-error">{l.asked.reason}</div>}
            {l.cardError && <div class="auto-hint">Its card could not be read: {l.cardError}</div>}
            {form?.index === l.index && (
              <div class="listing-form">
                <label>
                  <span class="auto-meta">This server's address</span>
                  <input type="text" value={form.base} onInput={(e) => setForm({ ...form, base: (e.target as HTMLInputElement).value })} />
                </label>
                <label>
                  <span class="auto-meta">Description</span>
                  <input type="text" maxLength={280} value={form.description} placeholder="What your packages do" onInput={(e) => setForm({ ...form, description: (e.target as HTMLInputElement).value })} />
                </label>
                <label>
                  <span class="auto-meta">Homepage</span>
                  <input type="text" value={form.url} placeholder="https://" onInput={(e) => setForm({ ...form, url: (e.target as HTMLInputElement).value })} />
                </label>
                <label class="listing-check">
                  <input type="checkbox" checked={form.live} onChange={(e) => setForm({ ...form, live: (e.target as HTMLInputElement).checked })} />
                  <span>Also show this server's public view in the store</span>
                </label>
                <div class="auto-hint">
                  {name} reads this server's public catalog at that address and checks it is signed with this server's public key. Then it lists <code>{props.publisher.name}</code> at once, or its operator decides.
                </div>
                <div class="auto-card-actions">
                  <button class="btn btn-primary" disabled={busy || !form.base.trim()} onClick={() => void send()}>{busy ? "Sending…" : l.listed ? "Send the change" : "Ask to be listed"}</button>
                  <button class="btn" disabled={busy} onClick={() => setForm(null)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {said && <div class="auto-hint">{said}</div>}
      {error && <div class="auto-error">{error}</div>}
    </div>
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
  peers: string[] | null;
  onBack: () => void;
  onChanged: () => void;
}) {
  const entry = props.catalog?.packages[props.pkg];
  const newest = entry?.releases[0];
  const [workflows, setWorkflows] = useState<Set<string>>(() => new Set());
  const [apps, setApps] = useState<Set<string>>(() => new Set());
  const [concepts, setConcepts] = useState<string[]>([]);
  /** The Concepts picked ALONE, without the pages under them (a subset of `concepts`). */
  const [alone, setAlone] = useState<Set<string>>(() => new Set());
  const [conceptDraft, setConceptDraft] = useState("");
  const [conceptHits, setConceptHits] = useState<string[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [typeDraft, setTypeDraft] = useState("");
  const [graphTypes, setGraphTypes] = useState<api.GraphType[]>([]);
  useEffect(() => {
    void api.listGraphTypes().then(setGraphTypes);
  }, []);
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
        setConcepts([...picks.concepts, ...picks.conceptsAlone].sort());
        setAlone(new Set(picks.conceptsAlone));
        setTypes(picks.types);
      },
      () => {},
    );
  }, [props.pkg, newest?.digest, props.workflows, props.apps]);

  // What a build of the picks carries, refused as a publish would be.
  const picks = useMemo(
    () => ({
      workflows: [...workflows].sort(),
      apps: [...apps].sort(),
      concepts: concepts.filter((c) => !alone.has(c)).sort(),
      conceptsAlone: concepts.filter((c) => alone.has(c)).sort(),
      types: [...types].sort(),
    }),
    [workflows, apps, concepts, alone, types],
  );
  const empty = picks.workflows.length + picks.apps.length + picks.concepts.length + picks.conceptsAlone.length + picks.types.length === 0;
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
  const along = preview?.result ? comesAlong(props.pkg, preview.result.files, picks, preview.result) : null;

  // Concept names, as typed: the graph's own names offered as they match.
  useEffect(() => {
    if (!conceptDraft.trim()) {
      setConceptHits([]);
      return;
    }
    let live = true;
    void api.searchNodes("Concept", conceptDraft.trim(), 8).then((hits) => live && setConceptHits(hits.map((h) => h.name)));
    return () => {
      live = false;
    };
  }, [conceptDraft]);
  const addConcept = () => {
    const name = conceptDraft.trim();
    if (name && !concepts.includes(name)) setConcepts([...concepts, name]);
    setConceptDraft("");
  };

  const addTypes = (draft = typeDraft) => {
    // One name or several, as typed: `Document, Section Excerpt`.
    const names = draft.split(/[\s,]+/).filter(Boolean);
    setTypes((was) => [...was, ...names.filter((n) => !was.some((t) => t.toLowerCase() === n.toLowerCase()))]);
    setTypeDraft("");
  };
  const addConcepts = (names: string[]) => setConcepts((was) => [...was, ...names.filter((n) => !was.includes(n))]);
  // What the picked workflows' runs wrote and read, not picked yet.
  const suggested = preview?.result?.suggested;
  const typeIdeas = (suggested?.types ?? []).filter((t) => !types.some((x) => x.toLowerCase() === t.toLowerCase()));
  const conceptIdeas = (suggested?.concepts ?? []).filter((c) => !concepts.includes(c));

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
        ...(picks.conceptsAlone.length ? { conceptsAlone: picks.conceptsAlone } : {}),
        ...(picks.types.length ? { types: picks.types } : {}),
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
      <div class="dialog-field">
        <label>Concepts</label>
        {concepts.length > 0 && (
          <div class="package-chips">
            {concepts.map((c) => (
              <span class="badge package-chip" key={c}>
                {c}
                <button
                  class="auto-link package-chip-mode"
                  title={alone.has(c) ? "This page alone: the pages under it here stay here. Click to bring them too" : "With every page under it. Click to carry this page alone"}
                  onClick={() => setAlone((was) => { const next = new Set(was); if (next.has(c)) next.delete(c); else next.add(c); return next; })}
                >
                  {alone.has(c) ? "alone" : "with its pages"}
                </button>
                <button class="auto-link" aria-label={`Remove ${c}`} onClick={() => { setConcepts(concepts.filter((x) => x !== c)); setAlone((was) => { const next = new Set(was); next.delete(c); return next; }); }}>×</button>
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
        <Ideas label="Read by these workflows' runs (each with its whole tree)" names={conceptIdeas} add={addConcepts} />
      </div>
      <div class="dialog-field">
        <label>Graph types</label>
        {types.length > 0 && (
          <div class="package-chips">
            {types.map((t) => (
              <span class="badge package-chip" key={t}>
                {t}
                <button class="auto-link" aria-label={`Remove ${t}`} onClick={() => setTypes(types.filter((x) => x !== t))}>×</button>
              </span>
            ))}
          </div>
        )}
        <input type="text" value={typeDraft} list="package-types" placeholder="A node type the workflows write, with its parents and edges"
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            // A pick from the list is a whole name: add it at once.
            if (graphTypes.some((g) => g.type === v)) addTypes(v);
            else setTypeDraft(v);
          }}
          onKeyDown={(e) => { if (e.key === "Enter") addTypes(); }} />
        <datalist id="package-types">
          {graphTypes.filter((g) => !STRUTS_OWN_TYPES.has(g.type) && !types.includes(g.type)).map((g) => <option key={g.type} value={g.type}>{g.description ?? g.domain ?? ""}</option>)}
        </datalist>
        <Ideas label="Written by these workflows' runs" names={typeIdeas} add={(names) => addTypes(names.join(" "))} />
      </div>
      {!empty && (
        <div class="package-along">
          {preview?.error ? (
            <div class="auto-error package-refusal">{preview.error}</div>
          ) : along ? (
            <>
              <ComesAlong along={along} secrets={preview?.result?.requires.secrets ?? []} />
              {along.leftOut.length > 0 && (
                <div class="auto-hint">
                  Not carried, since every strut has its own: {along.leftOut.join(", ")}.
                </div>
              )}
              {along.warnings.map((w, i) => <div class="auto-hint package-warning" key={i}>{w}</div>)}
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
      <PackageEarnings pkg={props.pkg} />
      <div class="flyout-section">
        <div class="flyout-section-title">Releases</div>
        {!entry && <div class="auto-hint">Not published yet.</div>}
        {props.catalog && entry && <CatalogPackage name={props.pkg} catalog={props.catalog} publicChannels={props.publicChannels} onChanged={props.onChanged} />}
      </div>
    </>
  );
}

/** What the package's workflows and tools earned on THIS server (plans/
 *  paid-runs.md §8): every item under its prefix, summed, then each. A copy
 *  installed elsewhere earns for that server. Nothing until one is sold. */
function PackageEarnings(props: { pkg: string }) {
  const view = useEarnings({ by: "item", prefix: props.pkg });
  if (!view || view.rows.length === 0) return null;
  return (
    <div class="flyout-section">
      <div class="flyout-section-title">Earnings here</div>
      <EarningsLine label="All its items" row={view.totals} />
      {view.rows.map((r) => (
        <div key={r.key} class="package-earnings-row">
          <span class="package-name">{r.key.slice(r.key.indexOf(":") + 1)}</span>
          <EarningsLine row={r} {...(r.price ? { price: r.price } : {})} />
        </div>
      ))}
    </div>
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
  // The install going now — this tab's, or one another door started (the
  // boot list, a proposal, a subscription) — followed until it ends.
  const [running, setRunning] = useState<api.PackageInstallState | null>(null);
  const onInstalled = useRef(props.onInstalled);
  onInstalled.current = props.onInstalled;

  useEffect(() => {
    api.listPackageIndexes().then(setIndexes, (err) => setError(errorMessage(err)));
  }, []);
  const id = running && !running.finishedAt ? running.id : null;
  // While none is followed, another door's is looked for every 2 s.
  useEffect(() => {
    if (id) return;
    let stop = false;
    const look = () =>
      api.listPackageInstalls().then((all) => {
        const going = all.find((s) => !s.finishedAt);
        if (going && !stop) setRunning((mine) => (mine && !mine.finishedAt ? mine : going));
      }, () => undefined);
    void look();
    const t = setInterval(() => void look(), 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [id]);
  useEffect(() => {
    if (!id) return;
    let stop = false;
    const tick = async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, 600));
        if (stop) return;
        let s: api.PackageInstallState;
        try {
          s = await api.getPackageInstall(id);
        } catch {
          continue; // a dropped read: the next one
        }
        if (stop) return;
        setRunning(s);
        if (!s.finishedAt) continue;
        const pkg = s.result?.package ?? s.ref;
        if (s.status === "done" && s.result) {
          const needs = [...s.result.missing.secrets.map((x) => `secret ${x}`), ...s.result.missing.binaries, ...s.result.missing.runtimes];
          setOutcome({ pkg: s.ref, ok: true, text: `Installed ${pkg}.${needs.length ? ` It needs ${needs.join(", ")}.` : ""}` });
          onInstalled.current();
        } else setOutcome({ pkg: s.ref, ok: false, text: s.error ?? "The install failed." });
        setBusy(null);
        return;
      }
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [id]);
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

  // Started at once and followed: a package of hundreds of Concept pages
  // takes a while, and the request would otherwise wait it out silently.
  const install = async (pkg: string, index: string) => {
    setBusy(pkg);
    setOutcome(null);
    try {
      setRunning(await api.startPackageInstall(pkg, { index }));
    } catch (err) {
      setOutcome({ pkg, ok: false, text: errorMessage(err) });
      setBusy(null);
    }
  };
  const going = running && !running.finishedAt ? running : null;
  /** The install's line and bar. */
  const progressOf = (s: api.PackageInstallState) => {
    const { text, fraction } = installProgressText(s);
    return (
      <div class="install-progress" title={s.package ? `${s.package}: ${text}` : text}>
        <span>{text}</span>
        {fraction !== undefined && (
          <span class="install-progress-bar">
            <span style={{ width: `${Math.round(fraction * 100)}%` }} />
          </span>
        )}
      </div>
    );
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
              <div class="auto-hint">The store that linked here is an index this strut server does not follow yet: <span class="package-url">{unfollowed.url}</span>. Following it reads its signed card, which names the publisher's key an install is checked against.</div>
              <div class="auto-card-actions">
                <button class="btn btn-sm btn-primary" disabled={following === "…"} onClick={() => void follow()}>{following === "…" ? "Following…" : "Follow this index"}</button>
              </div>
              {following && following !== "…" && <div class="auto-error">{following}</div>}
            </>
          ) : (
            <div class="auto-hint">Install it below once it shows; its code will run on this strut server.</div>
          )}
        </div>
      )}
      {going && !found?.packages.some((h) => h.package === going.ref) && (
        <div class="auto-card">
          <div class="auto-card-head">
            <span class="package-name">{going.ref}</span>
            <span class="badge">{going.door === "distro" ? "from a subscription" : "installing"}</span>
          </div>
          {progressOf(going)}
        </div>
      )}
      {outcome && !found?.packages.some((h) => h.package === outcome.pkg) && <div class={outcome.ok ? "auto-hint" : "auto-error"}>{outcome.text}</div>}
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
                <button class="btn btn-sm" disabled={busy !== null || going !== null} onClick={() => void install(h.package, h.index)} title={`Installs ${h.package} from the catalog the index ${h.index} names for ${h.publisher}. Its code runs on this strut server.`}>
                  {busy === h.package || going?.ref === h.package ? "Installing…" : "Install"}
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
            {going?.ref === h.package && progressOf(going)}
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

export function PackagesPanel(props: { install?: InstallLink | null }) {
  const [catalog, setCatalog] = useState<api.Catalog | null | undefined>(undefined);
  const [publisher, setPublisher] = useState<api.PublisherInfo | null | undefined>(undefined);
  const [workflows, setWorkflows] = useState<api.WorkflowEntry[]>([]);
  const [apps, setApps] = useState<api.AppListEntry[]>([]);
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
    api.listPeers().then((p) => setPeers(p.map((x) => x.id)), () => setPeers([]));
    api.listSubscriptions().then(setSubs, failed("subs"));
    api.listInstalledPackages().then(setInstalled, failed("installed"));
  }, []);

  // The packages published here: the catalog's.
  const here = useMemo(() => Object.keys(catalog?.packages ?? {}).sort(), [catalog]);
  const installedNames = useMemo(() => (installed ?? []).map((p) => p.package), [installed]);
  const newest = (pkg: string) => catalog?.packages[pkg]?.releases[0]?.version;

  return (
    <>
      {open ? (
        <PackagePage key={open} pkg={open} publisher={publisher?.name} catalog={catalog ?? null} publicChannels={publisher?.publicChannels ?? []}
          workflows={workflows} apps={apps} installed={installedNames} peers={peers}
          onBack={() => setOpen(null)} onChanged={() => { void loadCatalog(); api.getPublisher().then(setPublisher, failed("catalog")); }} />
      ) : (
        <>
          <div class="flyout-section">
            <PublisherHead publisher={publisher} onChanged={setPublisher} />
            {publisher && <ListingLines publisher={publisher} />}
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
    </>
  );
}

/** Types every strut has, which no package carries (the build refuses them). */
const STRUTS_OWN_TYPES = new Set(["Concept", "Claim", "Check", "Evidence"]);

/** Names to add with one click each, or all at once: what the picked
 *  workflows' runs wrote or read. Nothing when there are none. */
function Ideas(props: { label: string; names: string[]; add: (names: string[]) => void }) {
  if (!props.names.length) return null;
  return (
    <div class="package-ideas">
      <span class="auto-hint">{props.label}:</span>
      {props.names.map((n) => (
        <button class="badge package-chip package-idea" key={n} title={`Add ${n}`} onClick={() => props.add([n])}>+ {n}</button>
      ))}
      {props.names.length > 1 && <button class="auto-link" onClick={() => props.add(props.names)}>Add all</button>}
    </div>
  );
}

/** What a build of the picks carries beyond them, by kind: each kind a
 *  heading with its count, its names as chips — a namespace's names on one
 *  line under it — the Concept roots with the pages under them, and the
 *  secrets an installing strut must set. */
function ComesAlong(props: { along: ReturnType<typeof comesAlong>; secrets: readonly string[] }) {
  const { along } = props;
  const sections: Array<{ title: string; count: number; body: ComponentChildren }> = [];
  const chips = (names: string[]) => (
    <div class="package-along-chips">{names.map((n) => <span class="package-along-chip" key={n} title={n}>{n}</span>)}</div>
  );
  const spaced = (names: string[]) =>
    byNamespace(names).map((g) => (
      <div class="package-along-ns" key={g.ns}>
        {g.ns && <span class="package-along-ns-name">{g.ns}/</span>}
        {chips(g.names)}
      </div>
    ));
  if (along.workflows.length) sections.push({ title: "Workflows", count: along.workflows.length, body: spaced(along.workflows) });
  if (along.steps.length) sections.push({ title: "Steps", count: along.steps.length, body: spaced(along.steps) });
  if (along.apps.length) sections.push({ title: "Apps", count: along.apps.length, body: chips(along.apps) });
  if (along.concepts.pages > 0)
    sections.push({
      title: "Concepts",
      count: along.concepts.pages,
      body: (
        <div class="package-along-ns">
          <span class="package-along-note">
            {along.concepts.pages === 1 ? "1 page" : `${along.concepts.pages} pages`}{along.concepts.roots.length ? " under" : ""}
          </span>
          {chips(along.concepts.roots)}
        </div>
      ),
    });
  if (along.types.length)
    sections.push({
      title: "Ontology",
      count: along.types.length,
      body: (
        <div class="package-along-ns">
          <span class="package-along-note">parent types</span>
          {chips(along.types)}
        </div>
      ),
    });
  if (along.needs.length)
    sections.push({
      title: "Needs on the installing strut",
      count: along.needs.length,
      body: (
        <>
          <div class="package-along-say">Put here by this server's host or a service, not by strut: a strut without them cannot install or run what reaches them.</div>
          {spaced(along.needs)}
        </>
      ),
    });
  if (props.secrets.length) sections.push({ title: "Needs secrets", count: props.secrets.length, body: chips([...props.secrets]) });
  if (!sections.length) return null;
  return (
    <div class="package-along-box">
      <div class="package-along-head">Comes along</div>
      {sections.map((sec) => (
        <div class="package-along-section" key={sec.title}>
          <div class="package-group-title">{sec.title} <span class="package-along-count">{sec.count}</span></div>
          {sec.body}
        </div>
      ))}
    </div>
  );
}
