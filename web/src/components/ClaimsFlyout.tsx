import * as api from "../api";
import { CloseIcon } from "../icons";
import { FlyoutResizer } from "./FlyoutResizer";
import { ClaimsPanel } from "./ClaimsPanel";

// ── Claims Flyout (workflow level) ─────────────────────────────────────────
//
// The workflow's own contract. Each step's claims live on that step (open it
// on the canvas) — step evidence does not roll up into the workflow.

export function ClaimsFlyout(props: {
  workflow: string;
  onOpenRun?: (workflow: string, runId: string) => void;
  onLoaded?: (r: api.ClaimsResponse) => void;
  onClose: () => void;
}) {
  return (
    <div class="flyout">
      <FlyoutResizer />
      <div class="flyout-header">
        <div>
          <div class="flyout-eyebrow">Claims</div>
          <div class="flyout-title">{props.workflow}</div>
        </div>
        <button class="flyout-close" onClick={props.onClose} aria-label="Close"><CloseIcon /></button>
      </div>
      <div class="flyout-body">
        <div class="flyout-section">
          <span class="flyout-meta-value">
            How this workflow should behave. Status is computed from evidence on the active version — runs are verified
            automatically. A step's own claims are on that step.
          </span>
        </div>
        <ClaimsPanel subject={{ kind: "workflow", name: props.workflow }} onOpenRun={props.onOpenRun} onLoaded={props.onLoaded} />
      </div>
    </div>
  );
}
