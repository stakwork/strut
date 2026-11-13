import type { SttService } from "./audio/stt.js";
import type { SessionsCapability } from "./session-store.js";
import { jobsCapability, type JobsCapability } from "./jobs.js";
import type { PeersCapability } from "./peers.js";
import type { HistoryCapability } from "./history.js";
import type { Channels } from "./channels.js";
import type { PackagesCapability } from "./packages/indexes.js";
// Type-only: the graph backend stays a lazy, opt-in dependency.
import type { GraphBackend } from "./graph/backend.js";
import type { BrowserService } from "./browser/service.js";
import type { ModelCatalog } from "./llm.js";
/**
 * Standard "capabilities" — the small, generic, host-owned services that
 * LLM-authored adapter STEPS build on (see AGENTS.md "step vs service").
 *
 * An adapter step reaches the outside world through `ctx.services.http` (a
 * fetch-like transport) and `ctx.services.secrets` (credential access), never
 * the global `fetch` / `process.env` directly. Routing I/O through these two
 * capabilities is what makes an adapter:
 *   - **recordable** — `http` returns a PLAIN serializable object (a real
 *     `fetch` Response can't be written to a cassette), so the record/replay
 *     wrapper (`cassette.ts`) can capture and replay it; and
 *   - **leak-free** — secrets flow through one boundary, so the recorder knows
 *     exactly which values to scrub out of the cassette.
 *
 * These are the DEFAULT implementations the standard server injects. Consumers
 * using strut as a library can spread them into — or override them within —
 * their own typed services bag.
 */

import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import {
  dirname as pathDirname,
  join as pathJoin,
  relative as pathRelative,
  resolve as pathResolve,
  sep as pathSep,
} from "node:path";
import { runProcess, type ProcessRequest, type ProcessResult } from "./shell.js";
import { bootEnv, hiddenFromSteps } from "./env.js";
import type { LightningCapability } from "./payments/lightning.js";
import type { EarningsQuery, EarningsView } from "./payments/earnings.js";
import type { HumanTasksCapability } from "./tasks/tasks.js";
import type { TaskTypesCapability } from "./tasks/set-type.js";
import type { PublicViewCapability } from "./public-view.js";
import type { RemoteCapability } from "./remote.js";
import type { KnowledgeCapability } from "./knowledge.js";

// ── secrets ────────────────────────────────────────────────────────────────

/** Credential access. The single boundary through which adapters read secrets
 *  (API keys, tokens). Backed by `process.env` by default; back it with a
 *  persisted {@link SecretReadable} (e.g. a `SecretStore`) for UI-managed
 *  secrets — without touching any adapter. */
export interface SecretsCapability {
  get(name: string): Promise<string | undefined>;
  /** The same boundary bound to one principal (plans/code-change.md §3.2):
   *  `get(name)` resolves that actor's secret first, then whatever this
   *  capability resolves. The runner calls it once per run with the run's
   *  principal, so a step never does — it just reads `secrets.get(NAME)`.
   *  Absent when the deployment has no actor secrets. */
  forPrincipal?(principal: string): SecretsCapability;
}

/** The narrow read surface a secrets capability needs from a backing store —
 *  satisfied by `SecretStore` (secret-store.ts) without importing it here. */
export interface SecretReadable {
  get(name: string): Promise<string | undefined>;
}

/** The read surface of an actor-secret store (actor-secrets.ts). */
export interface ActorSecretReadable {
  get(actor: string, name: string): Promise<string | undefined>;
}

/**
 * Build a secrets capability. Pass either:
 *   - a flat key→value source (defaults to `process.env`), or
 *   - a `SecretReadable` store (e.g. a `SecretStore`), optionally with an
 *     `envFallback` so unset secrets still resolve from `process.env`.
 *
 * The store path is async-aware: a managed secret wins, then the env fallback.
 * With `actors`, the capability can be bound to a principal
 * (`forPrincipal`): that actor's secret wins over everything above.
 */
export function secretsCapability(
  source: Record<string, string | undefined> | SecretReadable = bootEnv(),
  opts: { envFallback?: Record<string, string | undefined>; actors?: ActorSecretReadable } = {},
): SecretsCapability {
  return hideSecrets(unhiddenSecrets(source, opts));
}

const HIDDEN = Symbol("strut.hiddenSecrets");

/** `secrets` answering nothing for a name no step reads (`hiddenFromSteps`,
 *  env.ts: the wallet's `LIGHTNING_*` credentials, `STRUT_SECRET_KEY`),
 *  whoever built it — strut builds every one of its own through this, and
 *  createStrut wraps a host's. A bound capability (`forPrincipal`) is
 *  wrapped too. */
export function hideSecrets(cap: SecretsCapability): SecretsCapability {
  if ((cap as { [HIDDEN]?: true })[HIDDEN]) return cap;
  const hidden: SecretsCapability & { [HIDDEN]?: true } = {
    get: (name: string) => (hiddenFromSteps(name) ? Promise.resolve(undefined) : cap.get(name)),
    ...(cap.forPrincipal ? { forPrincipal: (principal: string) => hideSecrets(cap.forPrincipal!(principal)) } : {}),
  };
  Object.defineProperty(hidden, HIDDEN, { value: true });
  return hidden;
}

function unhiddenSecrets(
  source: Record<string, string | undefined> | SecretReadable,
  opts: { envFallback?: Record<string, string | undefined>; actors?: ActorSecretReadable },
): SecretsCapability {
  let base: SecretsCapability;
  if (typeof (source as SecretReadable).get === "function") {
    const store = source as SecretReadable;
    const fallback = opts.envFallback;
    base = {
      async get(name: string) {
        const v = await store.get(name);
        if (v !== undefined) return v;
        return fallback?.[name];
      },
    };
  } else {
    const flat = source as Record<string, string | undefined>;
    base = {
      async get(name: string) {
        return flat[name];
      },
    };
  }
  const actors = opts.actors;
  if (!actors) return base;
  const withActors: SecretsCapability = {
    get: base.get,
    forPrincipal(principal: string): SecretsCapability {
      const bound: SecretsCapability = {
        async get(name: string) {
          const v = await actors.get(principal, name);
          return v !== undefined ? v : base.get(name);
        },
        // Re-binding replaces the principal rather than stacking.
        forPrincipal: (p) => (p === principal ? bound : withActors.forPrincipal!(p)),
      };
      return bound;
    },
  };
  return withActors;
}

// ── http ─────────────────────────────────────────────────────────────────

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Request body. Objects are JSON-encoded (with a default
   *  `content-type: application/json`); strings are sent as-is. */
  body?: unknown;
  /** Query params appended to the URL. */
  query?: Record<string, string | number | boolean>;
  /** Abort the request after this many milliseconds. */
  timeout?: number;
}

/** A plain, fully-serializable HTTP response — deliberately NOT a `fetch`
 *  Response, so it can be written to / replayed from a cassette. `body` is the
 *  parsed JSON when the response is JSON, otherwise the raw text. */
export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: unknown;
}

/** Fetch-like transport. The blessed path for adapter network I/O. */
export type HttpCapability = (
  url: string,
  opts?: HttpRequestOptions,
) => Promise<HttpResponse>;

/** Minimal shape of the global `fetch` we depend on — kept tiny so a fake can
 *  be injected in tests without pulling in DOM lib types. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  ok: boolean;
  headers: { forEach(cb: (value: string, key: string) => void): void };
  text(): Promise<string>;
}>;

function appendQuery(
  url: string,
  query?: Record<string, string | number | boolean>,
): string {
  if (!query) return url;
  const pairs = Object.entries(query).map(
    ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
  );
  if (!pairs.length) return url;
  return url + (url.includes("?") ? "&" : "?") + pairs.join("&");
}

/** Build an http capability over a `fetch` implementation (defaults to the
 *  global `fetch`). Encodes object bodies as JSON, parses JSON responses, and
 *  returns a plain serializable {@link HttpResponse}. */
export function httpCapability(
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): HttpCapability {
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "httpCapability: no fetch available — pass a fetch implementation",
    );
  }
  return async (url, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    let body: string | undefined;
    if (opts.body !== undefined) {
      if (typeof opts.body === "string") {
        body = opts.body;
      } else {
        body = JSON.stringify(opts.body);
        if (!hasHeader(headers, "content-type")) {
          headers["content-type"] = "application/json";
        }
      }
    }

    const res = await fetchImpl(appendQuery(url, opts.query), {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body,
      ...(opts.timeout ? { signal: AbortSignal.timeout(opts.timeout) } : {}),
    });

    const outHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      outHeaders[key.toLowerCase()] = value;
    });

    const text = await res.text();
    const isJson = (outHeaders["content-type"] ?? "").includes("application/json");
    let parsed: unknown = text;
    if (isJson || looksLikeJson(text)) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    return { status: res.status, ok: res.ok, headers: outHeaders, body: parsed };
  };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

function looksLikeJson(text: string): boolean {
  const t = text.trim();
  return t.startsWith("{") || t.startsWith("[");
}

// ── artifacts ──────────────────────────────────────────────────────────────

/**
 * Per-run artifact storage — files a run produces that later steps (and
 * humans, via `GET /artifacts/:runId/…`) reference. The convention: a step
 * writes a file and puts its RELATIVE path in its output; downstream steps
 * resolve it through this capability (or point an `agent` step's `cwd` at
 * `dir(ctx.runId)` so the built-in file tools see the same files).
 *
 * Artifacts are retained after the run ends — they're part of the run's
 * record, not scratch space (`onRunEnd` does not touch them).
 */
export interface ArtifactsCapability {
  /** Absolute path of the run's artifact directory, created on demand. */
  dir(runId: string): Promise<string>;
  /** Write `content` at `relPath` under the run's dir (subdirectories are
   *  created). Returns the absolute path of the written file. */
  write(runId: string, relPath: string, content: string | Uint8Array): Promise<string>;
  /** Read the file at `relPath` under the run's dir, as bytes.
   *  (`Buffer.from(bytes).toString()` for text.) */
  read(runId: string, relPath: string): Promise<Uint8Array>;
  /** Relative paths of every file under the run's dir (recursive, sorted).
   *  `[]` when the run has no artifacts. */
  list(runId: string): Promise<string[]>;
}

/** Reject run ids / relative paths that could escape the RUN's directory
 *  (one run must not reach another run's files). Returns the resolved
 *  absolute path when safe. The run's own link (`/artifacts/<runId>/<path>`,
 *  what `GET /artifacts/:runId` serves) is taken as `<path>`: callers hand
 *  it back as the path; another run's link still escapes. */
function artifactPath(root: string, runId: string, relPath = ""): string {
  if (!runId || /[/\\]|\.\./.test(runId)) {
    throw new Error(`artifacts: invalid runId "${runId}"`);
  }
  const ownLink = `/artifacts/${runId}/`;
  if (relPath.startsWith(ownLink)) relPath = relPath.slice(ownLink.length);
  const runDir = pathResolve(root, runId);
  const abs = pathResolve(runDir, relPath);
  if (abs !== runDir && !abs.startsWith(runDir + pathSep)) {
    throw new Error(`artifacts: path escapes the artifact root: ${relPath}`);
  }
  return abs;
}

/** Filesystem-backed artifacts capability rooted at `root`
 *  (`<root>/<runId>/<relPath>`). The default the standard server injects,
 *  rooted at `<workspace>/artifacts`. */
export function fileArtifactsCapability(root: string): ArtifactsCapability {
  return {
    async dir(runId) {
      const d = artifactPath(root, runId);
      await mkdir(d, { recursive: true });
      return d;
    },
    async write(runId, relPath, content) {
      const abs = artifactPath(root, runId, relPath);
      await mkdir(pathDirname(abs), { recursive: true });
      await writeFile(abs, content);
      return abs;
    },
    async read(runId, relPath) {
      const abs = artifactPath(root, runId, relPath);
      return new Uint8Array(await readFile(abs));
    },
    async list(runId) {
      const d = artifactPath(root, runId);
      let entries;
      try {
        entries = await readdir(d, { recursive: true, withFileTypes: true });
      } catch (err: any) {
        if (err?.code === "ENOENT") return [];
        throw err;
      }
      return entries
        .filter((e) => e.isFile())
        .map((e) => pathRelative(d, pathJoin(e.parentPath, e.name)))
        .sort();
    },
  };
}

// ── shell ──────────────────────────────────────────────────────────────────

/** A subprocess to run — see `ProcessRequest` (shell.ts). */
export type ShellRequest = ProcessRequest;
/** What it did — a PLAIN serializable object (exit code, captured output). */
export type ShellResult = ProcessResult;

/**
 * Run a program and capture its outcome. The blessed path for a step that
 * shells out — the `exec` core step, or a custom step wrapping a CLI
 * (`ffmpeg`, `yt-dlp`, a Python script under `uv run`) — instead of
 * `child_process` directly, for the same two reasons as `http`:
 *   - **recordable** — the result is a plain object, so run_step's cassette
 *     can capture and replay it; and
 *   - **leak-free** — the child's env is scrubbed to an allowlist
 *     (shell.ts `minimalEnv`) plus what the request adds, so the server's
 *     credentials never reach a subprocess. Credentials a program needs go
 *     in `env` explicitly (the exec step's `secretsEnv` resolves names
 *     through `secrets` and masks the values out of the output).
 * Never throws on a non-zero exit (read `code`); rejects when the program
 * can't be spawned.
 */
export type ShellCapability = (req: ShellRequest) => Promise<ShellResult>;

/** The default shell capability: spawn locally via `runProcess`. */
export function shellCapability(): ShellCapability {
  return (req) => runProcess(req);
}

// ── standard bag ───────────────────────────────────────────────────────────

/** The standard capability shape adapters rely on. Consumers extend this with
 *  their own typed services (graph store, llm client, …). */
export interface StrutCapabilities {
  http: HttpCapability;
  /** The history (src/history.ts, plans/concept-history.md): what
   *  `history/read` reads, and what a run's graph view tells. Set by the
   *  standard server wherever it has a graph and `git`. */
  history?: HistoryCapability;
  secrets: SecretsCapability;
  /** Per-run artifact files. Present on the standard server (rooted in the
   *  workspace); optional because a bare in-code bag may not carry one. */
  artifacts?: ArtifactsCapability;
  /** Subprocesses (the `exec` step, CLI-wrapping custom steps). Injected by
   *  `standardServices`; optional because a bare in-code bag may not carry
   *  one — the exec step falls back to a local `shellCapability()`. */
  shell?: ShellCapability;
  /** Speech-to-text (src/audio). Present on the standard server; a step can
   *  transcribe through it without importing sherpa. Optional because a
   *  bare in-code bag may not carry one. */
  stt?: SttService;
  /** Agent sessions (session-store.ts): the threads an `agent` step with
   *  `session` set continues. Present on the standard server; optional
   *  because a bare in-code bag may not carry one. */
  sessions?: SessionsCapability;
  /** The deployment's local data directory — where artifacts, cassettes and
   *  the git cache/worktrees (`git/*` steps) live. Set by the standard
   *  server; a bare in-code bag may not carry one (steps fall back to the OS
   *  temp dir). */
  dataDir?: string;
  /** A job's holds (jobs.ts; plans/jobs.md §6): what a tool claimed that must
   *  outlive the run — a pod — recorded with the step that lets it go, which
   *  strut runs when the job is deleted or swept. Present wherever the bag
   *  has a `dataDir`. */
  jobs?: JobsCapability;
  /** The Knowledge door (src/knowledge.ts): what a workflow that tends the
   *  Concept tree works through — a page as a tender reads it, the claims
   *  on it, a claim written with the standard check, what a person said as
   *  evidence. Set by the standard server wherever the claims layer is on;
   *  the `knowledge/*` steps are thin over it. */
  knowledge?: KnowledgeCapability;
  /** The other struts this one may call (peers.ts; plans/federation.md
   *  §2.2): name a peer, make a request with its token injected — the
   *  token itself is readable by nothing. Set by the standard server; a
   *  bare in-code bag may not carry one (`strut/run-workflow` then fails
   *  naming it). */
  peers?: PeersCapability;
  /** App CHANNELS (src/channels.ts; plans/app-channels.md): live messages
   *  between the people on an app. What the `channel/*` steps reach, for code
   *  an app runs (`ctx.app`). Set by the standard server. */
  channels?: Channels;
  /** The package STORE (src/packages/indexes.ts): the reads — `search`
   *  over the indexes this strut follows and the peers' installed packages,
   *  `get` a package's page, `concepts` / `concept` the Concept tree — what
   *  the `package/*` steps and the assistant door's package tools read; and
   *  `install`, `package/install`'s door, which opens only to an ACCEPTED
   *  proposal of that step (plans/marketplace.md §8). Set by the standard
   *  server. */
  packages?: PackagesCapability;
  /** The graph backend the SERVER wired (`createStrut({ graph })`, else the
   *  one behind a graph-backed workspace): what the `graph/*` steps read and
   *  write through, instead of opening one from env (`graphCtx` prefers it
   *  and falls back to `NEO4J_*` when it is absent). A Neo4j or a LadybugDB
   *  file (plans/ladybug-backend.md). */
  graph?: GraphBackend;
  /** The browser the `browser/*` steps drive (src/browser/service.ts): one
   *  Playwright connection, a context per run, closed when the run ends.
   *  Built by the standard server from `BROWSER_*`; a host's own wins.
   *  Optional because a bare in-code bag may not carry one (the steps then
   *  fail naming it). */
  browser?: BrowserService;
  /** The model catalog `GET /llm/models` serves (src/llm.ts
   *  `listModelOptions`): every model aieo knows, each with whether people
   *  may pick it (the host's `STRUT_MODELS`, else a key for its provider
   *  here), and the deployment's default. What `llm/models` reads. Set by
   *  the standard server; a bare bag falls back to the catalog with no boot
   *  default. */
  llmModels?: () => Promise<ModelCatalog>;
  /** The server's wallet, its RECEIVE side (plans/paid-runs.md §9,
   *  src/payments/lightning.ts): make an invoice, look one up, list what
   *  came in, read the balance. Nothing on it pays. Present only while a
   *  wallet is set (`LIGHTNING_*`, `PUT /earnings/wallet`); a host's own
   *  wins. */
  lightning?: LightningCapability;
  /** What this server earned (plans/paid-runs.md §8, src/payments/earnings.ts):
   *  the read `GET /earnings` answers, what the `earnings/read` step is thin
   *  over. Reads only: nothing on it pays — the payer is never on the bag. */
  earnings?: { read(q?: EarningsQuery): Promise<EarningsView> };
  /** Another strut's public door (plans/paid-runs.md §10, src/remote.ts):
   *  what it sells, a run or a tool call there with the credit this strut
   *  holds — injected, never handed out — and the door an ACCEPTED
   *  `remote/buy-credit` proposal pays through. The payer is not on it. */
  remote?: RemoteCapability;
  /** The TASK STORE (plans/human-steps.md §4, src/tasks/tasks.ts): people as
   *  a step of a workflow. On the shared bag, `ensure` alone — the `human`
   *  step's call (§9.2): no step, workflow or agent tool reaches the
   *  worker's calls or the staff's. A `worker: true` step's own call on an
   *  app door (`step_run`) gets the worker's calls in its place (§5.2,
   *  `TasksService.worker`); the staff reach the store through the `/tasks`
   *  routes alone. Set by the standard server; a host's own is kept as it
   *  is. */
  tasks?: HumanTasksCapability;
  /** The TASK TYPES (plans/human-steps.md §9.2, §9.8, src/tasks/set-type.ts):
   *  `list()` — each type with its open tasks, how many workers hold it and
   *  its answers in the last week — the card's reads, and `save`, which
   *  opens only for an ACCEPTED `task/set-type` proposal on disk (an admin's)
   *  for that name and input. Nothing on it grants a worker, deletes a type
   *  or changes a worker. Set by the standard server; a host's own wins. */
  taskTypes?: TaskTypesCapability;
  /** The PUBLIC VIEW's door for an agent's ask (src/public-view.ts;
   *  plans/public-surface.md §2 "The door"): `plan` — what adding an app
   *  brings into view, who can sign in, the card's reads — and `addApp`,
   *  which opens only for an ACCEPTED `app/make-public` proposal on disk (an
   *  admin's) for that app and version, and writes through `PUT
   *  /public-view`'s own save. Nothing on it removes from the view. Set by
   *  the standard server; a host's own wins. */
  publicView?: PublicViewCapability;
}

/** The default standard services bag: global-fetch http + secrets + a local
 *  shell. Secrets are
 *  env-backed by default; pass `secretStore` for a persisted (UI-managed) store
 *  with `process.env` as fallback. Injected by the standard server; override
 *  per environment as needed. */
export function standardServices(
  opts: {
    fetchImpl?: FetchLike;
    secretsSource?: Record<string, string | undefined>;
    secretStore?: SecretReadable;
    /** Per-actor secrets (actor-secrets.ts): lets the runner bind `secrets`
     *  to a run's principal. */
    actorSecretStore?: ActorSecretReadable;
    dataDir?: string;
  } = {},
): StrutCapabilities {
  const actors = opts.actorSecretStore;
  const secrets = opts.secretStore
    ? secretsCapability(opts.secretStore, { envFallback: bootEnv(), ...(actors ? { actors } : {}) })
    : secretsCapability(opts.secretsSource, actors ? { actors } : {});
  return {
    http: httpCapability(opts.fetchImpl),
    secrets,
    shell: shellCapability(),
    ...(opts.dataDir ? { dataDir: opts.dataDir, jobs: jobsCapability(opts.dataDir) } : {}),
  };
}
