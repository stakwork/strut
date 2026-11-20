import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { errorMessage } from "../helpers";
import { ConfirmButton } from "./ConfirmButton";

// One line per index this strut follows (plans/index-listing.md §1): listed
// (read off the index's signed card), waiting for its operator, refused —
// with List, Change and Take off. Each ask is a request sealed by the PUBLIC
// key, sent from this server. Two places draw it:
// - the Packages tab ("packages"): the name, for the packages made public;
// - the Public view tab ("view", plans/public-view-listing.md §5): the
//   public view in the store, for a server that may have no package at all —
//   the ask mints the public key, and the name is asked here when unset.

/** Why a listing request waits for the index's operator, in words. */
export const WAIT_WORDS: Record<api.PendingListing["reason"], string> = {
  host: "this server's host is not one the index lists with no person",
  "second name": "this key already holds another name there",
  "same host": "this server's host already holds a name there",
  move: "the name is moving to another host",
  takeover: "another key holds the name",
  "live row": "the name already shows a server's public view there, listed by the index's operator",
};

/** What a public view showed the index, in words: "1 workflow, 1 runnable". */
export function viewWords(view: NonNullable<api.PendingListing["view"]>): string {
  const n = (count: number, one: string, many = `${one}s`) => (count ? `${count} ${count === 1 ? one : many}` : "");
  return [n(view.apps, "app"), n(view.workflows, "workflow"), n(view.steps, "step"), n(view.concepts, "Concept tree"), n(view.runnable, "runnable item")].filter(Boolean).join(", ");
}

/** Where this server is reached, as a listing names it: the page's origin and its mount. */
const defaultBase = () => `${location.origin}${api.API_BASE}`.replace(/\/+$/, "");

const PUBLISHER_NAME = /^[a-z][a-z0-9-]{0,63}$/;

type Form = { index: string; name: string; base: string; description: string; url: string; live: boolean };

export function ListingLines(props: {
  mode: "packages" | "view";
  /** Null before this server has any key (the view's first ask mints them). */
  publisher: api.PublisherInfo | null;
  /** View mode: the SAVED public view shows something an index could list. */
  viewShows?: boolean;
  /** The publisher changed (a name set, the public key minted). */
  onPublisher?: (p: api.PublisherInfo | null) => void;
}) {
  const view = props.mode === "view";
  const pub = props.publisher;
  const [lines, setLines] = useState<api.ListingLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const load = () => api.listListings().then(setLines, (err) => setError(errorMessage(err)));
  useEffect(() => {
    void load();
  }, [pub?.public, pub?.name]);

  // The Packages tab: once there is a public key and a name, and something
  // public or listed — a server listed for its view alone is listed there too.
  const packagesShown = !!pub?.public && !!pub.name && (pub.publicChannels.length > 0 || !!lines?.some((l) => l.listed));
  if (view && lines?.length === 0) return <div class="auto-hint">This server follows no package index, so none can show its public view.</div>;
  if (!lines?.length || (!view && !packagesShown)) return error ? <div class="auto-error">{error}</div> : null;
  // Whether a package of this server's is public: its row then stays when the view is taken off.
  const hasPackages = (pub?.publicChannels.length ?? 0) > 0;

  const open = (l: api.ListingLine, live?: boolean) =>
    setForm({
      index: l.index,
      name: pub?.name ?? "",
      base: l.asked?.base ?? defaultBase(),
      description: l.asked?.description ?? l.row?.description ?? l.live?.description ?? "",
      url: l.asked?.url ?? l.row?.url ?? "",
      live: live ?? (view ? true : l.asked?.live ?? !!l.live),
    });
  const refreshPublisher = () => api.getPublisher().then((p) => props.onPublisher?.(p), () => undefined);
  const send = async () => {
    if (!form) return;
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      if (!pub?.name) {
        const name = form.name.trim();
        if (!PUBLISHER_NAME.test(name)) throw new Error("The name is lowercase letters, digits and dashes, starting with a letter.");
        await api.setPublisherName(name);
      }
      // `live` only when it says something: on, or off after this server asked
      // for it. Left out, the index leaves a live row under the name alone.
      const line = lines.find((l) => l.index === form.index);
      const live = form.live ? { live: true } : line?.asked?.live === true || line?.live ? { live: false } : {};
      const r = await api.askListing({ index: form.index, base: form.base.trim(), ...(form.description.trim() ? { description: form.description.trim() } : {}), ...(form.url.trim() ? { url: form.url.trim() } : {}), ...live });
      setSaid(r.status === "listed" ? (view ? "Shown in the store." : "Listed.") : `Sent: waiting for the index's operator — ${WAIT_WORDS[r.reason as api.PendingListing["reason"]] ?? r.reason}.`);
      setForm(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      void refreshPublisher();
      void load();
    }
  };
  /** Take the row off, or — the view's line, on a server whose packages stay listed — the view alone. */
  const takeOff = async (l: api.ListingLine, viewOnly: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (viewOnly) {
        const base = l.asked?.base ?? l.live?.url ?? defaultBase();
        await api.askListing({ index: l.index, base, ...(l.row?.description ? { description: l.row.description } : {}), ...(l.row?.url ? { url: l.row.url } : {}), live: false });
        setSaid("The store no longer shows this server's public view.");
      } else {
        await api.withdrawListing(l.index);
        setSaid("Taken off the index.");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      void load();
    }
  };

  const name = pub?.name;
  return (
    <div class="listing-lines">
      {view && !props.viewShows && <div class="auto-hint">Save something in the public view first: an index lists a view that shows something.</div>}
      {lines.map((l) => {
        const label = l.label ?? l.index;
        const waiting = !l.listed && l.asked?.status === "pending";
        const shown = l.listed && !!l.live;
        return (
          <div class="listing-line" key={l.index}>
            <span class="auto-meta">{label}</span>
            {view ? (
              shown ? (
                <span class="badge badge-accent" title={`${name} is on ${label}'s signed card with this server's public key, and its store shows this server's public view`}>Shown</span>
              ) : l.listed ? (
                <span class="badge" title={`${name} is listed on ${label} for its packages; the store does not show this server's public view`}>Listed, view not shown</span>
              ) : null
            ) : l.listed ? (
              <span class="badge badge-accent" title={`${name} is on ${label}'s signed card with this server's public key`}>Listed{l.live ? " · public view shown" : ""}</span>
            ) : null}
            {!l.listed && l.heldBy ? (
              <span class="badge badge-warning" title={`Another key holds ${name} there: ${l.heldBy}`}>Name held by another key</span>
            ) : waiting ? (
              <span class="badge" title={l.asked?.reason ? WAIT_WORDS[l.asked.reason as api.PendingListing["reason"]] ?? l.asked.reason : undefined}>Waiting for approval</span>
            ) : !l.listed && l.asked?.status === "refused" ? (
              <span class="badge badge-warning" title={l.asked.reason}>Refused</span>
            ) : null}
            {!l.requests ? (
              <span class="auto-hint">Its card is a file: ask its operator to list this server.</span>
            ) : l.listed && view && !shown ? (
              <button class="btn btn-sm btn-primary" disabled={busy || !props.viewShows} onClick={() => open(l, true)}>Show the public view too</button>
            ) : l.listed ? (
              <>
                <button class="btn btn-sm" disabled={busy} onClick={() => open(l)}>Change</button>
                {view && hasPackages ? (
                  <ConfirmButton class="btn btn-sm btn-danger" label="Stop showing" note={`${label}'s store stops showing this server's public view. ${name} stays listed for its packages.`} confirmLabel="Stop showing" tone="danger" disabled={busy} onConfirm={() => void takeOff(l, true)} />
                ) : (
                  <ConfirmButton class="btn btn-sm btn-danger" label="Take off" note={view ? `Take ${name} off ${label}: its store stops showing this server's public view.` : `Take ${name} off ${label}: new installs stop finding it by name. Copies already installed keep working.`} confirmLabel="Take off" tone="danger" disabled={busy} onConfirm={() => void takeOff(l, false)} />
                )}
              </>
            ) : waiting ? (
              <button class="btn btn-sm" disabled={busy} onClick={() => void takeOff(l, false)}>Withdraw</button>
            ) : (
              <button class="btn btn-sm btn-primary" disabled={busy || (view && !props.viewShows)} onClick={() => open(l)}>{view ? "Show on" : "List on"} {label}</button>
            )}
            {l.asked?.status === "refused" && l.asked.reason && !l.listed && <div class="auto-error">{l.asked.reason.replace(/^listing_refused: /, "Refused: ")}</div>}
            {l.asked?.status === "error" && l.asked.reason && !l.listed && <div class="auto-error">{l.asked.reason}</div>}
            {l.cardError && <div class="auto-hint">Its card could not be read: {l.cardError}</div>}
            {form?.index === l.index && (
              <div class="listing-form">
                {!name && (
                  <label>
                    <span class="auto-meta">Name</span>
                    <input type="text" value={form.name} placeholder="acme" onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })} />
                    <span class="auto-hint">The name the store shows this server under. Packages published from here later go under it too. Set once.</span>
                  </label>
                )}
                <label>
                  <span class="auto-meta">This server's address</span>
                  <input type="text" value={form.base} onInput={(e) => setForm({ ...form, base: (e.target as HTMLInputElement).value })} />
                </label>
                <label>
                  <span class="auto-meta">Description</span>
                  <input type="text" maxLength={280} value={form.description} placeholder={view ? "What anyone can do here" : "What your packages do"} onInput={(e) => setForm({ ...form, description: (e.target as HTMLInputElement).value })} />
                </label>
                <label>
                  <span class="auto-meta">Homepage</span>
                  <input type="text" value={form.url} placeholder="https://" onInput={(e) => setForm({ ...form, url: (e.target as HTMLInputElement).value })} />
                </label>
                {!view && (
                  <label class="listing-check">
                    <input type="checkbox" checked={form.live} onChange={(e) => setForm({ ...form, live: (e.target as HTMLInputElement).checked })} />
                    <span>Also show this server's public view in the store</span>
                  </label>
                )}
                <div class="auto-hint">
                  {view
                    ? `${label} checks this server holds its public key, and that its public view shows something. Then it shows the view at once, or its operator decides.`
                    : `${label} reads this server's public catalog at that address and checks it is signed with this server's public key. Then it lists ${name} at once, or its operator decides.`}
                </div>
                <div class="auto-card-actions">
                  <button class="btn btn-primary" disabled={busy || !form.base.trim() || (!name && !form.name.trim())} onClick={() => void send()}>
                    {busy ? "Sending…" : l.listed ? "Send the change" : view ? "Ask to be shown" : "Ask to be listed"}
                  </button>
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
