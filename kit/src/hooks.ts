/** The hooks (plans/apps.md §3.2): react-query over the `StrutClient`, each
 *  naming a STEP TYPE of the §5 `run/*` family — so the model never writes
 *  `postMessage`, and nothing launches a run but a call to `launch`. */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  useMutation, useQueries, useQuery, useQueryClient,
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
   *  a second launch under the same key returns the running run (§5.1).
   *  `files` go with the run as its attachments — saved under its
   *  artifacts as `attachments/<name>`, on each agent's prompt; for files
   *  that outlive the run, `useUpload` into a job. */
  launch: (input?: unknown, params?: Record<string, unknown>, key?: string, files?: readonly File[]) => Promise<LaunchResult>;
  pending: boolean;
  error: Error | null;
  /** The last launch's result. */
  data: LaunchResult | undefined;
  reset: () => void;
}

export interface UseLaunchOptions {
  /** Launch every run under this job — the app's (plans/apps.md §12: a page
   *  names `library`, strut keeps `app/<name>/library`), where `useUpload`
   *  puts files and an agent on `session: "{{ $job }}"` keeps its thread. */
  job?: string;
  /** With `job`: the job's title. */
  title?: string;
}

/** A MUTATION and nothing else (§5.1): a function to call, never a query —
 *  so no render, refetch or poll launches a run; a click does. */
export function useLaunch(workflow: string, opts: UseLaunchOptions = {}): UseLaunch {
  const client = useStrutClient();
  const qc = useQueryClient();
  const { job, title } = opts;
  const m = useMutation({
    mutationFn: async (v: { input?: unknown; params?: Record<string, unknown>; key?: string; files?: readonly File[] }) => {
      const attachments = v.files?.length ? await Promise.all(v.files.map(fileData)) : undefined;
      return client.run<LaunchResult>(
        RUN_STEPS.launch,
        compact({ workflow, input: v.input, params: v.params, key: v.key, job, title: job ? title : undefined, attachments }),
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: runKeys.lists(workflow) }),
  });
  const launch = useCallback(
    (input?: unknown, params?: Record<string, unknown>, key?: string, files?: readonly File[]) => m.mutateAsync({ input, params, key, files }),
    [m.mutateAsync],
  );
  return { launch, pending: m.isPending, error: m.error, data: m.data, reset: m.reset };
}

/** The ASSISTANT a page talks to: the workspace's `orchestrator`, the same
 *  assistant the person has in their host's chat, granted to the app by a
 *  person (app/grant) and named in app.yaml's grants.workflows. */
export const ASSISTANT_WORKFLOW = "orchestrator";

/** One message of a chat with the assistant: the viewer's, or its reply. */
export interface AssistantMessage {
  role: "user" | "assistant";
  /** The run the turn is (one per message the viewer sent). */
  runId: string;
  text: string;
  /** The reply's deliverables (a job's, by its link), as the assistant gave them. */
  artifacts?: unknown[];
  /** A question the assistant needs answered before it goes on; the answer is the next `send`. */
  ask?: { message: string };
  /** `pending` while the turn runs; `error` when it failed (the text says why). */
  status: "pending" | "done" | "error";
}

/** A job the latest turn started or continued: follow it with
 *  `useRun(workflow, runId, { live: true })` — its workflow (`job`, or
 *  `builder`) granted in app.yaml too. */
export interface AssistantJob {
  job: string;
  runId: string;
  /** The job-shaped workflow it runs, when the turn named one (a new job). */
  workflow?: string;
}

export interface UseAssistantOptions {
  /** The thread: the same name every visit keeps one conversation. Strut
   *  keeps it per app and per viewer, so another person's never mixes in.
   *  Default `assistant`. */
  thread?: string;
  /** How many earlier turns to read back (default 10, at most 20). */
  history?: number;
  /** Default `orchestrator`. */
  workflow?: string;
}

export interface UseAssistant {
  /** Oldest first: each turn's message and its reply. */
  messages: AssistantMessage[];
  /** Send the viewer's message (`run/launch`); the reply arrives in `messages`. */
  send: (text: string, files?: readonly File[]) => Promise<LaunchResult>;
  /** A turn is running. */
  pending: boolean;
  error: Error | null;
  /** The jobs the latest turn started or continued. */
  jobs: AssistantJob[];
}

interface AssistantInput { prompt?: unknown; session?: unknown }
interface AssistantOutput { text?: unknown; artifacts?: unknown; ask?: unknown }

function assistantMessages(run: RunSummary): AssistantMessage[] {
  const input = (run.input ?? {}) as AssistantInput;
  const out: AssistantMessage[] = [{ role: "user", runId: run.runId, text: typeof input.prompt === "string" ? input.prompt : "", status: "done" }];
  if (isInFlight(run)) return [...out, { role: "assistant", runId: run.runId, text: "", status: "pending" }];
  if (run.status !== "success") {
    return [...out, { role: "assistant", runId: run.runId, text: run.error?.message ?? `the turn ${run.status === "cancelled" ? "was cancelled" : "failed"}`, status: "error" }];
  }
  const o = (run.output ?? {}) as AssistantOutput;
  const ask = o.ask && typeof (o.ask as { message?: unknown }).message === "string" ? { message: (o.ask as { message: string }).message } : undefined;
  return [
    ...out,
    {
      role: "assistant",
      runId: run.runId,
      text: typeof o.text === "string" ? o.text : "",
      ...(Array.isArray(o.artifacts) && o.artifacts.length ? { artifacts: o.artifacts } : {}),
      ...(ask ? { ask } : {}),
      status: "done",
    },
  ];
}

/** An agent's tool call to `job/start` or `job/continue`, as its event
 *  names it: the tool is `job_start` (a tool name has no `/`), so the
 *  event's `stepType` is `tool:job_start`; the `/` forms are kept for a
 *  log from before. */
const JOB_TOOL = /^tool:job[_/](start|continue)$/;

/** A tool call's logged `output`: the run log keeps it as the JSON text the
 *  model was handed, an object only when a caller wrote one. */
function toolOutput(v: unknown): Record<string, unknown> | undefined {
  if (typeof v === "string") {
    try {
      const parsed: unknown = JSON.parse(v);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

/** The jobs a turn's log shows it started or continued (`job/start`,
 *  `job/continue` tool calls that came back with a job). */
export function assistantJobs(events: readonly RunEvent[] | undefined): AssistantJob[] {
  if (!events) return [];
  const starts = new Map<string, RunEvent>();
  for (const e of events) if (e.type === "step.start" && e.path) starts.set(e.path, e);
  const out: AssistantJob[] = [];
  for (const e of events) {
    const tool = e.type === "step.end" ? JOB_TOOL.exec(String(e["stepType"] ?? "")) : null;
    if (!tool) continue;
    const o = toolOutput(e["output"]);
    if (typeof o?.["job"] !== "string" || typeof o["runId"] !== "string") continue;
    const input = toolOutput(starts.get(e.path ?? "")?.["input"]);
    const started = tool[1] === "start" ? (input?.["workflow"] ?? "job") : undefined;
    out.push({ job: o["job"], runId: o["runId"], ...(typeof started === "string" ? { workflow: started } : {}) });
  }
  return out;
}

/**
 * A chat with the ASSISTANT (`orchestrator`) — the app's own conversation
 * with it, as the viewer, with no prompt at use: a person granted the app
 * this once (app/grant). One run per message (`run/launch`), the thread
 * kept by strut per app and viewer; the earlier turns read back with
 * `run/list` + `run/get` (one per turn, `history` of them). A mutation for
 * sending, queries for reading — nothing is sent but by `send`.
 */
export function useAssistant(opts: UseAssistantOptions = {}): UseAssistant {
  const workflow = opts.workflow ?? ASSISTANT_WORKFLOW;
  const thread = opts.thread ?? "assistant";
  const client = useStrutClient();
  const qc = useQueryClient();
  const history = Math.min(20, Math.max(1, opts.history ?? 10));
  const list = useRuns(workflow, { limit: history, live: true });
  const runs = list.data ?? [];
  const turns = useQueries({
    queries: runs.map((r) => ({
      queryKey: runKeys.run(workflow, r.runId),
      queryFn: () => client.run<RunSummary>(RUN_STEPS.get, compact({ workflow, runId: r.runId, wait: isInFlight(r) ? RUN_WAIT_MS : undefined })),
      // A settled turn never changes.
      staleTime: isInFlight(r) ? 0 : Infinity,
      refetchInterval: (q: { state: { data?: RunSummary } }) => (isInFlight(q.state.data ?? r) ? LIVE_INTERVAL_MS : false),
    })),
  });
  const mine = turns
    .map((t) => t.data)
    .filter((r): r is RunSummary => !!r && (r.input as AssistantInput | undefined)?.session === thread)
    .reverse();
  const latest = mine[mine.length - 1];
  const events = useRunEvents(workflow, latest?.runId, { live: true, enabled: !!latest });
  const m = useMutation({
    mutationFn: async (v: { text: string; files?: readonly File[] }) => {
      const attachments = v.files?.length ? await Promise.all(v.files.map(fileData)) : undefined;
      return client.run<LaunchResult>(RUN_STEPS.launch, compact({ workflow, input: { prompt: v.text, session: thread }, attachments }));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: runKeys.lists(workflow) }),
  });
  const send = useCallback((text: string, files?: readonly File[]) => m.mutateAsync({ text, files }), [m.mutateAsync]);
  const messages = useMemo(() => mine.flatMap(assistantMessages), [mine.map((r) => `${r.runId}:${r.status}`).join(",")]);
  return {
    messages,
    send,
    pending: m.isPending || mine.some(isInFlight),
    error: m.error ?? (list.error as Error | null),
    jobs: assistantJobs(events.data),
  };
}

/** The job steps the upload hook calls (plans/apps.md §12). */
export const JOB_STEPS = {
  upload: "job/upload",
  deleteUpload: "job/delete-upload",
  updates: "job/updates",
} as const;

/** The graph's change feed (plans/live-feeds.md §3). */
export const GRAPH_CHANGES_STEP = "graph/changes";

/** How long a live feed hook holds one call: under the server's 55 s, so a
 *  host that times a tool call out never sees one this long. */
export const FEED_WAIT_MS = 25_000;
/** After a failed read, the next waits this long. */
const FEED_RETRY_MS = 5_000;

/** A job's update as `job/updates` returns it (the `job.update` a host hears
 *  on its callback, specs/CALLBACKS.md §5). */
export interface JobUpdate {
  event: "job.update";
  job: string;
  at: string;
  runId?: string;
  /** image | walkthrough | a hold's kind | evidence | verify | proposal | status | graph | … */
  kind: string;
  url?: string;
  id?: string;
  title?: string;
  state?: string;
  detail?: Record<string, unknown>;
}

/** A graph write as `graph/changes` returns it. */
export interface GraphChange {
  kind: "node" | "edge";
  op: "created" | "updated" | "deleted";
  ref_id: string;
  at: string;
  node_type?: string;
  edge_type?: string;
  source?: string;
  target?: string;
  types?: string[];
}

interface FeedAnswer { cursor: string; reset?: true; more?: true }

const pageVisible = (): boolean => typeof document === "undefined" || document.visibilityState !== "hidden";

/** Resolves when the page is visible again (at once when it is). */
function whenVisible(stopped: () => boolean): Promise<void> {
  if (pageVisible() || typeof document === "undefined") return Promise.resolve();
  return new Promise((resolve) => {
    const on = () => {
      if (!pageVisible() && !stopped()) return;
      document.removeEventListener("visibilitychange", on);
      resolve();
    };
    document.addEventListener("visibilitychange", on);
  });
}

/**
 * One feed read after another, while mounted: each call hands back the
 * cursor the last returned and, when `live`, waits on the server for
 * something new — one call in flight, none while the page is hidden. The
 * server gathers a second before it answers, so this is at most a call a
 * second however fast things change.
 */
function useFeed<A extends FeedAnswer>(
  key: string | null,
  read: (since: string | undefined, wait: number | undefined) => Promise<A>,
  live: boolean,
  /** `first`: the answer to the hook's first read (the job's history, the graph's position). */
  apply: (answer: A, first: boolean) => void,
  first?: string,
): Error | null {
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (key === null) return;
    let stopped = false;
    let cursor = first;
    void (async () => {
      for (let n = 0; !stopped; n++) {
        try {
          const answer = await read(cursor, live && n > 0 ? FEED_WAIT_MS : undefined);
          if (stopped) return;
          cursor = answer.cursor;
          apply(answer, n === 0);
          setError(null);
          if (!live) return;
          if (answer.more) continue;
          await whenVisible(() => stopped);
        } catch (e) {
          if (stopped) return;
          setError(e instanceof Error ? e : new Error(String(e)));
          await new Promise((r) => setTimeout(r, FEED_RETRY_MS));
        }
      }
    })();
    return () => {
      stopped = true;
    };
    // `read` and `apply` are the caller's, made anew each render; the key says what is read.
  }, [key, live]);
  return error;
}

export interface UseJobUpdatesOptions {
  /** Keep reading as the job changes (default true). */
  live?: boolean;
  enabled?: boolean;
}

export interface UseJobUpdates {
  /** The newest state of each thing the job reported, in the order they last changed. */
  updates: JobUpdate[];
  /** The newest update of a kind (`latest("status")` is the job's current line). */
  latest: (kind: string) => JobUpdate | undefined;
  error: Error | null;
}

const updateKey = (u: Pick<JobUpdate, "kind" | "url" | "id">) => `${u.kind}\u0000${u.url ?? ""}\u0000${u.id ?? ""}`;

/**
 * A JOB's live updates (`job/updates`, plans/live-feeds.md §1): the shots,
 * frames, holds, verdicts, status lines and graph writes the job reports,
 * as they happen — what a host hears on its callback, for a page that has
 * none. The job is the app's (strut keeps a page's job ids in the app's
 * namespace), including the jobs its assistant starts (`useAssistant().jobs`).
 */
export function useJobUpdates(job: string | undefined, opts: UseJobUpdatesOptions = {}): UseJobUpdates {
  const client = useStrutClient();
  const live = opts.live ?? true;
  const [updates, setUpdates] = useState<JobUpdate[]>([]);
  const kept = useMemo(() => new Map<string, JobUpdate>(), [job]);
  const error = useFeed<FeedAnswer & { updates: JobUpdate[] }>(
    job && opts.enabled !== false ? job : null,
    (since, wait) => client.run(JOB_STEPS.updates, compact({ job, since, wait })),
    live,
    (answer, first) => {
      if (answer.reset) kept.clear();
      if (!first && !answer.reset && answer.updates.length === 0) return;
      for (const u of answer.updates) {
        const k = updateKey(u);
        kept.delete(k);
        kept.set(k, u);
      }
      setUpdates([...kept.values()]);
    },
  );
  const latest = useCallback(
    (kind: string) => {
      for (let i = updates.length - 1; i >= 0; i--) if (updates[i]!.kind === kind) return updates[i];
      return undefined;
    },
    [updates],
  );
  return { updates, latest, error };
}

export interface UseGraphChangesOptions {
  /** Keep reading as the graph changes (default true). */
  live?: boolean;
  enabled?: boolean;
}

export interface UseGraphChanges {
  /** Changes each time a write of those types lands (and when the server
   *  restarted, since then anything may have): put it in the dependencies
   *  of the reads that show those types. 0 until the first write. */
  rev: number;
  /** The writes the last change brought. */
  changes: GraphChange[];
  error: Error | null;
}

/**
 * The graph writes made through strut, from now on (`graph/changes`,
 * plans/live-feeds.md §3): a page that shows part of the graph reads it
 * again when that part changes — whoever wrote it. Ids and types only; the
 * page reads what changed with the reads it already makes. Grant
 * `graph/changes` in app.yaml.
 */
export function useGraphChanges(types: readonly string[] | undefined, opts: UseGraphChangesOptions = {}): UseGraphChanges {
  const client = useStrutClient();
  const live = opts.live ?? true;
  const [state, setState] = useState<{ rev: number; changes: GraphChange[] }>({ rev: 0, changes: [] });
  const list = types?.length ? [...types].sort() : undefined;
  const error = useFeed<FeedAnswer & { changes: GraphChange[] }>(
    opts.enabled === false ? null : JSON.stringify(list ?? null),
    (since, wait) => client.run(GRAPH_CHANGES_STEP, compact({ types: list, since, wait })),
    live,
    (answer) => {
      if (!answer.reset && answer.changes.length === 0) return;
      setState((s) => ({ rev: s.rev + 1, changes: answer.changes }));
    },
    // Only what is written from here: the page has just read what is.
    "now",
  );
  return { ...state, error };
}

/** A browser file as a step takes one: `{ name, mediaType, data }`, the
 *  bytes base64 — so a page never writes `FileReader` code. */
export async function fileData(file: File): Promise<{ name: string; mediaType?: string; data: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // In slices: one String.fromCharCode over megabytes overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { name: file.name, ...(file.type ? { mediaType: file.type } : {}), data: btoa(binary) };
}

/** What `job/upload` returns: `path` is relative to the job's folder —
 *  what a run launched under the job is handed in its `input`. */
export interface UploadResult {
  job: string;
  path: string;
  name: string;
  mediaType: string;
  size: number;
}

export interface UseUpload {
  /** Save a file into the job's `uploads/` (`job/upload`); a taken name is numbered. */
  upload: (file: File) => Promise<UploadResult>;
  /** Remove one by the `path` its upload returned (`job/delete-upload`). */
  remove: (path: string) => Promise<{ job: string; path: string; removed: boolean }>;
  pending: boolean;
  error: Error | null;
  /** The last upload's result. */
  data: UploadResult | undefined;
  reset: () => void;
}

/** Files into a JOB (plans/apps.md §12): the app's — a page names `library`,
 *  strut keeps `app/<name>/library` — so every run the page launches under
 *  it (`useLaunch(workflow, { job })`) and an agent on
 *  `session: "{{ $job }}"` find them at the same path. Mutations: nothing
 *  is sent until `upload` is called. */
export function useUpload(job: string): UseUpload {
  const client = useStrutClient();
  const up = useMutation({
    mutationFn: async (file: File) => client.run<UploadResult>(JOB_STEPS.upload, { job, ...(await fileData(file)) }),
  });
  const del = useMutation({
    mutationFn: (path: string) => client.run<{ job: string; path: string; removed: boolean }>(JOB_STEPS.deleteUpload, { job, path }),
  });
  const upload = useCallback((file: File) => up.mutateAsync(file), [up.mutateAsync]);
  const remove = useCallback((path: string) => del.mutateAsync(path), [del.mutateAsync]);
  return { upload, remove, pending: up.isPending || del.isPending, error: up.error ?? del.error, data: up.data, reset: up.reset };
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
