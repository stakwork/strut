import { useState, useEffect } from "preact/hooks";
import { baseType, formatStepRef, parseStepRef } from "../step-ref";
import { dependsForSave } from "../step-depends";
import * as api from "../api";
import { StepData } from "../flow-to-canvas";
import { ConfigField } from "./ConfigField";
import { FlyoutResizer } from "./FlyoutResizer";
import { CloseIcon } from "../icons";
import { humanize } from "../helpers";
import { ClaimsPanel, claimsSummary } from "./ClaimsPanel";
import yaml from "js-yaml";

// ── Step Edit Flyout ───────────────────────────────────────────────────────

/** `v10` before `v9` — labels are `vN`, so sort numerically, newest first. */
function byVersionDesc(a: string, b: string): number {
  return (parseInt(b.slice(1), 10) || 0) - (parseInt(a.slice(1), 10) || 0);
}

export function StepEditFlyout(props: {
  step: StepData;
  allSteps: StepData[];
  onSave: (updated: StepData) => void;
  onClose: () => void;
  /** Open a run from a claim's evidence / to-do. */
  onOpenRun?: (workflow: string, runId: string) => void;
}) {
  const [id, setId] = useState(props.step.id);
  // The step TYPE is fixed for this node; its VERSION is this workflow's
  // choice: undefined = the step's active version (what every unpinned
  // workflow runs), "vN" = pinned there until changed here (src/step-ref.ts).
  const stepType = baseType(props.step.type);
  const [pin, setPin] = useState<string | undefined>(parseStepRef(props.step.type).version);
  const typeRef = formatStepRef({ type: stepType, version: pin });
  // null = not a versioned (custom) step → no picker.
  const [versions, setVersions] = useState<{ active: string; versions: string[] } | null>(null);
  const [config, setConfig] = useState<Record<string, any>>({ ...props.step.config });
  const [depends, setDepends] = useState<string[]>(() => {
    if (props.step.depends == null) return [];
    return Array.isArray(props.step.depends) ? [...props.step.depends] : [props.step.depends];
  });
  const [when, setWhen] = useState<boolean | undefined>(props.step.when);
  const [fields, setFields] = useState<api.FieldDesc[]>([]);
  const [error, setError] = useState("");
  const [dependsOpen, setDependsOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [source, setSource] = useState<api.StepSourceResponse | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  // Claims belong to the step TYPE (not this instance in this workflow). The
  // probe tells us whether there is a claims layer at all, and drives the note.
  const [claims, setClaims] = useState<api.ClaimsResponse | null>(null);
  const [claimsOpen, setClaimsOpen] = useState(false);

  // Fetch schema for this step reference — a pin's schema is that version's.
  useEffect(() => {
    api.getStepSchema(typeRef).then((resp) => {
      setFields(resp.fields);
    }).catch(() => setFields([]));
  }, [typeRef]);

  useEffect(() => {
    setVersions(null);
    api.getStepVersions(stepType).then((r) => setVersions({ active: r.active, versions: r.versions })).catch(() => setVersions(null));
  }, [stepType]);

  // Lazily fetch source the first time the section is expanded (per type).
  useEffect(() => {
    setSourceOpen(false);
    setSource(null);
  }, [props.step.type]);

  useEffect(() => {
    setClaims(null);
    setClaimsOpen(false);
    api.getClaims({ kind: "step", name: baseType(props.step.type) })
      .then((r) => {
        setClaims(r);
        // A to-do or a refutation should not hide behind a collapsed row.
        const s = claimsSummary(r.claims);
        if (s.todos > 0 || s.refuted > 0) setClaimsOpen(true);
      })
      .catch(() => setClaims(null));
  }, [typeRef]);

  const toggleSource = () => {
    const next = !sourceOpen;
    setSourceOpen(next);
    if (next && source === null && !sourceLoading) {
      setSourceLoading(true);
      api.getStepSource(typeRef)
        .then(setSource)
        .catch(() => setSource({ type: typeRef, source: null, origin: null }))
        .finally(() => setSourceLoading(false));
    }
  };

  // Reset state when step changes
  useEffect(() => {
    setId(props.step.id);
    setPin(parseStepRef(props.step.type).version);
    setConfig({ ...props.step.config });
    const deps = props.step.depends == null ? [] : Array.isArray(props.step.depends) ? [...props.step.depends] : [props.step.depends];
    setDepends(deps);
    setDependsOpen(false);
    setWhen(props.step.when);
    setError("");
  }, [props.step]);

  const updateConfig = (name: string, value: unknown) => {
    setConfig((prev) => ({ ...prev, [name]: value }));
  };

  // Detect if any of the current deps is an `if` gate (enables the `when` field)
  const hasGateDep = depends.some((d) => {
    const dep = props.allSteps.find((s) => s.id === d);
    return dep?.type === "if";
  });

  const handleSave = () => {
    if (!id) { setError("Tool must have an id"); return; }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(id)) {
      setError("ID must match [a-zA-Z_][a-zA-Z0-9_]*");
      return;
    }
    // Strip empty-string values for optional fields
    const cleanConfig: Record<string, any> = {};
    for (const [k, v] of Object.entries(config)) {
      if (v !== "" && v !== undefined) cleanConfig[k] = v;
    }
    const updated: StepData = {
      id,
      type: typeRef,
      config: cleanConfig,
      options: props.step.options,
    };
    const savedDepends = dependsForSave(props.step.depends, depends);
    if (savedDepends) updated.depends = savedDepends;
    // Only persist `when` if there's a gate dep
    if (when != null && hasGateDep) updated.when = when;
    props.onSave(updated);
  };

  // Build YAML preview
  const previewObj: Record<string, any> = { id, type: typeRef, config };
  const previewDepends = dependsForSave(props.step.depends, depends);
  if (previewDepends) previewObj.depends = previewDepends;
  if (when != null && hasGateDep) previewObj.when = when;
  const yamlPreview = yaml.dump(previewObj, { lineWidth: 120, noRefs: true });

  // Other step ids for depends checkboxes (exclude self)
  const otherStepIds = props.allSteps.map((s) => s.id).filter((sid) => sid !== props.step.id);

  return (
    <div class="flyout">
      <FlyoutResizer />
      <div class="flyout-header">
        <div>
          <div class="flyout-eyebrow">Edit Tool</div>
          <div class="flyout-title">
            {stepType}
            {pin && <span class="badge badge-pin" title="Pinned to this version in this workflow">@{pin}</span>}
          </div>
        </div>
        <button class="flyout-close" onClick={props.onClose} aria-label="Close"><CloseIcon /></button>
      </div>
      <div class="flyout-body">
        {/* Step ID */}
        <div class="flyout-field">
          <label>ID</label>
          <input
            type="text"
            value={id}
            onInput={(e) => { setId((e.target as HTMLInputElement).value); setError(""); }}
          />
        </div>

        {/* Version pin — this workflow's choice, not the step's active pointer. */}
        {versions && (
          <div class="flyout-field">
            <label>Version</label>
            <select value={pin ?? ""} onInput={(e) => { const v = (e.target as HTMLSelectElement).value; setPin(v || undefined); setError(""); }}>
              <option value="">Active ({versions.active}) — follows step edits</option>
              {[...versions.versions].sort(byVersionDesc).map((v) => (
                <option key={v} value={v}>{v}{v === versions.active ? " (active)" : ""} — pinned</option>
              ))}
            </select>
            <div class="flyout-field-note">
              {!pin
                ? "Runs whatever version of this tool is active; editing the tool changes this workflow too."
                : pin === versions.active
                  ? `Pinned to ${pin}, which is also the active version. This workflow stays on ${pin} if the tool is edited.`
                  : `Pinned to ${pin} · active is ${versions.active}. This workflow keeps running ${pin} until you change it here.`}
            </div>
          </div>
        )}

        {/* Config fields from schema */}
        {fields.length > 0 && (
          <div class="flyout-section">
            <div class="flyout-section-title">Config</div>
            {fields.map((f) => (
              <ConfigField
                key={f.name}
                field={asStringIfTemplated(f, config[f.name])}
                value={config[f.name]}
                onChange={(v) => updateConfig(f.name, v)}
              />
            ))}
          </div>
        )}

        {/* Fallback: if no schema loaded yet, show raw config fields */}
        {fields.length === 0 && Object.keys(config).length > 0 && (
          <div class="flyout-section">
            <div class="flyout-section-title">Config</div>
            {Object.entries(config).map(([key, val]) => (
              <div class="flyout-field" key={key}>
                <label>{humanize(key)}</label>
                <input
                  type="text"
                  value={typeof val === "string" ? val : JSON.stringify(val)}
                  onInput={(e) => {
                    const raw = (e.target as HTMLInputElement).value;
                    try { updateConfig(key, JSON.parse(raw)); } catch { updateConfig(key, raw); }
                  }}
                />
              </div>
            ))}
          </div>
        )}

        {/* Depends — collapsed by default. The toggle row names the current
            deps, so the checkbox list only needs opening to change them. */}
        {otherStepIds.length > 0 && (
          <div class="flyout-section">
            <button
              class="flyout-toggle"
              onClick={() => setDependsOpen((o) => !o)}
              type="button"
              aria-expanded={dependsOpen}
            >
              <span class={`flyout-toggle-caret${dependsOpen ? " open" : ""}`}>▶</span>
              Depends on
              <span class="flyout-toggle-note">{depends.length > 0 ? depends.join(", ") : "none"}</span>
            </button>
            {dependsOpen && (
            <div class="flyout-checkbox-group flyout-toggle-body">
              {otherStepIds.map((sid) => {
                const dep = props.allSteps.find((s) => s.id === sid);
                const isGate = dep?.type === "if";
                return (
                  <label key={sid} class="flyout-checkbox-label">
                    <input
                      type="checkbox"
                      checked={depends.includes(sid)}
                      onChange={(e) => {
                        const checked = (e.target as HTMLInputElement).checked;
                        setDepends((prev) =>
                          checked ? [...prev, sid] : prev.filter((d) => d !== sid)
                        );
                      }}
                    />
                    {sid}{isGate && <span style="color:var(--text-dim);font-size:11px;"> (gate)</span>}
                  </label>
                );
              })}
            </div>
            )}
          </div>
        )}

        {/* When (gate condition) — only shown when depending on an `if` gate */}
        {hasGateDep && (
          <div class="flyout-section">
            <div class="flyout-section-title">When (gate branch)</div>
            <div class="flyout-field">
              <select
                value={when == null ? "" : String(when)}
                onChange={(e) => {
                  const v = (e.target as HTMLSelectElement).value;
                  setWhen(v === "" ? undefined : v === "true");
                }}
              >
                <option value="">always (no gating)</option>
                <option value="true">true branch</option>
                <option value="false">false branch</option>
              </select>
            </div>
          </div>
        )}

        {/* Claims on this step TYPE — only custom steps carry them, and only on
            a graph-backed workspace. */}
        {claims?.enabled && !claims.note && (() => {
          const sum = claimsSummary(claims.claims);
          const note = sum.total === 0
            ? "none"
            : [sum.refuted ? `${sum.refuted} refuted` : "", sum.open ? `${sum.open} unverified` : "", sum.todos ? `${sum.todos} to do` : ""].filter(Boolean).join(", ") || `${sum.total} supported`;
          return (
            <div class="flyout-section">
              <button class="flyout-toggle" onClick={() => setClaimsOpen((o) => !o)} type="button" aria-expanded={claimsOpen}>
                <span class={`flyout-toggle-caret${claimsOpen ? " open" : ""}`}>▶</span>
                Claims
                <span class={`flyout-toggle-note${sum.refuted ? " claim-note-bad" : ""}`}>{note}</span>
              </button>
              {claimsOpen && (
                <div class="flyout-toggle-body">
                  <ClaimsPanel subject={{ kind: "step", name: baseType(props.step.type) }} onOpenRun={props.onOpenRun} onLoaded={setClaims} />
                </div>
              )}
            </div>
          );
        })()}

        {/* YAML preview (read-only) */}
        <div class="flyout-section">
          <div class="flyout-section-title">YAML Preview</div>
          <pre class="flyout-yaml-preview">{yamlPreview}</pre>
        </div>

        {/* Step source (lazily fetched, read-only) */}
        <div class="flyout-section">
          <button class="flyout-toggle" onClick={toggleSource} type="button">
            <span class={`flyout-toggle-caret${sourceOpen ? " open" : ""}`}>▶</span>
            Source
            {source?.origin && (
              <span class="flyout-toggle-note">{source.origin}</span>
            )}
          </button>
          {sourceOpen && (
            sourceLoading ? (
              <div class="flyout-source-empty">Loading…</div>
            ) : source?.source ? (
              <pre class="flyout-source-code">{source.source}</pre>
            ) : (
              <div class="flyout-source-empty">No source available for this tool.</div>
            )
          )}
        </div>

        {error && <div style="color:var(--danger);font-size:12px;">{error}</div>}
      </div>
      <div class="flyout-actions">
        <button class="btn" onClick={props.onClose}>Cancel</button>
        <button class="btn btn-primary" onClick={handleSave}>Save</button>
      </div>
    </div>
  );
}

/**
 * If the current value contains a `{{ ... }}` template, render the field
 * as a plain string input so the user can edit the template directly. The
 * underlying schema is left untouched — once the template is removed the
 * field reverts to its declared kind on next render.
 */
function asStringIfTemplated(field: api.FieldDesc, value: unknown): api.FieldDesc {
  if (typeof value === "string" && value.includes("{{")) {
    return { ...field, kind: "string" };
  }
  return field;
}
