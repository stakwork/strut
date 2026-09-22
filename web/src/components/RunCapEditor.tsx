// ── Run-cap chip + editor ───────────────────────────────────────────────────
//
// Beside the category chip: the workflow's per-run LLM spend cap in dollars
// (plans/mothership-cost-control.md §3). Rendered only when the deployment
// routes spend through the Mothership (`GET /llm/mothership`) — without it
// nothing enforces the number. Empty = the deployment default. Metadata-only
// on the server: no new workflow version is published.

import { useState } from "preact/hooks";
import * as api from "../api";

export function RunCapEditor(props: {
  workflow: string;
  maxRunCostUsd?: number;
  onSaved: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(props.maxRunCostUsd != null ? String(props.maxRunCostUsd) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = () => {
    setValue(props.maxRunCostUsd != null ? String(props.maxRunCostUsd) : "");
    setError(null);
    setOpen((o) => !o);
  };

  const save = async () => {
    const raw = value.trim();
    const next = raw ? Number(raw) : null;
    if (next !== null && !(Number.isFinite(next) && next > 0)) {
      setError("Enter a positive dollar amount, or leave it empty for the deployment default.");
      return;
    }
    if (next === (props.maxRunCostUsd ?? null)) { setOpen(false); return; }
    setSaving(true);
    try {
      await api.setWorkflowRunCap(props.workflow, next);
      await props.onSaved();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <span class="cat-anchor">
      <button
        class={`cat-chip${props.maxRunCostUsd != null ? "" : " is-empty"}`}
        title="Per-run LLM spend cap, enforced by the Mothership"
        onClick={toggle}
      >
        {props.maxRunCostUsd != null ? `cap $${props.maxRunCostUsd}` : "+ run cap"}
      </button>
      {open && (
        <div class="cat-popover">
          <input
            type="number"
            min="0"
            step="any"
            value={value}
            placeholder="Max $ per run (empty = default)"
            autoFocus
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") setOpen(false);
            }}
          />
          {error && <div class="cat-popover-error">{error}</div>}
          <div class="cat-popover-actions">
            <button class="btn" onClick={() => setOpen(false)}>Cancel</button>
            <button class="btn btn-primary" disabled={saving} onClick={save}>Save</button>
          </div>
        </div>
      )}
    </span>
  );
}
