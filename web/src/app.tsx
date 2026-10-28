import { useState, useEffect, useCallback, useMemo, useRef } from "preact/hooks";
import { SystemCanvas } from "system-canvas-react";
import type { CanvasData, CanvasNode, CanvasEdge } from "system-canvas";
import type { AddNodeButtonRenderProps } from "system-canvas-react";
import yaml from "js-yaml";
import * as api from "./api";
import { foldAccessedNodes, isServedFilePath } from "@strut/kit/folds";
import { latestAttempt } from "./step-attempt";
import { pushUrl, replaceUrl } from "./embed";
import { hereEntry, readTrail, stepTrail, trailTitle, withTrail, type TrailEntry } from "./nav-trail";
import { flowToCanvas, stepWorkflow, strutTheme } from "./flow-to-canvas";
import type { StepData, RunEventData } from "./flow-to-canvas";
import "./styles/base.css";
import "./styles/components.css";
import { deepEqual, errorMessage, normalizeSteps, statusTone } from "./helpers";
import { load as loadPref, save as savePref } from "./storage";
import { searchSteps, searchWorkflows } from "../../src/search.js";
import { ChatFlyout } from "./components/ChatFlyout";
import { CategoryEditor } from "./components/CategoryEditor";
import { RunCapEditor } from "./components/RunCapEditor";
import { OwnerEditor } from "./components/OwnerEditor";
import { CreateDialog } from "./components/CreateDialog";
import { SecretsDialog } from "./components/SecretsDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { PackagesDialog } from "./components/PackagesDialog";
import { ArrowLeftIcon, ClockIcon, GearIcon, UserIcon } from "./icons";
import { displayActor } from "./actor";
import { sttSettings as sttStore, type SttSettings } from "./storage";
import { AddStepDialog, StepTypeEntry } from "./components/AddStepDialog";
import { StepEditFlyout } from "./components/StepEditFlyout";
import { StepInfoFlyout } from "./components/StepInfoFlyout";
import { EventsPanel } from "./components/EventsPanel";
import { RunOverview } from "./components/RunOverview";
import { EventsResizer } from "./components/EventsResizer";
import { SidebarResizer } from "./components/SidebarResizer";
import { StepRunFlyout } from "./components/StepRunFlyout";
import { WorkflowFlyout, claimsTone, type WorkflowTab } from "./components/WorkflowFlyout";
import { PromoteFlyout } from "./components/PromoteFlyout";
import { JobTimeline, fmtTime } from "./components/JobTimeline";
import { RunTime } from "./components/RunTime";
import { ThreadFlyout } from "./components/ThreadFlyout";
import { AppHost } from "./components/AppHost";
import { AppUsageFlyout } from "./components/AppUsageFlyout";
import { SoloApp } from "./components/SoloApp";
import { ArtifactViewer } from "./components/ArtifactViewer";
import { AppGlyph } from "./icons";
import { appKey, appMessage, appToolInput } from "./app-links";
import { RunInputPopover } from "./components/RunInputPopover";
import { ConfirmButton } from "./components/ConfirmButton";
import { useDismiss } from "./use-dismiss";
import { applyLookups, bindingsFromInputBlock, deriveInputBindings, nodeLookups, stepTypesIn, type InputBinding } from "./run-inputs";

// A nested run-execution the user has drilled into. `pathPrefix` is the
// original event-path prefix this child lives under (e.g. `wf/subflowId`),
// `workflow` is the child workflow name, `steps` its loaded definition.
// For a foreach/loop the body runs N times under `<pathPrefix>#<i>`, so the
// frame carries the iteration `count` and the selected `iter`.
interface DrillFrame {
  pathPrefix: string;
  workflow: string;
  steps: StepData[];
  iterations?: number;
  iter?: number;
}

// The actual event-path prefix for a frame, accounting for the selected
// foreach/loop iteration.
function framePrefix(f: DrillFrame): string {
  return f.iterations != null ? `${f.pathPrefix}#${f.iter ?? 0}` : f.pathPrefix;
}

// Count foreach/loop iterations from the run events: bodies execute under
// `<prefix>#<i>`, so the count is (max index + 1) seen across all such paths.
function countIterations(events: api.RunEvent[], prefix: string): number {
  let max = -1;
  for (const e of events) {
    if (!e.path.startsWith(prefix + "#")) continue;
    const rest = e.path.slice(prefix.length + 1); // after `#`
    const num = parseInt(rest, 10);
    if (!isNaN(num) && num > max) max = num;
  }
  return max + 1;
}

// What's on screen, as one comparable key (the back trail's notion of "moved").
function spotKey(wf: string | null, run: string | null, job: string | null): string {
  return `${wf ?? ""}|${run ?? ""}|${job ?? ""}`;
}

// Identity of a set of live runs, state included — equal keys, nothing changed.
function activeKey(runs: api.ActiveRun[]): string {
  return runs.map((r) => `${r.workflow}/${r.runId}:${r.state}`).join(",");
}

export function App() {
  // `?solo=1`: one thing alone in the window, with none of strut's UI around
  // it — what a native host (Peel) opens in a web view of its own. Rendered
  // in place of the shell, so none of its loads and polls run behind it.
  // Read once.
  //  - beside `?app=`: the app's page, here or a peer's (plans/apps.md §7.4).
  //  - beside `?artifact=<path>`: one served file — a job's file or a run's
  //    artifact, here or a peer's through the read-through — for a
  //    deliverable. Only a path of that shape (`isServedFilePath`).
  const [solo] = useState(() => {
    const p = new URLSearchParams(location.search);
    return p.get("solo") === "1" ? { app: p.get("app"), input: p.get("input"), artifact: p.get("artifact") } : null;
  });
  if (solo?.app) return <SoloApp app={solo.app} input={solo.input} />;
  if (solo?.artifact) {
    return isServedFilePath(solo.artifact)
      ? <ArtifactViewer path={solo.artifact} solo />
      : <div class="app-solo"><div class="empty">Not a file strut serves: {solo.artifact}</div></div>;
  }
  return <Shell />;
}

function Shell() {
  // Deep-links: ?wf=<workflow>&run=<runId>&v=<version> select on load and are
  // kept in sync (replaceState) as the selection changes, so the address bar
  // is always a shareable link to what's on screen. (?chat is read below and
  // preserved by the sync.) ?secrets=1 opens the Secrets dialog — the link an
  // agent outside the UI (the MCP door) sends the user to add a credential.
  const [initialUrl] = useState(() => new URLSearchParams(location.search));
  const [workflows, setWorkflows] = useState<api.WorkflowEntry[]>([]);
  const [runs, setRuns] = useState<api.RunSummary[]>([]);
  const [selectedWf, setSelectedWf] = useState<string | null>(initialUrl.get("wf"));
  const [selectedRun, setSelectedRun] = useState<string | null>(initialUrl.get("run"));
  // Jobs (plans/jobs-sidebar.md): the selected job's timeline takes the
  // canvas area; a run opened from it keeps the job selected, so the
  // breadcrumb leads back. ?job=<id> deep-links into one. The selected
  // workflow stays underneath as the history panel's filter.
  const [selectedJob, setSelectedJob] = useState<string | null>(initialUrl.get("job"));
  // Apps (plans/apps.md §7.3): the selected app's page takes the canvas
  // area, as the job timeline does; ?app=<name> deep-links into one, and
  // ?input=<the app's own query> is what it is opened with (its
  // `tool-input`, §7.1). The frame reloads when the builder publishes a new
  // version of it.
  const [apps, setApps] = useState<api.AppListEntry[]>([]);
  const [selectedApp, setSelectedApp] = useState<string | null>(initialUrl.get("app"));
  const [appInput, setAppInput] = useState<string | null>(initialUrl.get("input"));
  const [appQuery, setAppQuery] = useState("");
  const [appReload, setAppReload] = useState(0);
  // What the host hands the chat: a draft for its composer (Edit with the
  // builder), a message to send (an app's ui/message).
  const [chatDraft, setChatDraft] = useState<{ text: string; id: number } | null>(null);
  const [chatInbound, setChatInbound] = useState<{ text: string; id: number } | null>(null);
  // The back trail (./nav-trail): where the links you followed came from,
  // newest last, kept in the history entry's state so a reload or the back
  // button restores it. `navRef` says how the next selection change happens —
  // "push" (a step: new history entry), "restore" (the back button) or null
  // (a jump: the sidebar, a new run — the trail starts over).
  const [trail, setTrail] = useState<TrailEntry[]>(() => readTrail(history.state));
  const navRef = useRef<"push" | "restore" | null>(null);
  const lastSpot = useRef(spotKey(initialUrl.get("wf"), initialUrl.get("run"), initialUrl.get("job")));
  const [jobs, setJobs] = useState<api.JobListing[]>([]);
  const [job, setJob] = useState<api.JobView | null>(null);
  const [jobQuery, setJobQuery] = useState("");
  // Only my jobs: the user icon in the title row, remembered. The server
  // says who "me" is (`actor` on the listing); without one the icon hides.
  const [jobsMine, setJobsMine] = useState<boolean>(() => loadPref("jobsMine", false));
  const [jobsActor, setJobsActor] = useState<string | null>(null);
  // The history panel: one slot, Runs or Jobs, remembered across sessions.
  const [historyMode, setHistoryMode] = useState<"runs" | "jobs">(() => loadPref("historyMode", "runs"));
  // A thread's transcript, open in the flyout.
  const [threadView, setThreadView] = useState<{ thread: api.JobThread; turn?: api.JobTurn } | null>(null);
  // A step path to open the flyout on once the run opened from the timeline
  // has its steps and events (`openJobRun`).
  const [pendingFlyout, setPendingFlyout] = useState<string | null>(null);
  const [events, setEvents] = useState<api.RunEvent[]>([]);
  const [running, setRunning] = useState(false);
  // Bumped after a durable resume so the run-view effect re-tails the log
  // (the prior tail closed at the old terminal event).
  const [runEpoch, setRunEpoch] = useState(0);
  // True while an in-tab launched run is streaming live into `events`. Disarmed
  // when the user navigates into another run, so the stream can't clobber it.
  const liveStreamRef = useRef(false);
  const [loadError, setLoadError] = useState(false);
  // Run-view drill-down stack: each frame is a nested child execution. Each
  // carries the original event-path prefix it lives under, the child workflow
  // name, and that workflow's steps. Empty = viewing the root.
  const [runDrill, setRunDrill] = useState<DrillFrame[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showSecrets, setShowSecrets] = useState(initialUrl.get("secrets") === "1");
  const [showSettings, setShowSettings] = useState(false);
  const [showPackages, setShowPackages] = useState(false);
  // Bumped when the Packages dialog closes: a channel moved there, so the
  // Publish tab reads the catalog again.
  const [catalogEpoch, setCatalogEpoch] = useState(0);
  const [sttSettings, setSttSettings] = useState<SttSettings>(() => sttStore.get());
  const updateStt = (next: SttSettings) => { sttStore.set(next); setSttSettings(next); };
  const [showAddStep, setShowAddStep] = useState(false);
  const [stepTypes, setStepTypes] = useState<StepTypeEntry[]>([]);
  // The sidebar's bottom pair, Tools and Apps: at most one is expanded
  // (persisted; `stepsOpen` was the Tools-only pref before Apps joined it),
  // and which step type's read-only info flyout is open.
  const [bottomOpen, setBottomOpen] = useState<"tools" | "apps" | null>(
    () => loadPref("sidebarBottom", loadPref("stepsOpen", false) ? "tools" : null),
  );
  const stepsOpen = bottomOpen === "tools";
  const appListOpen = bottomOpen === "apps";
  const [infoStep, setInfoStep] = useState<StepTypeEntry | null>(null);
  const [stepQuery, setStepQuery] = useState("");
  const [wfQuery, setWfQuery] = useState("");
  const [publishedSteps, setPublishedSteps] = useState<StepData[] | null>(null);
  const [localSteps, setLocalSteps] = useState<StepData[] | null>(null);
  // The workflow `localSteps` were actually loaded for. Until this matches
  // `selectedWf`, the steps belong to the previously-selected workflow (the
  // load is async), so the root canvas must not render with them — otherwise
  // switching workflows briefly mounts/fits the canvas on the OLD content.
  const [loadedWf, setLoadedWf] = useState<string | null>(null);
  const [flyoutStepId, setFlyoutStepId] = useState<string | null>(null);
  const [flyoutStepIndex, setFlyoutStepIndex] = useState<number | null>(null);
  // Open on load when the URL deep-links into a chat (?chat=<id>).
  const [showChat, setShowChat] = useState(() =>
    new URLSearchParams(location.search).has("chat"),
  );
  const [runBindings, setRunBindings] = useState<InputBinding[] | null>(null);
  // The selected workflow's `params` defaults (tunable knobs). `wfParams` is
  // the published baseline; `localParams` is the editable working copy. Editing
  // a param and publishing = a new workflow version (params live in the YAML).
  const [wfParams, setWfParams] = useState<Record<string, unknown> | null>(null);
  const [localParams, setLocalParams] = useState<Record<string, unknown> | null>(null);
  // The declared `input:` block, if any — the Run form's source when present,
  // and written back on Publish so a canvas edit never drops it.
  const [localInput, setLocalInput] = useState<api.FlowDef["input"] | null>(null);
  // Which workflow-level flyout is open — the Workflow flyout (params /
  // claims / automations as tabs) or Promote — so they exclude each other by
  // construction; or, with an app open, its Usage. `wfTab` remembers the tab
  // across open/close.
  const [panel, setPanel] = useState<"workflow" | "promote" | "usage" | null>(null);
  const [wfTab, setWfTab] = useState<WorkflowTab>("params");
  // The workflow's contract as last read — null until probed;
  // `enabled: false` (a filesystem workspace) hides the Claims tab.
  const [wfClaims, setWfClaims] = useState<api.ClaimsResponse | null>(null);
  // Declared promotions resolved against the selected run's output (the
  // "promote a winner" review surface).
  const [promotions, setPromotions] = useState<api.Promotion[]>([]);
  // Whether every structured param currently parses (the flyout reports this);
  // an invalid YAML param blocks Publish while the flyout is open.
  const [paramsValid, setParamsValid] = useState(true);

  const isDirty = useMemo(() => {
    if (!publishedSteps || !localSteps) return false;
    const stepsDirty = !deepEqual(normalizeSteps(publishedSteps), normalizeSteps(localSteps));
    const paramsDirty = !deepEqual(wfParams ?? {}, localParams ?? {});
    return stepsDirty || paramsDirty;
  }, [publishedSteps, localSteps, wfParams, localParams]);

  const activeVersion = workflows.find((w) => w.name === selectedWf)?.activeVersion;
  const selectedEntry = workflows.find((w) => w.name === selectedWf);

  // Version picker: which version of the selected workflow the canvas shows.
  // Stored with the workflow it was pinned for, so the pin self-invalidates
  // when the selection changes (no effect-ordering games). null = active.
  const [versionPin, setVersionPin] = useState<{ wf: string | null; v: string | null }>(() => ({
    wf: initialUrl.get("v") ? initialUrl.get("wf") : null,
    v: initialUrl.get("v"),
  }));
  const viewVersion = versionPin.wf === selectedWf ? versionPin.v : null;
  const setViewVersion = useCallback(
    (v: string | null) => setVersionPin({ wf: selectedWf, v }),
    [selectedWf],
  );
  // Viewing history is read-only: editing/publishing/running only make sense
  // against the active version (Publish always builds on active, Run runs it).
  const viewingOld = viewVersion != null && activeVersion != null && viewVersion !== activeVersion;
  // The Workflow flyout's tabs — only what applies: no params → no Params
  // tab; claims off (filesystem workspace) → no Claims tab; history view →
  // no Automate tab (a schedule runs the active version). Publish is always
  // there: it says itself when a name has no package prefix.
  const workflowTabs = useMemo<WorkflowTab[]>(() => {
    if (!selectedWf) return [];
    const tabs: WorkflowTab[] = [];
    if (localParams && Object.keys(localParams).length > 0) tabs.push("params");
    if (wfClaims?.enabled) tabs.push("claims");
    if (!viewingOld) tabs.push("automations");
    tabs.push("versions", "publish");
    return tabs;
  }, [selectedWf, localParams, wfClaims, viewingOld]);
  const activeTab: WorkflowTab | null = workflowTabs.includes(wfTab) ? wfTab : (workflowTabs[0] ?? null);

  // Mirror the selection into the address bar so the current view is always
  // copy-paste shareable — and, when embedded, reported to the host so ITS
  // address bar is too (./embed). A jump replaces the entry (no history
  // spam); a step along the trail pushes one, so the back button returns.
  // Unrelated params (e.g. ?chat) are preserved.
  useEffect(() => {
    const spot = spotKey(selectedWf, selectedRun, selectedJob);
    const moved = spot !== lastSpot.current;
    lastSpot.current = spot;
    const mode = navRef.current;
    navRef.current = null;
    if (moved && mode === null && trail.length > 0) {
      setTrail([]); // a jump: this effect runs again with the empty trail
      return;
    }
    const p = new URLSearchParams(location.search);
    const put = (k: string, val: string | null) => (val ? p.set(k, val) : p.delete(k));
    put("wf", selectedWf);
    put("run", selectedRun);
    put("v", viewVersion);
    put("job", selectedJob);
    put("app", selectedApp);
    put("input", selectedApp ? appInput : null);
    put("secrets", showSecrets ? "1" : null);
    const qs = p.toString();
    const next = `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`;
    const state = withTrail(history.state, trail);
    if (mode === "push") {
      pushUrl(next, state);
    } else if (
      mode === "restore" || // the browser moved the URL; the host still has to hear
      next !== `${location.pathname}${location.search}${location.hash}` ||
      JSON.stringify(readTrail(history.state)) !== JSON.stringify(trail)
    ) {
      replaceUrl(next, state);
    }
  }, [selectedWf, selectedRun, viewVersion, selectedJob, selectedApp, appInput, showSecrets, trail]);

  // The back (or forward) button: show what that entry's URL says, with
  // the trail it had.
  useEffect(() => {
    const onPop = () => {
      const p = new URLSearchParams(location.search);
      const wf = p.get("wf"), run = p.get("run"), job = p.get("job"), v = p.get("v");
      if (spotKey(wf, run, job) !== lastSpot.current) navRef.current = "restore";
      liveStreamRef.current = false;
      setRunning(false);
      setFlyoutStepId(null);
      setFlyoutStepIndex(null);
      setThreadView(null);
      setTrail(readTrail(history.state));
      setSelectedWf(wf);
      setSelectedRun(run);
      setSelectedJob(job);
      setSelectedApp(p.get("app"));
      setAppInput(p.get("input"));
      setVersionPin({ wf: v ? wf : null, v });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Following a link: the selection change that comes next is a step on the
  // trail, not a jump. Call just before selecting `to`.
  const stepTo = useCallback((to: TrailEntry) => {
    const next = stepTrail(trail, hereEntry(selectedWf, selectedRun, selectedJob), to);
    if (next === trail) return;
    navRef.current = "push";
    setTrail(next);
  }, [trail, selectedWf, selectedRun, selectedJob]);

  // Back to the trail's i-th place: through the browser's history (every step
  // is an entry), so its back/forward stay in step; popstate does the rest.
  const goBack = (i: number) => history.go(i - trail.length);

  // ── Sidebar grouping ─────────────────────────────────────────────────────
  // Workflows grouped by category; groups (and workflows within them) are
  // ordered by most-recent run so the active experiment floats to the top.
  // Uncategorized workflows form a trailing group; headers only render when
  // at least one workflow actually has a category.
  // The Workflows filter is `GET /workflows?q=`'s matcher: every word must hit
  // the name, the category or the description.
  const matchedWorkflows = useMemo(() => searchWorkflows(workflows, wfQuery), [workflows, wfQuery]);
  // The Apps filter: the same matcher, over the title and description too.
  // Pinned apps (tabs where this workspace's apps are listed) first; a
  // filter keeps its own ranking.
  const matchedApps = useMemo(() => {
    const found = searchWorkflows(apps.map((a) => ({ ...a, description: [a.title, a.description, a.peer && `@${a.peer}`].filter(Boolean).join(" ") })), appQuery);
    return appQuery.trim() ? found : [...found.filter((a) => a.pinned), ...found.filter((a) => !a.pinned)];
  }, [apps, appQuery]);
  // `selectedApp` is the app's KEY: its name here, `@<peer>/<name>` for a
  // peer's (plans/apps.md §7.4).
  const appEntry = selectedApp ? apps.find((a) => appKey(a) === selectedApp) ?? null : null;
  const appTitle = (name: string) => apps.find((a) => !a.peer && a.name === name)?.title ?? name;
  // The open app's releases (plans/app-releases.md), for the topbar's
  // select: read again whenever what people open changes.
  const [appReleases, setAppReleases] = useState<{ live: string; releases: api.AppRelease[]; behind: api.AppLockDrift[] } | null>(null);
  useEffect(() => {
    if (!appEntry || appEntry.peer) {
      setAppReleases(null);
      return;
    }
    let on = true;
    api.getAppVersions(appEntry.name).then((r) => on && setAppReleases(r)).catch(() => on && setAppReleases(null));
    return () => {
      on = false;
    };
  }, [appEntry?.name, appEntry?.activeVersion, appEntry?.live]);
  const wfGroups = useMemo(() => {
    const byCat = new Map<string, api.WorkflowEntry[]>();
    for (const wf of matchedWorkflows) {
      const cat = wf.category ?? "";
      const arr = byCat.get(cat) ?? [];
      arr.push(wf);
      byCat.set(cat, arr);
    }
    const byRecency = (a: api.WorkflowEntry, b: api.WorkflowEntry) =>
      (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0) || a.name.localeCompare(b.name);
    const groups = [...byCat.entries()].map(([category, wfs]) => ({
      category,
      wfs: [...wfs].sort(byRecency),
      latest: Math.max(0, ...wfs.map((w) => w.lastRunAt ?? 0)),
    }));
    groups.sort((a, b) => {
      if (!a.category !== !b.category) return a.category ? -1 : 1; // uncategorized last
      return b.latest - a.latest || a.category.localeCompare(b.category);
    });
    return groups;
  }, [matchedWorkflows]);
  const showGroupHeaders = wfGroups.some((g) => g.category);
  const categories = useMemo(
    () => [...new Set(workflows.map((w) => w.category ?? ""))].filter(Boolean).sort(),
    [workflows],
  );

  // Collapsed category groups, persisted across sessions.
  const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>(
    () => loadPref("collapsedCats", {}),
  );
  const toggleCat = useCallback((cat: string) => {
    setCollapsedCats((prev) => {
      const next = { ...prev, [cat]: !prev[cat] };
      savePref("collapsedCats", next);
      return next;
    });
  }, []);

  // Runs are already filtered by workflow (fetched per-workflow)
  const filteredRuns = runs;

  const isRunView = selectedRun != null && events.length > 0;

  // A selected job with no run open: its timeline takes the canvas and the
  // topbar is the job's. `wf` is the workflow the canvas shows — none then,
  // while `selectedWf` stays the history panel's filter.
  const timelineOpen = selectedJob != null && selectedRun == null;
  // A selected app: its page in the canvas area, the topbar its own.
  const appOpen = selectedApp != null;
  const wf = timelineOpen || appOpen ? null : selectedWf;

  // ── View context: what the canvas + flyout operate on ───────────────────
  // Root view = the selected workflow. When drilled into a run's nested
  // execution, the deepest frame's child workflow + its re-keyed events.
  const drill = runDrill.length > 0 ? runDrill[runDrill.length - 1]! : null;
  const viewWorkflow = drill ? drill.workflow : selectedWf;
  const viewSteps = drill ? drill.steps : localSteps;

  // Re-key the run events into the drilled child's namespace: events under
  // `<prefix>/...` become `<childWorkflow>/...` so the existing path-based
  // status overlay + flyout lookups work unchanged at any depth.
  const viewEvents = useMemo(() => {
    if (!drill) return events;
    const prefix = framePrefix(drill);
    const { workflow } = drill;
    const out: api.RunEvent[] = [];
    for (const e of events) {
      if (e.path === prefix || e.path.startsWith(prefix + "/")) {
        out.push({ ...e, path: workflow + e.path.slice(prefix.length) });
      }
    }
    return out;
  }, [drill, events]);

  // Canvas is derived from the current view (root or drilled child). Run/live
  // events overlay status; in plain edit mode there are no events.
  const canvas = useMemo<CanvasData | null>(() => {
    if (loadError && selectedWf) {
      return {
        nodes: [{ id: "err", type: "text", text: `${selectedWf}\n\nCould not load`, x: 100, y: 100, width: 260, height: 70, color: "1" }],
        edges: [], theme: { base: "midnight" },
      };
    }
    if (!viewWorkflow || !viewSteps) return null;
    // Root view: don't render until the steps belong to the selected workflow.
    // (Drill frames carry their own already-loaded steps, so they're exempt.)
    if (runDrill.length === 0 && loadedWf !== selectedWf) return null;
    const overlay = events.length > 0 || running;
    return flowToCanvas(
      { name: viewWorkflow, steps: viewSteps },
      overlay ? (viewEvents as RunEventData[]) : undefined,
    );
  }, [loadError, selectedWf, loadedWf, runDrill.length, viewWorkflow, viewSteps, viewEvents, events.length, running]);

  // Events for the flyout step (within the current view). Containers show
  // their own aggregate I/O here (subflow → child input/output; foreach →
  // items array / results array); per-child detail is via the drill arrow.
  const flyoutEvents = useMemo(() => {
    if (!flyoutStepId || !viewWorkflow || viewEvents.length === 0) return null;
    const path = `${viewWorkflow}/${flyoutStepId}`;
    // The step's latest attempt: a re-run leaves the earlier try in the log.
    const stepEvts = latestAttempt(viewEvents, path);
    if (stepEvts.length === 0) return null;
    const start = stepEvts.find((e) => e.type === "step.start");
    const end = stepEvts.find((e) => e.type === "step.end");
    const error = stepEvts.find((e) => e.type === "step.error");
    const skipped = stepEvts.find((e) => e.type === "step.skipped");
    return { start, end, error, skipped, all: stepEvts, nodes: foldAccessedNodes(viewEvents, path) };
  }, [flyoutStepId, viewWorkflow, viewEvents]);

  const refreshWorkflows = useCallback(async () => {
    const wfs = await api.listWorkflows();
    setWorkflows(wfs);
  }, []);
  // This strut's apps, then each peer's through the read-through (plans/apps.md
  // §7.4) — a peer that does not answer just lists none.
  const [appsLoaded, setAppsLoaded] = useState(false);
  const refreshApps = useCallback(async () => {
    const local = await api.listApps().catch(() => []);
    setApps(local);
    const peers = await api.listPeers().catch(() => []);
    if (peers.length) {
      const remote = await Promise.all(peers.map((p) => api.listPeerApps(p.id).catch(() => [])));
      setApps([...local, ...remote.flat()]);
    }
    setAppsLoaded(true);
  }, []);

  // Every job title the UI has seen — the run rows' chips name a job by it.
  // Filled by the jobs listing, and by a run in flight, whose row carries the
  // launch's title: the listing may have been read before the job's record
  // had it.
  const jobTitles = useRef(new Map<string, string>());
  const refreshRuns = useCallback(async (wf?: string) => {
    const name = wf ?? selectedWf;
    if (!name) { setRuns([]); return; }
    const rs = await api.listRuns(name);
    for (const r of rs) if (r.job && r.jobTitle) jobTitles.current.set(r.job, r.jobTitle);
    setRuns(rs);
  }, [selectedWf]);

  const refreshStepTypes = useCallback(async () => {
    try {
      const resp = await api.listSteps();
      // The registry (`resp.core`) already includes disk-discovered custom
      // steps tagged with their real source, so `resp.workspace` overlaps it.
      // Dedupe by type (keying off the registry), folding in workspace
      // descriptions, so each step appears once in the Add Step picker.
      const descByType = new Map(resp.workspace.map((s) => [s.type, s.description]));
      const entries: StepTypeEntry[] = resp.core.map((s) => ({
        type: s.type,
        source: s.source as "core" | "lib" | "custom",
        description: s.description ?? descByType.get(s.type),
      }));
      setStepTypes(entries);
    } catch { /* ignore */ }
  }, []);

  // The server wants a key this browser doesn't have: ask for it. Not when
  // embedded — there the key is the host's to renew.
  useEffect(() => {
    if (window.parent !== window) return;
    api.onUnauthorized(() => setShowSettings(true));
    return () => api.onUnauthorized(null);
  }, []);

  useEffect(() => { refreshWorkflows(); refreshStepTypes(); void refreshApps(); }, []);

  // This strut's apps again every 30 s, for the warning dot (an app whose
  // pages cost the server too much — src/apps/monitor.ts) to show up on its
  // own. A peer's apps keep the answer of the last full refresh.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden) return;
      api.listApps().then((local) => setApps((prev) => [...local, ...prev.filter((a) => a.peer)]), () => {});
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  // Runs executing right now, in any workflow — the sidebar's running dot.
  // Polled (the server answers from memory) so runs started anywhere — the
  // chat, an automation, curl, another tab — show up.
  const [activeRuns, setActiveRuns] = useState<api.ActiveRun[]>([]);
  const pollActiveRuns = useCallback(async () => {
    try {
      const next = await api.listActiveRuns();
      setActiveRuns((prev) => (activeKey(prev) === activeKey(next) ? prev : next));
    } catch { /* keep the last answer */ }
  }, []);
  useEffect(() => {
    void pollActiveRuns();
    const timer = setInterval(() => { if (!document.hidden) void pollActiveRuns(); }, 5000);
    return () => clearInterval(timer);
  }, []);
  const runningByWf = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of activeRuns) counts.set(r.workflow, (counts.get(r.workflow) ?? 0) + 1);
    return counts;
  }, [activeRuns]);

  // ── Jobs ────────────────────────────────────────────────────────────────
  // The listing (the history panel's Jobs mode, scoped to the selected
  // workflow like the Runs list) and the selected job's view (the
  // timeline). Both re-read when a run anywhere changes state — a new run
  // may be a new job, a finished one changes a turn's row — on the same
  // signal the Runs list follows. A deployment whose jobs are an injected
  // capability without an index answers 501: the list stays empty.
  // The titles come from the jobs listing (`jobTitles`, above) — while it is
  // narrowed (a query, only mine), from the workflow's whole listing, the
  // jobs the run rows can reference.
  const refreshJobs = useCallback(async () => {
    try {
      const r = await api.listJobs({ q: jobQuery, workflow: selectedWf, mine: jobsMine, limit: 50 });
      const titled = jobQuery.trim() || jobsMine ? (await api.listJobs({ workflow: selectedWf, limit: 50 })).jobs : r.jobs;
      for (const j of titled) if (j.title) jobTitles.current.set(j.job, j.title);
      setJobs(r.jobs);
      setJobsActor(r.actor ?? null);
    } catch { /* no index */ }
  }, [jobQuery, selectedWf, jobsMine]);
  useEffect(() => { void refreshJobs(); }, [refreshJobs]);
  const refreshJob = useCallback(async () => {
    if (!selectedJob) { setJob(null); return; }
    try {
      const v = await api.getJob(selectedJob, { nodes: true });
      if (v.title) jobTitles.current.set(v.job, v.title);
      setJob(v);
    } catch { setJob(null); }
  }, [selectedJob]);
  useEffect(() => { setThreadView(null); void refreshJob(); }, [selectedJob]);
  useEffect(() => {
    if (selectedJob) void refreshJob();
    void refreshJobs();
  }, [activeRuns]);
  /** The job a run belongs to, as the sidebar names it. */
  const jobTitle = useCallback((id: string) => jobTitles.current.get(id) ?? id.slice(0, 8), [jobs]);
  // The selected workflow's live runs changed (one started, finished, paused)
  // → refresh its Runs list, so it never disagrees with the dot.
  const prevActive = useRef(activeRuns);
  useEffect(() => {
    const prev = prevActive.current;
    prevActive.current = activeRuns;
    if (!selectedWf) return;
    const mine = (rs: api.ActiveRun[]) => activeKey(rs.filter((r) => r.workflow === selectedWf));
    if (mine(prev) !== mine(activeRuns)) void refreshRuns(selectedWf);
  }, [activeRuns]);

  // Spend routed through the Mothership? Then the per-run cap means something.
  const [mothership, setMothership] = useState(false);
  useEffect(() => { api.getMothership().then(setMothership); }, []);

  // Switching workflows closes panels; switching versions does not (the
  // Versions tab stays open while you browse).
  useEffect(() => { setPanel(null); }, [selectedWf]);

  // Load workflow + its runs when selected
  useEffect(() => {
    setRunDrill([]);
    setLoadError(false);
    setWfClaims(null);
    if (selectedWf) api.getClaims({ kind: "workflow", name: selectedWf }).then(setWfClaims).catch(() => setWfClaims(null));
    if (!selectedWf) {
      setPublishedSteps(null);
      setLocalSteps(null);
      setLoadedWf(null);
      setWfParams(null);
      setLocalParams(null);
      setLocalInput(null);
      setRuns([]);
      setFlyoutStepId(null);
      setFlyoutStepIndex(null);
      return;
    }
    api.getWorkflowFlow(selectedWf, viewVersion ?? undefined).then((flow) => {
      const steps = flow.steps as StepData[];
      setPublishedSteps(steps);
      setLocalSteps(steps);
      setLoadedWf(selectedWf);
      setWfParams(flow.params ?? null);
      setLocalParams(flow.params ?? null);
      setLocalInput(flow.input ?? null);
    }).catch(() => {
      setPublishedSteps(null);
      setLocalSteps(null);
      setLoadedWf(selectedWf);
      setLoadError(true);
    });
    refreshRuns(selectedWf);
  }, [selectedWf, viewVersion]);

  // Load run events when a run is selected; clear overlay + drill when deselected
  useEffect(() => {
    setRunDrill([]);
    setFlyoutStepId(null);
    setFlyoutStepIndex(null);
    if (!selectedRun || !selectedWf) {
      setEvents([]);
      return;
    }
    // The log FIRST, as one compressed response and one render, THEN the SSE
    // tail from where it ends (`skip`) — so selecting an IN-FLIGHT run
    // (launched via curl, the chat agent, or another tab) still updates the
    // events panel in real time, while a big finished run no longer replays
    // through the tail: uncompressed, one frame per event, one render per
    // network chunk, each one laying out the whole list (swarm38,
    // 2026-10-03). The count is a race-free cursor on an append-only log.
    // Aborted on run-switch/unmount so pollers don't leak.
    const ctrl = new AbortController();
    setEvents([]);
    (async () => {
      const accumulated = await api.getRunEvents(selectedWf, selectedRun, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setEvents([...accumulated]);
      const result = await api.streamRun(selectedWf, selectedRun, (event) => {
        if (ctrl.signal.aborted) return;
        accumulated.push(event);
        setEvents([...accumulated]);
      }, { signal: ctrl.signal, skip: accumulated.length });
      // A live-tailed run just finished → refresh the sidebar status
      // (runs list + workflow ordering, which sorts by last run).
      if (result != null && !ctrl.signal.aborted) { refreshRuns(); refreshWorkflows(); }
    })().catch((e) => { if ((e as Error)?.name !== "AbortError") console.error(e); });
    return () => ctrl.abort();
  }, [selectedRun, runEpoch]);

  // Resolve the selected run's declared promotions (a winning value → a target
  // param). Drives the topbar Promote button + flyout. Empty unless the
  // workflow declares `promotes` and the run output resolves them.
  useEffect(() => {
    setPanel((p) => (p === "promote" ? null : p));
    setPromotions([]);
    if (!selectedRun || !selectedWf) return;
    api.getPromotions(selectedWf, selectedRun)
      .then(setPromotions)
      .catch(() => setPromotions([]));
  }, [selectedWf, selectedRun]);

  // A container node's ref arrow means "open this workflow" — go-to-definition.
  // We switch the selected workflow rather than drilling into an inline
  // sub-canvas (a subflow target is a standalone, separately-editable workflow).
  // In run view it instead drills into that node's nested execution.
  const handleNavigate = useCallback((ref: string) => {
    if (!ref.startsWith("wf:")) return;
    const name = ref.slice(3);
    if (isRunView) {
      // Run view: the arrow drills into this node's nested execution.
      const step = (viewSteps ?? []).find((s) => stepWorkflow(s) === name);
      if (step) drillIntoStep(step);
      return;
    }
    if (name === selectedWf) return;
    stepTo({ wf: name, run: null, job: selectedJob });
    setSelectedWf(name);
    setSelectedRun(null);
    setEvents([]);
    setFlyoutStepId(null);
    setFlyoutStepIndex(null);
  }, [selectedWf, selectedJob, isRunView, viewSteps, stepTo]);

  // Drill into a container step's nested execution (run view). Loads the child
  // workflow definition and pushes a frame; events are re-keyed by `viewEvents`.
  // foreach/loop bodies run N times under `<prefix>#<i>`, so we count the
  // iterations and start at #0.
  const drillIntoStep = useCallback((step: StepData) => {
    const childName = stepWorkflow(step);
    if (!childName) return;
    const base = runDrill.length > 0 ? framePrefix(runDrill[runDrill.length - 1]!) : (selectedWf ?? "");
    const pathPrefix = `${base}/${step.id}`;
    const isIter = step.type === "foreach" || step.type === "loop";
    api.getWorkflowFlow(childName).then((flow) => {
      const frame: DrillFrame = { pathPrefix, workflow: childName, steps: flow.steps as StepData[] };
      if (isIter) {
        frame.iterations = countIterations(events, pathPrefix);
        frame.iter = 0;
      }
      setRunDrill((prev) => [...prev, frame]);
      setFlyoutStepId(null);
      setFlyoutStepIndex(null);
    }).catch(console.error);
  }, [runDrill, selectedWf, events]);

  // Select a different iteration on the deepest (foreach/loop) drill frame.
  const setDrillIter = useCallback((iter: number) => {
    setRunDrill((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      next[next.length - 1] = { ...next[next.length - 1]!, iter };
      return next;
    });
    setFlyoutStepId(null);
    setFlyoutStepIndex(null);
  }, []);

  function updateLocalSteps(steps: StepData[]) {
    if (viewingOld) return; // historical versions are read-only
    setLocalSteps(steps);
  }

  const submitRun = useCallback(async (
    input: Record<string, unknown>,
    params?: Record<string, unknown>,
  ) => {
    if (!selectedWf || !localSteps) return;
    const wf = selectedWf;
    const accumulated: RunEventData[] = [];

    setRunBindings(null);
    setRunDrill([]);
    setRunning(true);
    // Empty events + running → pending status overlay on all nodes immediately.
    setEvents([] as api.RunEvent[]);
    liveStreamRef.current = true;

    try {
      // Detached launch (§8): we get the runId up front, so the run can surface
      // in the sidebar as "running" while it's still executing. We don't select
      // it yet — selecting fires an effect that refetches (and would clobber)
      // the live events; we select on completion, as before.
      const { runId } = await api.launchWorkflow(wf, input, params);
      let listedRunning = false;
      await api.streamRun(wf, runId, (event) => {
        // If the user navigated into another run mid-stream (e.g. opened a
        // generation's eval run), stop pushing this run's events over theirs.
        if (!liveStreamRef.current) return;
        accumulated.push(event as RunEventData);
        setEvents([...accumulated] as api.RunEvent[]);
        // First event means the run's log exists on disk → `/runs` now returns
        // it (status "running", no run.json yet). Refresh once to show it live.
        if (!listedRunning) {
          listedRunning = true;
          refreshRuns(wf);
          refreshWorkflows(); // re-sort the sidebar: this workflow just ran
          void pollActiveRuns();
        }
      });

      if (liveStreamRef.current) setSelectedRun(runId);
      await refreshRuns(wf);
      await refreshWorkflows();
    } finally {
      liveStreamRef.current = false;
      setRunning(false);
      void pollActiveRuns();
    }
  }, [selectedWf, localSteps, refreshRuns, refreshWorkflows, pollActiveRuns]);

  // Navigate into another workflow's run (from an Events-panel run-ref link).
  // Disarm any in-tab live stream first so it doesn't clobber the target run's
  // events (or yank us back when it finishes).
  const openRun = useCallback((wf: string, runId: string) => {
    liveStreamRef.current = false;
    setRunning(false);
    closeFlyout();
    stepTo({ wf, run: runId, job: selectedJob });
    if (selectedWf !== wf) setSelectedWf(wf);
    setSelectedRun(runId);
  }, [selectedWf, selectedJob, stepTo]);

  // Select a job: its timeline takes the canvas (no run open). The selected
  // workflow is left alone — it is the history panel's filter, and the
  // list you clicked in would reshuffle under the click if it cleared.
  const selectJob = useCallback((id: string | null) => {
    liveStreamRef.current = false;
    setRunning(false);
    setFlyoutStepId(null);
    setFlyoutStepIndex(null);
    setPanel(null);
    setInfoStep(null);
    setThreadView(null);
    setSelectedApp(null);
    setSelectedJob(id);
    setSelectedRun(null);
    setEvents([]);
  }, []);
  /** Open an app's page (plans/apps.md §7.3): the canvas area is its.
   *  `input` is what it is opened with (`?input=`); none, a plain open. */
  const selectApp = useCallback((name: string | null, input?: string) => {
    liveStreamRef.current = false;
    setRunning(false);
    setFlyoutStepId(null);
    setFlyoutStepIndex(null);
    setPanel(null);
    setInfoStep(null);
    setThreadView(null);
    setSelectedJob(null);
    setSelectedRun(null);
    setEvents([]);
    setSelectedApp(name);
    setAppInput(input ?? null);
  }, []);
  /** A strut deep link the app's page asked to open (`ui/open-link`). */
  const navigateFromApp = useCallback((params: Record<string, string>) => {
    if (params["app"]) return selectApp(params["app"], params["input"]);
    if (params["job"]) return selectJob(params["job"]);
    if (params["wf"]) {
      setSelectedApp(null);
      setSelectedJob(null);
      setSelectedWf(params["wf"]);
      setSelectedRun(params["run"] ?? null);
      setEvents([]);
      closeFlyout();
    }
  }, [selectApp, selectJob]);

  // A run opened from the timeline (or the job's run list): the run canvas
  // you have today, the job kept for the breadcrumb, the flyout on the
  // turn's step once the run's steps and events are in.
  const openJobRun = useCallback((workflow: string, runId: string, path?: string) => {
    setThreadView(null);
    openRun(workflow, runId);
    setPendingFlyout(path ?? null);
  }, [openRun]);
  // A row of the run overview: the open run's own canvas, the flyout on the
  // row's top-level step (`wf/each#2/x` opens on `each`).
  const openRunStep = useCallback((path: string) => {
    setRunDrill([]);
    setPendingFlyout(path.replace(/#\d+/g, ""));
  }, []);
  useEffect(() => {
    if (!pendingFlyout || !localSteps || loadedWf !== selectedWf || events.length === 0) return;
    // `wf/work/004-agent` opens on `work`: the step the canvas has. The run's
    // path is the workflow's name, slashes included (`acme/sync/work/…`).
    const prefix = `${selectedWf}/`;
    const id = pendingFlyout.startsWith(prefix) ? pendingFlyout.slice(prefix.length).split("/")[0] : undefined;
    const idx = id ? localSteps.findIndex((s) => s.id === id) : -1;
    if (idx >= 0) { setFlyoutStepId(id!); setFlyoutStepIndex(idx); }
    setPendingFlyout(null);
  }, [pendingFlyout, localSteps, loadedWf, selectedWf, events.length]);

  // ── Run control (RUN_CONTROL_SPEC): cancel / pause / resume ──────────────
  const selectedRunSummary = selectedRun ? runs.find((r) => r.runId === selectedRun) : undefined;
  const runControlStatus = selectedRunSummary?.status;
  // Live states come from the server's controller map; "stale"/"error"/
  // "cancelled" are dead-but-resumable (journal replay).
  const runIsLive =
    runControlStatus === "running" || runControlStatus === "pausing" ||
    runControlStatus === "paused" || runControlStatus === "cancelling";
  const runIsPaused = runControlStatus === "paused" || runControlStatus === "pausing";
  const runIsResumable =
    runControlStatus === "stale" || runControlStatus === "error" || runControlStatus === "cancelled";

  // A failed cancel / pause / resume shows in a popover under the buttons
  // until dismissed or the next attempt. Stored with its run, so it drops
  // away when the selection moves on.
  const [runFailure, setRunFailure] = useState<{ run: string; msg: string } | null>(null);
  const runControlError = runFailure?.run === selectedRun ? runFailure.msg : null;
  const runErrorRef = useRef<HTMLDivElement>(null);
  const dismissRunError = useCallback(() => setRunFailure(null), []);
  useDismiss(runErrorRef, runControlError != null, dismissRunError);

  const handleCancelRun = useCallback(async (force = false) => {
    if (!selectedWf || !selectedRun) return;
    setRunFailure(null);
    try { await api.cancelRun(selectedWf, selectedRun, force); } catch (e) { setRunFailure({ run: selectedRun, msg: `Cancel failed: ${errorMessage(e)}` }); }
    await refreshRuns(selectedWf);
  }, [selectedWf, selectedRun, refreshRuns]);

  const handlePauseRun = useCallback(async () => {
    if (!selectedWf || !selectedRun) return;
    setRunFailure(null);
    try { await api.pauseRun(selectedWf, selectedRun); } catch (e) { setRunFailure({ run: selectedRun, msg: `Pause failed: ${errorMessage(e)}` }); }
    await refreshRuns(selectedWf);
  }, [selectedWf, selectedRun, refreshRuns]);

  // Dual-purpose: releases a paused run, or durably resumes a dead one
  // (stale / error / cancelled) by replaying its journal.
  const handleResumeRun = useCallback(async () => {
    if (!selectedWf || !selectedRun) return;
    setRunFailure(null);
    try { await api.resumeRun(selectedWf, selectedRun); } catch (e) { setRunFailure({ run: selectedRun, msg: `Resume failed: ${errorMessage(e)}` }); return; }
    await refreshRuns(selectedWf);
    setRunEpoch((n) => n + 1); // re-tail: the log continues past its old terminal
  }, [selectedWf, selectedRun, refreshRuns]);

  // "Re-run from here" (§5.2 `from` invalidation): the chosen step, its
  // dependents, and later loop iterations re-execute; upstream replays free.
  // The flyout confirms, and shows why when this rejects.
  const handleRerunFrom = useCallback(async (path: string) => {
    if (!selectedWf || !selectedRun) return;
    await api.resumeRun(selectedWf, selectedRun, path);
    setFlyoutStepId(null);
    setFlyoutStepIndex(null);
    await refreshRuns(selectedWf);
    setRunEpoch((n) => n + 1);
  }, [selectedWf, selectedRun, refreshRuns]);

  // The inputs this workflow needs at run time — asked for by the Run popover
  // and by the Automations editor. A declared `input:` block is the answer;
  // without one, inputs are referenced wherever they're consumed, so every
  // step's schema is consulted — not just the first's (see run-inputs.ts). A
  // type whose schema fails to load still contributes its refs, as untyped
  // fields.
  // Either way the steps' schemas are consulted: an input a graph read
  // resolves by name gets a typeahead over that node type (nodeLookups).
  const loadInputBindings = useCallback(async (): Promise<InputBinding[]> => {
    if (!localSteps) return localInput ? bindingsFromInputBlock(localInput) : [];
    const schemas = new Map<string, api.FieldDesc[]>();
    await Promise.all(
      stepTypesIn(localSteps).map(async (type) => {
        try {
          schemas.set(type, (await api.getStepSchema(type)).fields);
        } catch {
          // untyped
        }
      }),
    );
    const schemaFor = (type: string) => schemas.get(type);
    if (localInput) return applyLookups(bindingsFromInputBlock(localInput), nodeLookups(localSteps, schemaFor, localParams));
    return deriveInputBindings(localSteps, schemaFor, localParams);
  }, [localSteps, localInput, localParams]);

  const handleRun = useCallback(async () => {
    if (!selectedWf || !localSteps || localSteps.length === 0) return;
    const bindings = await loadInputBindings();
    const hasParams = localParams != null && Object.keys(localParams).length > 0;
    if (bindings.length === 0 && !hasParams) {
      await submitRun({});
    } else {
      setRunBindings(bindings);
    }
  }, [selectedWf, localSteps, submitRun, localParams, loadInputBindings]);

  const handleCreate = useCallback(async (name: string, yamlStr: string, desc: string, category?: string) => {
    // Server auto-suffixes on collision; navigate to the resolved name.
    const res = await api.createWorkflowYaml(name, yamlStr, desc || undefined, category || undefined);
    await refreshWorkflows();
    setSelectedWf(res.workflow);
    setShowCreate(false);
  }, [refreshWorkflows]);

  const handlePublish = useCallback(async () => {
    if (!selectedWf || !localSteps || !activeVersion) return;
    // Next after the HIGHEST version, not the active one: after a rollback
    // the active version is not the newest, and active+1 would overwrite.
    const nums = (selectedEntry?.versions ?? [activeVersion]).map((v) => parseInt(v.replace(/^v/, ""), 10) || 0);
    const nextVersion = `v${Math.max(0, ...nums) + 1}`;
    const hasParams = localParams != null && Object.keys(localParams).length > 0;
    // The editor models name / input / steps / params; every other top-level
    // key of the version being edited — `claims:`, `promotes:`, `sealed:`,
    // `peer:` — rides through unchanged.
    let rest: Record<string, unknown> = {};
    try {
      const prev = yaml.load(await api.getWorkflowYaml(selectedWf, viewVersion ?? activeVersion)) as Record<string, unknown> | null;
      rest = Object.fromEntries(Object.entries(prev ?? {}).filter(([k]) => !["name", "input", "steps", "params"].includes(k)));
    } catch { /* publish what the editor has */ }
    const yamlStr = yaml.dump(
      { name: selectedWf, ...(localInput ? { input: localInput } : {}), steps: localSteps, ...(hasParams ? { params: localParams } : {}), ...rest },
      { lineWidth: 120, noRefs: true },
    );
    await api.publishWorkflowYaml(selectedWf, nextVersion, yamlStr);
    await refreshWorkflows();
    const flow = await api.getWorkflowFlow(selectedWf);
    const steps = flow.steps as StepData[];
    setPublishedSteps(steps);
    setLocalSteps(steps);
    setWfParams(flow.params ?? null);
    setLocalParams(flow.params ?? null);
    setLocalInput(flow.input ?? null);
  }, [selectedWf, selectedEntry, localSteps, localParams, localInput, activeVersion, viewVersion, refreshWorkflows]);

  // Roll back (or forward) to a stored version: it becomes what Run,
  // schedules and the canvas use. Nothing is published, so unsaved canvas
  // edits are lost — the Versions panel asks first.
  const handleActivateVersion = useCallback(async (version: string) => {
    if (!selectedWf) return;
    await api.setActiveWorkflowVersion(selectedWf, version);
    await refreshWorkflows();
    setViewVersion(null);
    const flow = await api.getWorkflowFlow(selectedWf);
    const steps = flow.steps as StepData[];
    setPublishedSteps(steps);
    setLocalSteps(steps);
    setWfParams(flow.params ?? null);
    setLocalParams(flow.params ?? null);
    setLocalInput(flow.input ?? null);
  }, [selectedWf, refreshWorkflows, setViewVersion]);

  // Clicking a node (body) always opens its flyout — leaf I/O, or a
  // container's aggregate I/O. Drilling into children is the arrow's job.
  const handleNodeClick = useCallback((node: CanvasNode) => {
    const stepId = node.customData?.stepId as string | undefined;
    const stepIndex = node.customData?.stepIndex as number | undefined;
    if (stepId == null) return;
    setPanel(null);
    setInfoStep(null);
    setFlyoutStepId(stepId);
    setFlyoutStepIndex(stepIndex ?? null);
  }, []);

  const handleNodeAdd = useCallback((_node: CanvasNode) => {
    // Intercepted by renderAddNodeButton — should not fire
  }, []);

  const handleAddStepSelect = useCallback((stepType: string) => {
    if (!localSteps || !selectedWf) return;
    // Generate a unique step id from the type name
    const base = stepType.replace(/[^a-zA-Z0-9_]/g, "_");
    let id = base;
    let n = 1;
    while (localSteps.some((s) => s.id === id)) {
      id = `${base}_${n++}`;
    }
    const newStep: StepData = {
      id,
      type: stepType,
      config: {},
      depends: [],
    };
    const next = [...localSteps, newStep];
    updateLocalSteps(next);
    setShowAddStep(false);
    // Open flyout for the new step
    setFlyoutStepId(id);
    setFlyoutStepIndex(next.length - 1);
  }, [localSteps, selectedWf]);

  const handleEdgeAdd = useCallback((edge: CanvasEdge) => {
    if (!localSteps || !selectedWf) return;
    // Extract step ids from node ids (format: "workflowName/stepId")
    const fromStepId = edge.fromNode.split("/").pop();
    const toStepId = edge.toNode.split("/").pop();
    if (!fromStepId || !toStepId) return;

    const next = localSteps.map((s) => {
      if (s.id !== toStepId) return s;
      // Add the dependency
      const currentDeps = s.depends == null ? [] : Array.isArray(s.depends) ? [...s.depends] : [s.depends];
      if (!currentDeps.includes(fromStepId)) {
        currentDeps.push(fromStepId);
      }
      return { ...s, depends: currentDeps };
    });
    updateLocalSteps(next);
  }, [localSteps, selectedWf]);

  const handleEdgeDelete = useCallback((edgeId: string) => {
    if (!localSteps || !selectedWf) return;
    // Edge id format: "wfName/fromId__to__wfName/toId"
    const parts = edgeId.split("__to__");
    if (parts.length !== 2) return;
    const fromStepId = parts[0]!.split("/").pop();
    const toStepId = parts[1]!.split("/").pop();
    if (!fromStepId || !toStepId) return;

    const next = localSteps.map((s) => {
      if (s.id !== toStepId) return s;
      const currentDeps = s.depends == null ? [] : Array.isArray(s.depends) ? [...s.depends] : [s.depends];
      const filtered = currentDeps.filter((d) => d !== fromStepId);
      return { ...s, depends: filtered };
    });
    updateLocalSteps(next);
  }, [localSteps, selectedWf]);

  const handleNodeDelete = useCallback((nodeId: string) => {
    if (!localSteps || !selectedWf) return;
    const stepId = nodeId.split("/").pop();
    if (!stepId) return;
    // Remove the step and clean up depends references
    const next = localSteps
      .filter((s) => s.id !== stepId)
      .map((s) => {
        if (!s.depends) return s;
        const deps = Array.isArray(s.depends) ? s.depends : [s.depends];
        const filtered = deps.filter((d) => d !== stepId);
        return { ...s, depends: filtered };
      });
    updateLocalSteps(next);
    if (flyoutStepId === stepId) closeFlyout();
  }, [localSteps, selectedWf, flyoutStepId]);

  const handleStepSave = useCallback((index: number, updated: StepData) => {
    if (!localSteps) return;
    const oldId = localSteps[index]!.id;
    const newId = updated.id;
    let next = [...localSteps];
    next[index] = updated;
    // If the ID changed, update all depends references in other steps
    if (oldId !== newId) {
      next = next.map((s, i) => {
        if (i === index || !s.depends) return s;
        const deps = Array.isArray(s.depends) ? s.depends : [s.depends];
        if (!deps.includes(oldId)) return s;
        return { ...s, depends: deps.map((d) => d === oldId ? newId : d) };
      });
    }
    updateLocalSteps(next);
    setFlyoutStepId(null);
    setFlyoutStepIndex(null);
  }, [localSteps, selectedWf]);

  const closeFlyout = () => { setFlyoutStepId(null); setFlyoutStepIndex(null); };

  // A claim's evidence (or to-do) points at the run it came from: go look at it.
  const openRunFromClaim = (workflow: string, runId: string) => {
    setPanel(null);
    closeFlyout();
    setViewVersion(null);
    stepTo({ wf: workflow, run: runId, job: selectedJob });
    setSelectedWf(workflow);
    setSelectedRun(runId);
  };

  // Delete the selected workflow (the flyout confirmed). The server refuses
  // while a run is in flight — the flyout shows why; nothing changes here.
  const handleDeleteWorkflow = useCallback(async () => {
    if (!selectedWf) return;
    await api.deleteWorkflow(selectedWf);
    setPanel(null);
    closeFlyout();
    setSelectedWf(null);
    setSelectedRun(null);
    setEvents([]);
    await refreshWorkflows();
  }, [selectedWf, refreshWorkflows]);

  // Sidebar Steps catalog: filtered by the section's search box (the Add
  // Step picker's matcher), grouped by tier in the same order as that picker.
  // Clicking an item toggles its read-only info flyout.
  const matchedSteps = useMemo(() => searchSteps(stepTypes, stepQuery), [stepTypes, stepQuery]);
  const stepGroups = useMemo(() => [
    { label: "Core", steps: matchedSteps.filter((s) => s.source === "core") },
    { label: "Library", steps: matchedSteps.filter((s) => s.source === "lib") },
    { label: "Custom", steps: matchedSteps.filter((s) => s.source === "custom") },
  ].filter((g) => g.steps.length > 0), [matchedSteps]);

  // Opening one of Tools / Apps closes the other.
  const toggleBottom = useCallback((section: "tools" | "apps") => {
    setBottomOpen((prev) => {
      const next = prev === section ? null : section;
      savePref("sidebarBottom", next);
      return next;
    });
  }, []);

  const openStepInfo = useCallback((entry: StepTypeEntry) => {
    setPanel(null);
    setFlyoutStepId(null);
    setFlyoutStepIndex(null);
    setInfoStep((prev) => (prev?.type === entry.type ? null : entry));
  }, []);

  // The selected app's page (plans/apps.md §7.3), in the canvas area,
  // opened with `?input=`. A peer's page gets no builder chat, and of its
  // links only one to an app on that peer opens in place (AppHost): the
  // rest are the peer's (plans/apps.md §7.4). Alone (`?solo=1`) it is
  // ./components/SoloApp.
  const appToolArgs = appToolInput(appInput);
  const appView = selectedApp
    ? appEntry
      ? <AppHost
          key={`${appKey(appEntry)}@${appEntry.activeVersion}`}
          app={{ name: appEntry.name, version: appEntry.activeVersion, ...(appEntry.peer ? { peer: appEntry.peer } : {}) }}
          reload={appReload}
          onNavigate={navigateFromApp}
          {...(appToolArgs ? { toolInput: appToolArgs } : {})}
          {...(appEntry.peer ? {} : {
            onMessage: (text: string) => {
              setShowChat(true);
              setChatInbound({ text: appMessage({ name: appEntry.name, version: appEntry.activeVersion }, text), id: Date.now() });
            },
          })}
        />
      : <div class="empty">{appsLoaded ? `No app "${selectedApp}"` : "Loading apps…"}</div>
    : null;

  return (
    <div class="shell">
      {/* Sidebar */}
      <div class="shell-sidebar">
        <div class="sidebar-brand"><span class="brand-dot" /> strut</div>

        <div class="sidebar-section" data-section="workflows">
          <div class="section-title">
            Workflows
            <button class="btn" style="float:right;padding:1px 8px;font-size:11px;margin-top:-3px;" onClick={() => setShowCreate(true)}>+</button>
          </div>
          {workflows.length > 0 && (
            <input
              class="sidebar-search"
              type="search"
              value={wfQuery}
              placeholder="Filter workflows…"
              aria-label="Filter workflows"
              onInput={(e) => setWfQuery((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setWfQuery("");
                if (e.key === "Enter" && matchedWorkflows.length === 1) {
                  setSelectedApp(null); setSelectedJob(null); setSelectedWf(matchedWorkflows[0]!.name); setSelectedRun(null); setEvents([]); closeFlyout();
                }
              }}
            />
          )}
          <div class="sidebar-scroll">
            {workflows.length === 0 && <div class="empty-sidebar">No workflows yet</div>}
            {workflows.length > 0 && matchedWorkflows.length === 0 && (
              <div class="empty-sidebar">No matching workflows</div>
            )}
            {wfGroups.map((g) => {
              const catKey = g.category || "__uncategorized";
              // A filter shows every match regardless of collapsed groups.
              const collapsed = showGroupHeaders && !wfQuery.trim() && !!collapsedCats[catKey];
              return (
                <div key={catKey}>
                  {showGroupHeaders && (
                    <div class="cat-header" onClick={() => toggleCat(catKey)}>
                      <span class={`cat-caret${collapsed ? "" : " is-open"}`}>▸</span>
                      <span class="cat-name">{g.category || "uncategorized"}</span>
                      {collapsed && g.wfs.some((wf) => runningByWf.has(wf.name)) && (
                        <span class="live-dot" title="A workflow in here is running" />
                      )}
                      <span class="cat-count">{g.wfs.length}</span>
                    </div>
                  )}
                  {!collapsed && g.wfs.map((wf) => (
                    <div key={wf.name} class={`list-item ${selectedWf === wf.name && !appOpen ? "is-active" : ""}`}
                      onClick={() => { setSelectedApp(null); setSelectedJob(null); setSelectedWf(wf.name); setSelectedRun(null); setEvents([]); closeFlyout(); }}>
                      <span class="list-item-name">{wf.name}</span>
                      {runningByWf.has(wf.name) && (
                        <span class="live-dot" title={`${runningByWf.get(wf.name)} run${runningByWf.get(wf.name) === 1 ? "" : "s"} in progress`} />
                      )}
                      {wf.automations?.some((a) => a.enabled) && (
                        <span class="list-item-clock" title="Runs on a schedule"><ClockIcon size={11} /></span>
                      )}
                      <span class="badge badge-accent">{wf.activeVersion}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        <SidebarResizer />

        {/* History — one slot, Runs or Jobs (plans/jobs-sidebar.md §2):
            the two lists slide, the mode is remembered, both are scoped to
            the selected workflow. */}
        <div class="sidebar-section has-modes" data-section="runs">
          <div class="section-title section-title-modes">
            <span class="mode-switch" role="tablist" aria-label="History">
              {(["runs", "jobs"] as const).map((m) => (
                <button key={m} type="button" role="tab" aria-selected={historyMode === m}
                  class={`mode-btn${historyMode === m ? " is-active" : ""}`}
                  onClick={() => { setHistoryMode(m); savePref("historyMode", m); }}>
                  {m === "runs" ? "Runs" : "Jobs"}
                </button>
              ))}
            </span>
            {historyMode === "runs" && selectedJob && job
              ? <span class="section-scope" title={job.job}>{job.title ?? job.job}</span>
              : selectedWf && <span class="section-scope" title={selectedWf}>{selectedWf}</span>}
            {historyMode === "jobs" && jobsActor && (
              <button type="button" class={`mine-toggle${jobsMine ? " is-on" : ""}`} aria-pressed={jobsMine}
                title={jobsMine ? `Only your jobs (${displayActor(jobsActor)}) — click for everyone's` : "Only your jobs"}
                onClick={() => { const v = !jobsMine; setJobsMine(v); savePref("jobsMine", v); }}>
                <UserIcon />
              </button>
            )}
          </div>
          <div class={`mode-track${historyMode === "jobs" ? " is-jobs" : ""}`}>
            <div class="mode-pane" inert={historyMode !== "runs"}>
              <div class="sidebar-scroll">
                {/* A selected job lists ITS runs, every workflow, newest first —
                    so the turns of a thread are a click apart. */}
                {selectedJob && job ? (
                  <>
                    {job.runs.length === 0 && <div class="empty-sidebar">No runs under this job</div>}
                    {job.runs.map((r) => (
                      <div key={r.runId} class={`list-item run-row ${selectedRun === r.runId ? "is-active" : ""}`}
                        onClick={() => openJobRun(r.workflow, r.runId)}>
                        <div class="run-row-main">
                          <RunTime runId={r.runId} at={r.at} durationMs={r.durationMs} />
                          <span class={`badge badge-${statusTone(r.status)}`}>{r.status}</span>
                        </div>
                        <span class="list-item-sub">
                          {r.workflow}{r.parentRunId ? " · child run" : ""}{r.sealed ? " · sealed" : ""}
                        </span>
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    {filteredRuns.length === 0 && <div class="empty-sidebar">{selectedWf ? "No runs for this workflow" : "No runs yet"}</div>}
                    {/* The time (the id is its tooltip; a click opens the run and copies its id),
                        the status at the row's end, the job it ran under
                        across the bottom — a click on the chip opens the
                        job's timeline. */}
                    {filteredRuns.map((run) => (
                      <div key={run.runId} class={`list-item run-row ${selectedRun === run.runId ? "is-active" : ""}`}
                        onClick={() => { setSelectedRun(run.runId); setViewVersion(null); closeFlyout(); }}>
                        <div class="run-row-main">
                          <RunTime runId={run.runId} at={run.startedAt} durationMs={run.durationMs} />
                          {run.automation && <span class="list-item-clock" title="Started by an automation"><ClockIcon size={10} /></span>}
                          <span class={`badge badge-${statusTone(run.status)}`}>{run.status}</span>
                        </div>
                        {run.job && (
                          <span class="job-chip" title={`Job ${run.job}`}
                            onClick={(e) => { e.stopPropagation(); selectJob(run.job!); }}>{jobTitle(run.job)}</span>
                        )}
                        {run.origin === "app" && run.app && (
                          <span class="app-chip" title={`Launched by the app ${run.app.name} (${run.app.version})`}
                            onClick={(e) => { e.stopPropagation(); selectApp(run.app!.name); }}>{appTitle(run.app.name)}</span>
                        )}
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>
            <div class="mode-pane" inert={historyMode !== "jobs"}>
              {/* Every job, newest-used first — a click opens its timeline. */}
              {(jobs.length > 0 || jobQuery) && (
                <input
                  class="sidebar-search"
                  type="search"
                  value={jobQuery}
                  placeholder="Find jobs…"
                  aria-label="Find jobs"
                  onInput={(e) => setJobQuery((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setJobQuery("");
                    if (e.key === "Enter" && jobs.length === 1) selectJob(jobs[0]!.job);
                  }}
                />
              )}
              <div class="sidebar-scroll">
                {jobs.length === 0 && (
                  <div class="empty-sidebar">{jobQuery ? "No matching jobs" : jobsMine ? "No jobs of yours" : selectedWf ? "No jobs for this workflow" : "No jobs yet"}</div>
                )}
                {jobs.map((j) => (
                  <div key={j.job} class={`list-item ${selectedJob === j.job ? "is-active" : ""}`} onClick={() => selectJob(j.job)}>
                    <div class="list-item-stack">
                      <span class="list-item-name" title={j.job}>{j.title ?? j.job}</span>
                      <span class="list-item-sub">
                        {fmtTime(j.usedAt)} · {j.runs} run{j.runs === 1 ? "" : "s"}{j.holds ? ` · ${j.holds} hold${j.holds === 1 ? "" : "s"}` : ""}
                      </span>
                    </div>
                    {j.busy && <span class="live-dot" title="A run is working in this job now" />}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {bottomOpen && <SidebarResizer />}

        {/* Steps catalog — every registered step type (core / lib / custom).
            Collapsed by default; click a step for its info flyout. */}
        <div class={`sidebar-section${stepsOpen ? "" : " is-collapsed"}`} data-section="tools">
          <div class="section-title section-title-toggle" onClick={() => toggleBottom("tools")}>
            <span class={`cat-caret${stepsOpen ? " is-open" : ""}`}>▸</span>
            <span>Tools</span>
            <span class="cat-count">
              {stepQuery.trim() ? `${matchedSteps.length} / ${stepTypes.length}` : stepTypes.length}
            </span>
          </div>
          {stepsOpen && stepTypes.length > 0 && (
            <input
              class="sidebar-search"
              type="search"
              value={stepQuery}
              placeholder="Filter tools…"
              aria-label="Filter tools"
              onInput={(e) => setStepQuery((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setStepQuery("");
                if (e.key === "Enter" && matchedSteps.length === 1) openStepInfo(matchedSteps[0]!);
              }}
            />
          )}
          {stepsOpen && (
            <div class="sidebar-scroll">
              {stepTypes.length === 0 && <div class="empty-sidebar">No tools</div>}
              {stepTypes.length > 0 && matchedSteps.length === 0 && (
                <div class="empty-sidebar">No matching tools</div>
              )}
              {stepGroups.map((g) => {
                // Shares collapsedCats with workflow categories; the prefix
                // keeps the keys apart. A filter shows every match regardless.
                const catKey = `tools:${g.label}`;
                const collapsed = !stepQuery.trim() && !!collapsedCats[catKey];
                return (
                  <div key={g.label}>
                    <div class="cat-header" onClick={() => toggleCat(catKey)}>
                      <span class={`cat-caret${collapsed ? "" : " is-open"}`}>▸</span>
                      <span class="cat-name">{g.label}</span>
                      <span class="cat-count">{g.steps.length}</span>
                    </div>
                    {!collapsed && g.steps.map((s) => (
                      <div key={s.type} class={`list-item ${infoStep?.type === s.type ? "is-active" : ""}`}
                        onClick={() => openStepInfo(s)}>
                        <span class="list-item-name">{s.type}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Apps (plans/apps.md §7.3): every workspace app, by title — a click
            opens its page in the canvas area. Shares the bottom with Tools:
            opening one closes the other. */}
        <div class={`sidebar-section sidebar-apps${appListOpen ? "" : " is-collapsed"}`} data-section="apps">
          <div class="section-title section-title-toggle" onClick={() => toggleBottom("apps")}>
            <span class={`cat-caret${appListOpen ? " is-open" : ""}`}>▸</span>
            <span>Apps</span>
            {apps.some((a) => a.warnings) && (
              <span class="usage-dot" title={`${apps.filter((a) => a.warnings).map((a) => a.title).join(", ")}: heavy backend use — open the app's Usage`} />
            )}
            <span class="cat-count">
              {appQuery.trim() ? `${matchedApps.length} / ${apps.length}` : apps.length}
            </span>
          </div>
          {appListOpen && apps.length > 2 && (
            <input
              class="sidebar-search"
              type="search"
              value={appQuery}
              placeholder="Filter apps…"
              aria-label="Filter apps"
              onInput={(e) => setAppQuery((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setAppQuery("");
                if (e.key === "Enter" && matchedApps.length === 1) selectApp(appKey(matchedApps[0]!));
              }}
            />
          )}
          {appListOpen && (
            <div class="sidebar-scroll">
              {apps.length === 0 && <div class="empty-sidebar">No apps yet — ask the builder for one</div>}
              {apps.length > 0 && matchedApps.length === 0 && <div class="empty-sidebar">No matching apps</div>}
              {matchedApps.map((a) => (
                <div key={appKey(a)} class={`list-item ${selectedApp === appKey(a) ? "is-active" : ""}`} title={a.description ? `${appKey(a)} — ${a.description}` : appKey(a)}
                  onClick={() => selectApp(appKey(a))}>
                  <span class="app-icon" aria-hidden="true"><AppGlyph /></span>
                  <span class="list-item-name">{a.title}</span>
                  {!!a.warnings && <span class="usage-dot" title={`${a.warnings} warning${a.warnings === 1 ? "" : "s"} on ${a.activeVersion}: its pages cost the server too much — open its Usage`} />}
                  {a.peer && <span class="badge" title={`Lives on the peer ${a.peer}: it runs there, as you`}>@{a.peer}</span>}
                  {a.pinned && <span class="badge app-tab-badge" title="Shown as a tab where this workspace's apps are listed">tab</span>}
                  <span class="badge badge-accent">{a.activeVersion}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Topbar */}
      <div class="shell-topbar">
        <span class="topbar-title">
          {wf ?? (selectedJob ? (job?.title ?? selectedJob) : appOpen ? (appEntry?.title ?? selectedApp) : "Select a workflow")}
          {appOpen && appEntry?.peer && (
            // A peer's app (plans/apps.md §7.4): what is live there, run there
            // as you. Its releases and its tab are the peer's to change.
            <span class="badge" title={`Lives on the peer ${appEntry.peer}: what is live there, run there as you`}>@{appEntry.peer} · {appEntry.activeVersion}</span>
          )}
          {appOpen && appEntry && !appEntry.peer && (
            // What people open (plans/app-releases.md, PUT /apps/:name/active):
            // the latest publish, or a release the app is held at. A release
            // picked here rolls back (or forward); a version picked makes a
            // release of it and holds the app there. The frame shows what is
            // live and reloads on a change.
            <select
              class="app-version-select"
              title={appEntry.live
                ? [
                    `Held at ${appEntry.live} (${appEntry.activeVersion}): a publish is a draft until it is made live here.`,
                    ...(appReleases?.behind.length ? ["Moved on since:", ...appReleases.behind.map((d) => `${d.name} ${d.locked} → ${d.current ?? "gone"}`)] : []),
                  ].join("\n")
                : "Following latest: every publish is live. Pick a version to hold the app there."}
              value={appEntry.live ? `release:${appEntry.live}` : "latest"}
              onChange={async (e) => {
                const v = (e.target as HTMLSelectElement).value;
                const target = v === "latest" ? { version: "latest" } : v.startsWith("release:") ? { release: v.slice(8) } : { version: v.slice(8) };
                try {
                  await api.setAppLive(appEntry.name, target);
                  await refreshApps();
                  setAppReload((n) => n + 1);
                } catch (err) {
                  alert(errorMessage(err));
                  (e.target as HTMLSelectElement).value = appEntry.live ? `release:${appEntry.live}` : "latest";
                }
              }}
            >
              <option value="latest">{appEntry.live ? "Follow latest" : `Following latest · ${appEntry.activeVersion}`}</option>
              {!!appReleases?.releases.length && (
                <optgroup label="Releases">
                  {[...appReleases.releases].reverse().map((r) => (
                    <option key={r.id} value={`release:${r.id}`}>{r.id} · {r.version}{r.id === appEntry.live ? " · live" : ""}</option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Make live and hold">
                {[...appEntry.versions].sort((a, b) => Number(b.slice(1)) - Number(a.slice(1))).map((v) => (
                  <option key={v} value={`version:${v}`}>
                    {v}{appEntry.live && Number(v.slice(1)) > Number(appEntry.activeVersion.slice(1)) ? " · draft" : v === appEntry.activeVersion ? " · live" : ""}
                  </option>
                ))}
              </optgroup>
            </select>
          )}
          {appOpen && appEntry && !appEntry.peer && (
            // A tab where this workspace's apps are listed (hive's sidebar):
            // the app's record, not a version — the select beside it stays
            // the rollback.
            <button
              type="button"
              class={`app-tab-toggle${appEntry.pinned ? " is-on" : ""}`}
              aria-pressed={!!appEntry.pinned}
              title={appEntry.pinned
                ? "Shown as a tab in the hosts that list this workspace's apps — click to stop"
                : appEntry.live
                  ? "Show this app as a tab in the hosts that list this workspace's apps"
                  : `Show this app as a tab in the hosts that list this workspace's apps — and hold it at ${appEntry.activeVersion}: later publishes are drafts until made live`}
              onClick={async () => {
                try {
                  await api.setAppPinned(appEntry.name, !appEntry.pinned);
                  await refreshApps();
                } catch (err) {
                  alert(errorMessage(err));
                }
              }}
            >Tab</button>
          )}
          {wf && (
            <CategoryEditor
              key={wf}
              workflow={wf}
              category={selectedEntry?.category}
              categories={categories}
              onSaved={refreshWorkflows}
            />
          )}
          {wf && mothership && (
            <OwnerEditor
              key={`owner:${wf}`}
              workflow={wf}
              owner={selectedEntry?.owner}
              unowned={workflows.filter((w) => !w.owner).length}
              onSaved={refreshWorkflows}
            />
          )}
          {wf && mothership && (
            <RunCapEditor
              key={`cap:${wf}`}
              workflow={wf}
              maxRunCostUsd={selectedEntry?.maxRunCostUsd}
              onSaved={refreshWorkflows}
            />
          )}
          {/* Version picker — browse the workflow's published lineage. Only
              outside run view (a run overlays the active structure), and only
              when there is history to browse. */}
          {wf && !selectedRun && selectedEntry && selectedEntry.versions.length > 1 && (
            <select
              class="version-select"
              value={viewVersion ?? activeVersion}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                setViewVersion(v === activeVersion ? null : v);
                closeFlyout();
                if (activeTab === "params") setPanel(null);
              }}
            >
              {[...selectedEntry.versions].reverse().map((v) => (
                <option key={v} value={v}>{v}{v === activeVersion ? " (active)" : ""}</option>
              ))}
            </select>
          )}
          {viewingOld && <span class="badge version-history-badge">history · read-only</span>}
          {selectedRun && <span class="topbar-run">{selectedRun.slice(0, 10)}</span>}
          {isDirty && <span class="dirty-dot" style="margin-left:8px;" />}
        </span>
        <div class="topbar-actions">
          {wf && !viewingOld && (
            <div class="run-anchor">
              <button class="btn btn-primary" onClick={handleRun}>Run</button>
              {runBindings && wf && (
                <RunInputPopover
                  workflow={wf}
                  bindings={runBindings}
                  params={localParams}
                  onSubmit={submitRun}
                  onClose={() => setRunBindings(null)}
                />
              )}
            </div>
          )}
          {/* Run control: cancel/pause a live run tree; resume a paused or
              dead (stale/error/cancelled) one — RUN_CONTROL_SPEC §3–§5. */}
          {selectedRun && (
            <span class="run-controls">
              {runIsLive && runControlStatus !== "cancelling" && (
                <ConfirmButton popover label="Cancel"
                  note="Cancel this run? Any nested runs it launched are cancelled too — each stops before its next tool (the in-flight tool finishes and is journaled)."
                  cancelLabel="Keep running" confirmLabel="Cancel run" onConfirm={() => handleCancelRun()} />
              )}
              {/* Cancel is cooperative: a step that never returns holds the run
                  `cancelling`. Force abandons it (RUN_CONTROL_SPEC / API §6.1). */}
              {runIsLive && runControlStatus === "cancelling" && (
                <ConfirmButton popover label="Force cancel"
                  note="This run is cancelling but a step has not finished. Force cancel stops waiting on it and ends the run now. The step's code is abandoned, not killed — anything it holds (a subprocess, a connection) stays until it dies."
                  cancelLabel="Keep waiting" confirmLabel="Force cancel" onConfirm={() => handleCancelRun(true)} />
              )}
              {runControlStatus === "running" && (
                <button class="btn" onClick={handlePauseRun}>Pause</button>
              )}
              {(runIsPaused || runIsResumable) && (
                <button class="btn btn-primary" onClick={handleResumeRun}>Resume</button>
              )}
              {runControlError && (
                <div class="anchored-popover" role="alert" ref={runErrorRef}>
                  <span class="confirm-note run-control-error">{runControlError}</span>
                  <button class="btn" onClick={dismissRunError}>Dismiss</button>
                </div>
              )}
            </span>
          )}
          {wf && isDirty && !viewingOld && <button class="btn btn-publish" disabled={panel === "workflow" && activeTab === "params" && !paramsValid} onClick={handlePublish}>Publish</button>}
          {isRunView && promotions.length > 0 && (
            <button
              class={`btn${panel === "promote" ? " is-active" : ""}`}
              onClick={() => { setPanel((p) => (p === "promote" ? null : "promote")); setInfoStep(null); closeFlyout(); }}
            >Promote</button>
          )}
          {/* The workflow's own flyout: params, claims, schedules — and delete.
              The claims dot rides along: the one "act now" signal up here. */}
          {wf && workflowTabs.length > 0 && (
            <button
              class={`btn${panel === "workflow" ? " is-active" : ""}`}
              title="Params, claims, schedules, versions and publishing"
              onClick={() => { setPanel((p) => (p === "workflow" ? null : "workflow")); setInfoStep(null); closeFlyout(); }}
            >Workflow{wfClaims?.enabled && <span class={`claims-dot claims-dot-${claimsTone(wfClaims)}`} />}</button>
          )}
          {appOpen && appEntry && (
            <button
              class={`btn${panel === "usage" ? " is-active" : ""}`}
              title={appEntry.warnings
                ? `${appEntry.warnings} warning${appEntry.warnings === 1 ? "" : "s"}: its pages cost the server too much`
                : "What this app's pages cost the server: calls, failures, data"}
              onClick={() => { setPanel((p) => (p === "usage" ? null : "usage")); closeFlyout(); }}
            >Usage{!!appEntry.warnings && <span class="usage-dot" />}</button>
          )}
          {appOpen && selectedApp && !appEntry?.peer && (
            <button
              class="btn"
              title="Open the builder chat with this app named"
              onClick={() => {
                setShowChat(true);
                setChatDraft({ text: `Edit the app "${selectedApp}": `, id: Date.now() });
              }}
            >Edit with the builder</button>
          )}
          <button class="btn" onClick={() => setShowSecrets(true)}>Secrets</button>
          <button class="btn" title="What this strut publishes, follows and has installed" onClick={() => setShowPackages(true)}>Packages</button>
          <button class={`btn btn-ai${showChat ? " is-active" : ""}`} onClick={() => setShowChat(!showChat)}>AI</button>
          <button class="btn btn-icon" onClick={() => setShowSettings(true)} aria-label="Settings" title="Settings">
            <GearIcon />
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div class="shell-canvas">
        {(trail.length > 0 || runDrill.length > 0 || (selectedJob && selectedRun)) && (
          <div class="drill-bar">
            {/* Followed a link here: Back returns to where it was, for when
                there is no browser back button (an iframe, the desktop app). */}
            {trail.length > 0 && (
              <button class="drill-back" onClick={() => goBack(trail.length - 1)} title={trailTitle(trail[trail.length - 1]!)}>
                <ArrowLeftIcon size={12} /> Back
              </button>
            )}
            {/* A run opened from a job: the job leads the breadcrumb, back
                to its timeline. */}
            {selectedJob && selectedRun && (
              <>
                <button class="drill-crumb" onClick={() => selectJob(selectedJob)} title="Back to the job">{job?.title ?? selectedJob}</button>
                <span class="drill-sep">›</span>
              </>
            )}
            {/* Then the places the links came from, oldest first. */}
            {trail.map((e, i) => (
              <span key={i}>
                <button class="drill-crumb" onClick={() => goBack(i)} title={trailTitle(e)}>{e.wf}</button>
                <span class="drill-sep">›</span>
              </span>
            ))}
            <button class={`drill-crumb${runDrill.length === 0 ? " is-active" : ""}`} onClick={() => setRunDrill([])}>{selectedWf}</button>
            {runDrill.map((f, i) => (
              <span key={f.pathPrefix}>
                <span class="drill-sep">›</span>
                <button
                  class={`drill-crumb${i === runDrill.length - 1 ? " is-active" : ""}`}
                  onClick={() => setRunDrill(runDrill.slice(0, i + 1))}
                >{f.workflow}</button>
              </span>
            ))}
            {drill?.iterations != null && drill.iterations > 0 && (
              <select
                class="drill-iter"
                value={String(drill.iter ?? 0)}
                onChange={(e) => setDrillIter(parseInt((e.target as HTMLSelectElement).value, 10))}
              >
                {Array.from({ length: drill.iterations }, (_, i) => (
                  <option key={i} value={String(i)}>iteration #{i}</option>
                ))}
              </select>
            )}
          </div>
        )}
        {/* A selected app: its page, hosted (plans/apps.md §7.3). A selected
            job with no run open: its timeline, not a graph. */}
        {appOpen && selectedApp ? (
          appView
        ) : timelineOpen ? (
          job
            ? <JobTimeline
                job={job}
                onOpenRun={openJobRun}
                onOpenThread={(thread, turn) => setThreadView({ thread, turn })}
                onRefresh={refreshJob}
                onNavigate={navigateFromApp}
                onOpenApp={selectApp}
              />
            : <div class="empty">Loading job…</div>
        ) : canvas
          ? <SystemCanvas
              // Remount when the viewed workflow OR pinned version changes so
              // the canvas re-fits/re-centers on its content (the library's
              // `autoFit="canvas-change"` only fires on sub-canvas
              // navigation, not when we swap the root `canvas` prop).
              key={`${viewWorkflow ?? "none"}@${viewVersion ?? "active"}`}
              panMode="trackpad"
              canvas={canvas}
              // A container node's ref arrow opens the referenced workflow
              // (go-to-definition) instead of drilling into an inline
              // sub-canvas — onNavigate routes via the sidebar selection.
              externalNavigation
              onNavigate={handleNavigate}
              editable={!isRunView && !viewingOld}
              showNodeToolbar={false}
              onNodeClick={handleNodeClick}
              onNodeAdd={handleNodeAdd}
              onNodeDelete={handleNodeDelete}
              onEdgeAdd={handleEdgeAdd}
              onEdgeDelete={handleEdgeDelete}
              renderAddNodeButton={(_props: AddNodeButtonRenderProps) => (
                selectedWf && !isRunView && !viewingOld
                  ? <button class="add-step-fab" onClick={() => setShowAddStep(true)}>+</button>
                  : null
              )}
              themes={{ strut: strutTheme }}
            />
          : <div class="empty">{workflows.length === 0 ? "Create a workflow to get started" : "Select a workflow to view its flow graph"}</div>}
      </div>

      {/* Events panel + resize handle */}
      {events.length > 0 && <EventsResizer />}
      {events.length > 0 && (
        <EventsPanel
          events={events}
          onOpenRun={openRun}
          aside={
            <RunOverview
              events={events}
              status={runControlStatus}
              cap={selectedEntry?.maxRunCostUsd}
              onOpenRun={openRun}
              onOpenStep={openRunStep}
              onOpenJob={selectJob}
              onOpenApp={selectApp}
            />
          }
        />
      )}

      {/* Create dialog */}
      {showCreate && <CreateDialog onClose={() => setShowCreate(false)} onCreate={handleCreate} categories={categories} />}
      {showSecrets && <SecretsDialog onClose={() => setShowSecrets(false)} />}
      {showPackages && <PackagesDialog onClose={() => { setShowPackages(false); setCatalogEpoch((n) => n + 1); }} />}
      {showSettings && (
        <SettingsDialog settings={sttSettings} onChange={updateStt} onClose={() => setShowSettings(false)} />
      )}

      {/* Add step dialog */}
      {showAddStep && <AddStepDialog stepTypes={stepTypes} onSelect={handleAddStepSelect} onClose={() => setShowAddStep(false)} />}

      {/* Chat flyout */}
      {showChat && (
        <ChatFlyout
          stt={sttSettings}
          draft={chatDraft}
          inbound={chatInbound}
          onAppPublished={(name) => {
            // The list (a new app, a new active version) and, when it is the
            // one in front of you, the frame.
            void refreshApps();
            if (selectedApp === name) setAppReload((n) => n + 1);
          }}
          onClose={() => setShowChat(false)}
          onWorkflowCreated={async (name) => {
            await refreshWorkflows();
            setSelectedWf(name);
          }}
          onWorkflowRan={async (name, runId) => {
            // Make sure the run's workflow is selected, then surface the new
            // run — at launch, so the sidebar and canvas follow it live.
            if (selectedWf !== name) setSelectedWf(name);
            void pollActiveRuns();
            void refreshWorkflows();
            await refreshRuns(name);
            setSelectedRun(runId);
          }}
        />
      )}

      {/* A job thread's transcript, read-only (plans/jobs-sidebar.md §4). */}
      {threadView && (
        <ThreadFlyout
          key={`${threadView.thread.id}:${threadView.turn?.runId ?? ""}`}
          thread={threadView.thread}
          turn={threadView.turn}
          onClose={() => setThreadView(null)}
          onOpenRun={(wf, id) => openJobRun(wf, id)}
        />
      )}

      {/* Step info flyout — read-only catalog view of a step type. */}
      {infoStep && (
        <StepInfoFlyout key={infoStep.type} entry={infoStep} onClose={() => setInfoStep(null)}
          onOpenWorkflow={(name) => { setSelectedWf(name); setSelectedRun(null); setEvents([]); }}
          onDelete={async () => { await api.deleteStep(infoStep.type); setInfoStep(null); await refreshStepTypes(); }} />
      )}

      {/* Workflow flyout — params (edits → Publish, a new version), claims
          (the contract + evidence), automations (schedules — metadata, never
          a version), and delete at the bottom. */}
      {panel === "workflow" && selectedWf && activeTab && (
        <WorkflowFlyout
          key={selectedWf}
          workflow={selectedWf}
          tab={activeTab}
          tabs={workflowTabs}
          apps={apps.filter((a) => a.grants.workflows.includes(selectedWf) || a.grants.automations.includes(selectedWf)).map((a) => ({ name: a.name, title: a.title }))}
          onOpenApp={selectApp}
          onOpenPackages={() => setShowPackages(true)}
          catalogEpoch={catalogEpoch}
          onTab={setWfTab}
          onClose={() => setPanel(null)}
          onDelete={handleDeleteWorkflow}
          params={localParams ?? {}}
          onParamsChange={setLocalParams}
          onParamsValidChange={setParamsValid}
          onPublish={handlePublish}
          claims={wfClaims}
          onClaimsLoaded={setWfClaims}
          onOpenRun={openRunFromClaim}
          automations={selectedEntry?.automations ?? []}
          loadBindings={loadInputBindings}
          // A change may be a schedule (sidebar badge) or a "Run now" (a new run).
          onAutomationsChanged={() => { void refreshWorkflows(); void refreshRuns(selectedWf); }}
          viewVersion={viewVersion}
          onViewVersion={(v) => { setViewVersion(v); closeFlyout(); }}
          onActivateVersion={handleActivateVersion}
          dirty={isDirty}
          runs={runs}
        />
      )}

      {/* An app's Usage: what its pages cost the server (src/apps/monitor.ts).
          A warning handed to the builder is a draft, sent by the person. */}
      {panel === "usage" && appOpen && appEntry && (
        <AppUsageFlyout
          key={appKey(appEntry)}
          app={{ name: appEntry.name, title: appEntry.title, version: appEntry.activeVersion, ...(appEntry.peer ? { peer: appEntry.peer } : {}) }}
          onClose={() => setPanel(null)}
          {...(appEntry.peer ? {} : {
            onFix: (w: api.AppWarning) => {
              setPanel(null);
              setShowChat(true);
              setChatDraft({
                text: `The app "${appEntry.name}" (${w.version}) is costing the server too much: ${w.message}.${w.example ? ` Last such call's config: ${w.example}.` : ""} ${w.fix} Fix the app and publish it.`,
                id: Date.now(),
              });
            },
          })}
        />
      )}

      {/* Promote flyout — review + apply a run's declared promotions. */}
      {panel === "promote" && selectedWf && selectedRun && promotions.length > 0 && (
        <PromoteFlyout
          key={`${selectedWf}/${selectedRun}`}
          workflow={selectedWf}
          runId={selectedRun}
          promotions={promotions}
          onClose={() => setPanel(null)}
          onPromoted={() => { refreshWorkflows(); }}
        />
      )}

      {/* Step flyout — operates on the current view (root or drilled child) */}
      {flyoutStepId != null && viewSteps && flyoutStepIndex != null && (() => {
        const step = viewSteps[flyoutStepIndex];
        if (!step) return null;

        if (isRunView && flyoutEvents) {
          // "Re-run from here" needs the step's TRUE event path (drilled views
          // are re-keyed), and only applies to a run that isn't live.
          const truePath = `${runDrill.length > 0 ? framePrefix(runDrill[runDrill.length - 1]!) : (selectedWf ?? "")}/${flyoutStepId}`;
          return (
            <StepRunFlyout
              step={step}
              events={flyoutEvents}
              onClose={closeFlyout}
              {...(!runIsLive && (runIsResumable || runControlStatus === "success")
                ? { onRerunFrom: () => handleRerunFrom(truePath) }
                : {})}
            />
          );
        }
        // Editing only applies at the root (drilled views are read-only run views).
        if (drill || !localSteps) return null;
        return (
          <StepEditFlyout
            step={step}
            allSteps={localSteps}
            onSave={(updated) => handleStepSave(flyoutStepIndex, updated)}
            onClose={closeFlyout}
            onOpenRun={openRunFromClaim}
          />
        );
      })()}
    </div>
  );
}
