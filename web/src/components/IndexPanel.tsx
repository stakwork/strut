import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { errorMessage } from "../helpers";
import { ago } from "./ClaimsPanel";
import { ConfirmButton } from "./ConfirmButton";
import { CopyButton } from "./CopyButton";
import { WAIT_WORDS } from "./PackagesPanel";

// ── The Index tab (plans/index-listing.md §3) ──────────────────────────────
//
// Only on a strut with the index role. WAITING: the listing requests that
// were not listed at once — who asks for which name, from which host, what
// its catalog holds, and why it waits (a takeover in red) — each approved
// or refused with a reason the publisher reads. LISTED: the card's rows with
// their last read, each delisted here. ADD BY HAND: today's `PUT
// /index/:prefix`, for a publisher whose catalog is not on a strut server.

const short = (key: string) => `${key.slice(0, 8)}…${key.slice(-4)}`;
const secs = (iso?: string) => (iso ? Date.parse(iso) / 1000 : undefined);

export function IndexPanel(props: { onChanged?: (waiting: number) => void }) {
  const [requests, setRequests] = useState<api.IndexRequests | null>(null);
  const [info, setInfo] = useState<api.IndexOperatorInfo | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refusing, setRefusing] = useState<{ id: string; reason: string } | null>(null);
  const [draft, setDraft] = useState({ prefix: "", key: "", url: "", description: "" });

  const load = async () => {
    try {
      const [r, i] = await Promise.all([api.listIndexRequests(), api.getIndexInfo()]);
      setRequests(r);
      setInfo(i);
      props.onChanged?.(r?.pending.length ?? 0);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      setRefusing(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
      void load();
    }
  };
  const addByHand = () =>
    act("add", async () => {
      await api.setIndexRow(draft.prefix.trim(), { key: draft.key.trim(), urls: [draft.url.trim()], ...(draft.description.trim() ? { description: draft.description.trim() } : {}) });
      setDraft({ prefix: "", key: "", url: "", description: "" });
    });

  const rows = Object.entries(info?.publishers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const crawl = (prefix: string) => info?.crawled.find((c) => c.prefix === prefix);

  return (
    <>
      {error && <div class="auto-error">{error}</div>}
      {info && (
        <div class="publisher-head">
          <span class="auto-meta">Index key</span>
          <span class="package-key">
            <code class="package-digest" title="The index key: what a strut server follows">{info.key}</code>
            <CopyButton value={info.key} label="Copy the index key" />
          </span>
        </div>
      )}

      <div class="flyout-section">
        <div class="flyout-section-title">Waiting</div>
        <div class="auto-hint">
          {requests?.autoHosts.length
            ? <>Listed with no person: a new name from <code>{requests.autoHosts.join(", ")}</code>, one per key and host. Everything else waits here.</>
            : <>Every listing request waits here (no host is listed automatically: <code>STRUT_INDEX_AUTO_HOSTS</code>).</>}
        </div>
        {requests === null && info === undefined && !error && <div class="auto-hint">Loading…</div>}
        {requests?.pending.length === 0 && <div class="auto-hint">Nothing waits.</div>}
        {requests?.pending.map((p) => (
          <div class={`auto-card${p.reason === "takeover" ? " is-takeover" : ""}`} key={p.id}>
            <div class="auto-card-head">
              <span class="package-name">{p.prefix}</span>
              <span class={`badge${p.reason === "takeover" ? " badge-danger" : p.reason === "move" ? " badge-warning" : ""}`} title={WAIT_WORDS[p.reason]}>{p.reason}</span>
            </div>
            <div class="auto-meta">
              <span title={p.key}>key {short(p.key)}</span>
              <span class="package-url">{p.base}</span>
              <span title={new Date(p.receivedAt).toLocaleString()}>asked {ago(secs(p.receivedAt))}</span>
            </div>
            {p.description && <div class="auto-hint">{p.description}</div>}
            <div class="auto-meta">Its catalog holds {p.catalog.packages.join(", ")}</div>
            {p.reason === "takeover" && p.heldBy && <div class="auto-error">The name is held by {short(p.heldBy)}. Approving gives it to the new key: new installs follow it, copies already installed keep the old one.</div>}
            {p.reason === "move" && p.from && <div class="auto-hint">Listed at {p.from} now; approving moves it to {p.host}.</div>}
            {refusing?.id === p.id ? (
              <div class="listing-form">
                <label>
                  <span class="auto-meta">Why (the publisher reads this)</span>
                  <input type="text" value={refusing.reason} maxLength={500} onInput={(e) => setRefusing({ id: p.id, reason: (e.target as HTMLInputElement).value })} />
                </label>
                <div class="auto-card-actions">
                  <button class="btn btn-danger" disabled={!!busy || !refusing.reason.trim()} onClick={() => void act(p.id, () => api.refuseIndexRequest(p.id, refusing.reason.trim()))}>Refuse</button>
                  <button class="btn" disabled={!!busy} onClick={() => setRefusing(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div class="auto-card-actions">
                <button class="btn btn-primary" disabled={!!busy} onClick={() => void act(p.id, () => api.approveIndexRequest(p.id))}>{busy === p.id ? "Approving…" : "Approve"}</button>
                <button class="btn" disabled={!!busy} onClick={() => setRefusing({ id: p.id, reason: "" })}>Refuse</button>
              </div>
            )}
          </div>
        ))}
        {!!requests?.refused.length && (
          <div class="auto-hint">
            Refused in the last 30 days: {requests.refused.map((r) => `${r.prefix} (${r.reason})`).join("; ")}
          </div>
        )}
      </div>

      <div class="flyout-section">
        <div class="flyout-section-title">Listed</div>
        {info === null && <div class="auto-hint">No publisher yet. The first row, added by hand below, mints this index's key.</div>}
        {rows.map(([prefix, row]) => {
          const st = crawl(prefix);
          return (
            <div class="auto-card" key={prefix}>
              <div class="auto-card-head">
                <span class="package-name">{prefix}</span>
                {st?.packages !== undefined && <span class="badge">{st.packages} package{st.packages === 1 ? "" : "s"}</span>}
              </div>
              <div class="auto-meta">
                <span title={row.key}>key {short(row.key)}</span>
                <span class="package-url">{row.urls[0]?.replace(/\?public=1$/, "")}</span>
                {st?.checkedAt && <span title={new Date(st.checkedAt).toLocaleString()}>read {ago(secs(st.checkedAt))}</span>}
              </div>
              {row.description && <div class="auto-hint">{row.description}</div>}
              {st?.error && <div class="auto-error">{st.error}</div>}
              <div class="auto-card-actions">
                <ConfirmButton label="Delist" note={`Take ${prefix} off this index: new installs stop finding it by name; copies already installed keep working.`} confirmLabel="Delist" tone="danger" disabled={!!busy} onConfirm={() => void act(prefix, () => api.removeIndexRow(prefix))} />
              </div>
            </div>
          );
        })}
      </div>

      <div class="flyout-section">
        <div class="flyout-section-title">Add by hand</div>
        <div class="listing-form">
          <label>
            <span class="auto-meta">Name</span>
            <input type="text" value={draft.prefix} placeholder="acme" onInput={(e) => setDraft({ ...draft, prefix: (e.target as HTMLInputElement).value })} />
          </label>
          <label>
            <span class="auto-meta">The publisher's public key</span>
            <input type="text" value={draft.key} placeholder="z-base-32, 52 characters" onInput={(e) => setDraft({ ...draft, key: (e.target as HTMLInputElement).value })} />
          </label>
          <label>
            <span class="auto-meta">Where its public catalog is served</span>
            <input type="text" value={draft.url} placeholder="https://<server>/packages/catalog?public=1" onInput={(e) => setDraft({ ...draft, url: (e.target as HTMLInputElement).value })} />
          </label>
          <label>
            <span class="auto-meta">Description</span>
            <input type="text" value={draft.description} onInput={(e) => setDraft({ ...draft, description: (e.target as HTMLInputElement).value })} />
          </label>
          <div class="auto-card-actions">
            <button class="btn btn-primary" disabled={!!busy || !draft.prefix.trim() || !draft.key.trim() || !draft.url.trim()} onClick={() => void addByHand()}>{busy === "add" ? "Listing…" : "List"}</button>
          </div>
        </div>
      </div>
    </>
  );
}
