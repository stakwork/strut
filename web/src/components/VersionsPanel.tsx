import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { ago } from "./ClaimsPanel";
import { errorMessage } from "../helpers";
import { ConfirmButton } from "./ConfirmButton";

// ── Versions panel (a Workflow flyout tab) ─────────────────────────────────
//
// The workflow's published lineage, newest first, with how often each version
// ran. "View" opens a version on the canvas (read-only, like the topbar
// picker); "Make active" rolls back (or forward) — Run, schedules and claims
// then use that version. Activating publishes nothing: the next Publish still
// gets a fresh number.

const secs = (iso?: string) => (iso ? Date.parse(iso) / 1000 : undefined);
/** When a version was published: relative within a day, then the date. */
const published = (iso: string) => {
  const d = new Date(iso);
  if (Date.now() - d.getTime() < 24 * 3600 * 1000) return ago(secs(iso));
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
    hour: "2-digit",
    minute: "2-digit",
  });
};

export function VersionsPanel(props: {
  workflow: string;
  /** The version the canvas shows (null = the active one). */
  viewVersion: string | null;
  onView: (version: string | null) => void;
  /** Make `version` active — the caller reloads and refreshes. */
  onActivate: (version: string) => Promise<void>;
  /** Unpublished canvas edits: activating discards them, so it asks first. */
  dirty: boolean;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getWorkflowVersions>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () =>
    api.getWorkflowVersions(props.workflow).then(setData, (err) => setError(errorMessage(err)));
  useEffect(() => { void refresh(); }, [props.workflow]);

  const activate = async (v: string) => {
    setBusy(v);
    setError(null);
    try {
      await props.onActivate(v);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const shown = props.viewVersion ?? data?.active;

  return (
    <div class="flyout-body">
      <div class="flyout-section">
        <span class="auto-hint">
          The active version is what Run, schedules and claims use. Making an older version active is a rollback — nothing is
          republished.
        </span>
      </div>
      {error && <div class="auto-error">{error}</div>}
      {data === null && !error && <div class="auto-hint">Loading…</div>}
      {data?.versions.map((v) => {
        const active = v.version === data.active;
        return (
          <div class={`auto-card${active ? " is-active-version" : ""}`} key={v.version}>
            <div class="auto-card-head">
              <span class="version-name">
                {v.version}
                {active && <span class="badge badge-accent">active</span>}
                {v.version === shown && !active && <span class="badge">viewing</span>}
              </span>
              <span class="auto-meta" title={new Date(v.createdAt).toLocaleString()}>{published(v.createdAt)}</span>
            </div>
            {v.description && <div class="auto-hint">{v.description}</div>}
            <div class="auto-meta">
              {v.runs === 0 ? (
                <span>No runs</span>
              ) : (
                <>
                  <span>{v.runs} run{v.runs === 1 ? "" : "s"}</span>
                  {v.success > 0 && <span class="badge badge-ok">{v.success} ok</span>}
                  {v.error > 0 && <span class="badge badge-danger">{v.error} failed</span>}
                  {v.lastRunAt && <span>last {ago(secs(v.lastRunAt))}</span>}
                </>
              )}
            </div>
            <div class="auto-card-actions">
              {v.version !== shown && (
                <button class="btn" onClick={() => props.onView(active ? null : v.version)}>View</button>
              )}
              {!active && (
                <ConfirmButton class="btn btn-primary" label={busy === v.version ? "Activating…" : "Make active"}
                  disabled={busy !== null} ask={props.dirty}
                  note={`Discard your unpublished changes and make ${v.version} active?`} confirmLabel="Discard and activate"
                  onConfirm={() => void activate(v.version)} />
              )}
            </div>
          </div>
        );
      })}
      {data && data.unattributed > 0 && (
        <div class="auto-hint">
          {data.unattributed} older run{data.unattributed === 1 ? "" : "s"} recorded no version and {data.unattributed === 1 ? "is" : "are"} not counted.
        </div>
      )}
    </div>
  );
}
