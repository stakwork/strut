/**
 * The `/public` routes (plans/public-surface.md §3; decision 13, ruled):
 * what a person made public on this strut server, read by anyone, live.
 *
 * A route family of its own. Each route answers from the surface alone
 * (src/public-surface.ts) whatever the gate's mode, so a host whose gate
 * sits in front of an unkeyed strut (mcp's `/lab`) passes the prefix by
 * path and strut still serves nothing else; a route nobody mounted here
 * does not exist here. Paths mirror the private ones (`/public/workflows/
 * :name/flow` is `/workflows/:name/flow` for a public workflow), and so do
 * the shapes, minus what a visitor never reads: who launched or owns a
 * thing (actors are deferred), schedules, the job and conversation a run
 * belonged to, callback and MCP origins. Every answer carries
 * `access-control-allow-origin: *` (the store reads a publisher's items
 * from the visitor's browser) and no cookie.
 *
 * Reads, and `POST /public/mcp` (mounted by createStrut). `GET /public`
 * also lists what anyone may RUN (plans/paid-runs.md §2): price, reserve,
 * input and recent runs — never its definition unless that is public too.
 * And anyone may START one (§3, work item 3: free items): `POST
 * /public/workflows/:name/run` answers with a RUN TOKEN that opens that
 * run's reads here — as far as the item's `results` allows — and its
 * cancel, and nothing else. The policy behind a launch (the caps, the
 * charge at the end) is src/public-runs.ts; the launch itself createStrut's.
 * `/public-view`, the person's door to the record, is mounted by
 * createStrut behind the gate like any write.
 */
import type { Context, Hono } from "hono";
import type { Flow, RunEvent, StepRegistry } from "./core.js";
import type { RunStore } from "./store.js";
import { summarizeFromEvents } from "./store.js";
import type { WorkspaceStore } from "./workspace.js";
import type { ArtifactsCapability } from "./capabilities.js";
import type { PublicSurfaceService } from "./public-surface.js";
import type { ListedRunnable } from "./public-runnable.js";
import { publicEvent, publicSummary, stepHelpers } from "./public-surface.js";
import { runsPage } from "./runs.js";
import { searchWorkflows } from "./search.js";
import { resolveStep } from "./steps/registry.js";
import { zodToFields } from "./ai/schemaHelpers.js";
import { isPublicRunToken, presentedRunToken, publicRunToken } from "./auth.js";
import { isPriced } from "./public-runnable.js";
import { PUBLIC_LAUNCHES_PER_MINUTE, PUBLIC_RUN_BODY_MAX_BYTES, PUBLIC_RUN_KEY_MAX, PUBLIC_RUN_WAIT_MAX_S, type PublicRuns } from "./public-runs.js";

export interface PublicRouteDeps {
  surface: PublicSurfaceService;
  workspace: WorkspaceStore;
  store: RunStore;
  /** The live registry (it changes at every rebuild). */
  registry: () => StepRegistry;
  /** Where each registry step came from (`core` | `lib` | `custom`). */
  stepSources: () => Record<string, string>;
  artifacts?: ArtifactsCapability;
  /** The headers a run's file is served with (createStrut's sandbox:
   *  untrusted content, no script). */
  fileHeaders: (path: string) => Record<string, string>;
  /** A live run's state (`running`, `paused`, …), else `stale`. */
  liveStatus: (workflow: string, runId: string) => string;
  /** Requests per visitor address per minute (`PUBLIC_REQUESTS_PER_MINUTE`). */
  ratePerMinute?: number;
  /** The apps in the public view, each at the version it serves: what a
   *  visitor's host lists and frames (plans/public-surface.md §5). */
  apps?: {
    info(name: string): Promise<PublicAppInfo | null>;
    /** The document with the PUBLIC identity written in (`publicAppIdentity`). */
    document(name: string): Promise<{ version: string; html: string } | null>;
  };
  /** The headers an app's document is served with (it runs: it is the app). */
  documentHeaders?: (path: string) => Record<string, string>;
  /** What anyone may run, and for how much (plans/paid-runs.md §2,
   *  `listRunnable`): `GET /public`'s `runnable`. */
  runnable?: () => Promise<ListedRunnable[]>;
  /** Public RUNS (plans/paid-runs.md §3): the launch, the launcher's reads
   *  with the run token, cancel. Absent: nothing launches here. */
  launches?: PublicLaunchDeps;
}

/** What the launch and cancel routes need of the server. */
export interface PublicLaunchDeps {
  runs: PublicRuns;
  /** Why nothing new starts now (the drain, src/drain.ts), else undefined. */
  draining(): string | undefined;
  /** Why the workflow refuses every launch now (disabled), else undefined. */
  disabled(name: string): Promise<string | undefined>;
  /** The workflow's own cost cap in dollars (`resolveRunCap` over its
   *  `maxRunCostUsd`); undefined when it cannot be read. */
  workflowCap(name: string): Promise<number | undefined>;
  /** Launch the run detached, as published, `origin: "public"`, under the
   *  id the caps minted, with its cap (`RunOptions.maxCostUsd`). */
  launch(flow: Flow, input: unknown, o: { runId: string; maxCostUsd?: number }): void;
  /** Cancel a live run's tree: 202, or why not (404, 409). */
  cancel(name: string, runId: string): Promise<{ status: 202 | 404 | 409; body: Record<string, unknown> }>;
  /** Launches one visitor address may make a minute (`PUBLIC_LAUNCHES_PER_MINUTE`). */
  perMinute?: number;
}

/** A public app as a visitor's host reads it. */
export interface PublicAppInfo {
  name: string;
  /** The version the public view serves: the held release's. */
  version: string;
  title: string;
  description?: string;
  icon?: string;
}

/** Every path this module serves: what the gate opens to anyone — its
 *  reads by path, and these POSTs by name. */
export const PUBLIC_PATH = /^\/public(?:\/|$)/;
/** The POSTs anyone may make: a visitor's page calling its app, a launch,
 *  and the launcher's cancel. */
export const PUBLIC_POST = /^\/public\/(?:mcp|workflows\/[^/]+\/(?:run|runs\/[^/]+\/cancel))$/;

/** Requests one visitor address may make to `/public` in a minute. */
export const PUBLIC_REQUESTS_PER_MINUTE = 1200;

/** The visitor's address: the first `x-forwarded-for` hop when a proxy in
 *  front set one, else the socket's. A budget, not a boundary — a client
 *  can name any address in the header. */
export function visitorAddress(c: Context): string {
  const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (fwd) return fwd;
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? "unknown";
}

const enc = encodeURIComponent;
/** The link a public run event carries for an agent session. */
export const publicTranscriptUrl = (workflow: string, runId: string, path: string) =>
  `/public/workflows/${enc(workflow)}/runs/${enc(runId)}/transcripts/${path.split("/").map(enc).join("/")}`;

/** A relative path a run's output names as one of its files, or undefined:
 *  `./` dropped, nothing absolute, no `..`, no URL. */
function relativeFile(v: unknown): string | undefined {
  if (typeof v !== "string" || !v || /^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith("/")) return undefined;
  const p = v.replace(/^(?:\.\/)+/, "");
  return p && !p.split("/").includes("..") ? p : undefined;
}

/** The files a run's output declares (`artifacts[].path`, and `render`
 *  when it is a file): what a launcher shown the output alone may read. */
export function declaredPaths(output: unknown): Set<string> {
  const out = new Set<string>();
  const list = (output as { artifacts?: unknown } | null | undefined)?.artifacts;
  if (!Array.isArray(list)) return out;
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    for (const k of ["path", "render"] as const) {
      const p = relativeFile((e as Record<string, unknown>)[k]);
      if (p) out.add(p);
    }
  }
  return out;
}

/** What the launcher of an item that shows its output alone reads of the
 *  summary: never its step counts, nor where an error was raised. */
function outputOnly(s: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["runId", "workflow", "status", "startedAt", "finishedAt", "durationMs", "input", "output", "origin", "totals"]) {
    if (s[k] !== undefined) out[k] = s[k];
  }
  const err = s["error"] as { message?: unknown } | undefined;
  if (err && typeof err === "object") out["error"] = { message: String(err.message ?? "") };
  return out;
}

/** A run's declared artifacts as its launcher opens them: a file here at
 *  its `/public` link (the run token goes beside it, `?t=`), an absolute
 *  link or inline content as declared. */
function launcherArtifacts(name: string, runId: string, output: unknown): Array<Record<string, unknown>> | undefined {
  const list = (output as { artifacts?: unknown } | null | undefined)?.artifacts;
  if (!Array.isArray(list)) return undefined;
  const base = `/public/workflows/${enc(name)}/runs/${enc(runId)}/files/`;
  const link = (p: string) => base + p.split("/").map(enc).join("/");
  const out: Array<Record<string, unknown>> = [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (typeof r["id"] !== "string" || typeof r["title"] !== "string") continue;
    const entry: Record<string, unknown> = { id: r["id"], title: r["title"] };
    for (const k of ["kind", "label", "summary"]) if (typeof r[k] === "string") entry[k] = r[k];
    const path = relativeFile(r["path"]);
    if (path) entry["url"] = link(path);
    else if (typeof r["url"] === "string" && /^https?:\/\//i.test(r["url"])) entry["url"] = r["url"];
    const render = relativeFile(r["render"]);
    if (render) entry["render"] = link(render);
    if (r["content"] !== undefined && r["content"] !== null) entry["content"] = r["content"];
    out.push(entry);
  }
  return out;
}

export function publicRoutes(app: Hono<any>, deps: PublicRouteDeps): void {
  const { surface, workspace, store } = deps;
  const notPublic = (c: Context, what: string) => c.json({ error: `${what} is not public on this strut server` }, 404);

  // Before every route below: a browser on another origin may read these
  // (the store draws a publisher's items in the visitor's browser), a
  // preflight is answered here, and each visitor address has a budget per
  // minute. Reads and the visitor door only: a write elsewhere under the prefix gets no CORS.
  const limit = deps.ratePerMinute ?? PUBLIC_REQUESTS_PER_MINUTE;
  const counts = new Map<string, { minute: number; n: number }>();
  const publicMiddleware = async (c: Context, next: () => Promise<void>) => {
    const method = c.req.method;
    if (method === "OPTIONS") {
      return c.body(null, 204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, POST",
        // `authorization`: a launcher's run token as a Bearer.
        "access-control-allow-headers": "content-type, accept, authorization, mcp-protocol-version",
        "access-control-max-age": "600",
      });
    }
    // Reads, a visitor's page calling its app (`POST /public/mcp`), and a
    // launch and its cancel (plans/paid-runs.md §3).
    if (method !== "GET" && method !== "HEAD" && !(method === "POST" && PUBLIC_POST.test(c.req.path))) return next();
    const minute = Math.floor(Date.now() / 60_000);
    const who = visitorAddress(c);
    const at = counts.get(who);
    if (!at || at.minute !== minute) {
      if (counts.size > 10_000) for (const [k, v] of counts) if (v.minute !== minute) counts.delete(k);
      counts.set(who, { minute, n: 1 });
    } else if (++at.n > limit) {
      return c.json({ error: `too many requests: ${limit} a minute` }, 429, { "access-control-allow-origin": "*", "retry-after": "60" });
    }
    c.header("access-control-allow-origin", "*");
    await next();
  };
  // One registration: Hono's `/public/*` matches `/public` too.
  app.use("/public/*", publicMiddleware);

  /** The workflow when it is public, else the 404 to answer. */
  const publicWorkflow = async (c: Context) => {
    const name = c.req.param("name") ?? "";
    const w = await surface.workflow(name);
    if (!w) return notPublic(c, `workflow "${name}"`);
    const meta = await workspace.getWorkflowMetadata(name);
    if (!meta) return notPublic(c, `workflow "${name}"`);
    return { name, w, meta };
  };

  /** A run this request may read, and how much of it: `all` — its
   *  workflow's runs are public, or it is the launcher's (the run token) and
   *  the item shows its launcher the whole run (`results: "run"`); `output`
   *  — the launcher's, the summary and the declared artifacts' files alone
   *  (plans/paid-runs.md §3, "What the launcher reads"). A launcher's run is
   *  one this server launched in public, whether or not its workflow is. */
  type OpenRun = { name: string; runId: string; events: RunEvent[]; open: "all" | "output"; launcher: boolean };
  const publicRun = async (c: Context): Promise<OpenRun | Response> => {
    const name = c.req.param("name") ?? "";
    const runId = c.req.param("runId") ?? "";
    // A run id is one path segment: anything else could name another
    // workflow's run through the file store's directories.
    if (!runId || /[/\\]|\.\./.test(runId)) return c.json({ error: `no run "${runId}" of "${name}"` }, 404);
    const token = presentedRunToken(c);
    if (deps.launches && token !== undefined && isPublicRunToken(name, runId, token)) {
      const events = await store.getRunEvents(name, runId);
      const start = events.find((e) => e.type === "run.start");
      // Right after its 202 a run may not have written `run.start` yet.
      if (start ? start.origin !== "public" : !deps.launches.runs.pending(name, runId)) return c.json({ error: `no run "${runId}" of "${name}"` }, 404);
      const all = (await surface.workflow(name))?.runs || (await surface.runnable("workflow", name))?.results === "run";
      return { name, runId, events, open: all ? "all" : "output", launcher: true };
    }
    const got = await publicWorkflow(c);
    if (got instanceof Response) return got;
    if (!got.w.runs) return notPublic(c, `the runs of "${got.name}"`);
    const events = await store.getRunEvents(got.name, runId);
    if (!events.length) return c.json({ error: `no run "${runId}" of "${got.name}"` }, 404);
    return { name: got.name, runId, events, open: "all", launcher: false };
  };
  /** The run, when this request may read all of it. */
  const wholeRun = async (c: Context): Promise<OpenRun | Response> => {
    const got = await publicRun(c);
    if (got instanceof Response || got.open === "all") return got;
    return c.json({ error: `the run's events, transcripts and files are not public: "${got.name}" shows its launcher the output alone` }, 404);
  };
  /** The files a run's output declares, as relative paths. */
  const declaredFiles = async (got: OpenRun): Promise<Set<string>> =>
    declaredPaths((await store.getRunSummary(got.name, got.runId))?.output);

  const listedWorkflows = async () => {
    const s = await surface.get();
    const all = new Map((await workspace.listWorkflows()).map((w) => [w.name, w]));
    return s.workflows.flatMap((p) => {
      const w = all.get(p.name);
      if (!w) return [];
      return [{
        name: w.name,
        activeVersion: w.activeVersion,
        versions: w.versions,
        ...(w.description ? { description: w.description } : {}),
        ...(w.category ? { category: w.category } : {}),
        runs: !!p.runs,
      }];
    });
  };

  const listedSteps = async () => {
    const registry = deps.registry();
    const sources = deps.stepSources();
    return (await surface.get()).steps.flatMap((type) => {
      const def = registry[type];
      if (!def) return [];
      return [{
        type,
        source: sources[type] ?? "core",
        ...(def.description ? { description: def.description } : {}),
        ...(def.effect === "read" || def.effect === "write" ? { effect: def.effect } : {}),
      }];
    });
  };

  // ── The surface ─────────────────────────────────────────────────────────

  app.get("/public", async (c) => {
    const s = await surface.get();
    const tree = s.concepts.length ? await surface.conceptTree() : undefined;
    const roots = tree ? tree.concepts.filter((x) => !x.parent) : [];
    return c.json({
      workflows: await listedWorkflows(),
      steps: await listedSteps(),
      concepts: roots.map((r) => ({ name: r.name, ...(r.description ? { description: r.description } : {}), pages: tree!.concepts.filter((x) => x.root === r.root).length })),
      types: s.types,
      apps: await listedApps(),
      // Listed whether or not its definition is public (decision 11).
      runnable: (await deps.runnable?.()) ?? [],
    });
  });

  // ── Apps ────────────────────────────────────────────────────────────────

  const listedApps = async (): Promise<PublicAppInfo[]> => {
    if (!deps.apps) return [];
    const out: PublicAppInfo[] = [];
    for (const a of (await surface.get()).apps) {
      const info = await deps.apps.info(a.name).catch(() => null);
      if (info) out.push(info);
    }
    return out;
  };

  app.get("/public/apps", async (c) => c.json(await listedApps()));

  // The page itself: the document of the version the public view serves,
  // carrying the PUBLIC identity (it opens `POST /public/mcp` for this app
  // and nothing else) and `<meta name="strut-public-view">`, which the kit
  // reads as `useHost().public`.
  app.get("/public/apps/:name{.+}/document", async (c) => {
    const name = c.req.param("name");
    if (!deps.apps || !(await surface.get()).apps.some((a) => a.name === name)) return notPublic(c, `app "${name}"`);
    const doc = await deps.apps.document(name).catch(() => null);
    if (!doc) return notPublic(c, `app "${name}"`);
    return c.body(doc.html, 200, { ...(deps.documentHeaders?.("dist/index.html") ?? { "content-type": "text/html; charset=utf-8" }), "cache-control": "no-cache" });
  });

  app.get("/public/apps/:name{.+}", async (c) => {
    const name = c.req.param("name");
    if (!deps.apps || !(await surface.get()).apps.some((a) => a.name === name)) return notPublic(c, `app "${name}"`);
    const info = await deps.apps.info(name).catch(() => null);
    return info ? c.json(info) : notPublic(c, `app "${name}"`);
  });

  // ── Workflows ───────────────────────────────────────────────────────────

  app.get("/public/workflows", async (c) => c.json(searchWorkflows(await listedWorkflows(), c.req.query("q") ?? "")));

  app.get("/public/workflows/:name", async (c) => {
    const got = await publicWorkflow(c);
    if (got instanceof Response) return got;
    const { meta, name, w } = got;
    return c.json({
      name,
      active: meta.active,
      ...(meta.category ? { category: meta.category } : {}),
      runs: !!w.runs,
      versions: Object.fromEntries(Object.entries(meta.versions).map(([v, info]) => [v, {
        createdAt: info.createdAt,
        ...(info.description ? { description: info.description } : {}),
        hash: info.hash,
        ...(info.source ? { source: info.source } : {}),
      }])),
    });
  });

  app.get("/public/workflows/:name/versions", async (c) => {
    const got = await publicWorkflow(c);
    if (got instanceof Response) return got;
    const versions = Object.entries(got.meta.versions)
      .map(([version, info]) => ({
        version,
        createdAt: info.createdAt,
        ...(info.description ? { description: info.description } : {}),
        ...(info.source ? { source: info.source } : {}),
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return c.json({ active: got.meta.active, versions });
  });

  app.get("/public/workflows/:name/flow", async (c) => {
    const got = await publicWorkflow(c);
    if (got instanceof Response) return got;
    const version = c.req.query("version");
    try {
      const flow = version ? await workspace.getWorkflowVersion(got.name, version) : await workspace.getWorkflow(got.name);
      return c.json({
        name: flow.name,
        steps: flow.steps,
        ...(flow.inputBlock != null ? { input: flow.inputBlock } : {}),
        ...(flow.params != null ? { params: flow.params } : {}),
        ...(flow.sealed ? { sealed: true } : {}),
        ...(flow.peer ? { peer: flow.peer } : {}),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  // ── Runs (only a workflow whose runs are public) ────────────────────────

  app.get("/public/workflows/:name/runs", async (c) => {
    const got = await publicWorkflow(c);
    if (got instanceof Response) return got;
    if (!got.w.runs) return notPublic(c, `the runs of "${got.name}"`);
    const page = runsPage(await store.listRuns(got.name), { limit: c.req.query("limit"), before: c.req.query("before") });
    const runs = await Promise.all(page.map(async (runId) => {
      const summary = await store.getRunSummary(got.name, runId);
      return summary ? publicSummary(summary) : { runId, workflow: got.name, status: deps.liveStatus(got.name, runId) };
    }));
    return c.json(runs);
  });

  app.get("/public/workflows/:name/runs/:runId", async (c) => {
    const got = await publicRun(c);
    if (got instanceof Response) return got;
    if (got.launcher) return launcherView(c, got);
    const summary = await store.getRunSummary(got.name, got.runId);
    if (summary) return c.json(publicSummary(summary));
    const partial = summarizeFromEvents(got.name, got.runId, got.events, deps.liveStatus(got.name, got.runId));
    return partial ? c.json(publicSummary(partial as unknown as Record<string, unknown>)) : c.json({ error: `no run "${got.runId}"` }, 404);
  });

  /** The launcher's view (plans/paid-runs.md §3): the run's status, input,
   *  output, error, what it spent and its declared artifacts with links
   *  here — and, once it ended and was charged, `charged`, in dollars. A
   *  free run is charged nothing: `charged: 0`, its cost (`totals.cost`) the
   *  seller's. `?wait=<s>` holds while it is in flight (at most 55 s). With
   *  `results: "run"`, the summary as a public run shows it. */
  const launcherView = async (c: Context, got: OpenRun) => {
    const runs = deps.launches!.runs;
    const waitS = Number(c.req.query("wait") ?? 0);
    const deadline = Date.now() + 1000 * Math.min(PUBLIC_RUN_WAIT_MAX_S, Number.isFinite(waitS) && waitS > 0 ? waitS : 0);
    let summary = await store.getRunSummary(got.name, got.runId);
    while ((!summary || runs.pending(got.name, got.runId)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      summary = await store.getRunSummary(got.name, got.runId);
    }
    const ended = !!summary && !runs.pending(got.name, got.runId);
    let base: Record<string, unknown>;
    if (summary) base = { ...summary };
    else {
      const events = await store.getRunEvents(got.name, got.runId);
      const partial = summarizeFromEvents(got.name, got.runId, events, deps.liveStatus(got.name, got.runId));
      base = partial ? { ...(partial as unknown as Record<string, unknown>) } : { runId: got.runId, workflow: got.name, status: deps.liveStatus(got.name, got.runId) };
    }
    const shown = got.open === "all" ? publicSummary(base) : outputOnly(base);
    const artifacts = launcherArtifacts(got.name, got.runId, summary?.output);
    return c.json({
      ...shown,
      ...(artifacts ? { artifacts } : {}),
      // Item 5 reads a priced run's charge from the ledger.
      ...(ended ? { charged: 0 } : {}),
    });
  };

  app.get("/public/workflows/:name/runs/:runId/events", async (c) => {
    const got = await wholeRun(c);
    if (got instanceof Response) return got;
    return c.json(got.events.map((e: RunEvent) => publicEvent(e, (path) => publicTranscriptUrl(got.name, got.runId, path))));
  });

  // One agent session by step path. Never `?full=1`: a thread's earlier
  // turns may be another run's, of another workflow.
  app.get("/public/workflows/:name/runs/:runId/transcripts/:path{.+}", async (c) => {
    const got = await wholeRun(c);
    if (got instanceof Response) return got;
    const path = c.req.param("path");
    const end = got.events.filter((e) => e.type === "step.end" && e.path === path && e.messages).pop();
    return end ? c.json(end.messages) : c.json({ error: `No transcript at "${path}" in run "${got.runId}"` }, 404);
  });

  // The run's own files (its artifacts directory). A job run's files live in
  // the job's directory, which other runs share: not public in v1.
  // A launcher shown the output alone reads the files the run's output
  // declares (`artifacts[].path`, `render`) and no other.
  app.get("/public/workflows/:name/runs/:runId/files", async (c) => {
    const got = await publicRun(c);
    if (got instanceof Response) return got;
    if (!deps.artifacts) return c.json({ runId: got.runId, files: [] });
    try {
      const files = await deps.artifacts.list(got.runId);
      if (got.open === "all") return c.json({ runId: got.runId, files });
      const declared = await declaredFiles(got);
      return c.json({ runId: got.runId, files: files.filter((f) => declared.has(f)) });
    } catch {
      return c.json({ runId: got.runId, files: [] });
    }
  });

  app.get("/public/workflows/:name/runs/:runId/files/:path{.+}", async (c) => {
    const got = await publicRun(c);
    if (got instanceof Response) return got;
    const relPath = c.req.param("path");
    if (!deps.artifacts) return c.json({ error: `file not found: ${relPath}` }, 404);
    if (got.open === "output" && !(await declaredFiles(got)).has(relPath)) return c.json({ error: `file not found: ${relPath}` }, 404);
    try {
      const bytes = await deps.artifacts.read(got.runId, relPath);
      return c.body(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 200, deps.fileHeaders(relPath));
    } catch (err: any) {
      if (err?.code === "ENOENT" || err?.code === "EISDIR") return c.json({ error: `file not found: ${relPath}` }, 404);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ── Launching (plans/paid-runs.md §3) ───────────────────────────────────

  // A launch, in order, each step answering before the next costs anything:
  // the per-address budget, the item (404 when nobody made it runnable),
  // the drain, the body, the caps (src/public-runs.ts), the price, then the
  // run. Item 5 puts the credit token's 402 and the hold in the price's place.
  const launchLimit = deps.launches?.perMinute ?? PUBLIC_LAUNCHES_PER_MINUTE;
  const launchCounts = new Map<string, { minute: number; n: number }>();
  const overLaunchBudget = (who: string): boolean => {
    const minute = Math.floor(Date.now() / 60_000);
    const at = launchCounts.get(who);
    if (!at || at.minute !== minute) {
      if (launchCounts.size > 10_000) for (const [k, v] of launchCounts) if (v.minute !== minute) launchCounts.delete(k);
      launchCounts.set(who, { minute, n: 1 });
      return false;
    }
    return ++at.n > launchLimit;
  };

  app.post("/public/workflows/:name/run", async (c) => {
    const launches = deps.launches;
    const name = c.req.param("name");
    const who = visitorAddress(c);
    if (overLaunchBudget(who)) return c.json({ error: `too many launches: ${launchLimit} a minute` }, 429, { "retry-after": "60" });
    const item = launches ? await surface.runnable("workflow", name) : undefined;
    const flow = item ? await workspace.getWorkflow(name).catch(() => null) : null;
    if (!launches || !item || !flow || flow.sealed) return c.json({ error: `workflow "${name}" is not open to anyone to run on this strut server` }, 404);
    const draining = launches.draining();
    if (draining) return c.json({ error: draining }, 503, { "retry-after": "60" });

    // The body: `input` and `key` alone, validated against the `input:`
    // block. Nothing a stranger sends picks the version, the knobs, a job,
    // a callback or files.
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > PUBLIC_RUN_BODY_MAX_BYTES) return c.json({ error: `the body is over ${PUBLIC_RUN_BODY_MAX_BYTES / 1024} KB` }, 413);
    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > PUBLIC_RUN_BODY_MAX_BYTES) return c.json({ error: `the body is over ${PUBLIC_RUN_BODY_MAX_BYTES / 1024} KB` }, 413);
    let body: Record<string, unknown>;
    try {
      body = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return c.json({ error: "the body is not JSON" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "the body is a JSON object: { input?, key? }" }, 400);
    const extra = Object.keys(body).filter((k) => k !== "input" && k !== "key");
    if (extra.length) return c.json({ error: `a public launch runs the workflow as published and takes { input, key } alone — drop ${extra.join(", ")}` }, 400);
    const key = body["key"];
    if (key !== undefined && (typeof key !== "string" || !key || key.length > PUBLIC_RUN_KEY_MAX)) {
      return c.json({ error: `key is a string of 1 to ${PUBLIC_RUN_KEY_MAX} characters` }, 400);
    }
    if (flow.inputBlock == null) return c.json({ error: `workflow "${name}" no longer declares an input: block, so a stranger's input cannot be checked` }, 409);
    const parsed = flow.input.safeParse(body["input"] ?? {});
    if (!parsed.success) return c.json({ error: `input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}` }, 400);
    const disabled = await launches.disabled(name);
    if (disabled) return c.json({ error: disabled }, 409);

    // The caps. A `key` this address sent for a run still in flight returns
    // that run, before any cap counts it twice.
    const admitted = await launches.runs.admit(item, {
      ...(await launches.workflowCap(name).then((cap) => (cap !== undefined ? { workflowCapUsd: cap } : {}))),
      ...(typeof key === "string" ? { key, scope: who } : {}),
    });
    if (admitted.ok === "existing") return c.json({ runId: admitted.runId, token: publicRunToken(name, admitted.runId), existing: true }, 202);
    if (!admitted.ok) return c.json({ error: admitted.error }, admitted.status, { "retry-after": String(admitted.retryAfter) });

    // The price. Item 5 (plans/paid-runs.md §4, §5) replaces this refusal
    // with the credit token: none, or one short of the reserve, is a 402
    // with an L402 challenge; a good one has the reserve set aside here.
    if (isPriced(item)) {
      admitted.release();
      return c.json(
        { error: `priced_runs_not_built: workflow "${name}" is priced, and this strut server does not take payment for a run yet`, code: "priced_runs_not_built" },
        501,
      );
    }
    try {
      launches.launch(flow, body["input"] ?? {}, { runId: admitted.runId, ...(admitted.capUsd !== undefined ? { maxCostUsd: admitted.capUsd } : {}) });
    } catch (err) {
      admitted.release();
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 503, { "retry-after": "60" });
    }
    return c.json({ runId: admitted.runId, token: publicRunToken(name, admitted.runId) }, 202);
  });

  // The launcher's cancel: that run's tree, with its run token.
  app.post("/public/workflows/:name/runs/:runId/cancel", async (c) => {
    const { name, runId } = c.req.param();
    const launches = deps.launches;
    const token = presentedRunToken(c);
    if (!launches || token === undefined || !isPublicRunToken(name, runId, token)) return c.json({ error: `no run "${runId}" of "${name}"` }, 404);
    const start = (await store.getRunEvents(name, runId)).find((e) => e.type === "run.start");
    if (start ? start.origin !== "public" : !launches.runs.pending(name, runId)) return c.json({ error: `no run "${runId}" of "${name}"` }, 404);
    const { status, body } = await launches.cancel(name, runId);
    return c.json(body, status);
  });

  // After the run routes: a version's YAML, the catch-all.
  app.get("/public/workflows/:name/:version", async (c) => {
    const got = await publicWorkflow(c);
    if (got instanceof Response) return got;
    const version = c.req.param("version");
    try {
      return c.text(await workspace.getWorkflowSource(got.name, version), 200, { "content-type": "text/yaml" });
    } catch {
      return c.json({ error: `Version "${version}" of workflow "${got.name}" not found` }, 404);
    }
  });

  // ── Steps ───────────────────────────────────────────────────────────────

  app.get("/public/steps", async (c) => c.json(await listedSteps()));

  /** The step when it is public, else the 404 to answer. */
  const publicStep = async (c: Context) => {
    const type = c.req.param("type") ?? "";
    if (!(await surface.step(type))) return notPublic(c, `step "${type}"`);
    return { type };
  };

  // What the step IS: description, effect, the secrets it names, its input
  // and output fields.
  app.get("/public/steps/:type{.+}/schema", async (c) => {
    const got = await publicStep(c);
    if (got instanceof Response) return got;
    const def = (await resolveStep(deps.registry(), got.type).catch(() => null))?.def;
    if (!def) return c.json({ error: `Step type "${got.type}" not found` }, 404);
    return c.json({
      type: got.type,
      ...(def.description ? { description: def.description } : {}),
      ...(def.effect === "read" || def.effect === "write" ? { effect: def.effect } : {}),
      ...(Array.isArray(def.secrets) ? { secrets: def.secrets } : {}),
      fields: zodToFields(def.input),
      output: zodToFields(def.output),
    });
  });

  // Its source, with the helpers its relative imports reach (ruled).
  app.get("/public/steps/:type{.+}/source", async (c) => {
    const got = await publicStep(c);
    if (got instanceof Response) return got;
    const def = deps.registry()[got.type];
    const found = def?.source ? { code: def.source, origin: "registry" } : await workspace.getStepSource(got.type);
    if (!found) return c.json({ type: got.type, source: null, origin: null, helpers: [] });
    const helpers = await stepHelpers(got.type, found.code, async (name) => (await workspace.getStepSource(name).catch(() => null))?.code ?? null);
    return c.json({ type: got.type, source: found.code, origin: found.origin, helpers });
  });

  app.get("/public/steps/:type{.+}/versions", async (c) => {
    const got = await publicStep(c);
    if (got instanceof Response) return got;
    try {
      const { active, versions } = await workspace.listStepVersions(got.type);
      return c.json({ type: got.type, active, versions });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  app.get("/public/steps/:type{.+}/version/:version", async (c) => {
    const got = await publicStep(c);
    if (got instanceof Response) return got;
    const version = c.req.param("version");
    try {
      return c.json({ type: got.type, version, source: await workspace.getStepVersionSource(got.type, version) });
    } catch {
      return c.json({ error: `Version "${version}" of step "${got.type}" not found` }, 404);
    }
  });

  // ── Concepts and the graph ──────────────────────────────────────────────

  // Every public tree, page by page: name, description, parent, root.
  app.get("/public/concepts", async (c) => {
    const q = (c.req.query("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const tree = await surface.conceptTree();
    const hit = (x: { name: string; description?: string }) => q.every((w) => x.name.toLowerCase().includes(w) || (x.description ?? "").toLowerCase().includes(w));
    return c.json({ concepts: tree.concepts.filter(hit).map(({ ref_id, ...rest }) => ({ ref_id, ...rest })) });
  });

  // One page: its properties (docs included), its children and its parent.
  app.get("/public/concepts/:name{.+}", async (c) => {
    const name = c.req.param("name");
    const tree = await surface.conceptTree();
    const page = tree.concepts.find((x) => x.name === name);
    const reader = surface.reader();
    if (!page || !reader) return notPublic(c, `Concept "${name}"`);
    const node = await reader.getNode(page.ref_id);
    if (!node) return notPublic(c, `Concept "${name}"`);
    const children = tree.concepts.filter((x) => x.parent === page.name && x.root === page.root);
    return c.json({
      ref_id: node.ref_id,
      name: page.name,
      properties: node.properties,
      ...(page.parent ? { parent: page.parent } : {}),
      root: page.root,
      children: children.map((x) => ({ name: x.name, ...(x.description ? { description: x.description } : {}) })),
    });
  });

  app.get("/public/graph/nodes/:ref_id", async (c) => {
    const reader = surface.reader();
    const ref_id = c.req.param("ref_id");
    const node = reader ? await reader.getNode(ref_id) : null;
    if (!node) return notPublic(c, `node "${ref_id}"`);
    return c.json({ ref_id: node.ref_id, node_type: node.node_type ?? null, name: node.name ?? null, title: node.title ?? null, properties: node.properties });
  });
}
