/**
 * BUILD a package (plans/marketplace.md §2): what the named workflows can
 * execute, written as a package directory and put in the cache by its
 * digest — so the archive route serves it, and `installPackage` installs it
 * from `file:<the cache directory>` — with the manifest a person would write
 * by hand.
 *
 *   1. The closure: `flowClosure` per named workflow, `agentTools` globs
 *      expanded against the registry; per named app, its grants (each
 *      granted workflow walked the same way, `grants.steps` globs expanded)
 *      and the apps it imports, read off its build (`dist/build.json`). A
 *      workflow, custom step or app it reaches is an ITEM when it is LOCAL
 *      — made here, from no package, not the host's — whatever its name
 *      (plans/packages-ux.md §3): its path in the package is its name, and
 *      one already under the prefix keeps the rest of it. A
 *      `requires.packages` pin when its active version carries an
 *      `upstream`, recorded nowhere when it is the host's (a seed's,
 *      `source: "seed"` — strut's own `job` or `strut/views` — or one a
 *      service published, a `publisher` stamp other than the builder's
 *      `ai`: the installing strut must have it, and the install checks) —
 *      or under a SIBLING the request requires, a package built here whose
 *      cached copy holds it as it is now. Core and lib types are recorded
 *      nowhere.
 *   2. The helpers: every file a carried step imports by a relative path,
 *      at the same place beside it, and every `_` step under the prefix.
 *   3. The named Concepts and the pages under each (`PARENT_OF`).
 *   4. Each step's live claims, as its `.claims.yaml` — a claim with a
 *      check that reaches outside the package and its requirements is left
 *      out, said.
 *   5. `requires`, from what can be read: secret names in configs
 *      (`secretNamesIn`) and literal `secrets.get("…")` calls in step
 *      source, literal `exec` commands, literal `runtime:` fields.
 *   6. An item in a sealed namespace refuses the build.
 *
 * Each item's OWN name is written under the prefix — a workflow's `name:`,
 * a step's `defineStep({ type })` literal — and nothing else: a reference
 * stays as written, and the installing strut finds a bare one in the
 * package first (plans/packages-ux.md §2).
 *
 * An app goes in as its active version's sources, `apps/<name>/`: the files
 * its version hash covers (never `dist/` or `data.db`), checked against that
 * hash, so its item hash in the package is its version hash here.
 *
 * Everything that refuses is collected before anything is written, and the
 * refusal names every one (`package_build_refused: …`). Building twice from
 * the same workspace gives the same digest.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { AppsCapability } from "../apps/apps.js";
import { readBuildInfo } from "../apps/build.js";
import type { ClaimsAuthoring } from "../claims-authoring.js";
import { claimSpecSchema, type ClaimsBlock } from "../claims-schemas.js";
import { flowClosure, globToRegExp, type FlowClosure } from "../closure.js";
import { findConcept, STRUT_CONCEPTS } from "../concept-seed.js";
import type { Flow, Step, StepRegistry } from "../core.js";
import { hasTemplates } from "../expr.js";
import type { GraphBackend } from "../graph/backend.js";
import type { CheckRow } from "../graph/claims.js";
import { secretNamesIn } from "../reach.js";
import type { SubflowResolver } from "../runner.js";
import { isSealedStep, sealedStepPatterns } from "../sealed.js";
import { baseType } from "../step-ref.js";
import { hashTree, treeFiles } from "../version.js";
import { packagePrefixOf, type Upstream, type VersionSource, type WorkspaceStore } from "../workspace.js";
import { dumpYaml, loadYaml } from "../yaml.js";
import type { CachedPackage, PackageCache } from "./cache.js";
import { MANIFEST_FILE, PACKAGE_DIGEST, PACKAGE_NAME, type PackageManifest } from "./format.js";
import { conceptPrefix } from "./installed.js";

export interface BuildDeps {
  workspace: WorkspaceStore;
  cache: PackageCache;
  graph?: GraphBackend;
  /** The claims layer's reads, for each step's claims; without one there are none. */
  claims?: Pick<ClaimsAuthoring, "reader"> | null;
  /** The registry the workspace's steps load into: what a glob grant
   *  expands against, and which types strut ships. */
  getRegistry(): Promise<StepRegistry>;
  /** The sealed namespaces (`STRUT_SEALED` + the defaults). */
  sealed?: readonly string[];
  /** An app version's directory, restored when it is not kept; without it
   *  the directory is the store's path as it is. */
  apps?: Pick<AppsCapability, "versionDir">;
}

export interface BuildRequest {
  /** `publisher/name`: the prefix every item is under. */
  package: string;
  version: string;
  description?: string;
  license?: string;
  /** Workflows by the names they have here, each with everything it can
   *  execute. An installed one is a pin — for what a closure that cannot be
   *  read whole reaches. */
  workflows?: string[];
  /** Custom steps beyond what the workflows reach (a step-centric package),
   *  or what such a closure reaches. */
  steps?: string[];
  /** Concept pages, each with the pages under it. */
  concepts?: string[];
  /** Apps, each with what its grants can execute and the apps it imports.
   *  One the package carries is `apps/<name>/`, so its path in the package
   *  is one segment; an installed one is a pin. */
  apps?: string[];
  /** Packages BUILT on this strut that this one requires (a sibling under
   *  another prefix of the same publisher): each at a digest this strut's
   *  cache holds, pinned whether or not the closure reaches it. An item the
   *  closure reaches under one must be in that package as it is here. */
  requires?: { packages?: Array<{ package: string; digest: string }> };
}

export interface BuildResult {
  package: string;
  version: string;
  digest: string;
  /** Every file the digest covers, sorted. */
  files: string[];
  manifest: PackageManifest;
  /** The package's directory in the cache. */
  dir: string;
  warnings: string[];
}

const refused = (problems: string[]) => new Error(`package_build_refused: ${problems.join("; ")}`);
const isHelperName = (name: string) => name.split("/").pop()!.startsWith("_");

/** The stamp the builder's authoring puts on what it publishes
 *  (`AI_PUBLISHER`, src/authoring.ts): any OTHER `publisher` is a service's,
 *  the host's own. */
const BUILDER_STAMP = "ai";
/** A relative specifier in an import, an `export … from` or an `import()` —
 *  the pattern src/strut-resolve-hook.ts walks. */
const RELATIVE_IMPORT = /\b(?:from|import)\s*\(?\s*(["'])(\.\.?\/[^"'\n]+)\1/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A literal `secrets.get("NAME")` (or `secrets?.get`) in step source. */
const SECRET_GET = /\bsecrets\??\.get\(\s*(["'`])([^"'`\s$\\]+)\1\s*[,)]/g;

type Kind = "workflow" | "step" | "app";

/** The record of an item's active version: where it came from. */
interface Origin {
  upstream?: Upstream;
  source?: VersionSource;
  /** The service stamp on the item (`WorkflowMetadata.publisher`). */
  publisher?: string;
}

/** The installing strut's to have, never a package's to carry: a seed's, or
 *  one a service published. */
const hosts = (o: Origin) => o.source === "seed" || (o.publisher !== undefined && o.publisher !== BUILDER_STAMP);

export async function buildPackage(deps: BuildDeps, req: BuildRequest): Promise<BuildResult> {
  const pkg = req.package;
  if (typeof pkg !== "string" || !PACKAGE_NAME.test(pkg)) throw refused(["a package is named publisher/name: two lowercase segments, [a-z][a-z0-9-]*"]);
  if (typeof req.version !== "string" || !req.version) throw refused(["a package has a version, the publisher's label (1.4.0)"]);
  if (!req.workflows?.length && !req.steps?.length && !req.concepts?.length && !req.apps?.length) throw refused(["name at least one workflow, step, Concept or app"]);

  const prefix = `${pkg}/`;
  const under = (name: string) => name.startsWith(prefix);
  /** An item's path in the package: the rest of a name under the prefix, a
   *  local name as it is. */
  const pathOf = (name: string) => (under(name) ? name.slice(prefix.length) : name);
  const sealed = deps.sealed ?? sealedStepPatterns();
  const registry = await deps.getRegistry();
  const custom = new Set(Object.keys(await deps.workspace.getActiveStepHashes()));
  const problems: string[] = [];
  const warnings = new Set<string>();

  const workflows = new Set<string>();
  const steps = new Set<string>();
  /** The apps under the prefix, each with its sources: path → bytes. */
  const apps = new Map<string, Map<string, Buffer>>();
  const pins = new Map<string, { digest: string; source: string; from: string }>();
  /** Every step a closure walked, a kept check's included: what `requires` is read from. */
  const walked: Step[] = [];

  // The siblings the request names: pinned at the digest given, their files
  // what a reached item under their prefix is checked against.
  const siblings = new Map<string, CachedPackage>();
  for (const r of req.requires?.packages ?? []) {
    const at = `${r.package} at ${r.digest}`;
    if (r.package === pkg) problems.push(`${pkg} cannot require itself`);
    else if (!PACKAGE_DIGEST.test(r.digest)) problems.push(`requires.packages: ${r.digest} is not a digest (sha256:<64 hex>)`);
    else if (pins.has(r.package)) problems.push(`requires.packages names ${r.package} twice`);
    else {
      const cached = await deps.cache.get(r.digest);
      if (!cached || cached.manifest.package !== r.package) problems.push(`requires.packages: this strut's cache holds no ${at} — build it first`);
      else {
        siblings.set(r.package, cached);
        pins.set(r.package, { digest: r.digest, source: `file:${cached.dir}`, from: "the request" });
      }
    }
  }

  const originOf = async (kind: Kind, name: string): Promise<Origin | null> => {
    const meta =
      kind === "workflow" ? await deps.workspace.getWorkflowMetadata(name) : kind === "step" ? await deps.workspace.getStepMetadata(name) : await deps.workspace.getApp(name);
    const v = meta?.versions[meta.active];
    const publisher = meta && "publisher" in meta ? (meta as { publisher?: string }).publisher : undefined;
    return meta ? { ...(v?.upstream ? { upstream: v.upstream } : {}), ...(v?.source ? { source: v.source } : {}), ...(publisher ? { publisher } : {}) } : null;
  };

  /** A name under ANOTHER package's prefix of this publisher (`acme/util/x`
   *  for `acme/linear`): that package's to carry, built and required. */
  const publisherSeg = pkg.split("/")[0]!;
  const anothersOfMine = (name: string) => {
    const p = packagePrefixOf(name);
    return !!p && p !== pkg && (siblings.has(p) || p.startsWith(`${publisherSeg}/`));
  };
  /** Does the package CARRY this name: under its prefix, or local — made
   *  here, from no package, not the host's, not another package's of this
   *  publisher. */
  const carriedSeen = new Map<string, boolean>();
  const carries = async (kind: Kind, name: string): Promise<boolean> => {
    if (under(name)) return true;
    const key = `${kind}:${name}`;
    const known = carriedSeen.get(key);
    if (known !== undefined) return known;
    const o = await originOf(kind, name);
    const yes = !!o && !o.upstream && !hosts(o) && !anothersOfMine(name);
    carriedSeen.set(key, yes);
    return yes;
  };

  // Outside the prefix: a seed's is strut's (or the host's), another
  // package's is a pin at the digest it was installed at, anything else is
  // refused — a package carries its own prefix and nobody else's items.
  const outside = async (kind: Kind, name: string, o: Origin, by: string) => {
    if (hosts(o)) return;
    const up = o.upstream;
    const sibling = siblings.get(packagePrefixOf(name) ?? "");
    if (sibling && (!up || up.package !== sibling.manifest.package)) {
      // A sibling built here: the item must be in it, byte for byte as it is now.
      const path = name.slice(sibling.manifest.package.length + 1);
      let here: string | undefined;
      let there: string | undefined;
      if (kind === "app") {
        here = (await deps.workspace.getApp(name))?.hash;
        const files = sibling.files.filter((f) => f.startsWith(`apps/${path}/`)).map((f) => f.slice(`apps/${path}/`.length));
        there = files.length ? await hashTree(join(sibling.dir, "apps", path), files) : undefined;
      } else {
        const file = `${kind === "workflow" ? "workflows" : "steps"}/${path}.${kind === "workflow" ? "yaml" : "ts"}`;
        here = kind === "workflow" ? await deps.workspace.getWorkflowSource(name, (await deps.workspace.getWorkflowMetadata(name))!.active) : (await deps.workspace.getStepSource(name))?.code;
        there = sibling.files.includes(file) ? await readFile(join(sibling.dir, file), "utf-8") : undefined;
      }
      if (there === undefined || there !== here) {
        problems.push(`${by} reaches the ${kind} ${name}, which ${sibling.manifest.package} at ${sibling.digest} ${there === undefined ? "does not hold" : "holds as it was, not as it is here"} — rebuild ${sibling.manifest.package} and require its new digest`);
      }
      return;
    }
    if (!up || packagePrefixOf(name) !== up.package) {
      problems.push(
        up
          ? `${by} reaches the ${kind} ${name}, which came from ${up.package} but is not under its name — install it from its package`
          : `${by} reaches the ${kind} ${name}, which is under ${packagePrefixOf(name)}/, another package of ${publisherSeg} — build that package and require it (requires.packages)`,
      );
      return;
    }
    const have = pins.get(up.package);
    if (have && have.digest !== up.digest) {
      problems.push(`${up.package} is reached at two digests, ${have.digest} (${have.from}) and ${up.digest} (${name})`);
      return;
    }
    if (!have) pins.set(up.package, { digest: up.digest, source: up.source.ref, from: name });
    if (o.source !== "install") warnings.add(`the ${kind} ${name} is edited here; the package requires ${up.package} at ${up.digest}, as it was installed, without the edit`);
  };

  const reachStep = async (ref: string, by: string): Promise<void> => {
    const type = baseType(ref);
    if (!custom.has(type)) {
      if (!registry[type]) problems.push(`${by} names the step ${type}, which is not on this strut`);
      return;
    }
    if (ref !== type) problems.push(`${by} pins ${ref}: a version label is this strut's own — name the step ${type}`);
    if (await carries("step", type)) steps.add(type);
    else await outside("step", type, (await originOf("step", type)) ?? {}, by);
  };

  const reachWorkflow = async (name: string, by: string): Promise<void> => {
    if (await carries("workflow", name)) return; // the resolver below walks it
    const o = await originOf("workflow", name);
    if (!o) problems.push(`${by} calls the workflow ${name}, which is not here`);
    else await outside("workflow", name, o, by);
  };

  /** Apps under the prefix still to walk: their grants and imports. */
  const appQueue: string[] = [];
  const reachApp = async (name: string, by: string): Promise<void> => {
    const o = await originOf("app", name);
    if (!o) problems.push(`${by} names the app ${name}, which is not here`);
    else if (!(await carries("app", name))) await outside("app", name, o, by);
    else if (pathOf(name).includes("/")) problems.push(`the app ${name} cannot be a package folder, apps/${pathOf(name)}/: an app has one segment in a package`);
    else if (!apps.has(name)) {
      apps.set(name, new Map());
      appQueue.push(name);
    }
  };

  // The closure walks a workflow the package carries and stops at any other:
  // a pin carries its own closure, the host's is the installing strut's.
  let root = "";
  const resolver: SubflowResolver = {
    getWorkflow: (name) => walkInto(name),
    getWorkflowVersion: (name) => walkInto(name),
  };
  const walkInto = async (name: string): Promise<Flow> => {
    if (!(await carries("workflow", name))) return { steps: [] } as unknown as Flow;
    try {
      const flow = await deps.workspace.getWorkflow(name);
      workflows.add(name);
      return flow;
    } catch {
      problems.push(`${root} calls the workflow ${name}, which is not here`);
      return { steps: [] } as unknown as Flow;
    }
  };

  /** What one closure reached: every step type, subflow and grant classified. */
  const reachAll = async (closure: FlowClosure, seen: Step[], by: string): Promise<void> => {
    for (const s of seen) {
      if (!hasTemplates(s.type)) await reachStep(s.type, by);
      if (s.type !== "subflow") continue;
      const cfg = (s.config ?? {}) as Record<string, unknown>;
      const wf = cfg["workflow"];
      if (typeof wf !== "string" || hasTemplates(wf)) continue;
      if (cfg["version"] !== undefined) problems.push(`${by} calls ${wf} at ${String(cfg["version"])}: a version label is this strut's own — call the workflow by name`);
      await reachWorkflow(wf, by);
    }
    for (const grant of closure.agentTools) {
      if (grant.startsWith("mcp/")) continue; // a registered MCP server: the deployment's
      if (!grant.includes("*")) await reachStep(grant, `${by} (grant ${grant})`);
      else for (const type of Object.keys(registry).filter((t) => globToRegExp(grant).test(t))) await reachStep(type, `${by} (grant ${grant})`);
    }
  };

  // 1. The closures.
  const unread: Array<{ workflow: string; why: string[] }> = [];
  const rooted = new Set<string>();
  const walkWorkflow = async (name: string, by: string): Promise<void> => {
    if (!(await carries("workflow", name))) {
      if (by === "the request" && !(await originOf("workflow", name))) {
        problems.push(`no workflow ${name} here`);
        return;
      }
      return reachWorkflow(name, by);
    }
    if (rooted.has(name)) return;
    rooted.add(name);
    let flow: Flow;
    try {
      flow = await deps.workspace.getWorkflow(name);
    } catch {
      problems.push(by === "the request" ? `no workflow ${name} here` : `${by} names the workflow ${name}, which is not here`);
      return;
    }
    workflows.add(name);
    root = name;
    const seen: Step[] = [];
    const closure = await flowClosure(flow, resolver, (s) => seen.push(s));
    walked.push(...seen);
    await reachAll(closure, seen, name);
    const why = [
      ...seen.filter((s) => s.type === "subflow" && hasTemplates(String((s.config as Record<string, unknown> | undefined)?.["workflow"] ?? ""))).map((s) => `step ${s.id} calls a workflow named by a template`),
      ...seen.filter((s) => hasTemplates(s.type)).map((s) => `step ${s.id}'s type is a template`),
      ...closure.unreadGrants.map((g) => `the grant ${g} is read when the run starts`),
    ];
    if (!closure.resolvable || why.length) unread.push({ workflow: name, why: why.length ? why : ["an agentTools value it cannot read"] });
  };
  for (const name of req.workflows ?? []) await walkWorkflow(name, "the request");
  for (const type of req.steps ?? []) {
    if (!custom.has(type)) problems.push(registry[type] ? `${type} is a step strut ships, not one a package carries` : `no custom step ${type} here`);
    else await reachStep(type, "the request");
  }
  // An app: its sources as its version hash covers them, what its grants can
  // execute, and the apps it imports — read off the build of those sources.
  for (const name of req.apps ?? []) await reachApp(name, "the request");
  while (appQueue.length) {
    const name = appQueue.shift()!;
    const rec = (await deps.workspace.getApp(name))!;
    const at = `${name}@${rec.version}`;
    const dir = (await deps.apps?.versionDir(name))?.path ?? (await deps.workspace.materializeAppVersion(name, rec.version)).path;
    const files = await treeFiles(dir);
    if (!files.length) {
      problems.push(`the files of ${at} are not on this host (${dir})`);
      continue;
    }
    if ((await hashTree(dir, files)) !== rec.hash) {
      problems.push(`the files of ${at} are not its version: its directory was edited in place — publish it again`);
      continue;
    }
    for (const f of files) apps.get(name)!.set(f, await readFile(join(dir, f)));
    const built = await readBuildInfo(dir);
    if (!built || built.hash !== rec.hash) problems.push(`${at} has no build of its sources, so the apps it imports cannot be read — build and publish it again`);
    for (const imp of built?.hash === rec.hash ? built.imports : []) {
      if (imp.pinned) problems.push(`${at} imports ${imp.name}@${imp.version}: a version label is this strut's own — import the app by name`);
      else await reachApp(imp.name, `the app ${name}`);
    }
    for (const wf of [...rec.manifest.grants.workflows, ...rec.manifest.grants.automations]) await walkWorkflow(wf, `the app ${name}`);
    for (const grant of rec.manifest.grants.steps) {
      const types = grant.includes("*") ? Object.keys(registry).filter((t) => globToRegExp(grant).test(t)) : [grant];
      for (const type of types) {
        await reachStep(type, `the app ${name} (grant ${grant})`);
        // What it may call with any config: what a step reads by default.
        walked.push({ id: `${name} (grant ${type})`, type, config: {} } as Step);
      }
    }
  }
  // A closure that cannot be read whole is a lower bound: built only when the
  // request lists more than the workflows it is the closure of — what it reaches.
  if (unread.length) {
    const roots = new Set(unread.map((u) => u.workflow));
    const listed = (req.steps?.length ?? 0) > 0 || (req.workflows ?? []).some((w) => !roots.has(w));
    for (const u of unread) {
      const what = `the closure of ${u.workflow} cannot be read whole (${u.why.join("; ")})`;
      if (listed) warnings.add(`${what}: the package holds what the request lists — check it is everything that can run`);
      else problems.push(`${what} — list what it reaches in workflows / steps`);
    }
  }

  // 2. The helpers: with their namespace under the prefix, and every file a
  // carried step imports by a relative path — which must sit at the same
  // place beside it in the package, so the import still resolves there.
  for (const type of custom) if (under(type) && isHelperName(type)) steps.add(type);
  const importQueue = [...steps];
  const importsWalked = new Set<string>();
  while (importQueue.length) {
    const type = importQueue.shift()!;
    if (importsWalked.has(type)) continue;
    importsWalked.add(type);
    const src = await deps.workspace.getStepSource(type);
    if (!src || src.origin !== "custom") continue;
    for (const [, , spec] of src.code.matchAll(RELATIVE_IMPORT)) {
      const target = posix.normalize(posix.join(posix.dirname(type), spec!)).replace(/\.(?:[mc]?js|[mc]?ts)$/, "");
      if (target.startsWith("../")) {
        problems.push(`the step ${type} imports ${spec}, which is outside the steps`);
        continue;
      }
      if (!custom.has(target)) {
        problems.push(`the step ${type} imports ${spec}, which is no step or helper here`);
        continue;
      }
      if (!(await carries("step", target))) {
        problems.push(`the step ${type} imports ${target}, which is not this package's to carry — a package's steps import only its own files`);
        continue;
      }
      const there = posix.normalize(posix.join(posix.dirname(pathOf(type)), spec!)).replace(/\.(?:[mc]?js|[mc]?ts)$/, "");
      if (there !== pathOf(target)) {
        problems.push(`the step ${type} imports ${target}, which would not sit beside it in the package (${pathOf(type)} → ${pathOf(target)})`);
        continue;
      }
      if (!steps.has(target)) steps.add(target);
      importQueue.push(target);
    }
  }

  // 6. Sealed namespaces are strut's.
  for (const name of [...workflows, ...steps, ...apps.keys()]) {
    if (isSealedStep(name, undefined, sealed) || isSealedStep(`${prefix}${pathOf(name)}`, undefined, sealed)) problems.push(`${name} is in a sealed namespace (${sealed.join(", ")}): those are strut's`);
  }
  // Two names, one path: a local name and the same name under the prefix.
  for (const [kind, names] of [["workflow", workflows], ["step", steps], ["app", new Set(apps.keys())]] as const) {
    const byPath = new Map<string, string>();
    for (const name of names) {
      const other = byPath.get(pathOf(name));
      if (other) problems.push(`the ${kind}s ${other} and ${name} would both be ${prefix}${pathOf(name)}`);
      else byPath.set(pathOf(name), name);
    }
  }

  // The items' files.
  const files = new Map<string, string | Buffer>();
  const rel = pathOf;
  for (const name of [...workflows].sort()) {
    const meta = await deps.workspace.getWorkflowMetadata(name);
    if (!meta) continue;
    const text = await deps.workspace.getWorkflowSource(name, meta.active);
    const declared = (loadYaml(text) as { name?: unknown } | null)?.name;
    if (declared !== undefined && declared !== name) {
      problems.push(`the workflow ${name} says name: ${String(declared)} — a package names a workflow by its path`);
      continue;
    }
    const stamped = declared === undefined || under(name) ? text : stampWorkflowName(text, `${prefix}${rel(name)}`);
    if (stamped === null) {
      problems.push(`the workflow ${name}'s name: line could not be written as ${prefix}${rel(name)} — give it a plain top-level name: line`);
      continue;
    }
    files.set(`workflows/${rel(name)}.yaml`, stamped);
  }
  for (const type of [...steps].sort()) {
    const src = await deps.workspace.getStepSource(type);
    if (!src || src.origin !== "custom") {
      problems.push(`no source for the step ${type}`);
      continue;
    }
    // The install loads each step and refuses one whose defineStep is not its path.
    if (!isHelperName(type) && registry[type]?.type !== type) problems.push(`the step ${type} does not load here as ${type}`);
    const code = isHelperName(type) || under(type) ? src.code : stampStepType(src.code, type, `${prefix}${rel(type)}`);
    if (code === null) {
      problems.push(`the step ${type} names its type with no literal type: "${type}" — the build writes ${prefix}${rel(type)} there`);
      continue;
    }
    files.set(`steps/${rel(type)}.ts`, code);
  }
  for (const [name, sources] of [...apps].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [file, bytes] of sources) files.set(`apps/${rel(name)}/${file}`, bytes);
  }

  // 3. Concepts, and 4. the steps' claims.
  if (req.concepts?.length) {
    const siblingPages = new Set([...siblings.values()].flatMap((p) => p.items.filter((i) => i.kind === "concept").map((i) => i.name)));
    for (const [file, text] of await conceptFiles(deps.graph, req.concepts, pkg, [...pins.keys()], siblingPages, problems, warnings)) files.set(file, text);
  }
  if (deps.claims) {
    const inside = insideCheck(deps, { registry, custom, under, workflows, steps, pins: [...pins.keys()] });
    for (const type of [...steps].filter((t) => !isHelperName(t)).sort()) {
      const kept = await stepClaims(deps.claims, type, inside, warnings);
      if (kept.claims.length) files.set(`steps/${rel(type)}.claims.yaml`, dumpYaml(kept.claims));
      walked.push(...kept.steps);
    }
  }
  if (problems.length) throw refused([...new Set(problems)]);
  if (!files.size) throw refused([`nothing to package`]);

  // 5. What it needs.
  const secrets = new Set<string>();
  const binaries = new Set<string>();
  const runtimes = new Set<string>();
  for (const s of walked) {
    const type = baseType(s.type);
    const cfg = (s.config ?? {}) as Record<string, unknown>;
    for (const name of secretNamesIn(cfg, registry[type])) {
      if (typeof name === "string" && name && !hasTemplates(name)) secrets.add(name);
      else warnings.add(`step ${s.id} names a secret by a template: requires.secrets lists only the names it can read`);
    }
    const cmd = cfg["cmd"];
    if (type === "exec" && typeof cmd === "string" && cmd && !hasTemplates(cmd) && !cmd.includes("/")) binaries.add(cmd);
    const runtime = cfg["runtime"];
    if (typeof runtime === "string" && runtime && !hasTemplates(runtime)) runtimes.add(runtime);
    else if (runtime !== undefined) warnings.add(`step ${s.id} names its runtime by a template: requires.runtimes lists only the names it can read`);
  }
  for (const type of steps) {
    for (const name of registry[type]?.secrets ?? []) secrets.add(name);
    for (const m of String(files.get(`steps/${rel(type)}.ts`) ?? "").matchAll(SECRET_GET)) secrets.add(m[2]!);
  }
  const sorted = (s: Set<string>) => [...s].sort();
  const requires: NonNullable<PackageManifest["requires"]> = {
    ...(secrets.size ? { secrets: sorted(secrets) } : {}),
    ...(binaries.size ? { binaries: sorted(binaries) } : {}),
    ...(runtimes.size ? { runtimes: sorted(runtimes).map((name) => ({ name })) } : {}),
    ...(pins.size ? { packages: [...pins.keys()].sort().map((p) => ({ package: p, digest: pins.get(p)!.digest, source: pins.get(p)!.source })) } : {}),
  };
  const manifest: PackageManifest = {
    package: pkg,
    version: req.version,
    ...(req.description ? { description: req.description } : {}),
    ...(req.license ? { license: req.license } : {}),
    ...(Object.keys(requires).length ? { requires } : {}),
  };
  files.set(MANIFEST_FILE, dumpYaml(manifest));

  // Written beside the cache, then in through it: the cache re-reads and hashes it.
  const scratch = join(deps.cache.root, ".build", randomBytes(8).toString("hex"));
  try {
    for (const [file, text] of files) {
      const to = join(scratch, ...file.split("/"));
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, text);
    }
    const info = await deps.cache.putDir(scratch);
    return { package: pkg, version: req.version, digest: info.digest, files: info.files, manifest, dir: info.dir, warnings: [...warnings] };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Is a check inside the package and its requirements? The reason it is
 *  not, or null. */
type InsideCheck = (check: CheckRow) => Promise<{ outside: string | null; steps: Step[] }>;

function insideCheck(
  deps: BuildDeps,
  pkg: { registry: StepRegistry; custom: Set<string>; under(name: string): boolean; workflows: Set<string>; steps: Set<string>; pins: string[] },
): InsideCheck {
  const pinned = (name: string) => pkg.pins.some((p) => name.startsWith(`${p}/`));
  const seed = async (kind: "workflow" | "step", name: string) => {
    const meta = kind === "workflow" ? await deps.workspace.getWorkflowMetadata(name) : await deps.workspace.getStepMetadata(name);
    const publisher = meta && "publisher" in meta ? (meta as { publisher?: string }).publisher : undefined;
    return !!meta && hosts({ ...(meta.versions[meta.active]?.source ? { source: meta.versions[meta.active]!.source } : {}), ...(publisher ? { publisher } : {}) });
  };
  const stepOk = async (type: string) =>
    pkg.custom.has(type) ? pkg.steps.has(type) || pinned(type) || (!pkg.under(type) && (await seed("step", type))) : !!pkg.registry[type];
  const workflowOk = async (name: string) => pkg.workflows.has(name) || pinned(name) || (!pkg.under(name) && (await seed("workflow", name)));
  // The check's subflows walk the package's workflows, and stop at anything else.
  const resolver: SubflowResolver = {
    getWorkflow: async (name) => (pkg.workflows.has(name) ? deps.workspace.getWorkflow(name) : ({ steps: [] } as unknown as Flow)),
    getWorkflowVersion: async (name) => (pkg.workflows.has(name) ? deps.workspace.getWorkflow(name) : ({ steps: [] } as unknown as Flow)),
  };
  return async (check) => {
    if (!check.step_type) return { outside: null, steps: [] }; // an external check: a person looks
    const seen: Step[] = [];
    const closure = await flowClosure({ steps: [{ id: "check", type: check.step_type, config: checkConfig(check) ?? {} } as Step] }, resolver, (s) => seen.push(s));
    if (!closure.resolvable) return { outside: "it cannot be read whole", steps: seen };
    for (const s of seen) {
      const type = baseType(s.type);
      if (hasTemplates(type) || type !== s.type || !(await stepOk(type))) return { outside: `it runs ${s.type}`, steps: seen };
      const wf = (s.config as Record<string, unknown> | undefined)?.["workflow"];
      if (type === "subflow" && (typeof wf !== "string" || !(await workflowOk(wf)))) return { outside: `it calls ${String(wf)}`, steps: seen };
    }
    for (const grant of closure.agentTools) {
      if (grant.startsWith("mcp/")) return { outside: `it grants ${grant}`, steps: seen };
      const types = grant.includes("*") ? Object.keys(pkg.registry).filter((t) => globToRegExp(grant).test(t)) : [grant];
      for (const t of types) if (!(await stepOk(t))) return { outside: `it grants ${t}`, steps: seen };
    }
    return { outside: null, steps: seen };
  };
}

function checkConfig(check: CheckRow): unknown {
  if (!check.step_config) return undefined;
  try {
    return JSON.parse(check.step_config);
  } catch {
    return check.step_config;
  }
}

/** A step's live claims in the `claimsArgSchema` shape, each with all its
 *  checks — or left out, said, when one of them reaches outside. Sorted, so
 *  the same claims are the same bytes. */
async function stepClaims(claims: Pick<ClaimsAuthoring, "reader">, type: string, inside: InsideCheck, warnings: Set<string>): Promise<{ claims: ClaimsBlock; steps: Step[] }> {
  const out: ClaimsBlock = [];
  const steps: Step[] = [];
  for (const claim of await claims.reader.claimsFor({ kind: "step", type })) {
    const checks = await claims.reader.checksFor(claim.id);
    const reasons: string[] = [];
    const specs = [];
    const checkSteps: Step[] = [];
    for (const k of checks) {
      const r = await inside(k);
      if (r.outside) reasons.push(`the check ${k.name}: ${r.outside}`);
      checkSteps.push(...r.steps);
      const config = checkConfig(k);
      specs.push({
        ...(k.step_type ? { type: k.step_type } : {}),
        ...(config !== undefined ? { config } : {}),
        ...(k.name ? { name: k.name } : {}),
        ...(k.description ? { description: k.description } : {}),
        ...(k.run_when ? { when: k.run_when } : {}),
        ...(k.policy ? { policy: k.policy } : {}),
        ...(k.freshness_days != null ? { freshnessDays: k.freshness_days } : {}),
        ...(k.sample_rate != null ? { sampleRate: k.sample_rate } : {}),
      });
    }
    const spec = claimSpecSchema.safeParse({ text: claim.claim_text, checks: specs.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
    if (reasons.length) warnings.add(`the claim "${claim.claim_text}" of ${type} is left out: ${reasons.join("; ")}, outside the package and what it requires`);
    else if (!spec.success) warnings.add(`the claim "${claim.claim_text}" of ${type} is left out: ${spec.error.issues.map((i) => i.message).join("; ")}`);
    else {
      out.push(spec.data);
      steps.push(...checkSteps);
    }
  }
  return { claims: out.sort((a, b) => a.text.localeCompare(b.text)), steps };
}

/** The named Concept pages and every page under each, as `concepts/<Name>.md`
 *  files `seedConcepts` reads back: front matter `description` and `parent`,
 *  the body `docs`. A page another seeder stamped is not this package's to
 *  carry; a top page's parent outside the package must be on the strut that
 *  installs it, which is said unless it is a page strut ships or one of a
 *  required package. */
async function conceptFiles(
  graph: GraphBackend | undefined,
  names: string[],
  pkg: string,
  pins: string[],
  siblingPages: Set<string>,
  problems: string[],
  warnings: Set<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const schema = graph ? await graph.schemas.schema("Concept") : undefined;
  if (!graph || !schema) {
    problems.push(`there are no Concepts to package: ${graph ? "the graph has no Concept schema" : "this workspace has no graph"}`);
    return out;
  }
  const known = [STRUT_CONCEPTS.prefix, ...(STRUT_CONCEPTS.legacyPrefixes ?? []), ...pins.map(conceptPrefix)];
  const pages = new Map<string, { description?: string; docs?: string; parent?: string }>();
  const queue: Array<{ ref: string; parent?: string }> = [];
  const tops: Array<{ name: string; parent: string; stamp: unknown }> = [];
  for (const name of names) {
    const node = await findConcept(graph, schema, name);
    if (!node || node.deleted) {
      problems.push(`no Concept ${name} in the graph`);
      continue;
    }
    // A top page keeps where it hangs: the first of its parents, by name.
    const parents = await graph.tx(async (tx) => {
      const edges = await graph.edgeEngine.liveEdgesOf(tx, node.ref_id, "PARENT_OF", false);
      const raws = await Promise.all((edges?.edges ?? []).map((e) => graph.nodeEngine.readRaw(tx, e.other)));
      return raws.filter((r) => r && typeof r.props["name"] === "string").map((r) => ({ name: r!.props["name"] as string, stamp: r!.props["unique_source_id"] }));
    });
    const parent = parents.sort((a, b) => a.name.localeCompare(b.name))[0];
    if (parent) tops.push({ name, parent: parent.name, stamp: parent.stamp });
    queue.push({ ref: node.ref_id, ...(parent ? { parent: parent.name } : {}) });
  }
  const seen = new Set<string>();
  while (queue.length) {
    const { ref, parent } = queue.shift()!;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const { raw, children } = await graph.tx(async (tx) => ({
      raw: await graph.nodeEngine.readRaw(tx, ref),
      children: (await graph.edgeEngine.liveEdgesOf(tx, ref, "PARENT_OF", true))?.edges.map((e) => e.other) ?? [],
    }));
    const p = raw?.props ?? {};
    const name = p["name"];
    if (typeof name !== "string" || !name) continue;
    const stamp = p["unique_source_id"];
    if (typeof stamp === "string" && !stamp.startsWith(conceptPrefix(pkg))) {
      problems.push(`the Concept ${name} is ${stamp.replace(/@.*$/, "")}'s (its stamp): a package carries pages of its own`);
      continue;
    }
    if (name.includes("/") || name.startsWith(".")) {
      problems.push(`the Concept ${name} cannot be a file name, concepts/${name}.md`);
      continue;
    }
    if (pages.has(name)) continue;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const page = { ...(str(p["description"]) ? { description: str(p["description"]) } : {}), ...(str(p["docs"]) ? { docs: str(p["docs"]) } : {}), ...(parent ? { parent } : {}) };
    pages.set(name, page);
    for (const child of children) queue.push({ ref: child, parent: name });
  }
  for (const top of tops) {
    if (pages.has(top.parent) || siblingPages.has(top.parent) || (typeof top.stamp === "string" && known.some((p) => (top.stamp as string).startsWith(p)))) continue;
    warnings.add(`the Concept ${top.name} hangs under ${top.parent}, which is not in the package: the strut that installs it must have a Concept ${top.parent}`);
  }
  for (const [name, page] of pages) {
    const front = { ...(page.description ? { description: page.description } : {}), ...(page.parent ? { parent: page.parent } : {}) };
    // Docs that open with `---` would read as front matter: give them an empty one.
    const head = Object.keys(front).length ? `---\n${dumpYaml(front)}---\n` : page.docs?.startsWith("---") ? "---\n{}\n---\n" : "";
    out.set(`concepts/${name}.md`, `${head}${page.docs ? `${page.docs}\n` : ""}`);
  }
  return out;
}

/** A workflow's text with its top-level `name:` line written as `full`, or
 *  null when there is no plain one to write (the rest of the text as it is). */
export function stampWorkflowName(text: string, full: string): string | null {
  const line = /^name:[ \t]*[^\n]*$/m;
  if (!line.test(text)) return null;
  const out = text.replace(line, `name: ${full}`);
  return (loadYaml(out) as { name?: unknown } | null)?.name === full ? out : null;
}

/** A step's source with each `type: "<from>"` literal written as `to`, or
 *  null when there is none to write. */
export function stampStepType(code: string, from: string, to: string): string | null {
  const literal = new RegExp(`(\\btype\\s*:\\s*)(["'\`])${escapeRe(from)}\\2`, "g");
  if (!literal.test(code)) return null;
  return code.replace(literal, (_m, head: string, q: string) => `${head}${q}${to}${q}`);
}
