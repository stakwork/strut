// ── Owner chip + claim ──────────────────────────────────────────────────────
//
// Beside the category chip: who the selected workflow belongs to — the
// person its scheduled runs are billed to (plans/mothership-cost-control.md
// §2). Rendered only when spend routes through the Mothership. An ownerless
// workflow can be claimed here, one at a time or every unowned one at once
// (the migration for a workspace that predates owners); the server decides
// who "you" are. Transfers are an admin action (PUT /workflows/:name/owner).

import { useState } from "preact/hooks";
import * as api from "../api";

export function OwnerEditor(props: {
  workflow: string;
  owner?: string;
  /** How many workflows in the workspace have no owner. */
  unowned: number;
  onSaved: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const toggle = () => {
    setError(null);
    setResult(null);
    setOpen((o) => !o);
  };

  const claim = async (all: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.claimWorkflows(all ? undefined : [props.workflow]);
      const taken = r.skipped.filter((s) => s.owner && s.owner !== r.actor).length;
      setResult(`Claimed ${r.claimed.length} for ${r.actor}${taken ? `; ${taken} owned by others` : ""}.`);
      await props.onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span class="cat-anchor">
      <button
        class={`cat-chip${props.owner ? "" : " is-empty"}`}
        title={props.owner ? "Owner — scheduled runs are billed to them" : "No owner — scheduled runs have nobody to bill"}
        onClick={toggle}
      >
        {props.owner ?? "unowned"}
      </button>
      {open && (
        <div class="cat-popover">
          <div class="cat-popover-text">
            {props.owner
              ? <>Owned by <b>{props.owner}</b>. Its scheduled runs are billed to them.</>
              : <>No owner. Scheduled runs of this workflow have nobody to bill.</>}
          </div>
          {result && <div class="cat-popover-text">{result}</div>}
          {error && <div class="cat-popover-error">{error}</div>}
          <div class="cat-popover-actions">
            <button class="btn" onClick={() => setOpen(false)}>Close</button>
            {props.unowned > 0 && (
              <button class="btn" disabled={busy} onClick={() => claim(true)} title="Claim every workflow that has no owner">
                Claim all unowned ({props.unowned})
              </button>
            )}
            {!props.owner && (
              <button class="btn btn-primary" disabled={busy} onClick={() => claim(false)}>Claim</button>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
