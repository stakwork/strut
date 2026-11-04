import { useEffect, useMemo, useState } from "preact/hooks";
import * as api from "../api";
import { errorMessage } from "../helpers";
import { CopyButton } from "./CopyButton";
import { checkedOf, emptyRecord, mergeNeeds, sameRecord, visitorAppLink } from "../public-view";

// ── The Public view dialog (plans/public-surface.md §2, decisions 19–20) ────
//
// What anyone may read on this server, live and read-only, with no account:
// its PUBLIC VIEW. Never a "publish" — nothing is copied or versioned, and the
// Packages dialog's Make public is the package catalog's. Adding an app or a
// workflow asks the server what it brings along (`GET /public-view/needs`)
// and pre-checks it, every line saying what it shows anyone; a person
// unticks what they do not mean, and Save writes the whole list — so the
// record stays explicit, and a later release never widens it by itself.

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

export function PublicViewDialog(props: { onClose: () => void }) {
  const [saved, setSaved] = useState<api.PublicViewAnswer | null>(null);
  const [draft, setDraft] = useState<api.PublicViewRecord>(emptyRecord);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState<api.PublicViewAnswer["held"]>(undefined);
  const [kind, setKind] = useState<Kind>("app");
  const [name, setName] = useState("");
  const [needs, setNeeds] = useState<api.PublicViewNeeds | null>(null);
  const [names, setNames] = useState<Record<Kind, string[]>>({ app: [], workflow: [], step: [], concept: [] });

  useEffect(() => {
    api.getPublicView().then((v) => { setSaved(v); setDraft(v.surface); }, (e) => setError(errorMessage(e)));
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
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const edit = (fn: (r: api.PublicViewRecord) => void) => {
    const next: api.PublicViewRecord = JSON.parse(JSON.stringify(draft));
    fn(next);
    setDraft(next);
  };
  const missing = useMemo(() => {
    const m = saved?.missing;
    return new Set([...(m?.apps ?? []).map((x) => `app:${x}`), ...(m?.workflows ?? []).map((x) => `workflow:${x}`), ...(m?.steps ?? []).map((x) => `step:${x}`), ...(m?.concepts ?? []).map((x) => `concept:${x}`)]);
  }, [saved]);
  const gone = (key: string) => missing.has(key) && <span class="badge badge-warning" title="Not on this server: skipped by every read">not here</span>;
  const nothing = draft.apps.length + draft.workflows.length + draft.steps.length + draft.concepts.length + draft.types.length === 0;

  return (
    <div class="dialog-backdrop" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class="dialog packages-dialog public-view-dialog">
        <div class="dialog-title">Public view</div>
        <div class="auto-hint">
          What anyone can read on this server, live and read-only, with no account: under <code>/public</code>. Nothing here is copied or published — take an item out and it closes again.
        </div>
        {error && <div class="auto-error">{error}</div>}
        {saved === null && !error && <div class="auto-hint">Loading…</div>}

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
              {draft.workflows.length > 0 && <div class="flyout-section-title">Workflows</div>}
              {draft.workflows.map((w) => (
                <div class="public-row" key={`workflow:${w.name}`}>
                  <span class="package-name">{w.name} {gone(`workflow:${w.name}`)}</span>
                  <label class="public-runs" title="Every run, whole: its input, outputs, agents' transcripts and files">
                    <input type="checkbox" checked={!!w.runs} onChange={() => edit((r) => {
                      const at = r.workflows.find((x) => x.name === w.name)!;
                      if (at.runs) delete at.runs;
                      else at.runs = true;
                    })} />
                    with its runs
                  </label>
                  <button class="btn btn-sm" onClick={() => edit((r) => { r.workflows = r.workflows.filter((x) => x.name !== w.name); })}>Remove</button>
                </div>
              ))}
              {draft.steps.length > 0 && <div class="flyout-section-title">Steps</div>}
              {draft.steps.map((s) => (
                <div class="public-row" key={`step:${s}`}>
                  <span class="package-name">{s} {gone(`step:${s}`)}</span>
                  <span class="auto-hint">its schema, source and helpers</span>
                  <button class="btn btn-sm" onClick={() => edit((r) => { r.steps = r.steps.filter((x) => x !== s); })}>Remove</button>
                </div>
              ))}
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

        <div class="dialog-actions">
          {dirty && <button class="btn" disabled={busy} onClick={() => saved && setDraft(saved.surface)}>Discard</button>}
          {dirty && <button class="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>}
          <button class="btn" onClick={props.onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
