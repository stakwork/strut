/**
 * The APPS capability (plans/apps.md §1.2, §1.3, §8): what the `/apps`
 * routes and the `app/*` steps are thin over — one implementation of
 * list / get / build / publish / checkout / init over the workspace store's
 * pointers (`WorkspaceStore.publishApp`, `getApp`, `materializeAppVersion`)
 * and the version directories under `<dataDir>/apps` (files.ts). A publish
 * BUILDS first (build.ts) and a failing build publishes nothing; the files
 * land in the version's directory, `dist/` included, once the pointer is
 * written. Under the meta surface's rules (`surface: "ai"` — `app/publish`,
 * a model's door) a manifest may not grant a sealed workflow or step, nor
 * `llm`, `agent` or `exec` as direct step grants (§5.1, §9): the workflow
 * is the unit of spend. A person's `POST /apps` (`surface: "person"`) may
 * grant anything, the `peer: true` precedent. Built by `createStrut` into
 * `ctx.services.apps`; an embedder builds one with `createApps`.
 *
 * A JOB's app (§6) is a directory in the job's, with no versions and no
 * pointer: `getDir` reads it back as `app/get { path }` returns it (its
 * build, `stale`, its client errors keyed by `{ job, path }`), and a build
 * of one runs under the meta surface's rules first — a model wrote its
 * grants and nothing publishes it. A person publishes one to the workspace
 * (`POST /apps { name, job, path }`, "Publish as an app"): its `data.db`
 * comes along when the workspace app has none yet (§1.2, `dataFrom`).
 */
import { copyFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isJobApp, type AppRef, type JobAppRef, type StepRegistry } from "../core.js";
import { globToRegExp } from "../closure.js";
import { isSealedStep } from "../sealed.js";
import { treeHash } from "../version.js";
import type { AppListEntry, AppRecord, AppUpstream, VersionSource, WorkspaceStore } from "../workspace.js";
import { buildApp, readBuildInfo, type BuildDeps, type BuildInfo, type BuildResult, type InstalledApp } from "./build.js";
import { copyAppDir, isEmptyDir, listAppFiles, validateAppName } from "./files.js";
import type { Kit, KitLocation } from "./kit.js";
import { readManifest, type AppManifest } from "./manifest.js";

/** Strut's starter directories (`app/init { template }`): `src/apps/templates/<name>/`. */
export const TEMPLATES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "templates");
export const DEFAULT_TEMPLATE = "default";

/** Never a direct grant from a model-written manifest (§5.1): a paid or
 *  shell-shaped step runs inside a workflow the app launches. */
export const PAID_OR_SHELL_STEPS: readonly string[] = ["llm", "agent", "exec"];

/** One app as `app/get` and `GET /apps/:name` read it: the record, the
 *  version's files and build, and what has moved since. */
export interface AppView extends AppRecord {
  /** The version's directory on this host. */
  dir: string;
  /** The directory is not there (a graph copied without its dataDir). */
  missing: boolean;
  files: string[];
  /** `dist/build.json`, or null when never built. */
  build: BuildInfo | null;
  /** The document is older than the sources — never built, the tree hash
   *  moved, or an imported kit moved (§3.4) — or the directory is missing. */
  stale: boolean;
  /** Granted workflows that no longer exist (§1.3). */
  inertGrants: string[];
  /** The app's latest client-side errors (§8): the kept
   *  `step:app/report-error` runs stamped with this app, newest first, at
   *  most `APP_ERRORS_MAX`. Absent when the capability has no run store. */
  errors?: AppError[];
}

/** One client-side error an app's page reported (`app/report-error`). */
export interface AppError {
  at: string;
  /** The workspace app's version; absent for a job's app, which has none. */
  version?: string;
  message: string;
  stack?: string;
  componentStack?: string;
  actor?: string;
  /** The kept run, under `step:app/report-error`. */
  runId: string;
}

/** How many of an app's errors `app/get` carries. */
export const APP_ERRORS_MAX = 50;

/** A directory read back as an app (`app/get { path }`, a JOB's app §6):
 *  what it holds, its build, and whether the build is behind its sources. */
export interface AppDirView {
  /** The directory on this host. */
  dir: string;
  /** For a job's app: the job and the app's path in it. */
  job?: string;
  path?: string;
  /** Null when `app.yaml` is missing or does not parse (`manifestErrors`). */
  manifest: AppManifest | null;
  manifestErrors?: string[];
  missing: boolean;
  files: string[];
  build: BuildInfo | null;
  /** Never built, or the sources (or an imported kit) moved since: `app/build`
   *  is due before the person sees the change. */
  stale: boolean;
  inertGrants: string[];
  /** A job app's latest client-side errors, newest first. */
  errors?: AppError[];
}

export type PublishSurface = "person" | "ai";

export interface AppPublishOptions {
  /** Who is publishing: the meta surface (`app/publish`) or a person (`POST /apps`). */
  surface: PublishSurface;
  publisher?: string;
  actor?: string;
  source?: VersionSource;
  upstream?: AppUpstream | null;
  reactivateKnown?: boolean;
  /** A directory whose `data.db` comes along when the workspace app has
   *  none yet (§1.2: a job's prototype with real data becomes a real app). */
  dataFrom?: string;
}

export type AppPublishResult =
  | { ok: true; name: string; version: string; changed: boolean; hash: string; bytes: number; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

export interface AppsCapability {
  list(): Promise<AppListEntry[]>;
  get(name: string, version?: string): Promise<AppView | null>;
  /** A version's directory (the active one by default), or null. */
  versionDir(name: string, version?: string): Promise<{ path: string; version: string; hash: string } | null>;
  /** Build the directory in place (`dist/`), with the installed apps and the
   *  workspace's workflows in reach; `name` is the app's, when known. Under
   *  `surface: "ai"` (a job's app, which nothing publishes) the meta
   *  surface's grant rules are checked first, as a publish checks them. */
  build(dir: string, opts?: { name?: string; surface?: PublishSurface }): Promise<BuildResult>;
  /** A directory read back as an app — a job's (`app`), or any other. */
  getDir(dir: string, app?: JobAppRef): Promise<AppDirView>;
  /** An app's latest client-side errors (§8), newest first: a workspace app
   *  by name, a job's app by `{ job, path }`. Empty with no run store. */
  errorsOf(app: string | JobAppRef): Promise<AppError[]>;
  /** Build, then record the version and copy the directory into place. */
  publish(dir: string, name: string, opts: AppPublishOptions): Promise<AppPublishResult>;
  /** Copy a version's directory to an empty `to`, to edit. */
  checkout(name: string, to: string, version?: string): Promise<{ path: string; version: string; hash: string }>;
  /** Scaffold an empty `to` from a template: strut's (`default`), or an installed app by name — a copy, with no upstream. */
  init(to: string, template?: string): Promise<{ path: string; template: string; files: string[] }>;
  setActive(name: string, version: string): Promise<void>;
  delete(name: string): Promise<boolean>;
  /** Strut's template names. */
  templates(): Promise<string[]>;
  /** The build's dependencies, for a caller that builds elsewhere. */
  buildDeps(name?: string): BuildDeps;
}

export interface AppsDeps {
  workspace: WorkspaceStore;
  /** The registry, for the sealed-step check on a meta-surface publish. */
  getRegistry?: () => StepRegistry;
  kit?: Kit | KitLocation;
  templatesDir?: string;
  now?: () => Date;
  /** The app's latest client-side errors, newest first (§8) — createStrut
   *  reads them off the run store (`appErrors`); absent, `get` carries none.
   *  A workspace app by name, a job's app by `{ job, path }`. */
  errors?: (app: string | JobAppRef, max: number) => Promise<AppError[]>;
}

/** An app's own SQLite file (§4.4): `<path>/data.db` in a job, beside the
 *  versions (`<dataDir>/apps/<name>/data.db`) in the workspace. */
const DATA_FILE = "data.db";

const isFile = async (p: string) => {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
};

const isDir = async (p: string) => {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
};

export function createApps(deps: AppsDeps): AppsCapability {
  const { workspace } = deps;
  const templatesDir = deps.templatesDir ?? TEMPLATES_DIR;

  const resolveApp = async (name: string, version?: string): Promise<InstalledApp | null> => {
    const rec = await workspace.getApp(name, version);
    if (!rec) {
      if (version && (await workspace.getApp(name))) throw new Error(`the installed app ${name} has no version ${version}`);
      return null;
    }
    const { path } = await workspace.materializeAppVersion(name, rec.version);
    return { name, version: rec.version, dir: path, hash: rec.hash };
  };

  const buildDeps = (name?: string): BuildDeps => ({
    ...(deps.kit ? { kit: deps.kit } : {}),
    ...(name ? { name } : {}),
    resolveApp,
    installedApps: async () => (await workspace.listApps()).map((a) => a.name),
    workflowExists: async (wf) => !!(await workspace.getWorkflowMetadata(wf).catch(() => null)),
    ...(deps.now ? { now: deps.now } : {}),
  });

  /** What a model-written manifest may not grant (§5.1, §9). */
  const refusedGrants = async (manifest: AppManifest): Promise<string[]> => {
    const out: string[] = [];
    const registry = deps.getRegistry?.() ?? {};
    for (const g of manifest.grants.steps) {
      const glob = g.includes("*");
      const re = glob ? globToRegExp(g) : null;
      const paid = glob ? PAID_OR_SHELL_STEPS.find((t) => re!.test(t)) : PAID_OR_SHELL_STEPS.includes(g) ? g : undefined;
      if (paid) {
        out.push(`grants.steps: "${g}" ${glob ? `reaches "${paid}", ` : "is "}a paid or shell-shaped step (llm, agent, exec) — the workflow is the unit of spend: put it in a workflow and grant that (plans/apps.md §5.1)`);
        continue;
      }
      const sealed = isSealedStep(g, registry) ? g : glob ? Object.keys(registry).find((t) => re!.test(t) && isSealedStep(t, registry)) : undefined;
      if (sealed) out.push(`grants.steps: "${g}" ${sealed === g ? "is" : `reaches "${sealed}",`} sealed — a person may grant it (POST /apps); the meta surface may not (plans/apps.md §9)`);
    }
    for (const key of ["workflows", "automations"] as const) {
      for (const wf of manifest.grants[key]) {
        const flow = await workspace.getWorkflow(wf).catch(() => null);
        if (flow?.sealed) out.push(`grants.${key}: "${wf}" is a sealed workflow — a person may grant it (POST /apps); the meta surface may not (plans/apps.md §9)`);
      }
    }
    return out;
  };

  const versionDir: AppsCapability["versionDir"] = async (name, version) => {
    const rec = await workspace.getApp(name, version);
    if (!rec) return null;
    const { path } = await workspace.materializeAppVersion(name, rec.version);
    return { path, version: rec.version, hash: rec.hash };
  };

  /** Has an imported kit moved since the build (§3.4)? */
  const importMoved = async (imp: BuildInfo["imports"][number]): Promise<boolean> => {
    const now = await workspace.getApp(imp.name, imp.pinned ? imp.version : undefined).catch(() => null);
    return !now || now.hash !== imp.hash;
  };

  /** The document is behind the directory: never built, the tree moved, or
   *  an imported kit did. */
  const isStale = async (dir: string, build: BuildInfo | null): Promise<boolean> => {
    if (!build) return true;
    if (build.hash !== (await treeHash(dir))) return true;
    for (const imp of build.imports) if (await importMoved(imp)) return true;
    return false;
  };

  const inert = async (manifest: AppManifest): Promise<string[]> => {
    const out: string[] = [];
    for (const wf of new Set([...manifest.grants.workflows, ...manifest.grants.automations])) {
      if (!(await workspace.getWorkflowMetadata(wf).catch(() => null))) out.push(wf);
    }
    return out;
  };

  const errorsOf = async (app: string | JobAppRef) => (deps.errors ? await deps.errors(app, APP_ERRORS_MAX).catch(() => []) : []);

  return {
    list: () => workspace.listApps(),

    async get(name, version) {
      const rec = await workspace.getApp(name, version);
      if (!rec) return null;
      const { path } = await workspace.materializeAppVersion(name, rec.version);
      const missing = !(await isDir(path));
      const files = missing ? [] : await listAppFiles(path);
      const build = missing ? null : await readBuildInfo(path);
      const stale = missing || (await isStale(path, build));
      const inertGrants = await inert(rec.manifest);
      const errors = deps.errors ? await errorsOf(name) : undefined;
      return { ...rec, dir: path, missing, files, build, stale, inertGrants, ...(errors ? { errors } : {}) };
    },

    versionDir,

    async build(dir, opts) {
      if (opts?.surface === "ai") {
        const read = await readManifest(dir);
        if (read.ok) {
          const refused = await refusedGrants(read.manifest);
          if (refused.length) return { ok: false, errors: refused, warnings: [] };
        }
      }
      return buildApp(dir, buildDeps(opts?.name));
    },

    async getDir(dir, app) {
      const missing = !(await isDir(dir));
      const read = missing ? null : await readManifest(dir);
      const manifest = read?.ok ? read.manifest : null;
      const build = missing ? null : await readBuildInfo(dir);
      return {
        dir,
        ...(app ? { job: app.job, path: app.path } : {}),
        manifest,
        ...(read && !read.ok ? { manifestErrors: read.errors } : {}),
        missing,
        files: missing ? [] : await listAppFiles(dir),
        build,
        stale: missing || (await isStale(dir, build)),
        inertGrants: manifest ? await inert(manifest) : [],
        ...(app && deps.errors ? { errors: await errorsOf(app) } : {}),
      };
    },

    errorsOf,

    async publish(dir, name, opts) {
      validateAppName(name);
      const read = await readManifest(dir);
      if (!read.ok) return { ok: false, errors: read.errors, warnings: [] };
      if (opts.surface === "ai") {
        const refused = await refusedGrants(read.manifest);
        if (refused.length) return { ok: false, errors: refused, warnings: [] };
      }
      const built = await buildApp(dir, buildDeps(name));
      if (!built.ok) return built;
      const publisher = opts.publisher ?? (opts.surface === "ai" ? "ai" : undefined);
      const r = await workspace.publishApp(name, built.hash, built.manifest, {
        ...(publisher !== undefined ? { publisher } : {}),
        ...(opts.actor ? { actor: opts.actor } : {}),
        ...(opts.source ? { source: opts.source } : {}),
        ...(opts.upstream !== undefined ? { upstream: opts.upstream } : {}),
        ...(opts.reactivateKnown !== undefined ? { reactivateKnown: opts.reactivateKnown } : {}),
      });
      const { path } = await workspace.materializeAppVersion(name, r.version);
      // The directory as built, `dist/` included — the same bytes on a
      // rebuild of a known version (§1.3). Publishing from the version's own
      // directory copies nothing.
      if (resolve(dir) !== resolve(path)) await copyAppDir(dir, path, { dist: true });
      // The app's database is the APP's, beside its versions: a job's comes
      // along only when there is none yet — never over the workspace's data.
      if (opts.dataFrom) {
        const from = join(opts.dataFrom, DATA_FILE);
        const to = join(dirname(path), DATA_FILE);
        if ((await isFile(from)) && !(await isFile(to))) await copyFile(from, to);
      }
      return { ok: true, name, version: r.version, changed: r.changed, hash: built.hash, bytes: built.bytes, warnings: built.warnings };
    },

    async checkout(name, to, version) {
      const at = await versionDir(name, version);
      if (!at) throw new Error(version ? `App "${name}" has no version ${version}` : `App "${name}" not found`);
      if (!(await isDir(at.path))) throw new Error(`the files of ${name}@${at.version} are not on this host (${at.path})`);
      if (!(await isEmptyDir(to))) throw new Error(`"${to}" exists and is not empty — app/checkout writes into a new or empty directory`);
      await copyAppDir(at.path, to, { dist: true });
      return { path: to, version: at.version, hash: at.hash };
    },

    async init(to, template = DEFAULT_TEMPLATE) {
      if (!(await isEmptyDir(to))) throw new Error(`"${to}" exists and is not empty — app/init writes into a new or empty directory`);
      const own = !template.includes("/") && !template.includes("..") ? join(templatesDir, template) : null;
      if (own && (await isDir(own))) {
        await copyAppDir(own, to, { dist: false });
      } else {
        const at = await versionDir(template).catch(() => null);
        if (!at) {
          const names = await this.templates();
          throw new Error(`no template "${template}" — strut's templates: ${names.join(", ")}; or the name of an installed app (app/list)`);
        }
        if (!(await isDir(at.path))) throw new Error(`the files of ${template}@${at.version} are not on this host (${at.path})`);
        await copyAppDir(at.path, to, { dist: false });
      }
      return { path: to, template, files: await listAppFiles(to) };
    },

    setActive: (name, version) => workspace.setActiveAppVersion(name, version),
    delete: (name) => workspace.deleteApp(name),

    async templates() {
      const { readdir } = await import("node:fs/promises");
      try {
        return (await readdir(templatesDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
      } catch {
        return [];
      }
    },

    buildDeps,
  };
}

/**
 * An app's latest client-side errors off the run store (§8): the kept
 * `step:app/report-error` runs whose summary carries the app — a workspace
 * app by name, a job's app by `{ job, path }` — newest first: what
 * `createApps({ errors })` is given on the standard server. One summary
 * read per kept run, newest first, stopping at `max` hits or `scanned`
 * runs.
 */
export async function appErrors(
  store: { listRuns(key: string): Promise<string[]>; getRunSummary(key: string, runId: string): Promise<{ startedAt: string; output?: unknown; actor?: string; app?: AppRef } | null> },
  app: string | JobAppRef,
  max = APP_ERRORS_MAX,
  scanned = 1000,
): Promise<AppError[]> {
  const key = "step:app/report-error";
  const out: AppError[] = [];
  const ids = (await store.listRuns(key).catch(() => [])).slice(0, scanned);
  const same = (got: AppRef): boolean =>
    typeof app === "string" ? !isJobApp(got) && got.name === app : isJobApp(got) && got.job === app.job && got.path === app.path;
  for (const runId of ids) {
    if (out.length >= max) break;
    const s = await store.getRunSummary(key, runId).catch(() => null);
    if (!s?.app || !same(s.app)) continue;
    // The report rides on the step's output (a summary keeps the run's
    // input, never a step's config).
    const report = (s.output ?? {}) as { message?: unknown; stack?: unknown; componentStack?: unknown };
    out.push({
      at: s.startedAt,
      ...(isJobApp(s.app) ? {} : { version: s.app.version }),
      message: typeof report.message === "string" ? report.message : "",
      ...(typeof report.stack === "string" ? { stack: report.stack } : {}),
      ...(typeof report.componentStack === "string" ? { componentStack: report.componentStack } : {}),
      ...(s.actor ? { actor: s.actor } : {}),
      runId,
    });
  }
  return out;
}
