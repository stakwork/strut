/**
 * RUNS as a capability (plans/apps.md §5): what the `run/*` lib steps are
 * thin over — list, read, launch and cancel runs, read a workflow's
 * contract, one of a run's files and one of its agents' transcripts — the
 * same layers the HTTP routes call (`GET …/runs`, `GET …/runs/:runId`,
 * `…/events`, `…/artifacts`, `…/transcripts/<path>`, `POST …/run`,
 * `…/cancel`), one implementation. `createStrut` builds it into
 * `ctx.services.runs` (the launcher, the controllers and the artifact
 * resolver live there); this module is the contract and the pure parts: the
 * list filter, the event cap, the file result, the transcript cap.
 *
 * Unsealed, unlike the `meta/*` twins (EVOLVE_SPEC §6): grantable to an
 * agent as `agentTools: ["run/*"]`, and what an APP reaches through
 * `step_run` on its `grants.workflows` — the kit's `useRuns`, `useRun`,
 * `useRunEvents`, `useTranscript`, `useLaunch`, `useCancel` and
 * `useWorkflow` name these steps (kit/src/hooks.ts). A sealed workflow (a
 * grading harness) is still refused by name: the steps are a model's door.
 */
import type { AppRef, McpServer, PeerOpen, RunEvent, RunSummary } from "./core.js";
import type { ArtifactRef } from "./artifact-refs.js";
import { slimEvent } from "./run-step.js";
import type { PartialRunSummary } from "./store.js";

/** `run/list`'s filter: one workflow's runs, or — `job` alone — a job's
 *  runs across every workflow it ran (its record's run lines). */
export interface RunListQuery {
  workflow?: string;
  /** Newest first; default 50, at most 500. */
  limit?: number;
  /** `success | error | cancelled`, or a live state (`running`, `paused`). */
  status?: string;
  /** Runs started at or after this moment (ISO, or ms since the epoch). */
  since?: string | number;
  /** Runs an automation fired, by its id. */
  automation?: string;
  /** Runs launched under a job. */
  job?: string;
}

/** One row of `run/list`: the summary without its payloads (`input`,
 *  `output`, `stepCounts` — `run/get` has them), plus the resolved
 *  deliverables, so a list draws a run's status, cost and links alone. */
export type RunListEntry = Omit<RunSummary, "input" | "output" | "stepCounts"> & {
  artifacts?: ArtifactRef[];
};

/** What `run/get` returns: the summary, whole, with its deliverables
 *  resolved; a run still in flight comes as the partial summary its log
 *  gives (`partial: true`, store.ts) with a live `status`. */
export type RunGetResult = (RunSummary | PartialRunSummary) & { artifacts?: ArtifactRef[] };

export interface RunLaunchQuery {
  workflow: string;
  input?: unknown;
  params?: Record<string, unknown>;
  /** Launch under a job (`POST …/run { job }`); `title` names it. */
  job?: string;
  title?: string;
  /** Dedupe in flight (§5.1): a run of this workflow launched under the
   *  same key and still running is returned instead of a second launch. */
  key?: string;
}

/** Who is launching, and for what — from the calling step's context. */
export interface RunLaunchBy {
  actor?: string;
  principal?: string;
  /** The app the launch is for (`ctx.app`): the run records it and
   *  `origin: "app"`. */
  app?: AppRef;
  /** The caller's MCP servers, handed on (`ctx.mcp`). */
  mcp?: McpServer[];
}

export interface RunLaunchResult {
  runId: string;
  /** The in-flight run launched under the same `key` (§5.1): nothing new ran. */
  existing?: true;
}

export interface WorkflowInfo {
  name: string;
  description?: string;
  category?: string;
  activeVersion?: string;
  /** The workflow's `input:` block, when it declares one. */
  input?: Record<string, unknown>;
  /** The `params` defaults. */
  params?: Record<string, unknown>;
  sealed?: true;
  peer?: PeerOpen;
}

/** One file of a run (`run/files`): text as text, anything else as base64,
 *  capped — a page cannot fetch a URL (§9), so the bytes come through the
 *  tool. */
export interface RunFile {
  path: string;
  mediaType: string;
  /** The file's size on disk. */
  bytes: number;
  text?: string;
  base64?: string;
  /** The content was cut at the cap (`RUN_FILE_MAX_BYTES`). */
  truncated?: true;
}

/** One agent's transcript (`run/transcript`): what `GET
 *  …/runs/:runId/transcripts/<path>` serves — the `messages` of that path's
 *  last `step.end` (AI SDK model messages: system, user, assistant, tool) —
 *  capped, since a page cannot follow the link the run log hands out. */
export interface RunTranscript {
  path: string;
  messages: Array<{ role: string; content: unknown }>;
  /** `full` stitched a session turn's thread from the session store (the
   *  route's `?full=1`): the system prompt, every earlier turn, this one. */
  full?: true;
  /** What the cap (`RUN_TRANSCRIPT_MAX_CHARS`) cut: absent when nothing was. */
  truncated?: TranscriptCut;
}

/** What `capTranscript` cut, so a reader can say so. */
export interface TranscriptCut {
  /** The whole transcript's size, in JSON chars. */
  chars: number;
  /** How many strings (tool results, file contents, long prompts) were cut
   *  to their head and tail, and the length each was cut to. */
  strings: number;
  stringMax: number;
  /** Messages left out of the middle: `count` of them, before index `at` of
   *  what came back — when the cut strings were not enough. */
  messages?: { at: number; count: number };
}

/** Every method refuses a SEALED workflow (a grading harness) by name —
 *  these are a model's door, as the meta/* twins are (EVOLVE_SPEC §6). */
export interface RunsCapability {
  list(q: RunListQuery): Promise<RunListEntry[]>;
  /** `wait` holds the call up to that many ms (at most `RUN_GET_MAX_WAIT_MS`)
   *  while the run is in flight, then answers with whatever it is. Null for a
   *  run that does not exist. */
  get(q: { workflow: string; runId: string; wait?: number }): Promise<RunGetResult | null>;
  /** The log from `skip` on, transcripts as links, capped (`capEvents`). */
  events(q: { workflow: string; runId: string; skip?: number }): Promise<RunEvent[]>;
  launch(q: RunLaunchQuery, by: RunLaunchBy): Promise<RunLaunchResult>;
  cancel(q: { workflow: string; runId: string }): Promise<{ ok: true; runId: string; state: string } | { ok: false; error: string }>;
  workflow(q: { workflow: string }): Promise<WorkflowInfo>;
  /** Null when the run or the file is not there. */
  files(q: { workflow: string; runId: string; path: string }): Promise<RunFile | null>;
  /** One agent's transcript by step path (`wf/review`, a sub-agent's
   *  `wf/review/003-agent`), capped (`capTranscript`). Throws what the route
   *  answers 404 with: no transcript at the path, or (`full`) a session gone. */
  transcript(q: { workflow: string; runId: string; path: string; full?: boolean }): Promise<RunTranscript>;
}

/** The most `run/get { wait }` may hold: under a client's request timeout,
 *  and the kit asks for 20 s. */
export const RUN_GET_MAX_WAIT_MS = 55_000;
export const RUN_LIST_DEFAULT_LIMIT = 50;
export const RUN_LIST_MAX_LIMIT = 500;
/** `run/events` keeps this many events: the head, plus the terminal event
 *  when the log has one — so a cut log still reads as settled (the kit's
 *  `eventsSettled`); `skip` pages past the cut. */
export const RUN_EVENTS_MAX = 5_000;
/** `run/files`: the most of a file that comes through (text or base64). */
export const RUN_FILE_MAX_BYTES = 2 * 1024 * 1024;
/** `run/transcript`: the most of a transcript that comes through, in JSON chars. */
export const RUN_TRANSCRIPT_MAX_CHARS = 2 * 1024 * 1024;
/** The lengths `capTranscript` cuts long strings to, in turn, before it
 *  leaves messages out. */
const TRANSCRIPT_STRING_LEVELS = [65_536, 16_384, 4_096];

export function requireRuns(services: unknown): RunsCapability {
  const runs = (services as { runs?: RunsCapability } | undefined)?.runs;
  if (!runs) {
    throw new Error(
      "run/* steps need the runs capability (ctx.services.runs). " +
        "The standard strut server provides it; an embedder builds one over its own launcher.",
    );
  }
  return runs;
}

/** `since` as ms since the epoch, or undefined for nothing usable. */
export function sinceMs(since: string | number | undefined): number | undefined {
  if (since === undefined || since === null || since === "") return undefined;
  const ms = typeof since === "number" ? since : /^\d+$/.test(since) ? Number(since) : Date.parse(since);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Does a run (its summary, or a live row) pass the list filter? The
 *  workflow and the limit are the caller's. */
export function matchesRunFilter(run: Partial<RunSummary> & { runId: string; status: string }, q: Omit<RunListQuery, "workflow" | "limit">): boolean {
  if (q.status && run.status !== q.status) return false;
  if (q.automation && run.automation?.id !== q.automation) return false;
  if (q.job && run.job !== q.job) return false;
  const from = sinceMs(q.since);
  if (from !== undefined) {
    // A run id is its launch moment (ms); the summary's startedAt agrees.
    const started = run.startedAt ? Date.parse(run.startedAt) : Number(run.runId);
    if (Number.isFinite(started) && started < from) return false;
  }
  return true;
}

/** A summary as a list row: its payloads dropped. */
export function listEntryOf(summary: RunSummary): RunListEntry {
  const { input: _i, output: _o, stepCounts: _s, ...rest } = summary;
  return rest;
}

/** The log from `skip` on, each event slimmed (`slimEvent`: a string field
 *  over 64 KB replaced by its size), cut at `RUN_EVENTS_MAX` keeping the
 *  head and the last event — the terminal one, when the log has it. */
export function capEvents(events: RunEvent[], skip = 0, max = RUN_EVENTS_MAX): RunEvent[] {
  const rest = events.slice(Math.max(0, skip)).map(slimEvent);
  if (rest.length <= max) return rest;
  return [...rest.slice(0, max - 1), rest[rest.length - 1]!];
}

const CONTENT_TYPES: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", html: "text/html", htm: "text/html", css: "text/css",
  js: "text/javascript", mjs: "text/javascript", ts: "text/typescript", tsx: "text/typescript", jsx: "text/javascript",
  json: "application/json", yaml: "text/yaml", yml: "text/yaml", xml: "application/xml", svg: "image/svg+xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", pdf: "application/pdf",
  log: "text/plain", diff: "text/plain", patch: "text/plain", sql: "text/plain", py: "text/plain", sh: "text/plain",
};

/** The media type a path's extension says; octet-stream otherwise. */
export function mediaTypeOf(path: string): string {
  const file = path.split("/").pop() ?? "";
  const dot = file.lastIndexOf(".");
  return (dot > 0 && CONTENT_TYPES[file.slice(dot + 1).toLowerCase()]) || "application/octet-stream";
}

/** Text or bytes? A NUL byte in the first 8 KB says bytes (git's own test). */
export function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

/** A file's bytes as `run/files` returns them: UTF-8 text when it reads as
 *  text, base64 otherwise, cut at `max` bytes. */
export function fileResult(path: string, bytes: Uint8Array, max = RUN_FILE_MAX_BYTES): RunFile {
  const cut = bytes.byteLength > max;
  const head = cut ? bytes.subarray(0, max) : bytes;
  const out: RunFile = { path, mediaType: mediaTypeOf(path), bytes: bytes.byteLength };
  if (isBinary(head)) out.base64 = Buffer.from(head).toString("base64");
  else out.text = Buffer.from(head).toString("utf8");
  if (cut) out.truncated = true;
  return out;
}

type TranscriptMessage = RunTranscript["messages"][number];

/** Every string in `v` over `max` chars cut to its head and tail, with how
 *  much went; `count.n` counts the cuts. */
function cutStrings(v: unknown, max: number, count: { n: number }): unknown {
  if (typeof v === "string") {
    if (v.length <= max) return v;
    count.n++;
    const half = Math.floor(max / 2);
    return `${v.slice(0, half)}\n…[${v.length - 2 * half} chars cut]…\n${v.slice(v.length - half)}`;
  }
  if (Array.isArray(v)) return v.map((x) => cutStrings(x, max, count));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = cutStrings(x, max, count);
    return out;
  }
  return v;
}

/**
 * A transcript as `run/transcript` returns it: whole when its JSON is within
 * `max` chars; else every string over a length (64k, then 16k, then 4k
 * chars) cut to its head and tail, and — when that is not enough — messages
 * left out of the middle: the head through the first user message (the
 * system prompt, the task) stays, then as many of the newest as fit, never
 * starting on a tool result whose call was left out. `truncated` says what
 * went.
 */
export function capTranscript(messages: TranscriptMessage[], max = RUN_TRANSCRIPT_MAX_CHARS): Pick<RunTranscript, "messages" | "truncated"> {
  const chars = JSON.stringify(messages).length;
  if (chars <= max) return { messages };
  let cut: TranscriptMessage[] = messages;
  let counts: number[] = [];
  let stringMax = 0;
  for (const level of TRANSCRIPT_STRING_LEVELS) {
    counts = [];
    cut = messages.map((m) => {
      const count = { n: 0 };
      const out = cutStrings(m, level, count) as TranscriptMessage;
      counts.push(count.n);
      return out;
    });
    stringMax = level;
    if (JSON.stringify(cut).length <= max) {
      return { messages: cut, truncated: { chars, strings: counts.reduce((a, b) => a + b, 0), stringMax } };
    }
  }
  const sizes = cut.map((m) => JSON.stringify(m).length + 1);
  const firstUser = cut.findIndex((m) => m.role === "user");
  const head = firstUser < 0 ? Math.min(1, cut.length) : firstUser + 1;
  let budget = max - 2 - sizes.slice(0, head).reduce((a, b) => a + b, 0);
  let from = cut.length;
  while (from > head && budget >= sizes[from - 1]!) budget -= sizes[--from]!;
  while (from < cut.length && cut[from]!.role === "tool") from++;
  const kept = [...counts.slice(0, head), ...counts.slice(from)];
  return {
    messages: [...cut.slice(0, head), ...cut.slice(from)],
    truncated: {
      chars,
      strings: kept.reduce((a, b) => a + b, 0),
      stringMax,
      ...(from > head ? { messages: { at: head, count: from - head } } : {}),
    },
  };
}
