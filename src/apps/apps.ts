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
 */
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StepRegistry } from "../core.js";
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
   *  workspace's workflows in reach; `name` is the app's, when known. */
  build(dir: string, opts?: { name?: string }): Promise<BuildResult>;
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
}

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

  return {
    list: () => workspace.listApps(),

    async get(name, version) {
      const rec = await workspace.getApp(name, version);
      if (!rec) return null;
      const { path } = await workspace.materializeAppVersion(name, rec.version);
      const missing = !(await isDir(path));
      const files = missing ? [] : await listAppFiles(path);
      const build = missing ? null : await readBuildInfo(path);
      let stale = missing || !build;
      if (build && !missing) {
        stale = build.hash !== (await treeHash(path));
        for (const imp of build.imports) if (!stale && (await importMoved(imp))) stale = true;
      }
      const inertGrants: string[] = [];
      for (const wf of new Set([...rec.manifest.grants.workflows, ...rec.manifest.grants.automations])) {
        if (!(await workspace.getWorkflowMetadata(wf).catch(() => null))) inertGrants.push(wf);
      }
      return { ...rec, dir: path, missing, files, build, stale, inertGrants };
    },

    versionDir,

    build: (dir, opts) => buildApp(dir, buildDeps(opts?.name)),

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
