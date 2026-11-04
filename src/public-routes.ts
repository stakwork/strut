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
 * Reads, and `POST /public/mcp` (mounted by createStrut). `/public-view`, the person's door to the record, is mounted by
 * createStrut behind the gate like any write.
 */
import type { Context, Hono } from "hono";
import type { RunEvent, StepRegistry } from "./core.js";
import type { RunStore } from "./store.js";
import { summarizeFromEvents } from "./store.js";
import type { WorkspaceStore } from "./workspace.js";
import type { ArtifactsCapability } from "./capabilities.js";
import type { PublicSurfaceService } from "./public-surface.js";
import { publicEvent, publicSummary, stepHelpers } from "./public-surface.js";
import { runsPage } from "./runs.js";
import { searchWorkflows } from "./search.js";
import { resolveStep } from "./steps/registry.js";
import { zodToFields } from "./ai/schemaHelpers.js";

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

/** Every path this module serves: what the gate opens to anyone. */
export const PUBLIC_PATH = /^\/public(?:\/|$)/;

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
        "access-control-allow-headers": "content-type, accept, mcp-protocol-version",
        "access-control-max-age": "600",
      });
    }
    // Reads, and a visitor's page calling its app (`POST /public/mcp`).
    if (method !== "GET" && method !== "HEAD" && !(method === "POST" && c.req.path === "/public/mcp")) return next();
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

  /** The run when its workflow's runs are public and it is one of them. */
  const publicRun = async (c: Context) => {
    const got = await publicWorkflow(c);
    if (got instanceof Response) return got;
    const runId = c.req.param("runId") ?? "";
    if (!got.w.runs) return notPublic(c, `the runs of "${got.name}"`);
    // A run id is one path segment: anything else could name another
    // workflow's run through the file store's directories.
    if (!runId || /[/\\]|\.\./.test(runId)) return c.json({ error: `no run "${runId}" of "${got.name}"` }, 404);
    const events = await store.getRunEvents(got.name, runId);
    if (!events.length) return c.json({ error: `no run "${runId}" of "${got.name}"` }, 404);
    return { ...got, runId, events };
  };

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
    const summary = await store.getRunSummary(got.name, got.runId);
    if (summary) return c.json(publicSummary(summary));
    const partial = summarizeFromEvents(got.name, got.runId, got.events, deps.liveStatus(got.name, got.runId));
    return partial ? c.json(publicSummary(partial as unknown as Record<string, unknown>)) : c.json({ error: `no run "${got.runId}"` }, 404);
  });

  app.get("/public/workflows/:name/runs/:runId/events", async (c) => {
    const got = await publicRun(c);
    if (got instanceof Response) return got;
    return c.json(got.events.map((e: RunEvent) => publicEvent(e, (path) => publicTranscriptUrl(got.name, got.runId, path))));
  });

  // One agent session by step path. Never `?full=1`: a thread's earlier
  // turns may be another run's, of another workflow.
  app.get("/public/workflows/:name/runs/:runId/transcripts/:path{.+}", async (c) => {
    const got = await publicRun(c);
    if (got instanceof Response) return got;
    const path = c.req.param("path");
    const end = got.events.filter((e) => e.type === "step.end" && e.path === path && e.messages).pop();
    return end ? c.json(end.messages) : c.json({ error: `No transcript at "${path}" in run "${got.runId}"` }, 404);
  });

  // The run's own files (its artifacts directory). A job run's files live in
  // the job's directory, which other runs share: not public in v1.
  app.get("/public/workflows/:name/runs/:runId/files", async (c) => {
    const got = await publicRun(c);
    if (got instanceof Response) return got;
    if (!deps.artifacts) return c.json({ runId: got.runId, files: [] });
    try {
      return c.json({ runId: got.runId, files: await deps.artifacts.list(got.runId) });
    } catch {
      return c.json({ runId: got.runId, files: [] });
    }
  });

  app.get("/public/workflows/:name/runs/:runId/files/:path{.+}", async (c) => {
    const got = await publicRun(c);
    if (got instanceof Response) return got;
    const relPath = c.req.param("path");
    if (!deps.artifacts) return c.json({ error: `file not found: ${relPath}` }, 404);
    try {
      const bytes = await deps.artifacts.read(got.runId, relPath);
      return c.body(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 200, deps.fileHeaders(relPath));
    } catch (err: any) {
      if (err?.code === "ENOENT" || err?.code === "EISDIR") return c.json({ error: `file not found: ${relPath}` }, 404);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
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
