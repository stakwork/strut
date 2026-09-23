import { useEffect, useState } from "preact/hooks";
import yaml from "js-yaml";
import * as api from "../api";

// ── Claims panel ───────────────────────────────────────────────────────────
//
// A subject's CONTRACT (plans/claims.md): each claim is one sentence about how
// the step / workflow should behave; its status is COMPUTED from evidence on
// the active version — never asserted — and shown with the newest evidence
// behind it and the checks that produce it. A person can add, reword and
// retire claims and checks here, and ANSWER an external check's open question
// (a "slot"): those render first, as to-dos, because a claim waiting on a
// person reads `unknown` until someone looks.
//
// Rewording a claim or editing a check creates a successor (both are
// immutable once they have evidence), so the panel always re-reads after a
// write rather than patching local state.

const STATUS_LABEL: Record<api.ClaimStatusValue, string> = {
  supported: "supported",
  refuted: "refuted",
  stale: "stale",
  unknown: "unknown",
};
const STATUS_HINT: Record<api.ClaimStatusValue, string> = {
  supported: "The newest evidence on the active version supports it.",
  refuted: "Evidence on the active version refutes it — a refutation always wins.",
  stale: "The evidence is about an older version; a run on the current one will refresh it.",
  unknown: "Never checked on any version.",
};

const BLANK_CHECK: CheckDraft = { kind: "step", type: "exec", config: "cmd: test\nargs: [\"{{ input.output.ok }}\", \"=\", \"true\"]\n", name: "", description: "", when: "run", policy: "" };

interface CheckDraft {
  kind: "step" | "external";
  type: string;
  /** YAML text of the step's config. */
  config: string;
  name: string;
  description: string;
  when: "run" | "publish";
  /** "" = let the server pick (always for free code checks, on_change for paid / external). */
  policy: "" | "always" | "on_change" | "sample" | "manual";
  sampleRate?: string;
}

function draftOf(k: api.ClaimCheck): CheckDraft {
  return {
    kind: k.external ? "external" : "step",
    type: k.type ?? "",
    config: k.config ? yaml.dump(k.config, { lineWidth: -1, noRefs: true }) : "",
    name: k.name,
    description: k.description ?? "",
    when: k.when ?? "run",
    policy: k.policy ?? "",
    ...(k.sampleRate != null ? { sampleRate: String(k.sampleRate) } : {}),
  };
}

/** A draft as the API's check spec; throws with a readable message. */
function specOf(d: CheckDraft): api.ClaimCheckSpec {
  const common = { ...(d.name.trim() ? { name: d.name.trim() } : {}), ...(d.policy ? { policy: d.policy } : {}) };
  if (d.kind === "external") {
    if (!d.description.trim()) throw new Error("Say what to look at, and why code cannot check it.");
    return { ...common, description: d.description.trim() };
  }
  if (!d.type.trim()) throw new Error("A tool check needs a tool (e.g. exec).");
  let config: unknown = {};
  if (d.config.trim()) {
    try {
      config = yaml.load(d.config);
    } catch (e) {
      throw new Error(`Config is not valid YAML: ${(e as Error).message}`);
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Config must be a YAML mapping.");
  }
  const rate = d.policy === "sample" ? Number(d.sampleRate) : undefined;
  if (d.policy === "sample" && !(rate! > 0 && rate! <= 1)) throw new Error("Sample rate must be in (0, 1].");
  return {
    ...common,
    type: d.type.trim(),
    config: config as Record<string, unknown>,
    when: d.when,
    ...(d.description.trim() ? { description: d.description.trim() } : {}),
    ...(rate !== undefined ? { sampleRate: rate } : {}),
  };
}

export function ago(seconds?: number): string {
  if (!seconds) return "";
  const mins = Math.round((Date.now() / 1000 - seconds) / 60);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 60 / 24)}d ago`;
}

function CheckEditor(props: { draft: CheckDraft; onChange: (d: CheckDraft) => void; stepTypes: string[] }) {
  const d = props.draft;
  const set = (patch: Partial<CheckDraft>) => props.onChange({ ...d, ...patch });
  return (
    <div class="claim-check-editor">
      <div class="claim-kind">
        <label><input type="radio" checked={d.kind === "step"} onChange={() => set({ kind: "step" })} /> A tool runs it</label>
        <label><input type="radio" checked={d.kind === "external"} onChange={() => set({ kind: "external", when: "run" })} /> A person / outside system</label>
      </div>
      {d.kind === "step" ? (
        <>
          <div class="flyout-field">
            <label>Tool</label>
            <input type="text" list="claim-step-types" value={d.type} placeholder="exec, llm, subflow, or a custom tool" onInput={(e) => set({ type: (e.target as HTMLInputElement).value })} />
            <datalist id="claim-step-types">{props.stepTypes.map((t) => <option key={t} value={t} />)}</datalist>
          </div>
          <div class="flyout-field">
            <label>Config (YAML) — the subject is <code>input</code>: <code>{"{{ input.output.* }}"}</code>, <code>{"{{ input.input.* }}"}</code></label>
            <textarea class="mono" rows={5} value={d.config} onInput={(e) => set({ config: (e.target as HTMLTextAreaElement).value })} />
          </div>
          <div class="claim-row">
            <div class="flyout-field">
              <label>Fires</label>
              <select value={d.when} onChange={(e) => set({ when: (e.target as HTMLSelectElement).value as CheckDraft["when"] })}>
                <option value="run">on a run</option>
                <option value="publish">at publish (a lint over the source)</option>
              </select>
            </div>
            <div class="flyout-field">
              <label>Policy</label>
              <select value={d.policy} onChange={(e) => set({ policy: (e.target as HTMLSelectElement).value as CheckDraft["policy"] })}>
                <option value="">default</option>
                <option value="always">always — every run</option>
                <option value="on_change">on change — once per version</option>
                <option value="sample">sample — a fraction of runs</option>
                <option value="manual">manual — only when asked</option>
              </select>
            </div>
            {d.policy === "sample" && (
              <div class="flyout-field">
                <label>Rate</label>
                <input type="text" value={d.sampleRate ?? ""} placeholder="0.1" onInput={(e) => set({ sampleRate: (e.target as HTMLInputElement).value })} />
              </div>
            )}
          </div>
        </>
      ) : (
        <div class="flyout-field">
          <label>What to look at — and why code cannot check it</label>
          <textarea rows={3} value={d.description} placeholder="Play the clip at the cut — a click is audible, not measurable here." onInput={(e) => set({ description: (e.target as HTMLTextAreaElement).value })} />
        </div>
      )}
      <div class="flyout-field">
        <label>Label (optional)</label>
        <input type="text" value={d.name} placeholder={d.kind === "step" ? d.type || "check" : "e.g. ear"} onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} />
      </div>
    </div>
  );
}

export function ClaimsPanel(props: {
  subject: api.ClaimSubject;
  /** Open a run in the app (workflow runs only). */
  onOpenRun?: (workflow: string, runId: string) => void;
  /** Reports the listing up (the topbar badge). */
  onLoaded?: (r: api.ClaimsResponse) => void;
}) {
  const [data, setData] = useState<api.ClaimsResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stepTypes, setStepTypes] = useState<string[]>([]);
  // One editor open at a time: "new", `claim:<id>`, `check:<id>`, `addcheck:<claimId>`.
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<CheckDraft[]>([BLANK_CHECK]);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const load = () =>
    api
      .getClaims(props.subject)
      .then((r) => {
        setData(r);
        props.onLoaded?.(r);
      })
      .catch((e) => setError((e as Error).message));

  useEffect(() => {
    setData(null);
    setEditing(null);
    setError("");
    load();
  }, [props.subject.kind, props.subject.name]);

  useEffect(() => {
    api.listSteps().then((r) => setStepTypes([...r.core.map((s) => s.type), ...r.workspace.map((s) => s.type)])).catch(() => {});
  }, []);

  /** Every write re-reads: an edit may have replaced the node it touched. */
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      setEditing(null);
      await load();
    } catch (e) {
      setError((e as Error).message.replace(/^\/[^:]+: /, ""));
    } finally {
      setBusy(false);
    }
  };

  const open = (key: string, claimText = "", checks: CheckDraft[] = [BLANK_CHECK]) => {
    setEditing(key);
    setText(claimText);
    setDrafts(checks);
    setError("");
  };

  if (!data) return error ? <div class="claim-error">{error}</div> : <div class="flyout-source-empty">Loading…</div>;
  if (!data.enabled) return null;
  if (data.note && data.claims.length === 0) return <div class="flyout-source-empty">Built-in tools carry no claims — claims attach to custom tools and workflows.</div>;

  const runLink = (run?: api.ClaimRunRef) => {
    if (!run?.runId) return null;
    const isWorkflow = run.name && !run.name.includes(":");
    const label = `${run.name ?? "run"} · ${run.runId}${run.path ? ` · ${run.path}` : ""}`;
    return isWorkflow && props.onOpenRun ? (
      <button type="button" class="claim-link" onClick={() => props.onOpenRun!(run.name!, run.runId!)}>{label}</button>
    ) : (
      <span class="claim-dim">{label}</span>
    );
  };

  const todos = data.claims.flatMap((c) => c.slots.map((s) => ({ claim: c, slot: s })));

  return (
    <div class="claims-panel">
      {/* To-dos first: questions only a person (or an outside system) can answer. */}
      {todos.map(({ claim, slot }) => (
        <div class="claim-todo" key={slot.evidence}>
          <div class="claim-todo-title">Needs a look — {claim.text}</div>
          <div class="claim-todo-question">{slot.question ?? "An external check is waiting on this run."}</div>
          <div class="claim-todo-run">
            {runLink(slot.run)}
            {slot.run?.runId && <a class="claim-link" href={api.artifactUrl(`/artifacts/${slot.run.runId}/`)} target="_blank" rel="noreferrer">artifacts</a>}
          </div>
          <textarea
            rows={2}
            placeholder="What did you observe?"
            value={answers[slot.evidence] ?? ""}
            onInput={(e) => setAnswers((a) => ({ ...a, [slot.evidence]: (e.target as HTMLTextAreaElement).value }))}
          />
          <div class="claim-actions">
            {([true, false] as const).map((supports) => (
              <button
                key={String(supports)}
                type="button"
                class={`btn ${supports ? "btn-primary" : "btn-danger"}`}
                disabled={busy || !(answers[slot.evidence] ?? "").trim() || !slot.run?.runId || !slot.run?.name}
                onClick={() =>
                  act(() => api.addClaimEvidence(claim.id, { name: slot.run!.name!, runId: slot.run!.runId!, supports, content: answers[slot.evidence]!.trim(), slot: slot.evidence }))
                }
              >{supports ? "Supports" : "Refutes"}</button>
            ))}
          </div>
        </div>
      ))}

      {data.claims.length === 0 && editing !== "new" && (
        <div class="flyout-source-empty">No claims yet — nothing says how this {props.subject.kind === "step" ? "tool" : props.subject.kind} should behave, so no run can be verified.</div>
      )}

      {data.claims.map((c) => (
        <div class="claim" key={c.id}>
          <div class="claim-head">
            <span class={`claim-status claim-status-${c.status}`} title={STATUS_HINT[c.status]}>{STATUS_LABEL[c.status]}</span>
            {c.assertedOnly && <span class="claim-flag" title="No instrument observed this — only a model's or a person's word.">asserted only</span>}
            {c.unverified > 0 && c.status !== "unknown" && <span class="claim-flag" title="Active checks with no evidence about the active version.">{c.unverified} unverified</span>}
            {c.speaker && <span class="claim-dim">by {c.speaker}</span>}
          </div>
          {editing === `claim:${c.id}` ? (
            <div class="claim-edit">
              <textarea rows={2} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
              <div class="claim-hint">Rewording creates a successor: its checks carry over, and it reads unknown until a run is verified again.</div>
              <div class="claim-actions">
                <button type="button" class="btn" onClick={() => setEditing(null)}>Cancel</button>
                <button type="button" class="btn btn-primary" disabled={busy || !text.trim()} onClick={() => act(() => api.editClaim(c.id, text.trim()))}>Save</button>
              </div>
            </div>
          ) : (
            <div class="claim-text">{c.text}</div>
          )}

          {c.latest && (
            <div class="claim-evidence">
              <span class={`claim-mode claim-mode-${c.latest.mode ?? "unknown"}`}>{c.latest.mode ?? "evidence"}</span>
              <span class="claim-evidence-content">{c.latest.content}</span>
              <div class="claim-dim">
                {ago(c.latest.observedAt)}
                {c.latest.by ? ` · by ${c.latest.by}` : ""}
                {c.latest.checkVersion ? ` · ${c.latest.checkVersion}` : ""} {runLink(c.latest.run)}
              </div>
            </div>
          )}

          <div class="claim-checks">
            {c.checks.map((k) =>
              editing === `check:${k.id}` ? (
                <div class="claim-edit" key={k.id}>
                  <CheckEditor draft={drafts[0]!} onChange={(d) => setDrafts([d])} stepTypes={stepTypes} />
                  <div class="claim-hint">Editing creates a successor check; this one's evidence stops counting — a changed instrument has measured nothing yet.</div>
                  <div class="claim-actions">
                    <button type="button" class="btn" onClick={() => setEditing(null)}>Cancel</button>
                    <button type="button" class="btn btn-primary" disabled={busy} onClick={() => act(async () => api.editCheck(k.id, specOf(drafts[0]!)))}>Save</button>
                  </div>
                </div>
              ) : (
                <div class="claim-check" key={k.id}>
                  <span class="claim-check-name">{k.name}</span>
                  <span class="claim-dim">
                    {k.external ? "external" : k.type}
                    {k.when === "publish" ? " · at publish" : ""}
                    {k.policy ? ` · ${k.policy.replace("_", " ")}` : ""}
                  </span>
                  <span class="claim-check-actions">
                    <button type="button" class="claim-link" onClick={() => open(`check:${k.id}`, "", [draftOf(k)])}>edit</button>
                    <button type="button" class="claim-link" disabled={busy} onClick={() => act(() => api.retireCheck(k.id))}>retire</button>
                  </span>
                  {k.external && k.description && <div class="claim-check-desc">{k.description}</div>}
                </div>
              ),
            )}
          </div>

          {editing === `addcheck:${c.id}` ? (
            <div class="claim-edit">
              <CheckEditor draft={drafts[0]!} onChange={(d) => setDrafts([d])} stepTypes={stepTypes} />
              <div class="claim-actions">
                <button type="button" class="btn" onClick={() => setEditing(null)}>Cancel</button>
                <button type="button" class="btn btn-primary" disabled={busy} onClick={() => act(async () => api.addCheck(c.id, specOf(drafts[0]!)))}>Add check</button>
              </div>
            </div>
          ) : (
            editing !== `claim:${c.id}` && (
              <div class="claim-foot">
                <button type="button" class="claim-link" onClick={() => open(`addcheck:${c.id}`)}>+ check</button>
                <button type="button" class="claim-link" onClick={() => open(`claim:${c.id}`, c.text)}>reword</button>
                <button type="button" class="claim-link" disabled={busy} onClick={() => act(() => api.retireClaim(c.id))}>retire</button>
              </div>
            )
          )}
        </div>
      ))}

      {editing === "new" ? (
        <div class="claim claim-edit">
          <div class="flyout-field">
            <label>How should it behave? One sentence — behavior, not mechanism.</label>
            <textarea rows={2} value={text} placeholder="The clip's audio contains the requested quote." onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
          </div>
          {drafts.map((d, i) => (
            <div key={i}>
              <div class="flyout-section-title">
                Check {drafts.length > 1 ? i + 1 : ""}
                {drafts.length > 1 && <button type="button" class="claim-link" onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}>remove</button>}
              </div>
              <CheckEditor draft={d} onChange={(next) => setDrafts(drafts.map((x, j) => (j === i ? next : x)))} stepTypes={stepTypes} />
            </div>
          ))}
          <button type="button" class="claim-link" onClick={() => setDrafts([...drafts, BLANK_CHECK])}>+ another check</button>
          <div class="claim-actions">
            <button type="button" class="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button type="button" class="btn btn-primary" disabled={busy || !text.trim()} onClick={() => act(async () => api.addClaim(props.subject, text.trim(), drafts.map(specOf)))}>Add claim</button>
          </div>
        </div>
      ) : (
        <button type="button" class="btn claim-add" onClick={() => open("new")}>+ Claim</button>
      )}

      {error && <div class="claim-error">{error}</div>}
      {data.verifyCostUsd != null && <div class="claim-dim claim-cost">Paid checks have cost ${data.verifyCostUsd.toFixed(4)} so far.</div>}
    </div>
  );
}

/** Counts for a badge: what needs attention on a subject. */
export function claimsSummary(claims: api.ClaimEntry[]): { total: number; refuted: number; open: number; todos: number } {
  return {
    total: claims.length,
    refuted: claims.filter((c) => c.status === "refuted").length,
    open: claims.filter((c) => c.status === "unknown" || c.status === "stale").length,
    todos: claims.reduce((n, c) => n + c.slots.length, 0),
  };
}
