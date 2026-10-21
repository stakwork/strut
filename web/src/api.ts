import type { AccessedNode } from "./accessed-nodes";
import { fileScopeOf } from "./artifact-view";

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
/** The API's base path ("" at the root, "/lab" under a host's mount) — for
 *  a caller that builds its own request, such as the app host's MCP client. */
export const API_BASE = BASE;

// Which strings are served-file paths, and which listing each reads from:
// with the viewer's other pure helpers.
export { isArtifactPath, fileScopeOf } from "./artifact-view";

/** Browser URL for an artifact path. Mount-path aware (works under `/lab`).
 *  An `<a href>` / `<img src>` cannot set a header, so the read token for
 *  the run's (or job's) files rides as `?t=` — not the key: a page an agent
 *  wrote can read its own URL. `useArtifactUrl` fetches the token. When the
 *  server minted none (a strut with no secret to sign one, behind a host's
 *  gate that takes the key as `?key=`) the key rides as it used to, and the
 *  server serves such a page with no script. */
export function artifactUrl(path: string, token = ""): string {
  const key = token ? "" : getApiKey();
  const q = token ? `?t=${encodeURIComponent(token)}` : key ? `?key=${encodeURIComponent(key)}` : "";
  return `${BASE}${path}${q}`;
}

/** A scope's listing: the files under it, as the listing route spells them
 *  (paths within the scope), and the read token for them. */
export interface FileScope { files: string[]; token: string }

// One listing per scope, fetched once (`GET /artifacts/:runId`, `GET
// /jobs/:id/files`) and kept for the page's life; dropped when the key
// changes, since the token is derived from it. The viewer reads the files
// (a directory, where a link leads), every link reads the token.
const fileScopes = new Map<string, Promise<FileScope>>();

/** The listing of the scope a served-file path (or the scope itself)
 *  belongs to. Rejects for a path that is not a served file, and when the
 *  listing cannot be read — on an open server the bare URL still works, on
 *  a gated one the 401 opens Settings. */
export function fileScope(path: string): Promise<FileScope> {
  const scope = fileScopeOf(path);
  if (!scope) return Promise.reject(new Error(`not a served file: ${path}`));
  let p = fileScopes.get(scope);
  if (!p) {
    p = apiFetch(scope).then(async (res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as { files?: unknown; token?: unknown };
      return {
        files: Array.isArray(body.files) ? body.files.filter((f): f is string => typeof f === "string") : [],
        token: typeof body.token === "string" ? body.token : "",
      };
    });
    p.catch(() => fileScopes.delete(scope));
    fileScopes.set(scope, p);
  }
  return p;
}

/** The read token for the files `path` belongs to; "" when the server
 *  minted none, the listing could not be read, or the path is not a served
 *  file. */
export function fileToken(path: string): Promise<string> {
  return fileScope(path).then((s) => s.token, () => "");
}

/** The text of an artifact, for the inline viewer (markdown / text files). */
export async function fetchArtifactText(path: string): Promise<string> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

// ── API key ────────────────────────────────────────────────────────────────
// When the server sets STRUT_API_KEY, every route needs `Authorization:
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
  refused = false;
  fileScopes.clear();
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

// ── Session ────────────────────────────────────────────────────────────────
// The other way in, for a strut facing the internet with no host in front:
// `signIn` posts the key ONCE to `POST /auth/session` and gets back an
// HttpOnly cookie the page cannot read — the browser sends it by itself
// from then on, and nothing here holds the key. What is kept is a marker of
// the session (who, until when) so the UI knows it is signed in: the
// credential is the cookie, and a 401 while the marker is set means it ran
// out. Every request carries `x-strut-ui: 1`, the header the server's
// CSRF rule wants beside the cookie on anything but a read (auth.ts).
const SESSION_STORAGE = "strut/session";

export interface SessionInfo {
  actor?: string;
  /** When the session ends (ms since the epoch). */
  exp: number;
}

/** The session this browser signed into, if it has not run out. */
export function getSession(): SessionInfo | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE);
    if (!raw) return null;
    const s = JSON.parse(raw) as SessionInfo;
    if (typeof s?.exp !== "number" || s.exp <= Date.now()) {
      localStorage.removeItem(SESSION_STORAGE);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

function setSession(s: SessionInfo | null): void {
  try {
    if (s) localStorage.setItem(SESSION_STORAGE, JSON.stringify(s));
    else localStorage.removeItem(SESSION_STORAGE);
  } catch {}
}

/** Trade the key for a session: the cookie is set by the response, any key
 *  this browser kept is forgotten, and the marker is stored. Rejects with
 *  the server's message on a wrong key. */
export async function signIn(key: string, actor?: string): Promise<SessionInfo> {
  const res = await fetch(`${BASE}/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-strut-ui": "1" },
    body: JSON.stringify({ key, ...(actor ? { actor } : {}) }),
  });
  const body = (await res.json().catch(() => null)) as (SessionInfo & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  setApiKey("");
  setSession({ ...(body?.actor ? { actor: body.actor } : {}), exp: body!.exp });
  return getSession()!;
}

/** End the session: the cookie is cleared by the response. */
export async function signOut(): Promise<void> {
  await fetch(`${BASE}/auth/session`, { method: "DELETE", headers: { "x-strut-ui": "1" } }).catch(() => {});
  setSession(null);
  refused = false;
  fileScopes.clear();
}

function authHeaders(): Record<string, string> {
  const key = getSession() ? "" : getApiKey();
  return { "x-strut-ui": "1", ...(key ? { Authorization: `Bearer ${key}` } : {}) };
}

/** The headers every UI request carries — the UI marker (the server's CSRF
 *  rule beside the session cookie) and the key, when this browser holds one
 *  rather than a session. For a request made outside `apiFetch`: the app
 *  host's MCP client (./app-host). */
export function apiHeaders(): Record<string, string> {
  return authHeaders();
}

// The server refused the key (or the lack of one). The app is told once per
// key — every poll would say it again — and opens Settings → Connection.
let refused = false;
let onRefused: (() => void) | null = null;
export function onUnauthorized(fn: (() => void) | null): void {
  onRefused = fn;
}

/** `fetch` against the API base with the key attached — or, signed in,
 *  nothing but the UI header: the session cookie rides by itself. Every
 *  call goes through here so a gated deployment works without per-call
 *  plumbing. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  for (const [k, v] of Object.entries(authHeaders())) if (!headers.has(k)) headers.set(k, v);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401 && !refused) {
    refused = true;
    setSession(null); // a session the server refused has run out
    onRefused?.();
  }
  return res;
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
 *  browser WebSocket can't set headers, so the key rides as `?key=` —
 *  signed in, the session cookie rides on the upgrade instead. */
export function sttStreamUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${proto}//${location.host}${BASE}/audio/stream`);
  const key = getSession() ? "" : getApiKey();
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
    body: JSON.stringify({ name, yaml: yamlStr, description, category, source: "ui" }),
  });

export interface WorkflowVersionStats {
  version: string;
  createdAt: string;
  description?: string;
  /** Which door wrote it — seed / ui / api / builder / agent / promote.
   *  Absent on versions published before it was recorded. */
  source?: string;
  /** Who published it, when known. */
  actor?: string;
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
    body: JSON.stringify({ version, steps, description, source: "ui" }),
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
    body: JSON.stringify({ version, yaml: yamlStr, description, source: "ui" }),
  });

/** One version's YAML as published (`GET /workflows/:name/:version`). */
export const getWorkflowYaml = async (name: string, version: string) => {
  const res = await apiFetch(`/workflows/${name}/${version}`);
  if (!res.ok) throw new Error(`Failed to load ${version}: ${res.status}`);
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
 *
 * `skip`: how many events the caller already has (from `getRunEvents`) — the
 * tail starts after them. The log is append-only, so the count is a
 * race-free cursor.
 */
export async function streamRun(
  name: string,
  runId: string,
  onEvent?: (event: RunEvent) => void,
  opts: { signal?: AbortSignal; skip?: number } = {},
): Promise<any> {
  const { signal, skip } = opts;
  let res: Response;
  try {
    res = await apiFetch(`/workflows/${name}/runs/${runId}/stream${skip ? `?skip=${skip}` : ""}`, { signal });
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
  /** The select also takes the user's own text — an "Other…" choice that
   *  opens a text box. The builder's questions only: a step's Zod enum is
   *  a constraint, a question's options are what the model offered. */
  other?: boolean;
  /** Overrides the humanized `name` as the field's label. */
  label?: string;
  /** The field's `.describe()` text — shown as a hint. */
  description?: string;
  /** Free-text field with a suggestion catalog ("llm-models" → listLlmModels). */
  suggest?: "llm-models";
  /** From a step's schema: the value is a graph node's NAME and the sibling
   *  field `typeField` holds its type (graph/graph-get's `name`). */
  lookup?: { typeField: string };
  /** Resolved for a run input (run-inputs.ts): the value names a node of
   *  this type — ConfigField offers a typeahead over graph-search. */
  nodeType?: string;
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
  /** The job the run was launched under (plans/jobs.md), when one was given. */
  job?: string;
  /** A run still in flight: the launch's title for its job, if it gave one.
   *  A finished run's summary has none — the jobs listing names the job. */
  jobTitle?: string;
  /** Who launched the run when it was not a person or an API call:
   *  `schedule`, `peer`, `app` (plans/apps.md §11). */
  origin?: string;
  /** The app the run was launched for, with `origin: "app"`. */
  app?: { name: string; version: string };
  /** What the run's model calls spent (absent when none did). */
  totals?: { modelCalls: number; usage: TokenUsage; cost: number };
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
  /** Graph nodes the step named — read, expanded, written (never a search
   *  hit). On a `step.end`; an agent's are on its tool calls'. */
  nodes?: AccessedNode[];
  /** On `run.start`: who launched the run, and the job it was launched under. */
  actor?: string;
  job?: string;
  /** On a `step.end` whose step called a model (or waited on a run that
   *  did): what it spent (`withUsage`, src/core.ts). */
  modelCalls?: number;
  usage?: TokenUsage;
  cost?: number;
}

/** One graph node as the graph holds it now (`GET /graph/nodes/:ref_id`). */
export interface GraphNode {
  ref_id: string;
  node_type: string | null;
  name: string | null;
  properties: Record<string, unknown>;
}

export const getGraphNode = (refId: string) => fetchJSON<GraphNode>(`/graph/nodes/${encodeURIComponent(refId)}`);

export const listRuns = (workflow: string) =>
  fetchJSON<RunSummary[]>(`/workflows/${workflow}/runs`);

/** The deliverables a finished run's output declared, resolved to links
 *  (404 until the run has a summary). */
export const getRunArtifacts = (workflow: string, runId: string) =>
  fetchJSON<{ artifacts: ArtifactRef[] }>(`/workflows/${encodeURIComponent(workflow)}/runs/${runId}/artifacts`);

/** A run executing right now in the server process (`GET /runs/active`). */
export interface ActiveRun {
  workflow: string;
  runId: string;
  state: "running" | "pausing" | "paused" | "cancelling";
  /** Set for a nested run launched by another run. */
  parentRunId?: string;
  /** The job the run was launched under, and the launch's title for it. */
  job?: string;
  jobTitle?: string;
}

export const listActiveRuns = () => fetchJSON<ActiveRun[]>("/runs/active");

// ── Jobs (plans/jobs-sidebar.md) ───────────────────────────────────────────
// The shapes mirror the server's (`JobView` in src/job-index.ts, `JobThread`
// / `JobTurn` in src/job-threads.ts); written out here because those modules
// pull node types the web build has no business resolving.

export interface TokenUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** One resolved deliverable (`src/artifact-refs.ts`). */
export interface ArtifactRef {
  id: string;
  kind: string;
  title: string;
  label?: string;
  summary?: string;
  url?: string;
  content?: unknown;
  error?: string;
}

/** A current deliverable of a job: the ref and the run that last reported it. */
export interface JobArtifact extends ArtifactRef {
  runId: string;
  path?: string;
}

export type TurnStatus = "success" | "error" | "cancelled" | "running";

/** One agent execution of a job — or a peer run, or a run with no agent. */
export interface JobTurn {
  runId: string;
  workflow: string;
  path: string;
  stepType: string;
  label: string;
  at: string;
  durationMs?: number;
  status: TurnStatus;
  turn?: number;
  offset?: number;
  session?: string;
  usage?: TokenUsage;
  cost?: number;
  context?: { used: number; limit: number };
  toolCalls: number;
  transcript?: string;
  artifacts?: ArtifactRef[];
  nodeCount: number;
  nodes?: AccessedNode[];
  spawned: JobThread[];
  peer?: { id: string; workflow: string; runId: string; status: string };
}

export interface JobTotals {
  turns: number;
  usage: TokenUsage;
  cost: number;
  toolCalls: number;
  context?: { used: number; limit: number };
}

/** A thread: one session's turns, or one cold execution. */
export interface JobThread {
  id: string;
  session: boolean;
  label: string;
  startedAt: string;
  updatedAt: string;
  turns: JobTurn[];
  totals: JobTotals;
}

/** One row of `GET /jobs`. */
export interface JobListing {
  job: string;
  title?: string;
  createdBy?: string;
  /** Everyone who launched a run under the job, first seen first. */
  actors?: string[];
  createdAt?: string;
  usedAt: string;
  busy?: string;
  runs: number;
  holds: number;
}

export interface JobRunView {
  workflow: string;
  runId: string;
  at: string;
  parentRunId?: string;
  status: "running" | "success" | "error" | "cancelled";
  durationMs?: number;
  error?: string;
  sealed?: true;
}

/** `GET /jobs/:id`. */
export interface JobView extends Omit<JobListing, "runs" | "holds"> {
  holds: Array<{ id: string; kind: string; since: string; note?: string; url?: string }>;
  /** The first hold of each kind that has a url: `{ pod: "https://…" }`. */
  urls: Record<string, string>;
  repos: string[];
  files: string[];
  runs: JobRunView[];
  sessions: Array<{ id: string; turns: number; updatedAt: string; busy?: true }>;
  artifacts: JobArtifact[];
  text?: string;
  threads?: JobThread[];
  omittedRuns?: number;
  /** The job's ledger, where the claims layer is on (absent otherwise). */
  claims?: LedgerClaim[];
}

/** Every turn under `threads`, spawned ones included, each counted once. */
export function jobTotals(threads: JobThread[]): JobTotals {
  const usage: TokenUsage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0 };
  const totals: JobTotals = { turns: 0, usage, cost: 0, toolCalls: 0 };
  const walk = (ts: JobThread[]) => {
    for (const th of ts) for (const t of th.turns) {
      totals.turns++;
      totals.toolCalls += t.toolCalls;
      if (typeof t.cost === "number") totals.cost += t.cost;
      if (t.usage) for (const k of Object.keys(usage) as (keyof TokenUsage)[]) usage[k] += Number(t.usage[k]) || 0;
      walk(t.spawned);
    }
  };
  walk(threads);
  return totals;
}

/** Every job, newest-used first; `q` is the sidebar's matcher
 *  (`src/search.ts`), `workflow` keeps the jobs that ran that workflow,
 *  `mine` the jobs the request's actor launched a run of. `actor` is who
 *  the server took the request to be from — absent, `mine` lists nothing. */
export const listJobs = (opts: { q?: string; workflow?: string | null; mine?: boolean; limit?: number } = {}) => {
  const p = new URLSearchParams();
  if (opts.q?.trim()) p.set("q", opts.q.trim());
  if (opts.workflow) p.set("workflow", opts.workflow);
  if (opts.mine) p.set("mine", "1");
  if (opts.limit) p.set("limit", String(opts.limit));
  const qs = p.toString();
  return fetchJSON<{ jobs: JobListing[]; actor?: string }>(`/jobs${qs ? `?${qs}` : ""}`);
};

/** One job with its threads; `nodes` adds each turn's touched graph nodes. */
export const getJob = (id: string, opts: { nodes?: boolean; limit?: number } = {}) => {
  const p = new URLSearchParams();
  if (opts.nodes) p.set("nodes", "1");
  if (opts.limit) p.set("limit", String(opts.limit));
  const qs = p.toString();
  return fetchJSON<JobView>(`/jobs/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`);
};

/** A stored model message, as a transcript endpoint serves it. */
export interface StoredMessage {
  role: string;
  content: unknown;
}

/** An agent session read back from a run: the `transcript` link a turn
 *  carries (`/workflows/…/transcripts/<path>`, `?full=1` for the thread). */
export const getTranscript = (link: string, signal?: AbortSignal) => fetchJSON<StoredMessage[]>(link, { signal });

export const getRun = (workflow: string, runId: string) =>
  fetchJSON<RunSummary>(`/workflows/${workflow}/runs/${runId}`);

export const getRunEvents = (workflow: string, runId: string, signal?: AbortSignal) =>
  fetchJSON<RunEvent[]>(`/workflows/${workflow}/runs/${runId}/events`, { signal });

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

/** One hit of GET /graph/names (the fields the typeahead shows). */
export interface NodeHit {
  ref_id: string;
  name: string;
  node_type: string;
  description?: string;
}

/** Nodes of `type` whose name contains `q`, names starting with it first —
 *  the Run popover's typeahead for an input that graph/graph-get resolves by
 *  name (`FieldDesc.nodeType`). A read route of the server's own, never a
 *  step the workflow names. `[]` when the deployment has no graph (501) or
 *  the call fails. */
export async function searchNodes(type: string, q: string, limit = 8): Promise<NodeHit[]> {
  try {
    const r = await fetchJSON<{ nodes?: NodeHit[] }>(
      `/graph/names?type=${encodeURIComponent(type)}&q=${encodeURIComponent(q)}&limit=${limit}`,
    );
    return Array.isArray(r.nodes) ? r.nodes.filter((h) => h && typeof h.name === "string" && h.name.length > 0) : [];
  } catch {
    return [];
  }
}

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
  /** A model call ended; `context` is how full the window is now. */
  onStepFinish: (context?: ChatContext) => void;
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
  /** How full the model's context window is, as of the last model call. */
  context?: ChatContext;
}

/** Tokens the conversation occupies after a model call, against the model's
 *  context window (the server's `ChatContext`). */
export interface ChatContext {
  used: number;
  limit: number;
}

/** A normalized fine-grained chat event (matches the server's `ChatEvent`). */
export interface ChatEvent {
  ts: string;
  chatId: string;
  turn: number;
  type: "text-delta" | "tool-input" | "tool-output" | "tool-progress" | "step.finish" | "chat.compact" | "chat.end" | "chat.error";
  delta?: string;
  toolName?: string;
  toolCallId?: string;
  input?: any;
  output?: any;
  /** tool-output: the tool threw (output is the error message). */
  isError?: boolean;
  error?: { message: string };
  /** step.finish: the context after this step. chat.compact: the floor the
   *  compaction left (the summary's size; the next call corrects it). */
  context?: ChatContext;
  /** chat.compact: what was folded into the summary (plans/compaction.md). */
  compact?: { messages: number; tokens: number };
}

export interface ChatTranscript {
  meta: ChatMeta;
  /** Stored AI SDK ModelMessage objects (opaque — rendered by the flyout). */
  messages: { role: string; content: unknown }[];
}

/** Launch a chat turn (detached). Pass `chatId` to continue an existing
 *  session, or omit it to start a new one. `model` (canonical name from
 *  listLlmModels, or any aieo name) is validated server-side and recorded
 *  on the chat; omit it to keep the chat's model. `attachments` are files
 *  (`data` a data URL) the server saves and shows the model. Returns the
 *  ids to reattach with. */
export async function sendChat(
  message: string,
  chatId?: string,
  model?: string,
  attachments?: { name: string; mediaType: string; data: string }[],
): Promise<{ chatId: string; turn: number }> {
  const res = await apiFetch(`/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      ...(chatId ? { chatId } : {}),
      ...(model ? { model } : {}),
      ...(attachments?.length ? { attachments } : {}),
    }),
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

/** A chat's meta alone — the idle poll's request, so a long transcript is
 *  not re-sent every few seconds. */
export const getChatMeta = (chatId: string) =>
  fetchJSON<ChatMeta>(`/chat/${chatId}/meta`);

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
    case "chat.compact":
      // A compaction resets the meter to its floor, like a step's end sets it.
      cb.onStepFinish(e.context);
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
  kind: "step" | "workflow" | "job";
  /** Workflow name, custom step type, or job id. */
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
  latest?: {
    content?: string;
    observedAt?: number;
    mode?: string;
    check?: string;
    checkVersion?: string;
    by?: string;
    run?: ClaimRunRef;
    /** The version it observed: a hash, or a job turn's run id. */
    about?: string;
    /** Where to look: a job file's url (a screenshot), the file itself. */
    locator?: { url?: string; file?: string };
  };
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
/** A person's observation on a run; with `slot`, the answer to an open
 *  question. A job's turn is named by `job` (`name` is then optional). */
export const addClaimEvidence = (claimId: string, body: { name?: string; job?: string; runId: string; supports: boolean; content: string; slot?: string }) =>
  fetchJSON<{ evidence: string; filled: boolean }>(`/claims/${claimId}/evidence`, json("POST", body));

// ── A job's ledger (plans/job-claims.md §6) ────────────────────────────────
// What the work must deliver and whether it does, as of the job's newest
// turn. The mirror of `LedgerClaim` in src/ledger.ts — NOT `ClaimEntry`,
// the `/claims` listing the panel edits: no speaker, slots or check config,
// but each check's `lastVerify` from the latest pass.

export type SkipReason = "policy" | "budget" | "cannot-launch" | "unknown-version" | "denied" | "superseded";
export type LastVerify = { pending: true } | { ran: true } | { skipped: SkipReason; reason?: string } | { planned: string };

export interface LedgerCheck {
  id: string;
  name: string;
  external?: true;
  lastVerify?: LastVerify;
}

export interface LedgerClaim {
  id: string;
  text: string;
  status: ClaimStatusValue;
  assertedOnly: boolean;
  unverified: number;
  latest?: {
    content?: string;
    observed_at?: number;
    mode?: string;
    check?: string;
    checkVersion?: string;
    /** The turn the verdict is about (a run id). */
    about?: string;
    /** What the check pointed at: a job file's url (a screenshot), an endpoint. */
    locator?: { url?: string; file?: string };
  };
  checks: LedgerCheck[];
}

/** `POST /jobs/:id/verify`: the pass over the newest turn, and the ledger after it. */
export interface JobVerifyResult {
  job: string;
  key: string;
  /** The turn verified. */
  runId: string;
  skipped?: "verify-origin" | "unknown-run" | "unfinished" | "unknown-job";
  checks: Array<{ path: string; claimId: string; checkId: string; lastVerify: LastVerify }>;
  evidence: number;
  slots: number;
  costUsd: number;
  claims: LedgerClaim[];
}

export const getJobClaims = (id: string) =>
  fetchJSON<{ enabled: boolean; job: string; claims: LedgerClaim[] }>(`/jobs/${encodeURIComponent(id)}/claims`);
/** Verify the job NOW against its newest turn — every check fires, `manual`
 *  ones included; `claims` narrows to ids. */
export const verifyJob = (id: string, claims?: string[]) =>
  fetchJSON<JobVerifyResult>(`/jobs/${encodeURIComponent(id)}/verify`, json("POST", claims ? { claims } : {}));

/** One check's verdict on one run (`RunEvidence`, src/claims-authoring.ts). */
export interface RunEvidence {
  claim: { id: string; text: string };
  /** The workflow, or a step it executed — and the version that ran. */
  subject?: { kind: "step" | "workflow"; name: string; version: string };
  /** `open` = an external check's question, still waiting on someone. */
  verdict: "supports" | "refutes" | "open";
  content?: string;
  question?: string;
  observedAt?: number;
  mode?: string;
  check?: string;
  checkVersion?: string;
  by?: string;
  run: ClaimRunRef;
}

export interface RunEvidenceResponse {
  enabled: boolean;
  workflow?: string;
  /** Newest run first; by step path within a run. */
  evidence: RunEvidence[];
  /** Set when the page is full: pass as `before` for older runs. */
  next?: string;
}

/** What the checks said about a workflow's runs. `limit` counts runs. */
export const getRunEvidence = (workflow: string, opts: { runId?: string; before?: string; limit?: number } = {}) => {
  const q = new URLSearchParams(Object.entries(opts).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])));
  return fetchJSON<RunEvidenceResponse>(`/workflows/${encodeURIComponent(workflow)}/evidence${q.size ? `?${q}` : ""}`);
};

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

// ── Proposals (plans/proposals.md) ──────────────────────────────────────────
// A tool call a person approves before it runs: the record a gated agent
// tool wrote, and the decision that applies the step in code.

export type ProposalStatus = "pending" | "accepted" | "rejected" | "applied" | "failed";

export interface ProposalBrief {
  id: string;
  step: string;
  title: string;
  status: ProposalStatus;
  url: string;
  rationale?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface Proposal extends Omit<ProposalBrief, "url" | "decidedAt"> {
  input: unknown;
  by: { workflow: string; runId: string; path: string; job?: string; session?: string; actor?: string; principal?: string };
  decision?: { action: "accept" | "reject"; by?: string; at: string; input?: unknown; reason?: string };
  result?: { output?: unknown; error?: string; cost?: number; at: string };
}

export const getRunProposals = (workflow: string, runId: string) =>
  fetchJSON<{ proposals: ProposalBrief[] }>(`/workflows/${encodeURIComponent(workflow)}/runs/${runId}/proposals`);

export const getProposals = (filter: { job?: string; session?: string; runId?: string; status?: ProposalStatus } = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) if (v !== undefined) q.set(k, v);
  const qs = q.toString();
  return fetchJSON<{ proposals: Proposal[] }>(`/proposals${qs ? `?${qs}` : ""}`);
};

export const getProposal = (id: string) => fetchJSON<Proposal>(`/proposals/${encodeURIComponent(id)}`);

/** Accept (the step runs now) or reject a proposal; the record after. */
export const decideProposal = (id: string, action: "accept" | "reject", reason?: string) =>
  fetchJSON<Proposal>(`/proposals/${encodeURIComponent(id)}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...(reason ? { reason } : {}) }),
  });

// ── Apps (plans/apps.md §7.2, §7.3) ────────────────────────────────────────
// A workspace APP: a front-end project over workflows, published as a
// versioned directory, rendered by strut's own UI as an MCP Apps host
// (components/AppHost.tsx over ./app-host). The document is a FILE of the
// version — `dist/index.html` under `/apps/:name/:version/files`, served
// like a run's artifacts: the listing mints the token, the file opens on it.

export interface AppGrants {
  workflows: string[];
  steps: string[];
  sqlite: boolean;
  automations: string[];
}

export interface AppManifest {
  title: string;
  description?: string;
  icon?: string;
  entry?: string;
  grants: AppGrants;
  data?: { graph?: { types: Record<string, unknown>; edges: unknown[] } };
}

/** `GET /apps`: one row per app. */
export interface AppListEntry {
  name: string;
  activeVersion: string;
  versions: string[];
  title: string;
  description?: string;
  icon?: string;
  grants: AppGrants;
  publisher?: string;
  owner?: string;
}

/** One client-side error the app's page reported (`app/report-error`). */
export interface AppError {
  at: string;
  version: string;
  message: string;
  stack?: string;
  componentStack?: string;
  actor?: string;
  runId: string;
}

/** `GET /apps/:name[?version=]`. */
export interface AppView {
  name: string;
  version: string;
  hash: string;
  manifest: AppManifest;
  active: string;
  versions: Record<string, { createdAt: string; hash: string }>;
  publisher?: string;
  owner?: string;
  dir: string;
  missing: boolean;
  files: string[];
  stale: boolean;
  inertGrants: string[];
  errors?: AppError[];
}

export const listApps = () => fetchJSON<{ apps: AppListEntry[] }>("/apps").then((r) => r.apps);

export const getApp = (name: string, version?: string) =>
  fetchJSON<AppView>(`/apps/${encodeURIComponent(name)}${version ? `?version=${encodeURIComponent(version)}` : ""}`);

export const getAppVersions = (name: string) =>
  fetchJSON<{ name: string; active: string; versions: Record<string, { createdAt: string; hash: string }> }>(`/apps/${encodeURIComponent(name)}/versions`);

/** Rollback: make a version the active one (publishes nothing). */
export const setActiveAppVersion = (name: string, version: string) =>
  fetchJSON<{ ok: true; name: string; active: string }>(`/apps/${encodeURIComponent(name)}/active`, {
    method: "PUT",
    body: JSON.stringify({ version }),
  });

export const deleteApp = (name: string) =>
  fetchJSON<{ ok: true; name: string }>(`/apps/${encodeURIComponent(name)}`, { method: "DELETE" });

/** The scope a version's files are listed and read under — what
 *  `useFileScope` takes, and what `appDocumentPath` is inside. */
export function appFilesScope(name: string, version: string): string {
  return `/apps/${encodeURIComponent(name)}/${version}/files`;
}

/** The version's document, inside its scope. */
export function appDocumentPath(name: string, version: string): string {
  return `${appFilesScope(name, version)}/dist/index.html`;
}

/** The document's bytes, read with the scope's token (`?t=`) — the server
 *  writes the app's identity into the page as it serves it under the token
 *  — else with the UI's own credential. The caller frames the TEXT as a
 *  sandboxed frame's srcdoc: the page runs in an opaque origin, never on
 *  this one. */
export async function fetchAppDocument(name: string, version: string, token: string): Promise<string> {
  const path = appDocumentPath(name, version);
  const res = await apiFetch(`${path}${token ? `?t=${encodeURIComponent(token)}` : ""}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}
