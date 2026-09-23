import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { ago } from "./ClaimsPanel";

// ── Versions panel (a Workflow flyout tab) ─────────────────────────────────
//
// The workflow's published lineage, newest first, with how often each version
// ran. "View" opens a version on the canvas (read-only, like the topbar
// picker); "Make active" rolls back (or forward) — Run, schedules and claims
// then use that version. Activating publishes nothing: the next Publish still
// gets a fresh number.

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^\/[^:]*: /, "");
const secs = (iso?: string) => (iso ? Date.parse(iso) / 1000 : undefined);

export function VersionsPanel(props: {
  workflow: string;
  /** The version the canvas shows (null = the active one). */
  viewVersion: string | null;
  onView: (version: string | null) => void;
  /** Make `version` active — the caller confirms, reloads and refreshes. */
  onActivate: (version: string) => Promise<void>;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getWorkflowVersions>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () =>
    api.getWorkflowVersions(props.workflow).then(setData, (err) => setError(message(err)));
  useEffect(() => { void refresh(); }, [props.workflow]);

  const activate = async (v: string) => {
    setBusy(v);
    setError(null);
    try {
      await props.onActivate(v);
      await refresh();
    } catch (err) {
      setError(message(err));
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
              <span class="auto-meta">{ago(secs(v.createdAt))}</span>
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
                <button class="btn btn-primary" disabled={busy !== null} onClick={() => void activate(v.version)}>
                  {busy === v.version ? "Activating…" : "Make active"}
                </button>
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
