import { useRef, useState } from "preact/hooks";
import { appToolInput, namesApp, panelTarget, type PanelTarget } from "../app-links";
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
  return (
    <div class="app-panel-app">
      <div class="app-panel-head">
        <span class="app-panel-title" title={title}>{title}</span>
        {app && <span class="app-panel-sub">{`${app.peer ? `@${app.peer} · ` : ""}${app.name} ${app.version}`}</span>}
        <button class="copy-btn" onClick={props.onClose} aria-label="Close" title="Close"><CloseIcon /></button>
      </div>
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
