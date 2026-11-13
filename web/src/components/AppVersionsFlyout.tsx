import { useState } from "preact/hooks";
import { displayActor } from "../actor";
import { errorMessage } from "../helpers";
import { CloseIcon } from "../icons";
import {
  STATE_LABEL,
  appVersionRows,
  followNote,
  holdNote,
  isHeld,
  isSeeded,
  liveRelease,
  makeLiveNote,
  restoreNote,
  when,
  type AppVersionsData,
} from "../app-versions";
import { newestVersion } from "../app-screenshots";
import { AppScreenshots } from "./AppScreenshots";
import { ConfirmButton } from "./ConfirmButton";
import { FlyoutResizer } from "./FlyoutResizer";

// ── An app's versions (plans/app-releases.md) ──────────────────────────────
//
// What people open, and how to change it. On top, the mode: every publish
// goes live (following latest), or the app is held at a version and a
// publish waits as a draft. Then the live version, then one row per version,
// newest first, with View (this browser only: the frame shows it under a
// banner, nobody else's changes), Make live, or Restore for a version that
// was live before (its newest release, `PUT /apps/:name/active { release }`).
// Every change asks first. Release ids stay out of sight but in History.
//
// Not shown yet: what the live release's lock no longer matches (`behind`)
// and what it could not hold (`floating`). Runs do not keep to the lock until
// plans/app-releases.md work item 2, so a "workflows changed since" line
// would offer an Update that changes nothing.

type Target = { version: string } | { release: string };

export function AppVersionsFlyout(props: {
  app: { name: string; title: string };
  /** `GET /apps/:name/versions`, read by the shell (the topbar's chip counts
   *  the same drafts); null while it loads. */
  data: AppVersionsData | null;
  loadError: string;
  /** The version this browser is viewing in place of the live one. */
  viewing: string | null;
  onView: (version: string | null) => void;
  /** Make a version or a release live, or follow latest: the caller
   *  refreshes the app and its frame. Throws when the server refuses. */
  onSetLive: (target: Target) => Promise<void>;
  /** A new version was published (the Screenshots section): read the app again. */
  onPublished: () => void | Promise<void>;
  onClose: () => void;
}) {
  const { app, data, loadError } = props;
  const [busy, setBusy] = useState(false);
  /** A refusal, and — for a Restore the server refused — the version to make live instead. */
  const [failed, setFailed] = useState<{ message: string; instead?: string } | null>(null);
  const [pendingMode, setPendingMode] = useState<"follow" | "hold" | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const act = async (target: Target, instead?: string) => {
    setBusy(true);
    setFailed(null);
    setPendingMode(null);
    try {
      await props.onSetLive(target);
    } catch (err) {
      setFailed({ message: errorMessage(err), ...(instead ? { instead } : {}) });
    } finally {
      setBusy(false);
    }
  };

  const held = !!data && isHeld(data.live);
  const seeded = !!data && isSeeded(data);
  const rows = data ? appVersionRows(data) : [];
  const release = data ? liveRelease(data) : undefined;
  const shown = props.viewing ?? data?.active;

  return (
    <div class="flyout">
      <FlyoutResizer />
      <div class="flyout-header">
        <div class="flyout-title">Versions · {app.title}</div>
        <button class="btn btn-icon" onClick={props.onClose} aria-label="Close"><CloseIcon /></button>
      </div>
      <div class="flyout-body app-versions">
        {loadError && <div class="auto-error">{loadError}</div>}
        {!data && !loadError && <div class="empty">Loading…</div>}
        {data && (
          <>
            {seeded ? (
              <div class="auto-hint">Seeded by strut: every start makes its committed version live, so it cannot be held.</div>
            ) : (
              <div class="app-mode">
                <div class="app-mode-seg" role="group" aria-label="What people open">
                  <button
                    type="button"
                    class={`app-mode-btn${!held ? " is-on" : ""}${pendingMode === "follow" ? " is-pending" : ""}`}
                    aria-pressed={!held}
                    disabled={busy}
                    onClick={() => setPendingMode(held && pendingMode !== "follow" ? "follow" : null)}
                  >Every publish goes live</button>
                  <button
                    type="button"
                    class={`app-mode-btn${held ? " is-on" : ""}${pendingMode === "hold" ? " is-pending" : ""}`}
                    aria-pressed={held}
                    disabled={busy}
                    onClick={() => setPendingMode(!held && pendingMode !== "hold" ? "hold" : null)}
                  >Hold a version</button>
                </div>
                {pendingMode && (
                  <div class="app-mode-confirm">
                    <span class="confirm-note">{pendingMode === "follow" ? followNote(data) : holdNote(data.active)}</span>
                    <button class="btn btn-sm" onClick={() => setPendingMode(null)}>Cancel</button>
                    <button
                      class="btn btn-sm btn-primary"
                      onClick={() => void act(pendingMode === "follow" ? { version: "latest" } : { version: data.active })}
                    >{pendingMode === "follow" ? "Go live with every publish" : `Hold at ${data.active}`}</button>
                  </div>
                )}
              </div>
            )}

            <div class="app-live-card">
              <div class="app-live-head">
                <span class="app-live-version">{data.active}</span>
                <span class="badge badge-ok">live</span>
                {props.viewing && props.viewing !== data.active && (
                  <button class="btn btn-sm app-live-view" onClick={() => props.onView(null)}>View</button>
                )}
              </div>
              <div class="auto-meta">
                {held && release
                  ? <span title={new Date(release.createdAt).toLocaleString()}>
                      Live since {when(release.createdAt)}{release.by ? `, by ${displayActor(release.by)}` : ""}
                    </span>
                  : <span title={data.versions[data.active] ? new Date(data.versions[data.active]!.createdAt).toLocaleString() : undefined}>
                      Published {data.versions[data.active] ? when(data.versions[data.active]!.createdAt) : ""}
                      {seeded ? "" : " · every publish goes live"}
                    </span>}
              </div>
            </div>

            {failed && (
              <div class="auto-error">
                {failed.message}
                {failed.instead && (
                  <div class="app-versions-instead">
                    <button class="btn btn-sm" disabled={busy} onClick={() => void act({ version: failed.instead! })}>
                      Make {failed.instead} live as it is now
                    </button>
                  </div>
                )}
              </div>
            )}

            <div class="app-version-list">
              {rows.map((row) => (
                <div key={row.version} class={`app-version-row${row.state === "live" ? " is-live" : ""}${row.version === props.viewing ? " is-viewing" : ""}`}>
                  <span class="app-version-name">{row.version}</span>
                  {row.state && row.state !== "live" && <span class={`app-version-state is-${row.state}`}>{STATE_LABEL[row.state]}</span>}
                  {row.state === "live" && <span class="badge badge-ok">live</span>}
                  {row.version === props.viewing && <span class="badge">viewing</span>}
                  <span class="app-version-when" title={new Date(row.createdAt).toLocaleString()}>{when(row.createdAt)}</span>
                  <span class="app-version-actions">
                    {row.version !== shown && (
                      <button class="btn btn-sm" disabled={busy} onClick={() => props.onView(row.state === "live" ? null : row.version)}>View</button>
                    )}
                    {!seeded && row.state !== "live" && (row.state === "was-live" && row.release ? (
                      <ConfirmButton
                        popover
                        class="btn btn-sm"
                        label="Restore"
                        note={restoreNote(row.version)}
                        confirmLabel={`Restore ${row.version}`}
                        tone="primary"
                        disabled={busy}
                        onConfirm={() => void act({ release: row.release! }, row.version)}
                      />
                    ) : (
                      <ConfirmButton
                        popover
                        class="btn btn-sm"
                        label="Make live"
                        note={makeLiveNote(row.version, data.live)}
                        confirmLabel={`Make ${row.version} live`}
                        tone="primary"
                        disabled={busy}
                        onConfirm={() => void act({ version: row.version })}
                      />
                    ))}
                  </span>
                </div>
              ))}
            </div>

            {data.releases.length > 0 && (
              <div class="app-versions-history">
                <button class="flyout-toggle" type="button" onClick={() => setHistoryOpen(!historyOpen)}>
                  <span class={`flyout-toggle-caret${historyOpen ? " open" : ""}`}>▶</span>
                  History
                </button>
                {historyOpen && (
                  <ul class="app-history-list">
                    {[...data.releases].reverse().map((r) => (
                      <li key={r.id} title={`${r.id} · ${new Date(r.createdAt).toLocaleString()}`}>
                        <span class="app-version-name">{r.version}</span> made live {when(r.createdAt)}
                        {r.by ? ` by ${displayActor(r.by)}` : ""}
                        {r.id === data.live && <span class="badge badge-ok">live now</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {!seeded && newestVersion(data.versions) && (
              <AppScreenshots name={app.name} version={newestVersion(data.versions)!} onSaved={props.onPublished} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
