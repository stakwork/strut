/** The hooks (plans/apps.md §3.2): react-query over the `StrutClient`, each
 *  naming a STEP TYPE of the §5 `run/*` family — so the model never writes
 *  `postMessage`, and nothing launches a run but a call to `launch`. */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  useMutation, useQuery, useQueryClient,
  type QueryKey, type UseQueryResult,
} from "@tanstack/react-query";
import type { AppIdentity, StrutClient } from "./client.js";
import type { DisplayMode, HostState, Theme } from "./host.js";
import { appLink, type AppLinkInput } from "./links.js";
import { useStrutClient, useStrutHost } from "./provider.js";

/** The run steps the hooks call (§5). */
export const RUN_STEPS = {
  list: "run/list",
  get: "run/get",
  events: "run/events",
  transcript: "run/transcript",
  launch: "run/launch",
  cancel: "run/cancel",
  workflow: "run/workflow",
} as const;

/** How often a `live` query refetches while something it shows is in flight. */
export const LIVE_INTERVAL_MS = 2_000;
/** How long `run/get { wait }` may hold for a single live run before answering. */
export const RUN_WAIT_MS = 20_000;

/** A run summary as `run/list` and `run/get` return it (the server's
 *  `RunSummary`; an in-flight run has no `finishedAt`). */
export interface RunSummary {
  runId: string;
  workflow: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: { message: string; stack?: string };
  automation?: { id: string };
  job?: string;
  actor?: string;
  origin?: string;
  artifacts?: unknown[];
  [k: string]: unknown;
}

export interface RunEvent {
  type: string;
  path?: string;
  ts?: string;
  [k: string]: unknown;
}

/** What `run/transcript` returns (the server's `RunTranscript`): one
 *  agent's session as stored — AI SDK model messages — capped, with what
 *  the cap cut. */
export interface RunTranscript {
  path: string;
  messages: Array<{ role: string; content: unknown }>;
  /** `full` stitched a session turn's whole thread. */
  full?: true;
  truncated?: {
    /** The whole transcript's size, in JSON chars. */
    chars: number;
    /** Strings cut to their head and tail, and the length each was cut to. */
    strings: number;
    stringMax: number;
    /** `count` messages left out before index `at`. */
    messages?: { at: number; count: number };
  };
}

/** What `run/workflow` returns: the workflow's description, active version,
 *  `input:` block and params defaults. */
export interface WorkflowInfo {
  name: string;
  description?: string;
  activeVersion?: string;
  input?: Record<string, unknown>;
  params?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface LaunchResult {
  runId: string;
  /** `run/launch { key }` found a run of this workflow in flight under the same key. */
  existing?: boolean;
}

const TERMINAL = new Set(["success", "error", "cancelled"]);

/** A run is in flight until its status is terminal. */
export function isInFlight(run: Pick<RunSummary, "status"> | undefined | null): boolean {
  return !!run && !TERMINAL.has(run.status);
}

export function anyInFlight(runs: ReadonlyArray<Pick<RunSummary, "status">> | undefined): boolean {
  return !!runs?.some(isInFlight);
}

/** A run's log is settled once its terminal event is in it. */
export function eventsSettled(events: ReadonlyArray<Pick<RunEvent, "type">> | undefined): boolean {
  return !!events?.some((e) => e.type === "run.end" || e.type === "run.error");
}

/** Query keys, so a component can invalidate what the hooks hold. */
export const runKeys = {
  all: ["strut"] as const,
  list: (workflow: string, filter?: Record<string, unknown>) => ["strut", RUN_STEPS.list, workflow, filter ?? {}] as const,
  lists: (workflow: string) => ["strut", RUN_STEPS.list, workflow] as const,
  run: (workflow: string, runId: string) => ["strut", RUN_STEPS.get, workflow, runId] as const,
  events: (workflow: string, runId: string) => ["strut", RUN_STEPS.events, workflow, runId] as const,
  transcript: (workflow: string, runId: string, path: string, full = false) => ["strut", RUN_STEPS.transcript, workflow, runId, path, full] as const,
  workflow: (workflow: string) => ["strut", RUN_STEPS.workflow, workflow] as const,
};

/** Drop undefined values, so the config strut sees is only what was asked. */
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

export interface UseRunsOptions {
  status?: string;
  automation?: string;
  job?: string;
  limit?: number;
  since?: string;
  /** Refetch every `LIVE_INTERVAL_MS` while a listed run is in flight. */
  live?: boolean;
  enabled?: boolean;
}

/** `run/list`: a workflow's runs, newest first. `null` with a `job`: the
 *  job's runs across every workflow it ran. */
export function useRuns(workflow: string | null, opts: UseRunsOptions = {}): UseQueryResult<RunSummary[]> {
  const client = useStrutClient();
  const { live, enabled, ...filter } = opts;
  const config = compact({ ...(workflow ? { workflow } : {}), ...filter });
  return useQuery({
    queryKey: runKeys.list(workflow ?? "", compact(filter)),
    queryFn: () => client.run<RunSummary[]>(RUN_STEPS.list, config),
    enabled: (enabled ?? true) && (!!workflow || !!filter.job),
    refetchInterval: live ? (q) => (anyInFlight(q.state.data) ? LIVE_INTERVAL_MS : false) : false,
  });
}

export interface UseRunOptions {
  /** Long-poll with `run/get { wait }` while the run is in flight, and refetch
   *  when it answers still in flight. */
  live?: boolean;
  enabled?: boolean;
}

/** `run/get`: one run — the summary, its whole `input` and `output`, its
 *  resolved artifacts. */
export function useRun(workflow: string, runId: string | undefined, opts: UseRunOptions = {}): UseQueryResult<RunSummary> {
  const client = useStrutClient();
  const qc = useQueryClient();
  const key: QueryKey = runKeys.run(workflow, runId ?? "");
  return useQuery({
    queryKey: key,
    queryFn: () => {
      const prev = qc.getQueryData<RunSummary>(key);
      const wait = opts.live && isInFlight(prev) ? RUN_WAIT_MS : undefined;
      return client.run<RunSummary>(RUN_STEPS.get, compact({ workflow, runId, wait }));
    },
    enabled: (opts.enabled ?? true) && !!workflow && !!runId,
    refetchInterval: opts.live ? (q) => (isInFlight(q.state.data) ? LIVE_INTERVAL_MS : false) : false,
  });
}

export interface UseRunEventsOptions {
  /** Refetch while the log has no terminal event. */
  live?: boolean;
  enabled?: boolean;
}

/** `run/events`: a run's event log (transcripts as links). */
export function useRunEvents(workflow: string, runId: string | undefined, opts: UseRunEventsOptions = {}): UseQueryResult<RunEvent[]> {
  const client = useStrutClient();
  return useQuery({
    queryKey: runKeys.events(workflow, runId ?? ""),
    queryFn: () => client.run<RunEvent[]>(RUN_STEPS.events, compact({ workflow, runId })),
    enabled: (opts.enabled ?? true) && !!workflow && !!runId,
    refetchInterval: opts.live ? (q) => (eventsSettled(q.state.data) ? false : LIVE_INTERVAL_MS) : false,
  });
}

export interface UseTranscriptOptions {
  /** A session turn: the whole thread up to it, not just the turn. */
  full?: boolean;
  enabled?: boolean;
}

/** `run/transcript`: one agent's transcript by its step path — what the
 *  `transcript` link on a `step.end` in `run/events` points at, which a page
 *  cannot follow. Written once, when the step ends, so never refetched. */
export function useTranscript(workflow: string, runId: string | undefined, path: string | undefined, opts: UseTranscriptOptions = {}): UseQueryResult<RunTranscript> {
  const client = useStrutClient();
  return useQuery({
    queryKey: runKeys.transcript(workflow, runId ?? "", path ?? "", !!opts.full),
    queryFn: () => client.run<RunTranscript>(RUN_STEPS.transcript, compact({ workflow, runId, path, full: opts.full || undefined })),
    enabled: (opts.enabled ?? true) && !!workflow && !!runId && !!path,
    staleTime: Infinity,
  });
}

/** `run/workflow`: the description, the active version, the `input:` block,
 *  the params defaults — what a launch form renders. */
export function useWorkflow(workflow: string, opts: { enabled?: boolean } = {}): UseQueryResult<WorkflowInfo> {
  const client = useStrutClient();
  return useQuery({
    queryKey: runKeys.workflow(workflow),
    queryFn: () => client.run<WorkflowInfo>(RUN_STEPS.workflow, { workflow }),
    enabled: (opts.enabled ?? true) && !!workflow,
    staleTime: 60_000,
  });
}

export interface UseLaunch {
  /** Launch a run of the workflow (`run/launch`). `key` dedupes in flight:
   *  a second launch under the same key returns the running run (§5.1). */
  launch: (input?: unknown, params?: Record<string, unknown>, key?: string) => Promise<LaunchResult>;
  pending: boolean;
  error: Error | null;
  /** The last launch's result. */
  data: LaunchResult | undefined;
  reset: () => void;
}

/** A MUTATION and nothing else (§5.1): a function to call, never a query —
 *  so no render, refetch or poll launches a run; a click does. */
export function useLaunch(workflow: string): UseLaunch {
  const client = useStrutClient();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (v: { input?: unknown; params?: Record<string, unknown>; key?: string }) =>
      client.run<LaunchResult>(RUN_STEPS.launch, compact({ workflow, input: v.input, params: v.params, key: v.key })),
    onSuccess: () => qc.invalidateQueries({ queryKey: runKeys.lists(workflow) }),
  });
  const launch = useCallback(
    (input?: unknown, params?: Record<string, unknown>, key?: string) => m.mutateAsync({ input, params, key }),
    [m.mutateAsync],
  );
  return { launch, pending: m.isPending, error: m.error, data: m.data, reset: m.reset };
}

export interface UseCancel {
  cancel: (workflow: string, runId: string) => Promise<unknown>;
  pending: boolean;
  error: Error | null;
}

/** `run/cancel`, a mutation. */
export function useCancel(): UseCancel {
  const client = useStrutClient();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (v: { workflow: string; runId: string; force?: boolean }) =>
      client.run(RUN_STEPS.cancel, { workflow: v.workflow, runId: v.runId, ...(v.force ? { force: true } : {}) }),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: runKeys.lists(v.workflow) });
      void qc.invalidateQueries({ queryKey: runKeys.run(v.workflow, v.runId) });
    },
  });
  const cancel = useCallback((workflow: string, runId: string, force?: boolean) => m.mutateAsync({ workflow, runId, force }), [m.mutateAsync]);
  return { cancel, pending: m.isPending, error: m.error };
}

export interface UseStep<T> {
  /** Run the step with this config (its fields) and input (its template scope). */
  run: (config?: Record<string, unknown>, input?: unknown) => Promise<T>;
  pending: boolean;
  error: Error | null;
  data: T | undefined;
  reset: () => void;
}

/** Any granted step as a function — a tool call in the viewer's name (§5.1). */
export function useStep<T = unknown>(type: string): UseStep<T> {
  const client = useStrutClient();
  const m = useMutation({
    mutationFn: (v: { config?: Record<string, unknown>; input?: unknown }) => client.run<T>(type, v.config, v.input),
  });
  const run = useCallback((config?: Record<string, unknown>, input?: unknown) => m.mutateAsync({ config, input }), [m.mutateAsync]);
  return { run, pending: m.isPending, error: m.error, data: m.data, reset: m.reset };
}

function useHostState(): HostState {
  const host = useStrutHost();
  return useSyncExternalStore(host.subscribe, host.getState, host.getState);
}

/** Which app this page is (plans/apps.md §7.2), off its identity: the
 *  workspace app `{ name, version }`. Undefined under a host's own client. */
export function useApp(): AppIdentity | undefined {
  return useStrutClient().app;
}

/** What the model or a link opened the app with (`ui/notifications/tool-input`,
 *  the bridge): `{ view?, runId?, … }`, undefined until one arrives. A
 *  link's values are strings (`appLink`). */
export function useToolInput<T extends Record<string, unknown> = Record<string, unknown>>(): T | undefined {
  return useHostState().toolInput as T | undefined;
}

/** Links to THIS app opened with an input (`appLink`, off the page's
 *  identity): `openLink(link({ view: "/runs" }))` shows that view, with the
 *  host's address bar following where it has one, so the person can share
 *  it. Under a host's own client (no identity) the link throws: pass the
 *  name to `appLink` there. */
export function useAppLink(): (input?: AppLinkInput) => string {
  const app = useApp();
  return useCallback(
    (input?: AppLinkInput) => {
      if (!app) throw new Error("useAppLink: this page has no app identity — use appLink(name, input)");
      return appLink(app.name, input);
    },
    [app?.name],
  );
}

export interface UseHost {
  connected: boolean;
  theme: Theme;
  displayMode: DisplayMode;
  availableDisplayModes: DisplayMode[];
  locale?: string;
  timeZone?: string;
  /** A message to the host's conversation (`ui/message`). */
  sendMessage: (text: string) => Promise<void>;
  /** A link the host opens (`ui/open-link`): a strut deep link in strut's UI,
   *  anything else in a new tab (§7.1). */
  openLink: (url: string) => Promise<void>;
  requestDisplayMode: (mode: DisplayMode) => Promise<DisplayMode>;
}

/** The host behind the page: theme, display mode, locale, and the two
 *  requests the page may make of it. */
export function useHost(): UseHost {
  const host = useStrutHost();
  const s = useHostState();
  return useMemo(
    () => ({
      connected: s.connected,
      theme: s.theme,
      displayMode: s.displayMode,
      availableDisplayModes: s.availableDisplayModes,
      locale: s.locale,
      timeZone: s.timeZone,
      sendMessage: (text: string) => host.sendMessage(text),
      openLink: (url: string) => host.openLink(url),
      requestDisplayMode: (mode: DisplayMode) => host.requestDisplayMode(mode),
    }),
    [host, s],
  );
}

export type { StrutClient };
