import { useState } from "preact/hooks";
import * as api from "../api";
import { CloseIcon, ClockIcon } from "../icons";
import { FlyoutResizer } from "./FlyoutResizer";
import { errorMessage } from "../helpers";
import { ClaimsPanel, claimsSummary } from "./ClaimsPanel";
import { ParamsPanel } from "./ParamsPanel";
import { AutomationsPanel } from "./AutomationsPanel";
import { VersionsPanel } from "./VersionsPanel";
import type { InputBinding } from "../run-inputs";

// ── Workflow Flyout ─────────────────────────────────────────────────────────
//
// Everything about the selected workflow that is not a step, one tab each:
// its params (the tunable knobs — versioned content, so edits go through
// Publish), its claims (the contract + evidence, computed on the active
// version), its automations (schedules — metadata, never a version) and its
// versions (run counts + rollback). One
// flyout means one topbar button, and the tabs exclude each other by
// construction. Which tabs exist is the caller's call: a workflow with no
// params has no Params tab, a filesystem workspace has no Claims tab, the
// history view has no Automate tab. Deleting the workflow lives at the
// bottom, out of the way.

export type WorkflowTab = "params" | "claims" | "automations" | "versions";

const LABEL: Record<WorkflowTab, string> = { params: "Params", claims: "Claims", automations: "Automate", versions: "Versions" };

/** The claims dot: what needs attention, at a glance — refuted > a to-do >
 *  unverified (or no claims at all) > every claim supported. */
export function claimsTone(claims: api.ClaimsResponse): "bad" | "todo" | "open" | "ok" {
  const sum = claimsSummary(claims.claims);
  return sum.refuted ? "bad" : sum.todos ? "todo" : sum.open || sum.total === 0 ? "open" : "ok";
}

export function claimsTitle(claims: api.ClaimsResponse): string {
  const sum = claimsSummary(claims.claims);
  if (sum.total === 0) return "No claims yet — nothing says how this workflow should behave";
  return `${sum.total} claim${sum.total === 1 ? "" : "s"}: ${sum.refuted} refuted, ${sum.open} unverified, ${sum.todos} waiting on someone`;
}


export function WorkflowFlyout(props: {
  workflow: string;
  tab: WorkflowTab;
  tabs: WorkflowTab[];
  onTab: (tab: WorkflowTab) => void;
  onClose: () => void;
  /** Delete the workflow — the caller owns selection + refresh. Rejects with
   *  the server's reason (a run still in flight), shown in the footer. */
  onDelete: () => Promise<void>;
  // Params
  params: Record<string, unknown>;
  onParamsChange: (next: Record<string, unknown>) => void;
  onParamsValidChange: (valid: boolean) => void;
  // Claims
  claims: api.ClaimsResponse | null;
  onClaimsLoaded: (r: api.ClaimsResponse) => void;
  onOpenRun: (workflow: string, runId: string) => void;
  // Automations
  automations: api.Automation[];
  loadBindings: () => Promise<InputBinding[]>;
  onAutomationsChanged: () => void;
  // Versions
  viewVersion: string | null;
  onViewVersion: (version: string | null) => void;
  onActivateVersion: (version: string) => Promise<void>;
  /** Every run of the workflow, all versions — the footer's totals. */
  runs: api.RunSummary[];
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const scheduled = props.automations.filter((a) => a.enabled).length;
  const ok = props.runs.filter((r) => r.status === "success").length;
  const failed = props.runs.filter((r) => r.status === "error").length;

  const del = async () => {
    if (!confirm(`Delete "${props.workflow}"?\n\nEvery version, schedule and run goes with it.`)) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await props.onDelete();
    } catch (err) {
      setDeleteError(errorMessage(err));
      setDeleting(false);
    }
  };

  return (
    <div class="flyout">
      <FlyoutResizer />
      <div class="flyout-header">
        <div>
          <div class="flyout-eyebrow">Workflow</div>
          <div class="flyout-title">{props.workflow}</div>
        </div>
        <button class="flyout-close" onClick={props.onClose} aria-label="Close"><CloseIcon /></button>
      </div>
      <div class="flyout-tabs" role="tablist">
        {props.tabs.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={t === props.tab}
            class={`flyout-tab${t === props.tab ? " is-active" : ""}`}
            title={t === "claims" && props.claims ? claimsTitle(props.claims) : undefined}
            onClick={() => props.onTab(t)}
          >
            {t === "automations" && <ClockIcon size={12} />}
            {LABEL[t]}
            {t === "claims" && props.claims && <span class={`claims-dot claims-dot-${claimsTone(props.claims)}`} />}
            {t === "automations" && scheduled > 0 && <span class="automations-count">{scheduled}</span>}
          </button>
        ))}
      </div>

      {props.tab === "params" && (
        <ParamsPanel params={props.params} onChange={props.onParamsChange} onValidChange={props.onParamsValidChange} />
      )}
      {props.tab === "claims" && (
        <div class="flyout-body">
          <div class="flyout-section">
            <span class="flyout-meta-value">
              How this workflow should behave. Status is computed from evidence on the active version — runs are verified
              automatically. A tool's own claims are on that tool.
            </span>
          </div>
          <ClaimsPanel subject={{ kind: "workflow", name: props.workflow }} onOpenRun={props.onOpenRun} onLoaded={props.onClaimsLoaded} />
        </div>
      )}
      {props.tab === "automations" && (
        <AutomationsPanel
          workflow={props.workflow}
          loadBindings={props.loadBindings}
          onOpenRun={props.onOpenRun}
          onChanged={props.onAutomationsChanged}
          onEditingChange={setEditing}
        />
      )}

      {props.tab === "versions" && (
        <VersionsPanel
          workflow={props.workflow}
          viewVersion={props.viewVersion}
          onView={props.onViewVersion}
          onActivate={props.onActivateVersion}
        />
      )}

      {/* The automation editor brings its own action bar; the footer yields to it. */}
      {!editing && (
        <div class="flyout-footer">
          <span class="flyout-footer-runs" title="All runs, every version">
            {props.runs.length === 0 ? "No runs" : `${props.runs.length} run${props.runs.length === 1 ? "" : "s"}`}
            {ok > 0 && <span class="badge badge-ok">{ok} ok</span>}
            {failed > 0 && <span class="badge badge-danger">{failed} failed</span>}
          </span>
          {deleteError && <span class="flyout-footer-error">{deleteError}</span>}
          <button class="btn btn-danger" disabled={deleting} onClick={del}>Delete workflow</button>
        </div>
      )}
    </div>
  );
}
