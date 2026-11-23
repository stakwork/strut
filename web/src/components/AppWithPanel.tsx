import { useEffect, useRef, useState } from "preact/hooks";
import * as api from "../api";
import { appToolInput, frameableHold, namesApp, panelTarget, type PanelTarget } from "../app-links";
import { STATE_LABEL, appVersionRows, isHeld, isSeeded, liveRelease, modeChange, panelChip, panelKey, rowChange, when, type LiveChange } from "../app-versions";
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
// localStorage); in a narrow container it lies over the app. A third thing
// it opens is what a job holds at an address (`?job=<id>&hold=<kind>`, a
// pod's app): the panel reads the address from the job (`GET
// /jobs/:id/urls`), never from the link, and frames it with a tab beside.
// Everything else — a link to the app on screen, a workflow, a run, a job — goes to the
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
            : "hold" in panel
            ? <PanelHold key={`${panel.job}/${panel.hold}`} job={panel.job} hold={panel.hold} onClose={() => setPanel(null)} />
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

/** The frame's sandbox: the page's own scripts, forms, storage and popups
 *  (a sign-in that opens a window), and no navigating this page away. */
const HOLD_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-storage-access-by-user-activation";

/** What a job holds at an address, in the panel: read from the job, framed
 *  under a bar with its host, Open in a tab and ✕. The address is on
 *  another site (a pod's), so a sign-in that needs its cookies may not hold
 *  in the frame — the tab always works. */
function PanelHold(props: { job: string; hold: string; onClose: () => void }) {
  /** Undefined while the job is read; null when it holds no such address. */
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState("");
  useEffect(() => {
    let on = true;
    api.getJobUrls(props.job).then(
      (r) => on && setUrl(frameableHold(r.urls[props.hold], location.origin)),
      (err) => on && setError(errorMessage(err)),
    );
    return () => {
      on = false;
    };
  }, [props.job, props.hold]);
  const title = props.hold.charAt(0).toUpperCase() + props.hold.slice(1);
  return (
    <div class="app-panel-app">
      <div class="app-panel-head">
        <span class="app-panel-title">{title}</span>
        <span class="app-panel-sub">{url ? new URL(url).host : props.job}</span>
        {url && <a class="btn btn-sm" href={url} target="_blank" rel="noopener noreferrer">Open in a tab</a>}
        <button class="copy-btn" onClick={props.onClose} aria-label="Close" title="Close"><CloseIcon /></button>
      </div>
      <div class="app-panel-body">
        {url
          ? <iframe class="app-panel-frame" src={url} title={title} sandbox={HOLD_SANDBOX} referrerpolicy="no-referrer" allow="clipboard-read; clipboard-write; fullscreen" />
          : <div class="empty">{error || (url === null ? `This job holds no ${props.hold} with an address now.` : "Reading the job…")}</div>}
      </div>
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
  // Read again after a change to what is live: the chip and the version shown follow.
  const [again, setAgain] = useState(0);
  const { app, entry } = useListedApp(props.target.app, again);
  const mayRelease = useMayRelease();
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
  // A local app's versions, to look at, and — for anyone but a member — to
  // make live (plans/jamie-app.md §5.2): a host's ticket names the role, and
  // strut refuses a member's session `PUT /apps/:name/active` anyway.
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
          mayRelease={mayRelease}
          onView={(version) => {
            setVersionsOpen(false);
            props.onTarget({ app: panelKey(app.name, version, entry.activeVersion) });
          }}
          onChanged={() => {
            // What everyone opens changed: show it, as the full UI's frame
            // does, under the chip that now says so.
            setVersionsOpen(false);
            setAgain((n) => n + 1);
            props.onTarget({ app: app.name });
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

/** Whether this page may change what people open: anyone but a member (a
 *  host's ticket names the role). Unknown until the session answers, and
 *  no controls till then. */
function useMayRelease(): boolean {
  const [may, setMay] = useState(false);
  useEffect(() => {
    let on = true;
    void api.pageSession.then((s) => on && setMay(s?.role !== "member"));
    return () => {
      on = false;
    };
  }, []);
  return may;
}

/** A local app's versions under the panel's bar, newest first, each in its
 *  state: a click shows that version here. For anyone who may
 *  (`mayRelease`), the app's mode and each row's Make live or Restore, as
 *  the full UI's Versions flyout has them; each asks first, in the list. */
function PanelVersions(props: {
  name: string;
  shown: string;
  mayRelease: boolean;
  onView: (version: string) => void;
  /** What is live changed: the panel closes this list and shows it. */
  onChanged: () => void;
}) {
  const [data, setData] = useState<api.AppVersionsResponse | null>(null);
  const [error, setError] = useState("");
  /** The change asking to be confirmed: a row's version, or "mode". */
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A refusal, and — for a Restore the server refused — the version to make live instead. */
  const [failed, setFailed] = useState<{ message: string; instead?: string } | null>(null);
  useEffect(() => {
    let on = true;
    api.getAppVersions(props.name)
      .then((d) => on && setData(d))
      .catch((err) => on && setError(errorMessage(err)));
    return () => {
      on = false;
    };
  }, [props.name]);

  const change = async (target: LiveChange["target"], instead?: string) => {
    setBusy(true);
    setFailed(null);
    setAsking(null);
    try {
      await api.setAppLive(props.name, target);
      props.onChanged();
    } catch (err) {
      setFailed({ message: errorMessage(err), ...(instead ? { instead } : {}) });
    } finally {
      setBusy(false);
    }
  };

  const rows = data ? appVersionRows(data) : null;
  const may = props.mayRelease && !!data && !isSeeded(data);
  const mode = data && may ? modeChange(data) : null;
  const release = data ? liveRelease(data) : undefined;
  /** The trigger, and under it while asking, the note and the confirm. */
  const ask = (key: string, c: LiveChange) => (
    <>
      <button
        type="button"
        class={`btn btn-sm app-panel-change${asking === key ? " is-active" : ""}`}
        aria-expanded={asking === key}
        disabled={busy}
        onClick={() => setAsking((a) => (a === key ? null : key))}
      >{c.label}</button>
      {asking === key && (
        <div class="app-panel-ask">
          <span class="confirm-note">{c.note}</span>
          <button type="button" class="btn btn-sm" onClick={() => setAsking(null)}>Cancel</button>
          <button type="button" class="btn btn-sm btn-primary" onClick={() => void change(c.target, c.restores)}>{c.confirmLabel}</button>
        </div>
      )}
    </>
  );
  return (
    <div class="app-panel-versions" aria-label="Versions">
      {error && <div class="auto-error">{error}</div>}
      {!rows && !error && <div class="empty">Loading…</div>}
      {data && mode && (
        <div class="app-panel-version-row app-panel-mode">
          <span class="app-panel-mode-now">
            {isHeld(data.live)
              ? `Held at ${data.active}${release ? ` since ${when(release.createdAt)}` : ""}`
              : "Every publish goes live"}
          </span>
          {ask("mode", mode)}
        </div>
      )}
      {failed && (
        <div class="auto-error">
          {failed.message}
          {failed.instead && (
            <div class="app-versions-instead">
              <button type="button" class="btn btn-sm" disabled={busy} onClick={() => void change({ version: failed.instead! })}>
                Make {failed.instead} live as it is now
              </button>
            </div>
          )}
        </div>
      )}
      {rows?.map((r) => {
        const c = may ? rowChange(r, data!.live) : null;
        return (
          <div key={r.version} class="app-panel-version-row">
            <button
              type="button"
              class={`app-panel-version${r.version === props.shown ? " is-current" : ""}`}
              aria-current={r.version === props.shown || undefined}
              title={r.version === props.shown ? "Shown here" : `Show ${r.version} here`}
              onClick={() => props.onView(r.version)}
            >
              <span class="app-panel-version-name">{r.version}</span>
              {r.state && <span class={`app-version-state is-${r.state}`}>{STATE_LABEL[r.state]}</span>}
              {r.summary && <span class="app-panel-version-summary" title={r.summary}>{r.summary}</span>}
              <span class="app-panel-version-when">{when(r.createdAt)}</span>
            </button>
            {c && ask(r.version, c)}
          </div>
        );
      })}
      {rows && !may && (
        <div class="app-panel-versions-note">
          {data && isSeeded(data)
            ? "Seeded by strut: every start makes its committed version live."
            : "Viewing only. Making a version live is done where the apps are managed."}
        </div>
      )}
    </div>
  );
}
