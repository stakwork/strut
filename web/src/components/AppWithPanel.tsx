import { useEffect, useRef, useState } from "preact/hooks";
import * as api from "../api";
import { appToolInput, namesApp, panelTarget, type PanelTarget } from "../app-links";
import { STATE_LABEL, appVersionRows, panelChip, panelKey, when, type AppVersionRow } from "../app-versions";
import { errorMessage } from "../helpers";
import { CloseIcon } from "../icons";
import { useListedApp } from "../use-listed-app";
import { AppHost, type HostedApp } from "./AppHost";
import { ArtifactViewer } from "./ArtifactViewer";
import { WidthResizer } from "./FlyoutResizer";

// ── An app's page with a side panel beside it (plans/jamie-app.md §4) ──────
//
// What an app cannot show in its own document — its CSP frames nothing
// (`frame-src 'none'`) and `run/files` stops at 2 MB — it hands to its host
// as a strut deep link through `ui/open-link`: `?artifact=<served path>` (a
// job's file, a run's artifact, a peer's through the read-through) or
// `?app=<key>` (another app, a peer's too). This host opens those in a
// PANEL beside the app (`panelTarget`, ../app-links) instead of navigating
// away, so the app stays on screen with its state: the file through the
// artifact viewer — which runs a page an agent wrote under its file token
// (`?t=`, never the key while the strut has a secret to sign one) and shows
// a peer's file from its bytes, with no credential in its URL — and the
// app through the app host, in a frame of its own. A new link replaces what
// the panel shows (an app's new input goes to it in place); ✕ closes it; its
// left edge resizes it (`--app-panel-width` on the split, kept in
// localStorage); in a narrow container it lies over the app. Everything
// else — a link to the app on screen, a workflow, a run, a job — goes to the
// caller's `onNavigate` as before. The panel's own app links the same way:
// a file or a third app replaces it, a link to the page beside it is that
// page's. Used by the canvas area's host (../app.tsx) and the page alone
// (./SoloApp), which is how Hive and Peel frame an app: the panel is inside
// that one page. A visitor's page (the public view) has no panel: what it
// would open is read with the viewer's credential.

type AppHostProps = Parameters<typeof AppHost>[0];

/** The panel's narrowest, and the least it leaves the app beside it. */
const PANEL_MIN = 320;
const MAIN_MIN = 360;

export function AppWithPanel(props: AppHostProps) {
  const [panel, setPanel] = useState<PanelTarget | null>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  if (props.visitor) return <AppHost {...props} />;
  const outer = props.onNavigate;
  const onNavigate = (params: Record<string, string>) => {
    const target = panelTarget(params, [props.app]);
    if (target) {
      setPanel(target);
      return true;
    }
    return outer ? outer(params) : false;
  };
  return (
    <div class={`app-split${panel ? " has-panel" : ""}`} ref={splitRef}>
      <div class="app-split-main">
        <AppHost {...props} onNavigate={onNavigate} />
      </div>
      {panel && (
        <aside class="app-panel" aria-label="Beside the app">
          <WidthResizer
            holder={() => splitRef.current}
            panel=".app-panel"
            property="--app-panel-width"
            storageKey="strut.appPanelWidth"
            defaultWidth={520}
            minWidth={PANEL_MIN}
            maxWidth={() => (splitRef.current?.clientWidth ?? window.innerWidth) - MAIN_MIN}
          />
          {"artifact" in panel
            ? <ArtifactViewer path={panel.artifact} solo onClose={() => setPanel(null)} />
            : <PanelApp
                target={panel}
                beside={props.app}
                theme={props.theme}
                onTarget={setPanel}
                onNavigate={outer}
                onClose={() => setPanel(null)}
              />}
        </aside>
      )}
    </div>
  );
}

/** Another app in the panel: looked up by its key (the version to show),
 *  under a bar with its title and ✕. */
function PanelApp(props: {
  target: { app: string; input?: string };
  /** The page the panel is beside. */
  beside: HostedApp;
  theme?: "light" | "dark";
  /** What the panel shows next: a file, another app, this app's new input. */
  onTarget: (next: PanelTarget) => void;
  /** The host's own navigation, for every other link. */
  onNavigate?: (params: Record<string, string>) => boolean | void;
  onClose: () => void;
}) {
  const { app, entry } = useListedApp(props.target.app);
  const toolInput = appToolInput(props.target.input);
  const onNavigate = (params: Record<string, string>) => {
    const next = panelTarget(params, app ? [app, props.beside] : [props.beside]);
    if (next) {
      props.onTarget(next);
      return true;
    }
    // A link to itself: its input, in place (the host sends it; the
    // target follows so a re-render keeps it).
    if (app && namesApp(params["app"], app)) {
      props.onTarget({ app: props.target.app, ...(params["input"] ? { input: params["input"] } : {}) });
      return true;
    }
    return props.onNavigate ? props.onNavigate(params) : false;
  };
  const title = entry?.title || app?.name || props.target.app;
  // A local app's versions, to look at — never to make live: whoever opens
  // a panel may not be the one who decides what everyone gets
  // (plans/jamie-app.md §5.2). That is the Versions flyout's, in the full UI.
  const chip = app && entry && !app.peer ? panelChip(app.version, entry) : null;
  const [versionsOpen, setVersionsOpen] = useState(false);
  useEffect(() => setVersionsOpen(false), [props.target.app]);
  return (
    <div class="app-panel-app">
      <div class="app-panel-head">
        <span class="app-panel-title" title={title}>{title}</span>
        {app && chip ? (
          <span class="app-panel-sub">
            <button
              type="button"
              class={`app-version-chip${versionsOpen ? " is-active" : ""}`}
              aria-expanded={versionsOpen}
              title="Look at another version"
              onClick={() => setVersionsOpen((o) => !o)}
            >
              {chip.label}
              {chip.drafts > 0 && <span class="app-version-drafts">{chip.drafts} draft{chip.drafts === 1 ? "" : "s"}</span>}
              <span class="app-version-caret" aria-hidden="true">▾</span>
            </button>
          </span>
        ) : app && <span class="app-panel-sub">{`${app.peer ? `@${app.peer} · ` : ""}${app.name} ${app.version}`}</span>}
        <button class="copy-btn" onClick={props.onClose} aria-label="Close" title="Close"><CloseIcon /></button>
      </div>
      {versionsOpen && app && entry && (
        <PanelVersions
          name={app.name}
          shown={app.version}
          onView={(version) => {
            setVersionsOpen(false);
            props.onTarget({ app: panelKey(app.name, version, entry.activeVersion) });
          }}
        />
      )}
      <div class="app-panel-body">
        {app
          ? <AppHost
              key={`${app.peer ?? ""}/${app.name}@${app.version}`}
              app={app}
              onNavigate={onNavigate}
              {...(props.theme ? { theme: props.theme } : {})}
              {...(toolInput ? { toolInput } : {})}
            />
          : <div class="empty">{entry === null ? `No app "${props.target.app}"` : "Loading the app…"}</div>}
      </div>
    </div>
  );
}

/** A local app's versions under the panel's bar, newest first, each in its
 *  state: a click shows that version here. Viewing only — making one live
 *  is the full UI's Versions flyout (or a host's admin page). */
function PanelVersions(props: { name: string; shown: string; onView: (version: string) => void }) {
  const [rows, setRows] = useState<AppVersionRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let on = true;
    api.getAppVersions(props.name)
      .then((data) => on && setRows(appVersionRows(data)))
      .catch((err) => on && setError(errorMessage(err)));
    return () => {
      on = false;
    };
  }, [props.name]);
  return (
    <div class="app-panel-versions" role="menu" aria-label="Versions">
      {error && <div class="auto-error">{error}</div>}
      {!rows && !error && <div class="empty">Loading…</div>}
      {rows?.map((r) => (
        <button
          key={r.version}
          type="button"
          role="menuitem"
          class={`app-panel-version${r.version === props.shown ? " is-current" : ""}`}
          onClick={() => props.onView(r.version)}
        >
          <span class="app-panel-version-name">{r.version}</span>
          {r.state && <span class={`app-version-state is-${r.state}`}>{STATE_LABEL[r.state]}</span>}
          <span class="app-panel-version-when">{when(r.createdAt)}</span>
        </button>
      ))}
      {rows && <div class="app-panel-versions-note">Viewing only. Making a version live is done where the apps are managed.</div>}
    </div>
  );
}
