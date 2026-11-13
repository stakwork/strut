import { useEffect, useMemo, useState } from "preact/hooks";
import * as api from "../api";
import { errorMessage } from "../helpers";
import { CopyButton } from "./CopyButton";
import { EarningsLine, useEarnings } from "./EarningsLine";
import { ListingLines } from "./ListingLines";
import { canWords } from "../store-links";
import { ChevronRightIcon } from "../icons";
import {
  boxesOf,
  checkedOf,
  emptyRecord,
  isPricedItem,
  mergeNeeds,
  needsTick,
  removeRow,
  reserveUsd,
  rowKey,
  rowsOf,
  runHints,
  capNote,
  sameRecord,
  setBox,
  setPrice,
  setResults,
  setSignIn,
  setVisitorKey,
  setVisitorLimit,
  shownNumber,
  SIGN_IN_METHODS,
  typedNumber,
  visitorsOf,
  usd,
  visitorAppLink,
  VISITOR_DEFAULT_LIMITS,
  type PriceField,
  type Row,
  type VisitorLimitField,
} from "../public-view";

// ── Public view (the Publish dialog's Public view tab; plans/public-surface.md
// §2, decisions 19–20) ──────────────────────────────────────────────────────
//
// What anyone may read on this server, live and read-only, with no account:
// its PUBLIC VIEW. Nothing is copied or versioned, and the Packages tab's
// Make public is the package catalog's. Adding an app or a
// workflow asks the server what it brings along (`GET /public-view/needs`)
// and pre-checks it, every line saying what it shows anyone; a person
// unticks what they do not mean, and Save writes the whole list — so the
// record stays explicit, and a later release never widens it by itself.
// Below the items, who may SIGN IN to the public apps (plans/app-repos.md
// §5): the methods, a key per domain, and each visitor's daily limits — the
// record's `visitors`, which a served box's serve.yaml writes instead.

type Kind = "app" | "workflow" | "step" | "concept";
const KINDS: Array<{ kind: Kind; label: string }> = [
  { kind: "app", label: "App" },
  { kind: "workflow", label: "Workflow" },
  { kind: "step", label: "Step" },
  { kind: "concept", label: "Concept tree" },
];

function Cascade(props: { needs: api.PublicViewNeeds; onAdd: (checked: Set<string>) => void; onCancel: () => void }) {
  const { needs } = props;
  const [checked, setChecked] = useState(() => checkedOf(needs));
  const toggle = (key: string) => {
    const next = new Set(checked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setChecked(next);
  };
  const line = (key: string, label: string, note: string, opts: { disabled?: boolean; sub?: boolean } = {}) => (
    <label class={`public-need${opts.sub ? " is-sub" : ""}`} key={key}>
      <input type="checkbox" checked={checked.has(key)} disabled={opts.disabled} onChange={() => toggle(key)} />
      <span class="public-need-text">
        <span class="package-name">{label}</span>
        <span class="auto-hint">{note}</span>
      </span>
    </label>
  );
  const what = needs.app ? `the app "${needs.app.title}" (${needs.app.name} ${needs.app.version})` : `the workflow "${needs.workflow}"`;
  return (
    <div class="auto-card public-cascade">
      <div class="auto-card-head"><span>Adding {what} brings along</span></div>
      {needs.app && (
        <div class="auto-hint">
          The page, held at {needs.app.version}: a later publish is a draft until you move its release. Visitors can read; they cannot start a run.
        </div>
      )}
      {needs.workflows.length > 0 && <div class="flyout-section-title">Workflows</div>}
      {needs.workflows.map((w) => (
        <div key={w.name}>
          {line(`workflow:${w.name}`, w.name, "its definition and versions")}
          {checked.has(`workflow:${w.name}`) && line(`runs:${w.name}`, "with its runs", "every run, whole: its input, outputs, agents' transcripts and files", { sub: true })}
        </div>
      ))}
      {needs.reads.length > 0 && <div class="flyout-section-title">Reads the page may call</div>}
      {needs.reads.map((r) => line(`read:${r.name}`, r.name, r.note))}
      {needs.steps.length > 0 && <div class="flyout-section-title">Steps</div>}
      {needs.steps.map((s) => line(`step:${s.name}`, s.name, s.note))}
      {needs.concepts.length > 0 && <div class="flyout-section-title">Concept trees</div>}
      {needs.concepts.map((c) =>
        line(`concept:${c.name}`, c.missing ? c.name : `${c.name} · ${c.pages} page${c.pages === 1 ? "" : "s"}`, `${c.note} — read by ${c.from.join(", ")}`, { disabled: !!c.missing }),
      )}
      {needs.perRun.map((p) => <div class="auto-hint" key={p}>Decided per run, not added: {p}</div>)}
      <div class="auto-card-actions">
        <button class="btn btn-primary" onClick={() => props.onAdd(checked)}>Add these</button>
        <button class="btn" onClick={props.onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** A number box over a value the draft holds. It keeps the text typed
 *  ("0.", "1.50") while that reads as the value; shown from the value alone,
 *  the dot was gone the moment it was typed. */
function NumberBox(props: { value: number | undefined; step: string; placeholder: string; onText: (text: string) => void }) {
  const [text, setText] = useState(props.value === undefined ? "" : String(props.value));
  // A value changed from outside (a reload, a save) is what the box types on from.
  useEffect(() => {
    if (typedNumber(text) !== props.value) setText(props.value === undefined ? "" : String(props.value));
  }, [props.value]);
  return (
    <input
      type="number"
      min="0"
      step={props.step}
      value={shownNumber(text, props.value)}
      placeholder={props.placeholder}
      onInput={(e) => {
        const typed = (e.target as HTMLInputElement).value;
        setText(typed);
        props.onText(typed);
      }}
    />
  );
}

const PRICE_FIELDS: Array<{ field: PriceField; label: string; unit: string; step: string; title: string }> = [
  { field: "base", label: "Base", unit: "$ a run", step: "0.01", title: "Charged on every run, whatever it cost" },
  { field: "markup", label: "Markup", unit: "× cost", step: "0.1", title: "Times what the run cost: 1 charges exactly the cost" },
  { field: "capUsd", label: "Per-run cap", unit: "$", step: "0.5", title: "The most one run may spend; a markup needs one" },
  { field: "dailyCapUsd", label: "Daily cap", unit: "$", step: "1", title: "The spend you carry per UTC day; a free item that calls a model needs one" },
];

/** A workflow or step row: its three boxes, and the price "anyone can run
 *  it" opens (plans/paid-runs.md §2). */
function ItemRow(props: {
  row: Row;
  draft: api.PublicViewRecord;
  saved: api.PublicViewRecord;
  info: api.PublicRunInfo | undefined;
  infoError?: string;
  ticked: boolean;
  /** What it earned here, all time (plans/paid-runs.md §8). */
  earned?: api.EarningsRow;
  gone: preact.ComponentChild;
  onTick: (on: boolean) => void;
  onRemove: () => void;
  edit: (fn: (r: api.PublicViewRecord) => api.PublicViewRecord) => void;
}) {
  const { row, draft, info } = props;
  const boxes = boxesOf(draft, row);
  const item = draft.runnable.find((r) => r.kind === row.kind && r.name === row.name);
  const box = (key: "definition" | "runs" | "run", label: string, title: string) => (
    <label class="public-box" title={title}>
      <input type="checkbox" checked={boxes[key]} onChange={() => props.edit((r) => setBox(r, row, key, !boxes[key]))} />
      {label}
    </label>
  );
  const hints = item && info ? runHints(item, info) : [];
  const tick = needsTick(row, info, props.saved);
  const nothing = !boxes.definition && !boxes.runs && !boxes.run;
  return (
    <div class={`public-item${nothing ? " is-off" : ""}`}>
      <div class="public-row">
        <span class="package-name">{row.name} {props.gone}</span>
        <span class="public-boxes">
          {box("definition", "definition", row.kind === "workflow" ? "Anyone reads its definition and versions" : "Anyone reads its schema, its source and the helpers it imports")}
          {row.kind === "workflow" && box("runs", "runs", "Anyone reads every run, whole: its input, outputs, agents' transcripts and files")}
          {box("run", "anyone can run it", "Anyone may start it, free or for sats, with their own input")}
        </span>
        <button class="btn btn-sm" title="Take it out of the public view" onClick={props.onRemove}>Remove</button>
      </div>
      {item && (
        <div class="public-run">
          {info && (
            <div class="public-run-can">
              <span class="store-can" title="What running it reaches: spends = a model is called; acts = a step changes something outside the run; code = code runs in this server; reads = none of those">
                {canWords(info.can).map((w) => <span key={w} class={`badge store-can-${w}`}>{w}</span>)}
              </span>
              <span class="auto-hint">
                {info.costs.measured
                  ? `Its runs here, last ${info.costs.days} days: ${info.costs.runs} · average ${usd(info.costs.average)} · highest ${usd(info.costs.highest)}`
                  : row.kind === "step"
                    ? `No kept runs of this step here in the last ${info.costs.days} days (a call inside a workflow counts as the workflow's)`
                    : `No runs here in the last ${info.costs.days} days`}
              </span>
            </div>
          )}
          {props.infoError && <div class="auto-error">{props.infoError}</div>}
          <div class="public-price">
            {PRICE_FIELDS.map((f) => (
              <label key={f.field} title={f.title}>
                <span>{f.label} <span class="auto-hint">{f.unit}</span></span>
                <NumberBox
                  step={f.step}
                  value={item[f.field]}
                  placeholder={f.field === "base" || f.field === "markup" ? "0" : "none"}
                  onText={(text) => props.edit((r) => setPrice(r, row, f.field, text))}
                />
              </label>
            ))}
            {row.kind === "workflow" && (
              <label title="What the person who started a run reads back">
                <span>Launcher reads</span>
                <select value={item.results ?? "output"} onChange={(e) => props.edit((r) => setResults(r, row, (e.target as HTMLSelectElement).value as "output" | "run"))}>
                  <option value="output">its output</option>
                  <option value="run">the whole run</option>
                </select>
              </label>
            )}
          </div>
          <div class="auto-hint">
            {isPricedItem(item)
              ? `A run needs ${usd(reserveUsd(item))} of credit to start (base + markup × the per-run cap); what it is not charged stays the buyer's.`
              : `Free: anyone may run it, and you carry what it costs${item.dailyCapUsd !== undefined ? `, up to ${usd(item.dailyCapUsd)} a day` : ""}.`}
          </div>
          {capNote(item) && <div class="auto-hint">{capNote(item)}</div>}
          {info && !info.gateway && (info.can.spends || (item.markup ?? 0) > 0) && (
            <div class="auto-hint">No gateway here: nothing stops a run at its cap. Overspend shows after the run, bounded by the agent's step limit and the daily cap.</div>
          )}
          {hints.map((h) => <div class="public-run-hint" key={h}>{h}</div>)}
          {props.earned && props.earned.calls > 0 && <EarningsLine label="Here, all time" row={props.earned} />}
          {tick && (
            <label class="public-tick">
              <input type="checkbox" checked={props.ticked} onChange={() => props.onTick(!props.ticked)} />
              Strangers will run this on your server with their input — it {[info!.can.acts ? "changes things outside the run" : "", info!.can.code ? "runs code" : ""].filter(Boolean).join(" and ")}.
            </label>
          )}
        </div>
      )}
    </div>
  );
}

const LIMIT_FIELDS: Array<{ field: VisitorLimitField; label: string; title: string }> = [
  { field: "writesPerDay", label: "Writes", title: "Saved state, graph rows and error reports, per visitor per UTC day" },
  { field: "launchesPerDay", label: "Launches", title: "Runs started, per visitor per UTC day" },
];

/** Who may sign in to the public apps, and what one visitor may do in a
 *  day: folded to one line that says what is offered, since it is set once. */
function SignInSection(props: { draft: api.PublicViewRecord; setDraft: (r: api.PublicViewRecord) => void }) {
  const { draft, setDraft } = props;
  const v = visitorsOf(draft);
  const offered = new Set(v.signIn);
  const domain = v.visitorKey === "domain";
  const shown = SIGN_IN_METHODS.filter((m) => offered.has(m.method)).map((m) => m.short);
  return (
    <details class="flyout-section public-sign-in">
      <summary>
        <ChevronRightIcon size={12} class="public-sign-in-chev" />
        <span class="flyout-section-title">Sign-in</span>
        <span class="auto-hint">{shown.length ? shown.join(", ") : "off: every visitor is anonymous"}</span>
      </summary>
      <div class="auto-hint">
        Visitors of the public apps may sign in with a key they hold, and are then that key here: their own saved state, channels and rows.
        Nothing about them is kept but the key. With none ticked, every visitor is anonymous.
      </div>
      {SIGN_IN_METHODS.map((m) => (
        <label class="public-need" key={m.method}>
          <input type="checkbox" checked={offered.has(m.method)} onChange={() => setDraft(setSignIn(draft, m.method, !offered.has(m.method)))} />
          <span class="public-need-text">
            <span class="package-name">{m.label}</span>
            <span class="auto-hint">{m.note}</span>
          </span>
        </label>
      ))}
      {offered.size > 0 && (
        <>
          <label class="public-need">
            <input type="checkbox" checked={domain} onChange={() => setDraft(setVisitorKey(draft, !domain))} />
            <span class="public-need-text">
              <span class="package-name">A key per domain</span>
              <span class="auto-hint">
                a visitor is someone else on each domain this server answers on, and no domain can tie them to another
                {offered.has("nostr") ? " — a Nostr extension then is not offered" : ""}
              </span>
            </span>
          </label>
          <div class="public-price">
            {LIMIT_FIELDS.map((f) => (
              <label key={f.field} title={f.title}>
                <span>{f.label} <span class="auto-hint">a visitor a day</span></span>
                <NumberBox
                  step="1"
                  value={v.limits?.[f.field]}
                  placeholder={String(VISITOR_DEFAULT_LIMITS[f.field])}
                  onText={(text) => setDraft(setVisitorLimit(draft, f.field, text))}
                />
              </label>
            ))}
          </div>
          {draft.apps.length === 0 && <div class="auto-hint">No app is in the public view yet: a visitor signs in to one.</div>}
        </>
      )}
    </details>
  );
}

/** `onDirty` hears whether the draft differs from what is saved, so the tab
 *  can say so while the other tab is open. */
export function PublicViewPanel(props: { onDirty?: (dirty: boolean) => void }) {
  const [saved, setSaved] = useState<api.PublicViewAnswer | null>(null);
  const [draft, setDraft] = useState<api.PublicViewRecord>(emptyRecord);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState<api.PublicViewAnswer["held"]>(undefined);
  const [kind, setKind] = useState<Kind>("app");
  const [name, setName] = useState("");
  const [needs, setNeeds] = useState<api.PublicViewNeeds | null>(null);
  const [names, setNames] = useState<Record<Kind, string[]>>({ app: [], workflow: [], step: [], concept: [] });
  // The workflow and step rows, kept in the order first shown, so a row the
  // person unticks everything on stays where it is until Remove.
  const [rows, setRows] = useState<Row[]>([]);
  // What "anyone can run it" shows per row (`GET /public-view/runnable`),
  // read when the box is first on; and the ticks given for what acts or runs code.
  const [infos, setInfos] = useState<Record<string, api.PublicRunInfo | { error: string }>>({});
  const [ticks, setTicks] = useState<Set<string>>(new Set());
  // What each runnable item earned here (`GET /earnings`), read again after a save.
  const [savedAt, setSavedAt] = useState(0);
  const earnings = useEarnings({ by: "item" }, savedAt);
  // This server as the publisher an index lists (plans/public-view-listing.md §5).
  const [publisher, setPublisher] = useState<api.PublisherInfo | null | undefined>(undefined);
  const earnedOf = (r: Row) => earnings?.rows.find((e) => e.key === `${r.kind}:${r.name}`);

  useEffect(() => {
    api.getPublicView().then((v) => { setSaved(v); setDraft(v.surface); setRows(rowsOf(v.surface)); }, (e) => setError(errorMessage(e)));
    api.getPublisher().then(setPublisher, () => setPublisher(null));
    void Promise.all([
      api.listApps().catch(() => []),
      api.listWorkflows().catch(() => []),
      api.listSteps().catch(() => ({ core: [], workspace: [] })),
    ]).then(([apps, wfs, steps]) => setNames({
      app: apps.map((a) => a.name).sort(),
      workflow: wfs.map((w) => w.name).sort(),
      step: [...new Set([...steps.workspace.map((s) => s.type), ...steps.core.filter((s) => s.source === "custom").map((s) => s.type)])].sort(),
      concept: [],
    }));
  }, []);

  const dirty = !!saved && !sameRecord(saved.surface, draft);
  useEffect(() => props.onDirty?.(dirty), [dirty]);
  useEffect(() => setRows((r) => rowsOf(draft, r)), [draft]);
  useEffect(() => {
    for (const item of draft.runnable) {
      const key = rowKey(item);
      if (infos[key]) continue;
      setInfos((m) => ({ ...m, [key]: m[key] ?? { error: "" } }));
      api.publicRunInfo(item.kind === "workflow" ? { workflow: item.name } : { step: item.name }).then(
        (info) => setInfos((m) => ({ ...m, [key]: info })),
        (e) => setInfos((m) => ({ ...m, [key]: { error: errorMessage(e) } })),
      );
    }
  }, [draft, infos]);
  const infoOf = (r: Row) => {
    const i = infos[rowKey(r)];
    return i && "can" in i ? i : undefined;
  };
  const untickedRows = saved ? rows.filter((r) => boxesOf(draft, r).run && needsTick(r, infoOf(r), saved.surface) && !ticks.has(rowKey(r))) : [];
  const add = async () => {
    const n = name.trim();
    if (!n) return;
    setError(null);
    if (kind === "app" || kind === "workflow") {
      try {
        setNeeds(await api.publicViewNeeds(kind === "app" ? { app: n } : { workflow: n }));
      } catch (e) {
        setError(errorMessage(e));
      }
      return;
    }
    const next: api.PublicViewRecord = JSON.parse(JSON.stringify(draft));
    const list = kind === "step" ? next.steps : next.concepts;
    if (!list.includes(n)) list.push(n);
    setDraft(next);
    setName("");
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const v = await api.putPublicView(draft);
      setSaved(v);
      setDraft(v.surface);
      setHeld(v.held);
      setSavedAt(Date.now());
      // A row left with nothing ticked was taken out by the save.
      const listed = new Set(rowsOf(v.surface).map(rowKey));
      setRows((rs) => rowsOf(v.surface, rs.filter((r) => listed.has(rowKey(r)))));
    } catch (e) {
      setError(errorMessage(e));
      // Read each row's facts again: what the save refused may have changed
      // elsewhere (an owner claimed, a wallet set).
      setInfos({});
    } finally {
      setBusy(false);
    }
  };
  const edit =(fn: (r: api.PublicViewRecord) => void) => {
    const next: api.PublicViewRecord = JSON.parse(JSON.stringify(draft));
    fn(next);
    setDraft(next);
  };
  const remove = (row: Row) => {
    setDraft(removeRow(draft, row));
    setRows((rs) => rs.filter((r) => rowKey(r) !== rowKey(row)));
  };
  const missing = useMemo(() => {
    const m = saved?.missing;
    return new Set([...(m?.apps ?? []).map((x) => `app:${x}`), ...(m?.workflows ?? []).map((x) => `workflow:${x}`), ...(m?.steps ?? []).map((x) => `step:${x}`), ...(m?.concepts ?? []).map((x) => `concept:${x}`)]);
  }, [saved]);
  const gone = (key: string) => missing.has(key) && <span class="badge badge-warning" title="Not on this server: skipped by every read">not here</span>;
  const nothing = draft.apps.length + rows.length + draft.concepts.length + draft.types.length === 0;
  // What an index lists: something the store would show (node types alone do not count).
  const shows = !!saved && saved.surface.apps.length + saved.surface.workflows.length + saved.surface.steps.length + saved.surface.concepts.length + saved.surface.runnable.length > 0;

  return (
    <div class="public-view-panel">
      <div class="auto-hint">
        What anyone can read on this server, live and read-only, with no account: under <code>/public</code>. Nothing here is a copy — take an item out and it closes again.
        A workflow or a step may also be run by anyone, free or for sats, whether or not its definition is shown.
      </div>
      {error && <div class="auto-error">{error.split("; ").map((line) => <div key={line}>{line}</div>)}</div>}
      {saved === null && !error && <div class="auto-hint">Loading…</div>}
      {saved && publisher !== undefined && (
        <div class="flyout-section">
          <div class="flyout-section-title">In the store</div>
          <ListingLines mode="view" publisher={publisher} viewShows={shows} onPublisher={setPublisher} />
        </div>
      )}

      {saved && (
        <>
          <div class="flyout-section">
            {nothing && <div class="auto-hint">Nothing is in the public view.</div>}
            {draft.apps.length > 0 && <div class="flyout-section-title">Apps</div>}
            {draft.apps.map((a) => (
              <div class="auto-card" key={`app:${a.name}`}>
                <div class="auto-card-head">
                  <span class="package-name">{a.name} {gone(`app:${a.name}`)}</span>
                  <button class="btn btn-sm" title="Take it out of the public view" onClick={() => edit((r) => { r.apps = r.apps.filter((x) => x.name !== a.name); })}>Remove</button>
                </div>
                <div class="auto-meta">
                  <span>reads: {a.reads?.length ? a.reads.join(", ") : "runs and the graph only"}</span>
                </div>
                {!missing.has(`app:${a.name}`) && saved.surface.apps.some((x) => x.name === a.name) && (
                  <div class="auto-card-actions">
                    <a class="btn btn-sm" href={visitorAppLink(a.name, location.href)} target="_blank" rel="noopener">Open as a visitor</a>
                    <CopyButton value={visitorAppLink(a.name, location.href)} label="Copy link" />
                  </div>
                )}
              </div>
            ))}
            {(["workflow", "step"] as const).map((k) => {
              const of = rows.filter((r) => r.kind === k);
              if (!of.length) return null;
              return (
                <div key={k}>
                  <div class="flyout-section-title">{k === "workflow" ? "Workflows" : "Steps"}</div>
                  {of.map((row) => {
                    const key = rowKey(row);
                    const info = infos[key];
                    return (
                      <ItemRow
                        key={key}
                        row={row}
                        draft={draft}
                        saved={saved.surface}
                        info={info && "can" in info ? info : undefined}
                        {...(info && "error" in info && info.error ? { infoError: info.error } : {})}
                        ticked={ticks.has(key)}
                        {...(earnedOf(row) ? { earned: earnedOf(row) } : {})}
                        gone={gone(key)}
                        onTick={(on) => setTicks((t) => {
                          const next = new Set(t);
                          if (on) next.add(key);
                          else next.delete(key);
                          return next;
                        })}
                        onRemove={() => remove(row)}
                        edit={(fn) => setDraft(fn(draft))}
                      />
                    );
                  })}
                </div>
              );
            })}
            {draft.concepts.length > 0 && <div class="flyout-section-title">Concept trees</div>}
            {draft.concepts.map((c) => (
              <div class="public-row" key={`concept:${c}`}>
                <span class="package-name">{c} {gone(`concept:${c}`)}</span>
                <span class="auto-hint">the root and every page under it, live</span>
                <button class="btn btn-sm" onClick={() => edit((r) => { r.concepts = r.concepts.filter((x) => x !== c); })}>Remove</button>
              </div>
            ))}
            {draft.types.length > 0 && <div class="flyout-section-title">Node types</div>}
            {draft.types.map((t) => (
              <div class="public-row" key={`type:${t}`}>
                <span class="package-name">{t}</span>
                <button class="btn btn-sm" onClick={() => edit((r) => { r.types = r.types.filter((x) => x !== t); })}>Remove</button>
              </div>
            ))}
          </div>

          <SignInSection draft={draft} setDraft={setDraft} />

          {needs ? (
            <Cascade
              needs={needs}
              onCancel={() => setNeeds(null)}
              onAdd={(checked) => {
                setDraft(mergeNeeds(draft, needs, checked));
                setNeeds(null);
                setName("");
              }}
            />
          ) : (
            <div class="flyout-section">
              <div class="flyout-section-title">Add</div>
              <div class="public-add">
                <select value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value as Kind)}>
                  {KINDS.map((k) => <option value={k.kind} key={k.kind}>{k.label}</option>)}
                </select>
                <input
                  class="package-search"
                  type="text"
                  list="public-view-names"
                  placeholder={kind === "concept" ? "Root page name" : `${KINDS.find((k) => k.kind === kind)!.label} name`}
                  value={name}
                  onInput={(e) => setName((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
                />
                <datalist id="public-view-names">{names[kind].map((n) => <option value={n} key={n} />)}</datalist>
                <button class="btn" disabled={!name.trim()} onClick={() => void add()}>{kind === "app" || kind === "workflow" ? "Add…" : "Add"}</button>
              </div>
            </div>
          )}

          {held?.map((h) => (
            <div class={h.error ? "auto-error" : "auto-hint"} key={h.app}>
              {h.error ? `${h.app}: not held — ${h.error}` : `${h.app} is held at ${h.version} (release ${h.release}): a later publish is a draft until you move it.`}
            </div>
          ))}
        </>
      )}

      {dirty && (
        <div class="public-view-save">
          <span class="auto-hint">
            {untickedRows.length
              ? `Tick that strangers will run ${untickedRows.map((r) => r.name).join(", ")} before saving.`
              : "Unsaved changes: nothing is shown or taken out until you save."}
          </span>
          <button class="btn" disabled={busy} onClick={() => { if (saved) { setDraft(saved.surface); setRows(rowsOf(saved.surface)); setError(null); } }}>Discard</button>
          <button class="btn btn-primary" disabled={busy || untickedRows.length > 0} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
        </div>
      )}
    </div>
  );
}
