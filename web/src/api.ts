// Mount-path-agnostic API base. Derived at runtime from the app's own
// script URL so the UI works whether strut is served at the root (`/`) or
// under any sub-path (`/lab`, `/foo/bar`, …) — no build-time base needed.
// In a production build the bundle loads from `<mount>/assets/...`, so the
// prefix is everything before `/assets/`. In dev (vite) there is no
// `/assets/` segment, so the base is empty and the dev proxy handles it.
function deriveBase(): string {
  try {
    const path = new URL(import.meta.url).pathname;
    const m = path.match(/^(.*)\/assets\//);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

const BASE = deriveBase();

/** True for a run-artifact path as steps put it in their output —
 *  `/artifacts/<runId>/<relPath>` (see `ctx.services.artifacts`). */
export function isArtifactPath(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("/artifacts/");
}

/** Browser URL for an artifact path. Mount-path aware (works under `/lab`);
 *  the route is public, so a plain `<a href>` needs no key. */
export function artifactUrl(path: string): string {
  return `${BASE}${path}`;
}

// ── API key ────────────────────────────────────────────────────────────────
// When the server sets STRUT_API_KEY, gated routes need `Authorization:
// Bearer`. A host that spawns strut (desktop app) hands the per-launch key to
// the UI as `?key=` on first load; we stash it in sessionStorage and strip
// it from the URL. A user can also paste one in Settings (localStorage),
// for a server deployment. sessionStorage (this launch) wins.
const KEY_STORAGE = "strut/apiKey";

function captureKeyFromUrl(): void {
  try {
    const url = new URL(location.href);
    const key = url.searchParams.get("key");
    if (!key) return;
    sessionStorage.setItem(KEY_STORAGE, key);
    url.searchParams.delete("key");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  } catch {
    // no storage / no history API — the key just isn't remembered
  }
}
captureKeyFromUrl();

export function getApiKey(): string {
  try {
    return sessionStorage.getItem(KEY_STORAGE) || localStorage.getItem(KEY_STORAGE) || "";
  } catch {
    return "";
  }
}

/** Save a user-entered key (Settings). Empty clears it. */
export function setApiKey(key: string): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else {
      localStorage.removeItem(KEY_STORAGE);
      sessionStorage.removeItem(KEY_STORAGE);
    }
  } catch {}
}

/** Where the active key came from, for the Settings hint. */
export function apiKeySource(): "url" | "settings" | null {
  try {
    if (sessionStorage.getItem(KEY_STORAGE)) return "url";
    if (localStorage.getItem(KEY_STORAGE)) return "settings";
  } catch {}
  return null;
}

function authHeaders(): Record<string, string> {
  const key = getApiKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** `fetch` against the API base with the key attached. Every call goes
 *  through here so a gated deployment works without per-call plumbing. */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  for (const [k, v] of Object.entries(authHeaders())) if (!headers.has(k)) headers.set(k, v);
  return fetch(`${BASE}${path}`, { ...init, headers });
}

export async function fetchJSON<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await apiFetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {}
    throw new Error(`${path}: ${msg}`);
  }
  return res.json() as Promise<T>;
}

// ── Speech-to-text (src/audio) ─────────────────────────────────────────────

export interface SttModelStatus {
  id: string;
  bytes: number;
  language: string;
  /** How often partials change (ms). */
  chunkMs: number;
  /** Accepts a hotwords list. */
  hotwords: boolean;
  cased: boolean;
  description: string;
  installed: boolean;
  /** Which entry the server's env/default resolution picks. */
  default: "model" | "partialModel" | null;
}

export interface SttModelsResponse {
  /** Whether the sherpa addon loads on the server. */
  available: boolean;
  modelDir: string;
  models: SttModelStatus[];
}

export const listSttModels = () => fetchJSON<SttModelsResponse>("/audio/models");

export type SttDownloadProgress =
  | { phase: "download"; received: number; total: number }
  | { phase: "extract" }
  | { phase: "done" };

/** Download + verify + extract a catalog model on the server; SSE progress. */
export async function downloadSttModel(
  id: string,
  onProgress: (p: SttDownloadProgress) => void,
): Promise<void> {
  const res = await apiFetch(`/audio/models/${encodeURIComponent(id)}/download`, { method: "POST" });
  if (!res.ok || !res.body) throw new Error(`download ${id}: ${res.status} ${res.statusText}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let event = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        const data = JSON.parse(line.slice(5));
        if (event === "error") throw new Error(data.error ?? "download failed");
        onProgress(data as SttDownloadProgress);
      }
    }
  }
}

/** WebSocket URL for `/audio/stream` on the same origin + mount path. A
 *  browser WebSocket can't set headers, so the key rides as `?key=`. */
export function sttStreamUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${proto}//${location.host}${BASE}/audio/stream`);
  const key = getApiKey();
  if (key) url.searchParams.set("key", key);
  return url.toString();
}

// ── Workflows ──────────────────────────────────────────────────────────────

export interface WorkflowEntry {
  name: string;
  activeVersion: string;
  versions: string[];
  description?: string;
  /** Sidebar grouping label, if set. */
  category?: string;
  /** The owning actor and per-run LLM spend cap, if set
   *  (plans/mothership-cost-control.md). */
  owner?: string;
  maxRunCostUsd?: number;
  /** The workflow's schedules, if any — the sidebar's clock badge. */
  automations?: Automation[];
  /** Start time (epoch ms) of the most recent run, if any. */
  lastRunAt?: number;
}

export interface WorkflowMeta {
  active: string;
  versions: Record<string, { createdAt: string; description?: string }>;
}

export const listWorkflows = () => fetchJSON<WorkflowEntry[]>("/workflows");

export const getWorkflowMeta = (name: string) =>
  fetchJSON<WorkflowMeta>(`/workflows/${name}`);

export const getWorkflowCode = async (name: string, version: string) => {
  const res = await apiFetch(`/workflows/${name}/${version}`);
  return res.text();
};

export interface PromoteSpec {
  from: string;
  to: string;
  label?: string;
}

/** One field of a workflow's declared `input:` block, as written. */
export interface InputFieldDef {
  type: "string" | "number" | "boolean" | "json";
  /** Required unless it has a `default` or says `required: false`. */
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface FlowDef {
  name: string;
  steps: { id: string; type: string; config: Record<string, any>; options?: any }[];
  /** The declared `input:` block. Absent = any object is accepted. */
  input?: Record<string, InputFieldDef>;
  /** Tunable default knobs (prompts, thresholds, …), overridable per run. */
  params?: Record<string, unknown>;
  /** Declared "promote a run output → a target param default" mappings. */
  promotes?: PromoteSpec[];
}

/** Parsed flow of a workflow — the active version, or a pinned historical
 *  one when `version` is given (the version picker's data source). */
export const getWorkflowFlow = (name: string, version?: string) =>
  fetchJSON<FlowDef>(
    `/workflows/${name}/flow${version ? `?version=${encodeURIComponent(version)}` : ""}`,
  );

export interface CreateWorkflowResponse {
  ok: true;
  /** Final workflow name (may differ from `requested` if auto-suffixed). */
  workflow: string;
  version: string;
  active: string;
  renamed: boolean;
  requested: string;
}

/** Create a brand-new workflow at v1. Auto-suffixes the name on collision. */
export const createWorkflowYaml = (
  name: string,
  yamlStr: string,
  description?: string,
  category?: string,
) =>
  fetchJSON<CreateWorkflowResponse>(`/workflows`, {
    method: "POST",
    body: JSON.stringify({ name, yaml: yamlStr, description, category }),
  });

export interface WorkflowVersionStats {
  version: string;
  createdAt: string;
  description?: string;
  /** Finished runs that executed this version's content, by status. */
  runs: number;
  success: number;
  error: number;
  lastRunAt?: string;
}

/** Every version, newest first, with its run counts (the Versions tab).
 *  `unattributed` = finished runs that recorded no version hash. */
export const getWorkflowVersions = (name: string) =>
  fetchJSON<{ active: string; versions: WorkflowVersionStats[]; unattributed: number }>(`/workflows/${name}/versions`);

/** Make a stored version the active one — what Run, schedules and the
 *  canvas use. A rollback publishes nothing. */
export const setActiveWorkflowVersion = (name: string, version: string) =>
  fetchJSON<{ ok: boolean }>(`/workflows/${name}/active`, {
    method: "PUT",
    body: JSON.stringify({ version }),
  });

/** Set or clear a workflow's sidebar category (metadata-only, no new version). */
export const setWorkflowCategory = (name: string, category: string | null) =>
  fetchJSON<{ ok: boolean }>(`/workflows/${name}/category`, {
    method: "PUT",
    body: JSON.stringify({ category }),
  });

/** Set or clear a workflow's per-run LLM spend cap (metadata-only, no new
 *  version). Enforced only where spend routes through the Mothership. */
export const setWorkflowRunCap = (name: string, maxRunCostUsd: number | null) =>
  fetchJSON<{ ok: boolean }>(`/workflows/${name}/run-cap`, {
    method: "PUT",
    body: JSON.stringify({ maxRunCostUsd }),
  });

/** Every version, its metadata and its runs. 409 while a run is in flight. */
export const deleteWorkflow = (name: string) =>
  fetchJSON<{ ok: boolean; workflow: string }>(`/workflows/${encodeURIComponent(name)}`, { method: "DELETE" });

/** Claim ownerless workflows for whoever this request is from (all of them
 *  when `workflows` is omitted). Never takes one someone else owns. */
export const claimWorkflows = (workflows?: string[]) =>
  fetchJSON<{ actor: string; claimed: string[]; skipped: Array<{ workflow: string; owner?: string; reason: string }> }>("/actor/claim", {
    method: "POST",
    body: JSON.stringify(workflows ? { workflows } : {}),
  });

/** Does this deployment route LLM spend through the Mothership? The run-cap
 *  chip is only shown then — without it nothing enforces the number. */
export const getMothership = () =>
  fetchJSON<{ enabled?: boolean }>("/llm/mothership").then((r) => !!r.enabled).catch(() => false);

/** Publish a new version of an existing workflow. */
export const publishWorkflow = (
  name: string,
  version: string,
  steps: any[],
  description?: string,
) =>
  fetchJSON<any>(`/workflows/${name}`, {
    method: "POST",
    body: JSON.stringify({ version, steps, description }),
  });

/** Publish a new version of an existing workflow (raw YAML). */
export const publishWorkflowYaml = (
  name: string,
  version: string,
  yamlStr: string,
  description?: string,
) =>
  fetchJSON<any>(`/workflows/${name}`, {
    method: "POST",
    body: JSON.stringify({ version, yaml: yamlStr, description }),
  });

export const getWorkflowYaml = async (name: string, version: string) => {
  const res = await apiFetch(`/workflows/${name}/${version}`);
  return res.text();
};

/**
 * Run a workflow. The launch is **detached** (§8): `POST …/run` starts the
 * run server-side and returns `{ runId }` immediately, then we **reattach**
 * to its event log via `GET …/runs/:runId/stream` (SSE tail). `onEvent` fires
 * for each event (replayed history + live appends); the returned RunResult
 * arrives on the terminal `done` event. The two-step launch+reattach is
 * invisible to callers — same signature as a single streamed request.
 */
export async function runWorkflow(
  name: string,
  input: unknown,
  onEvent?: (event: RunEvent) => void,
  params?: Record<string, unknown>,
): Promise<any> {
  const { runId } = await launchWorkflow(name, input, params);
  return streamRun(name, runId, onEvent);
}

/**
 * Launch a run **detached** (§8) and return its `runId` immediately — the run
 * keeps executing server-side regardless of this connection. Callers that want
 * to surface the run *before* it finishes (e.g. show it as "running" in a list)
 * launch first, then `streamRun(name, runId)` to follow its events.
 */
export async function launchWorkflow(
  name: string,
  input: unknown,
  params?: Record<string, unknown>,
): Promise<{ runId: string }> {
  const res = await apiFetch(`/workflows/${name}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input,
      ...(params && Object.keys(params).length > 0 ? { params } : {}),
    }),
  });
  return (await res.json()) as { runId: string };
}

/**
 * Reattach to a run (live or completed) and stream its events. Tails the
 * server's append-only log from the start, so callers see full history even
 * when they attach late. Resolves to the final RunResult on `done`.
 */
export async function streamRun(
  name: string,
  runId: string,
  onEvent?: (event: RunEvent) => void,
  signal?: AbortSignal,
): Promise<any> {
  let res: Response;
  try {
    res = await apiFetch(`/workflows/${name}/runs/${runId}/stream`, { signal });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return null;
    throw e;
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let result: any = null;
  // Persists across read chunks: an `event:` line and its `data:` line can
  // arrive in different chunks (e.g. the multi-MB `done` result frame).
  let eventType = "message";

  while (true) {
    let done: boolean, value: Uint8Array | undefined;
    try {
      ({ done, value } = await reader.read());
    } catch (e) {
      // Aborted mid-read (caller navigated away): return quietly.
      if ((e as Error)?.name === "AbortError") return null;
      throw e;
    }
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse SSE lines
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const data = JSON.parse(line.slice(6));
        if (eventType === "done") {
          result = data;
        } else {
          onEvent?.(data as RunEvent);
        }
        eventType = "message";
      }
    }
  }

  return result;
}

// ── Steps ──────────────────────────────────────────────────────────────────

export interface StepsResponse {
  core: { type: string; source: string; description?: string }[];
  workspace: { type: string; description?: string }[];
}

export const listSteps = () => fetchJSON<StepsResponse>("/steps");

export interface FieldDesc {
  name: string;
  /** `multi` (a checkbox list over `enumValues`) is the UI's own — the
   *  builder's multi-select questions (./elicitation); zodToFields never
   *  emits it. */
  kind: "string" | "number" | "boolean" | "enum" | "multi" | "json";
  required: boolean;
  default?: unknown;
  enumValues?: string[];
  /** Display text per enum value (a question's `oneOf` titles). */
  enumLabels?: Record<string, string>;
  /** Overrides the humanized `name` as the field's label. */
  label?: string;
  /** The field's `.describe()` text — shown as a hint. */
  description?: string;
  /** Free-text field with a suggestion catalog ("llm-models" → listLlmModels). */
  suggest?: "llm-models";
}

export interface StepSchemaResponse {
  type: string;
  fields: FieldDesc[];
}

/** A custom step's version labels + the active one (404 for core/lib steps,
 *  which have no versions) — the step editor's version pin picker. */
export const getStepVersions = (type: string) =>
  fetchJSON<{ type: string; active: string; versions: string[] }>(`/steps/${encodeURIComponent(type)}/versions`);

export const getStepSchema = (type: string) =>
  fetchJSON<StepSchemaResponse>(`/steps/${encodeURIComponent(type)}/schema`);

export interface StepSourceResponse {
  type: string;
  source: string | null;
  origin: "registry" | "core" | "lib" | "custom" | null;
}

export const getStepSource = (type: string) =>
  fetchJSON<StepSourceResponse>(`/steps/${encodeURIComponent(type)}/source`);

export interface StepStatsResponse {
  type: string;
  /** Workflows whose active version can run the step; `direct` = named in its
   *  own YAML, otherwise reached through a subflow. */
  workflows: Array<{ name: string; direct: boolean }>;
  runs: { total: number; success: number; error: number; lastAt: string | null };
}

export const getStepStats = (type: string) =>
  fetchJSON<StepStatsResponse>(`/steps/${encodeURIComponent(type)}/stats`);

/** A custom step and every version of it (404 for core/lib steps). Workflows
 *  that use it are left as they are — they fail when a run reaches it. */
export const deleteStep = (type: string) =>
  fetchJSON<{ ok: boolean; type: string }>(`/steps/${encodeURIComponent(type)}`, { method: "DELETE" });

// ── Runs ───────────────────────────────────────────────────────────────────

export interface RunSummary {
  runId: string;
  workflow: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  status: string;
  input?: unknown;
  output?: unknown;
  error?: { message: string };
  /** Set when an automation fired this run (plans/automations.md). */
  automation?: { id: string };
}

export interface RunEvent {
  ts: string;
  runId: string;
  path: string;
  type: string;
  stepType?: string;
  input?: unknown;
  output?: unknown;
  error?: { message: string };
  durationMs?: number;
  iteration?: number;
}

export const listRuns = (workflow: string) =>
  fetchJSON<RunSummary[]>(`/workflows/${workflow}/runs`);

export const getRun = (workflow: string, runId: string) =>
  fetchJSON<RunSummary>(`/workflows/${workflow}/runs/${runId}`);

export const getRunEvents = (workflow: string, runId: string) =>
  fetchJSON<RunEvent[]>(`/workflows/${workflow}/runs/${runId}/events`);

// ── Run control (RUN_CONTROL_SPEC) ─────────────────────────────────────────
// Cancel/pause act on the live run tree (nested runs included). Resume is
// dual-purpose: releases a paused run, or durably resumes a dead one
// ("stale"/error/cancelled) by replaying its journal — optionally forcing
// re-execution from a step path (`from`, the "re-run from here" gesture).

export const cancelRun = (workflow: string, runId: string) =>
  fetchJSON<{ ok: boolean; state: string }>(
    `/workflows/${workflow}/runs/${runId}/cancel`,
    { method: "POST" },
  );

export const pauseRun = (workflow: string, runId: string) =>
  fetchJSON<{ ok: boolean; state: string; quiesced: boolean }>(
    `/workflows/${workflow}/runs/${runId}/pause`,
    { method: "POST" },
  );

export const resumeRun = (workflow: string, runId: string, from?: string) =>
  fetchJSON<{ ok: boolean; resumed: string }>(
    `/workflows/${workflow}/runs/${runId}/resume`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(from ? { from } : {}),
    },
  );

// ── Promotions (promote a run output → a target workflow's param) ───────────

/** A declared promotion resolved against a specific run's output. `value` is
 *  what would be written; `current` is the target param's existing default. */
export interface Promotion {
  from: string;
  to: string;
  target: { workflow: string; param: string };
  label: string;
  value: unknown;
  current: unknown;
  resolved: boolean;
}

export interface PromoteResult {
  ok: true;
  workflow: string;
  param: string;
  version: string;
  before: unknown;
  after: unknown;
}

/** Resolve a run's declared promotions (pure read — nothing is written). */
export const getPromotions = (workflow: string, runId: string) =>
  fetchJSON<Promotion[]>(`/workflows/${workflow}/runs/${runId}/promotions`);

/** Apply one promotion (human-approved): writes the target param + publishes
 *  a new version. `to` identifies which declared spec to apply. */
export const promote = (workflow: string, runId: string, to: string) =>
  fetchJSON<PromoteResult>(`/workflows/${workflow}/runs/${runId}/promote`, {
    method: "POST",
    body: JSON.stringify({ to }),
  });

// ── LLM models (chat picker + step editor `model` suggestions) ─────────────

export interface LlmModelOption {
  provider: string;
  alias: string;
  modelId: string;
  /** Canonical "provider/modelId" — the value to submit. */
  name: string;
  default: boolean;
  /** The provider has a key configured (secret store or env). */
  available: boolean;
}

export interface LlmModelsResponse {
  /** The deployment's default chat model, canonical. */
  default: string;
  models: LlmModelOption[];
  /** provider → the env var / secret name that holds its key. */
  keyNames: Record<string, string>;
}

export const listLlmModels = () => fetchJSON<LlmModelsResponse>("/llm/models");

// ── Chat (AI workflow builder) ─────────────────────────────────────────────
//
// A chat is a DETACHED background job: `POST /chat` launches a turn
// server-side and returns `{ chatId, turn }`; we reattach via
// `GET /chat/:id/stream` (SSE tail). Close the tab and the agent keeps
// running — reopen, load the transcript (`getChat`), and reattach to the
// live turn. Mirrors the workflow-run launch+reattach model above.

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ToolCallInfo {
  name: string;
  input: any;
  toolCallId?: string;
}

export interface ToolResultInfo {
  name: string;
  input: any;
  output: any;
  toolCallId?: string;
  /** The tool threw; `output` is the error message. */
  isError?: boolean;
}

export interface ChatCallbacks {
  onTextDelta: (delta: string) => void;
  onToolCall: (tc: ToolCallInfo) => void;
  onToolResult?: (tr: ToolResultInfo) => void;
  /** A streaming tool's intermediate yield (graph_walk's hop events). */
  onToolProgress?: (p: { name: string; toolCallId?: string; output: any }) => void;
  onStepFinish: () => void;
  onFinish: (status: string) => void;
}

export type ChatStatus = "live" | "done" | "error";

// The builder's open question (plans/elicitation.md) — the server's
// ElicitationRecord as `meta.elicitation`. ACP's shapes: `mode`, `message`,
// a flat `requestedSchema` for a form; for a secret, the NAME and the
// relative link (this app is the page it opens). Never a value.
export interface ElicitationOption {
  const: string;
  title?: string;
  description?: string;
}
export interface ElicitationProperty {
  type: "string" | "number" | "integer" | "boolean" | "array";
  title?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  oneOf?: ElicitationOption[];
  items?: { type?: "string"; enum?: string[]; anyOf?: ElicitationOption[] };
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: "email" | "uri" | "date" | "date-time";
  minimum?: number;
  maximum?: number;
}
export interface ElicitationSchema {
  type: "object";
  properties: Record<string, ElicitationProperty>;
  required?: string[];
}
export type Elicitation = { elicitationId: string; toolCallId: string; turn: number; createdAt: string; message: string } & (
  | { mode: "form"; requestedSchema: ElicitationSchema }
  | { mode: "url"; name: string; url: string; exists: boolean }
);
export type ElicitationAction = "accept" | "decline" | "cancel";

export interface ChatMeta {
  id: string;
  title?: string;
  status: ChatStatus;
  model?: string;
  createdAt: string;
  updatedAt: string;
  currentTurn: number;
  /** Who started the chat (the first speaker with an actor) and who spoke
   *  last. Whole actor ids — `displayActor` shortens them for the UI. */
  createdBy?: string;
  actor?: string;
  /** The builder is waiting on this question; the flyout shows its form. */
  elicitation?: Elicitation;
}

/** A normalized fine-grained chat event (matches the server's `ChatEvent`). */
export interface ChatEvent {
  ts: string;
  chatId: string;
  turn: number;
  type: "text-delta" | "tool-input" | "tool-output" | "tool-progress" | "step.finish" | "chat.end" | "chat.error";
  delta?: string;
  toolName?: string;
  toolCallId?: string;
  input?: any;
  output?: any;
  /** tool-output: the tool threw (output is the error message). */
  isError?: boolean;
  error?: { message: string };
}

export interface ChatTranscript {
  meta: ChatMeta;
  /** Stored AI SDK ModelMessage objects (opaque — rendered by the flyout). */
  messages: { role: string; content: unknown }[];
}

/** Launch a chat turn (detached). Pass `chatId` to continue an existing
 *  session, or omit it to start a new one. `model` (canonical name from
 *  listLlmModels, or any aieo name) is validated server-side and recorded
 *  on the chat; omit it to keep the chat's model. Returns the ids to
 *  reattach with. */
export async function sendChat(
  message: string,
  chatId?: string,
  model?: string,
): Promise<{ chatId: string; turn: number }> {
  const res = await apiFetch(`/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, ...(chatId ? { chatId } : {}), ...(model ? { model } : {}) }),
  });
  if (!res.ok) {
    // 409 = the chat already has a turn in progress (reattach instead).
    // 400 = the message or model pick was rejected; `error` says why.
    let msg = `chat: ${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {}
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return (await res.json()) as { chatId: string; turn: number };
}

/** Load a chat's full transcript + meta (for reload / reattach). */
export const getChat = (chatId: string) =>
  fetchJSON<ChatTranscript>(`/chat/${chatId}`);

/** A finished tool call's progress outputs (`tool-progress` events), in
 *  order — for a streaming tool (graph_walk) loaded from history, whose
 *  stored message holds only the final result. */
export const getToolProgress = (chatId: string, toolCallId: string) =>
  fetchJSON<{ outputs: any[] }>(`/chat/${chatId}/progress/${encodeURIComponent(toolCallId)}`);

/** List chat sessions (newest first). */
export const listChats = () => fetchJSON<ChatMeta[]>("/chats");

/** Stop a chat's live turn (409 when nothing is running). The turn ends
 *  with `chat.end`, so an attached stream finishes as usual. */
export const cancelChat = (chatId: string) =>
  fetchJSON<{ ok: boolean }>(`/chat/${chatId}/cancel`, { method: "POST" });

/** Answer the builder's open question: a form's content with `accept`, or
 *  `decline` / `cancel` for either kind. The server validates, records who
 *  answered, and starts the next turn — `queued` when one is live (it
 *  follows that turn; the idle poll notices). 404 once the question is
 *  closed. A secret is never accepted here: see storeElicitedSecret. */
export const answerElicitation = (
  chatId: string,
  elicitationId: string,
  body: { action: ElicitationAction; content?: Record<string, unknown> },
) =>
  fetchJSON<{ chatId: string; turn?: number; queued?: true }>(`/chat/${chatId}/elicitations/${encodeURIComponent(elicitationId)}`, {
    method: "POST",
    body: JSON.stringify(body),
  });

/** URL mode's completion: the value goes straight into the secret store
 *  under the NAME the server recorded; the chat hears "stored". */
export const storeElicitedSecret = (chatId: string, elicitationId: string, value: string) =>
  fetchJSON<{ chatId: string; turn?: number; queued?: true }>(`/chat/${chatId}/elicitations/${encodeURIComponent(elicitationId)}/secret`, {
    method: "POST",
    body: JSON.stringify({ value }),
  });

/**
 * Reattach to a chat turn (live or completed) and stream its events. Tails
 * the server's append-only log from the start of the turn, so callers see
 * full history even when they attach late. Resolves once the turn ends.
 */
export async function streamChat(
  chatId: string,
  turn: number,
  callbacks: ChatCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  // Aborting detaches this client from the turn — the turn itself keeps
  // running server-side. Resolves silently (no onFinish) when aborted.
  let res: Response;
  try {
    res = await apiFetch(`/chat/${chatId}/stream?turn=${turn}`, { signal });
  } catch (err) {
    if (signal?.aborted) return;
    throw err;
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buf = "";
  let status = "done";
  // Persists across read chunks: an `event:` line and its `data:` line can
  // arrive in different chunks.
  let eventType = "message";

  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (signal?.aborted) return;
      throw err;
    }
    const { done, value } = chunk;
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const data = line.slice(6);
        try {
          const msg = JSON.parse(data);
          if (eventType === "done") {
            status = msg.status ?? status;
          } else {
            dispatchChatEvent(msg as ChatEvent, callbacks);
          }
        } catch {
          // skip unparseable lines
        }
        eventType = "message";
      }
    }
  }

  if (signal?.aborted) return;
  callbacks.onFinish(status);
}

function dispatchChatEvent(e: ChatEvent, cb: ChatCallbacks): void {
  switch (e.type) {
    case "text-delta":
      if (e.delta) cb.onTextDelta(e.delta);
      break;
    case "tool-input":
      cb.onToolCall({ name: e.toolName ?? "", input: e.input, toolCallId: e.toolCallId });
      break;
    case "tool-output":
      cb.onToolResult?.({
        name: e.toolName ?? "",
        input: e.input,
        output: e.output,
        toolCallId: e.toolCallId,
        isError: e.isError,
      });
      break;
    case "tool-progress":
      cb.onToolProgress?.({ name: e.toolName ?? "", toolCallId: e.toolCallId, output: e.output });
      break;
    case "step.finish":
      cb.onStepFinish();
      break;
    case "chat.error":
      cb.onTextDelta(`\n\n⚠️ ${e.error?.message ?? "chat error"}`);
      break;
    case "chat.end":
      break;
  }
}

// ── Secrets ────────────────────────────────────────────────────────────────
// Deployment-scoped credentials. Values are write-only over the API — the
// list endpoint returns NAMES + metadata only, never the secret value.

export interface SecretInfo {
  name: string;
  createdAt: string;
  updatedAt: string;
}

export const listSecrets = () =>
  fetchJSON<{ secrets: SecretInfo[] }>("/secrets").then((r) => r.secrets);

export const setSecret = (name: string, value: string) =>
  fetchJSON<{ ok: true; name: string }>(`/secrets/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });

export const deleteSecret = (name: string) =>
  fetchJSON<{ ok: true; name: string }>(`/secrets/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });

// ── Claims (plans/claims.md) ───────────────────────────────────────────────
// A subject's contract: how it should behave, the checks that test it, and
// what the evidence says. Graph-backed workspaces only — `enabled: false`
// otherwise, and the panel hides itself.

export interface ClaimSubject {
  kind: "step" | "workflow";
  /** Workflow name, or custom step type. */
  name: string;
}

export type ClaimStatusValue = "supported" | "refuted" | "stale" | "unknown";

export interface ClaimRunRef {
  /** Run-store key: a workflow name, or `step:<type>`. */
  name?: string;
  runId?: string;
  path?: string;
}

/** A check as the panel edits it: a STEP check names a registry step
 *  (`type` + `config`); an EXTERNAL check has only a `description`. */
export interface ClaimCheckSpec {
  type?: string;
  config?: Record<string, unknown>;
  name?: string;
  description?: string;
  when?: "run" | "publish";
  policy?: "always" | "on_change" | "sample" | "manual";
  freshnessDays?: number;
  sampleRate?: number;
}

export interface ClaimCheck extends ClaimCheckSpec {
  id: string;
  name: string;
  external: boolean;
  publisher?: string;
}

export interface ClaimEntry {
  id: string;
  text: string;
  /** Who wrote it: `ai`, `person`, a seeder. */
  speaker?: string;
  status: ClaimStatusValue;
  /** The verdict rests on a model's or a person's word — nothing observed. */
  assertedOnly: boolean;
  /** Active checks with no evidence about the active version. */
  unverified: number;
  openSlot: boolean;
  latest?: { content?: string; observedAt?: number; mode?: string; check?: string; checkVersion?: string; by?: string; run?: ClaimRunRef };
  /** Questions an external check is waiting on — the panel's to-dos. */
  slots: Array<{ evidence: string; check?: string; question?: string; run?: ClaimRunRef }>;
  checks: ClaimCheck[];
}

export interface ClaimsResponse {
  enabled: boolean;
  subject?: ClaimSubject;
  claims: ClaimEntry[];
  /** Why there is no contract here (e.g. a built-in step). */
  note?: string;
  /** What this subject's paid checks have cost so far. */
  verifyCostUsd?: number;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

export const getClaims = (subject: ClaimSubject) =>
  fetchJSON<ClaimsResponse>(`/claims?kind=${subject.kind}&name=${encodeURIComponent(subject.name)}`);
export const addClaim = (subject: ClaimSubject, text: string, checks: ClaimCheckSpec[]) =>
  fetchJSON<{ id: string; checks: string[] }>("/claims", json("POST", { subjects: [subject], text, checks }));
/** Rewording creates a SUCCESSOR (claims are immutable); returns its id. */
export const editClaim = (id: string, text: string) => fetchJSON<{ id: string; superseded?: string }>(`/claims/${id}`, json("PATCH", { text }));
export const retireClaim = (id: string) => fetchJSON<{ id: string }>(`/claims/${id}`, json("DELETE"));
export const addCheck = (claimId: string, check: ClaimCheckSpec) => fetchJSON<{ id: string }>(`/claims/${claimId}/checks`, json("POST", { check }));
export const editCheck = (id: string, patch: ClaimCheckSpec) => fetchJSON<{ id: string }>(`/checks/${id}`, json("PATCH", { patch }));
export const retireCheck = (id: string) => fetchJSON<{ id: string }>(`/checks/${id}`, json("DELETE"));
/** A person's observation on a run; with `slot`, the answer to an open question. */
export const addClaimEvidence = (claimId: string, body: { name: string; runId: string; supports: boolean; content: string; slot?: string }) =>
  fetchJSON<{ evidence: string; filled: boolean }>(`/claims/${claimId}/evidence`, json("POST", body));

// ── Automations (plans/automations.md) ─────────────────────────────────────
//
// A schedule that launches a workflow. Workflow-level metadata: creating,
// editing or pausing one never publishes a version. The trigger is a closed
// grammar (no cron); the SERVER owns the calendar math — the form asks
// `previewAutomation` for the sentence and the next fires.

export type Day = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type MonthDay = number | "last" | { nth: 1 | 2 | 3 | 4 | "last"; weekday: Day };

/** What the form sends. The server fills `tz` / `anchor` when omitted. */
export type TriggerDraft =
  | { every: "interval"; minutes: number; anchor?: string; on?: Day[]; between?: [string, string]; tz?: string }
  | { every: "day"; at: string[]; tz?: string }
  | { every: "week"; on: Day[]; at: string[]; tz?: string }
  | { every: "month"; day: MonthDay; at: string[]; tz?: string }
  | { every: "once"; at: string; tz?: string };
/** As stored: zone always present. */
export type Trigger = TriggerDraft & { type: "schedule"; tz: string };

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  input: Record<string, unknown>;
}

/** An automation plus what the server derives for display. */
export interface AutomationView extends Automation {
  workflow: string;
  /** The trigger as one plain sentence. */
  summary: string;
  /** ISO instant; null when paused or never again. */
  nextRunAt: string | null;
  lastRun: { runId: string; status: "running" | "success" | "error" | "cancelled"; startedAt: string } | null;
  /** Its previous run is still going — a fire now would be skipped. */
  running: boolean;
  /** Why the latest fire launched nothing. */
  lastFireError?: string;
}

export interface AutomationDraft {
  name: string;
  trigger: TriggerDraft;
  input?: Record<string, unknown>;
  enabled?: boolean;
}
export interface AutomationSaved {
  automation: AutomationView;
  next: string[];
}

const automationsPath = (workflow: string) => `/workflows/${encodeURIComponent(workflow)}/automations`;

export const listAutomations = (workflow?: string) =>
  fetchJSON<{ automations: AutomationView[] }>(`/automations${workflow ? `?workflow=${encodeURIComponent(workflow)}` : ""}`).then((r) => r.automations);
/** The trigger as a sentence + its next five fires. Writes nothing. */
export const previewAutomation = (trigger: TriggerDraft) =>
  fetchJSON<{ summary: string; next: string[] }>("/automations/preview", json("POST", { trigger }));
export const createAutomation = (workflow: string, draft: AutomationDraft) =>
  fetchJSON<AutomationSaved>(automationsPath(workflow), json("POST", draft));
export const updateAutomation = (workflow: string, id: string, patch: Partial<AutomationDraft>) =>
  fetchJSON<AutomationSaved>(`${automationsPath(workflow)}/${id}`, json("PATCH", patch));
export const deleteAutomation = (workflow: string, id: string) =>
  fetchJSON<{ id: string }>(`${automationsPath(workflow)}/${id}`, json("DELETE"));
/** Run now, off-schedule. */
export const fireAutomation = (workflow: string, id: string) =>
  fetchJSON<{ runId: string }>(`${automationsPath(workflow)}/${id}/fire`, json("POST"));
