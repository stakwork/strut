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
 *      `ai`: the installing strut must have it, and the install checks;
 *      one strut itself does not seed everywhere — a host's seed, a
 *      service's item — is a warning and `leftToInstaller`) —
 *      or under a SIBLING the request requires, a package built here whose
 *      cached copy holds it as it is now. Core and lib types are recorded
 *      nowhere.
 *   2. The helpers: every file a carried step imports by a relative path,
 *      at the same place beside it, and every `_` step under the prefix.
 *   3. The named Concepts and the pages under each (`PARENT_OF`) — or a
 *      page named alone (`conceptsAlone`) without them — each a
 *      new-form page under its node key (`concepts/<key>.md`: its name,
 *      every attribute, every parent — plans/concept-history.md §2.1), and
 *      the named graph types with their parents and edges (./graph-types.ts).
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
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppsCapability } from "../apps/apps.js";
import { readBuildInfo } from "../apps/build.js";
import { isFirstPartyName } from "../apps/files.js";
import type { ClaimsAuthoring } from "../claims-authoring.js";
import { claimSpecSchema, type ClaimsBlock } from "../claims-schemas.js";
import { flowClosure, globToRegExp, type FlowClosure } from "../closure.js";
import { findConcept, NOT_ATTRIBUTES, renderConceptPage, STRUT_CONCEPTS } from "../concept-seed.js";
import type { Flow, Step, StepRegistry } from "../core.js";
import { hasTemplates } from "../expr.js";
import type { GraphBackend } from "../graph/backend.js";
import type { CheckRow } from "../graph/claims.js";
import { composeNodeKey } from "../graph/node-writer.js";
import type { NodeSchema } from "../graph/schema-resolver.js";
import { secretNamesIn } from "../reach.js";
import type { SubflowResolver } from "../runner.js";
import { isSealedStep, sealedStepPatterns } from "../sealed.js";
import { baseType } from "../step-ref.js";
import { isSystemWorkflow } from "../system-workflows.js";
import { hashTree, treeFiles } from "../version.js";
import { packagePrefixOf, type Upstream, type VersionSource, type WorkspaceStore } from "../workspace.js";
import { dumpYaml, loadYaml } from "../yaml.js";
import { archiveProblem } from "./archive.js";
import type { CachedPackage, PackageCache } from "./cache.js";
import { MANIFEST_FILE, PACKAGE_DIGEST, PACKAGE_NAME, readPackage, type PackageManifest } from "./format.js";
import { allTypeFiles, exportTypes } from "./graph-types.js";
import { suggest, type SuggestDeps, type Suggested } from "./suggest.js";
import { parseServeFile, planServe, SERVE_FILE } from "./serve.js";
import { conceptPrefix, listInstalledPackages, packageConcepts } from "./installed.js";

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
  /** The runs, read for what the package's workflows wrote and read
   *  (`suggested`); without them only the workflows' text is read. */
  runs?: SuggestDeps["runs"];
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
  /** Concept pages carried ALONE, without the pages under them: a root a
   *  package's steps need (`Firm`) whose pages here are this strut's own. */
  conceptsAlone?: string[];
  /** Graph types by name, each read off this graph's ontology with its
   *  parents and the edges among them, as `graph/<Type>.yaml`. */
  types?: string[];
  /** Apps, each with what its grants can execute and the apps it imports.
   *  One the package carries is `apps/<name>/`, so its path in the package
   *  is one segment; an installed one is a pin. */
  apps?: string[];
  /** Packages BUILT on this strut that this one requires (a sibling under
   *  another prefix of the same publisher): each at a digest this strut's
   *  cache holds, pinned whether or not the closure reaches it. An item the
   *  closure reaches under one must be in that package as it is here. */
  requires?: { packages?: Array<{ package: string; digest: string }> };
  /** `serve.yaml`'s fields (src/packages/serve.ts): the package as a served
   *  box shows it — its app, by the name the package gives it, and what a
   *  visitor may read and run. Written as the package's top-level file and
   *  checked against what the build carries. */
  serve?: Record<string, unknown>;
}

export interface BuildResult {
  package: string;
  version: string;
  digest: string;
  /** Every file the digest covers, sorted. */
  files: string[];
  manifest: PackageManifest;
  /** The package's directory in the cache; empty on a dry run, which keeps
   *  nothing. */
  dir: string;
  warnings: string[];
  /** The workflows, steps and apps the closure reaches that the installing
   *  strut must already have — a seed of this strut's host or a service's
   *  item, never strut's own — each also a warning. */
  leftToInstaller: LeftToInstaller[];
  /** Graph types and Concept roots the workflows' runs wrote and read, not
   *  named (./suggest.ts): what the package page offers to add. */
  suggested: Suggested;
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

/** What strut itself seeds on every server: the workflows it ships as
 *  files (`src/workflows/<name>.yaml` — job, orchestrator, builder, the
 *  browser, privacy and home-sync ones — and the system workflows) and the
 *  apps under `strut/`. A host's seed (the mcp lab's) and a service's item
 *  are not on every strut, so the build says so (`leftToInstaller`). */
const STRUT_WORKFLOWS = (() => {
  const dir = fileURLToPath(new URL("../workflows/", import.meta.url));
  return new Set(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -".yaml".length)) : []);
})();
const strutShips = (kind: Kind, name: string) =>
  kind === "workflow" ? STRUT_WORKFLOWS.has(name) || isSystemWorkflow(name) : kind === "app" ? isFirstPartyName(name) : false;

/** An item the closure reaches that this strut's host or a service put here. */
export interface LeftToInstaller {
  kind: Kind;
  name: string;
  /** The service stamp on it; none for a host's seed. */
  publisher?: string;
}

/** `dryRun`: everything a build does — the closure, the refusals, the
 *  files and their digest — with nothing kept in the cache: what the
 *  package page shows as "comes along" while a person picks. */
export async function buildPackage(deps: BuildDeps, req: BuildRequest, opts: { dryRun?: boolean } = {}): Promise<BuildResult> {
  const { files, manifest, warnings, suggested, leftToInstaller = [] } = await packageFiles(deps, req);
  const pkg = manifest.package;
  // Written beside the cache, then in through it: the cache re-reads and hashes it.
  const scratch = join(deps.cache.root, ".build", randomBytes(8).toString("hex"));
  try {
    for (const [file, text] of files) {
      const to = join(scratch, ...file.split("/"));
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, text);
    }
    // A package that cannot travel is refused here, dry run included, never
    // kept for an archive route that could not serve it.
    const read = await readPackage(scratch);
    // A `serve.yaml` names what the package carries (its app, its workflows).
    if (req.serve !== undefined) {
      try {
        planServe(parseServeFile(String(files.get(SERVE_FILE))), read);
      } catch (err) {
        throw refused([err instanceof Error ? err.message.replace(/^serve_invalid: /, "") : String(err)]);
      }
    }
    const unarchivable = await archiveProblem(scratch, read.files);
    if (unarchivable) throw new Error(`package_unarchivable: ${pkg} cannot be sent to another strut server: ${unarchivable}`);
    if (opts.dryRun) {
      return { package: pkg, version: req.version, digest: read.digest, files: read.files, manifest, dir: "", warnings, leftToInstaller, suggested: suggested! };
    }
    const info = await deps.cache.putDir(scratch, read.digest);
    return { package: pkg, version: req.version, digest: info.digest, files: info.files, manifest, dir: info.dir, warnings, leftToInstaller, suggested: suggested! };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** `packageFiles`' pick for a SNAPSHOT (plans/concept-history.md §2): the
 *  whole workspace, in the whole mode `wholeFiles` describes. */
export const EVERYTHING = "everything";

/** `packageFiles`' pick for a REPO's commit (app-repos.md §3.3): every
 *  item under one package's prefix, as this workspace has it now
 *  (`underFiles`). */
export interface PackageUnder {
  under: string;
}

/** A package directory as files: path → text or bytes, `strut.yaml` among
 *  them. */
export interface PackageFiles {
  files: Map<string, string | Buffer>;
  manifest: PackageManifest;
  warnings: string[];
  /** A build's: what the picked workflows' runs reach that it does not carry. */
  suggested?: Suggested;
  /** A build's: what it leaves to the installing strut (`BuildResult`). */
  leftToInstaller?: LeftToInstaller[];
  /** `PackageUnder`'s: each file's item — a workflow, step or app by its
   *  name here, a Concept by its page's name. */
  items?: Map<string, { kind: "workflow" | "step" | "app" | "concept"; name: string }>;
}

/**
 * The ONE place a package's files are written (plans/concept-history.md
 * §2): a build passes its picks and gets what they reach (the closure, the
 * module comment's six rules); a snapshot passes `EVERYTHING` and gets the
 * whole workspace (`wholeFiles`). The writers are shared — a Concept page
 * (`conceptPageFile`), a graph type (`typeFile`), an app's sources, a step's
 * claims — so the same item is the same bytes in a package and in the
 * history.
 */
export async function packageFiles(deps: BuildDeps, picks: BuildRequest): Promise<PackageFiles>;
export async function packageFiles(deps: WholeDeps, picks: typeof EVERYTHING | PackageUnder): Promise<PackageFiles>;
export async function packageFiles(deps: BuildDeps | WholeDeps, picks: BuildRequest | typeof EVERYTHING | PackageUnder): Promise<PackageFiles> {
  if (picks === EVERYTHING) return wholeFiles(deps);
  if ("under" in picks) return underFiles(deps, picks.under);
  return pickedFiles(deps as BuildDeps, picks);
}

async function pickedFiles(deps: BuildDeps, req: BuildRequest): Promise<PackageFiles> {
  const pkg = req.package;
  if (typeof pkg !== "string" || !PACKAGE_NAME.test(pkg)) throw refused(["a package is named publisher/name: two lowercase segments, [a-z][a-z0-9-]*"]);
  if (typeof req.version !== "string" || !req.version) throw refused(["a package has a version, the publisher's label (1.4.0)"]);
  if (!req.workflows?.length && !req.steps?.length && !req.concepts?.length && !req.conceptsAlone?.length && !req.apps?.length && !req.types?.length) throw refused(["name at least one workflow, step, Concept, app or graph type"]);

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
  const left = new Map<string, LeftToInstaller>();

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
    if (hosts(o)) {
      if (!strutShips(kind, name)) left.set(`${kind} ${name}`, { kind, name, ...(o.publisher ? { publisher: o.publisher } : {}) });
      return;
    }
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
    const read = await appSources(deps, name, rec.version, rec.hash);
    if ("problem" in read) {
      problems.push(read.problem);
      continue;
    }
    apps.set(name, read.files);
    const dir = read.dir;
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
    // Its category travels in its YAML, where the install reads it as it
    // reads `description:` (a strut that does not read it ignores the key).
    const categorized = meta.category ? stampWorkflowCategory(stamped, meta.category) : stamped;
    if (categorized === null) warnings.add(`the workflow ${name}'s category ${meta.category} could not be written into its YAML: it installs with none`);
    files.set(`workflows/${rel(name)}.yaml`, categorized ?? stamped);
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
  const pageNames = new Set<string>(); // the Concepts carried, by name (a file is named by its key)
  if (req.concepts?.length || req.conceptsAlone?.length) {
    const siblingPages = new Set([...siblings.values()].flatMap((p) => p.items.filter((i) => i.kind === "concept").map((i) => i.name)));
    // A page that tells an agent to run a carried workflow or step names it
    // as the installing strut will have it, under the prefix: `job` and the
    // orchestrator run under no package, so a bare name finds nothing there.
    const carriedNames = new Map<string, string>();
    for (const name of [...workflows, ...[...steps].filter((t) => !isHelperName(t))]) if (!under(name)) carriedNames.set(name, `${prefix}${rel(name)}`);
    const pinned = [...pins.keys()];
    const others = new Map<string, "workflow" | "step">();
    for (const w of await deps.workspace.listWorkflows()) {
      if (!workflows.has(w.name) && !strutShips("workflow", w.name) && !pinned.some((p) => w.name.startsWith(`${p}/`))) others.set(w.name, "workflow");
    }
    for (const t of custom) if (!steps.has(t) && !isHelperName(t) && !pinned.some((p) => t.startsWith(`${p}/`))) others.set(t, "step");
    const names: PageNames = { rename: renamer(carriedNames), others: (text) => [...namesIn(text, [...others.keys()])].map((n) => ({ kind: others.get(n)!, name: n })) };
    const named = { subtree: req.concepts ?? [], alone: req.conceptsAlone ?? [] };
    for (const [file, page] of await conceptFiles(deps.graph, named, pkg, [...pins.keys()], siblingPages, problems, warnings, names)) {
      files.set(file, page.text);
      pageNames.add(page.name);
    }
  }
  if (req.types?.length) {
    const required = new Set([...siblings.values()].flatMap((p) => p.items.filter((i) => i.kind === "type").map((i) => i.name)));
    for (const [file, text] of await exportTypes(deps.graph, req.types, required, problems, warnings)) files.set(file, text);
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

  // What the workflows' runs wrote and read that the package does not carry yet.
  const carried = (names: Set<string>, kind: "type" | "concept") => {
    const out = new Set(names);
    for (const p of siblings.values()) for (const i of p.items) if (i.kind === kind) out.add(i.name);
    return out;
  };
  const carriedTypes = carried(new Set([...files.keys()].map((f) => /^graph\/(.+)\.yaml$/.exec(f)?.[1]).filter((n): n is string => !!n)), "type");
  const carriedPages = carried(pageNames, "concept");
  const suggested = await suggest(
    { ...(deps.runs ? { runs: deps.runs } : {}), ...(deps.graph ? { graph: deps.graph } : {}) },
    [...new Set([...(req.workflows ?? []), ...workflows])],
    walked.map((st) => ({ type: baseType(st.type), ...(st.config !== undefined ? { config: st.config } : {}) })),
    { types: carriedTypes, concepts: carriedPages, conceptStamp: (stamp) => stamp.startsWith(conceptPrefix(pkg)) },
  );

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
  if (req.serve !== undefined) {
    const text = dumpYaml(req.serve);
    try {
      parseServeFile(text);
    } catch (err) {
      throw refused([err instanceof Error ? err.message.replace(/^serve_invalid: /, "") : String(err)]);
    }
    files.set(SERVE_FILE, text);
  }
  // What the package leaves to the installing strut beyond strut's own: said, never refused.
  const leftToInstaller = [...left.values()].sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
  for (const l of leftToInstaller) {
    warnings.add(`the ${l.kind} ${l.name} is left to the installing strut (${l.publisher ? `published here by ${l.publisher}` : "seeded here by this strut's host"}): a strut without it cannot install or run what reaches it`);
  }
  return { files, manifest, warnings: [...warnings], suggested, leftToInstaller };
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

/** The named Concept pages and every page under each, as the new-form
 *  pages `seedConcepts` reads back (`renderConceptPage`), each under its
 *  node key, `concepts/<key>.md` → its name and text: front matter `name`,
 *  every attribute the Concept schema declares that the node holds (but
 *  what `NOT_ATTRIBUTES` names), and `parents`, every live parent by name;
 *  the body `docs`. A page another seeder stamped is not this package's to
 *  carry; a parent outside the package must be on the strut that installs
 *  it, which is said unless it is a page strut ships or one of a required
 *  package. */
async function conceptFiles(
  graph: GraphBackend | undefined,
  named: { subtree: readonly string[]; alone: readonly string[] },
  pkg: string,
  pins: string[],
  siblingPages: Set<string>,
  problems: string[],
  warnings: Set<string>,
  said: PageNames = { rename: (t) => t, others: () => [] },
): Promise<Map<string, { name: string; text: string }>> {
  const out = new Map<string, { name: string; text: string }>();
  const schema = graph ? await graph.schemas.schema("Concept") : undefined;
  if (!graph || !schema) {
    problems.push(`there are no Concepts to package: ${graph ? "the graph has no Concept schema" : "this workspace has no graph"}`);
    return out;
  }
  const known = [STRUT_CONCEPTS.prefix, ...(STRUT_CONCEPTS.legacyPrefixes ?? []), ...pins.map(conceptPrefix)];
  const pages = new Map<string, { props: Record<string, unknown>; parents: Array<{ name: string; stamp: unknown }> }>();
  const queue: string[] = [];
  // A page named alone brings none of the pages under it, whichever way it is reached.
  const alone = new Set<string>();
  for (const name of [...named.subtree, ...named.alone]) {
    const node = await findConcept(graph, schema, name);
    if (!node || node.deleted) problems.push(`no Concept ${name} in the graph`);
    else {
      queue.push(node.ref_id);
      if (named.alone.includes(name)) alone.add(node.ref_id);
    }
  }
  const seen = new Set<string>();
  while (queue.length) {
    const ref = queue.shift()!;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const { raw, children, parents } = await graph.tx(async (tx) => {
      const ups = await graph.edgeEngine.liveEdgesOf(tx, ref, "PARENT_OF", false);
      const raws = await Promise.all((ups?.edges ?? []).map((e) => graph.nodeEngine.readRaw(tx, e.other)));
      return {
        raw: await graph.nodeEngine.readRaw(tx, ref),
        children: (await graph.edgeEngine.liveEdgesOf(tx, ref, "PARENT_OF", true))?.edges.map((e) => e.other) ?? [],
        parents: raws.filter((r) => r && typeof r.props["name"] === "string").map((r) => ({ name: r!.props["name"] as string, stamp: r!.props["unique_source_id"] })),
      };
    });
    const p = raw?.props ?? {};
    const name = p["name"];
    if (typeof name !== "string" || !name) continue;
    const stamp = p["unique_source_id"];
    if (typeof stamp === "string" && !stamp.startsWith(conceptPrefix(pkg))) {
      problems.push(`the Concept ${name} is ${stamp.replace(/@.*$/, "")}'s (its stamp): a package carries pages of its own`);
      continue;
    }
    if (pages.has(name)) continue;
    pages.set(name, { props: p, parents });
    if (!alone.has(ref)) for (const child of children) queue.push(child);
  }
  for (const [name, page] of pages) {
    for (const parent of page.parents) {
      if (pages.has(parent.name) || siblingPages.has(parent.name) || (typeof parent.stamp === "string" && known.some((k) => (parent.stamp as string).startsWith(k)))) continue;
      warnings.add(`the Concept ${name} hangs under ${parent.name}, which is not in the package: the strut that installs it must have a Concept ${parent.name}`);
    }
    // Its docs and description name the carried workflows and steps as packaged.
    const props = { ...page.props };
    for (const k of ["description", "docs"]) if (typeof props[k] === "string") props[k] = said.rename(props[k] as string);
    for (const o of said.others(`${typeof props["description"] === "string" ? props["description"] : ""}\n${typeof props["docs"] === "string" ? props["docs"] : ""}`)) {
      warnings.add(`the Concept ${name} names the ${o.kind} ${o.name}, which the package does not carry and strut does not ship: a strut without it finds nothing by that name`);
    }
    const file = conceptPageFile(schema, props, page.parents.map((x) => x.name));
    if (file) out.set(`concepts/${file.key}.md`, { name, text: file.text });
  }
  return out;
}

/** One Concept as its page (`renderConceptPage`): the node's name, every
 *  attribute the Concept schema declares that it holds (but what
 *  `NOT_ATTRIBUTES` names), its parents by name, its docs — and the node
 *  key the file is named by. The one writer of a page, for a build and a
 *  snapshot alike. Null for a node with no name. */
function conceptPageFile(schema: NodeSchema, props: Record<string, unknown>, parents: readonly string[]): { key: string; name: string; text: string } | null {
  const name = props["name"];
  if (typeof name !== "string" || !name) return null;
  const attributes = Object.fromEntries(
    Object.keys(schema.attributes)
      .filter((a) => !NOT_ATTRIBUTES.has(a))
      .map((a) => [a, props[a]])
      .filter(([, v]) => v !== null && v !== undefined && v !== ""),
  );
  const docs = typeof props["docs"] === "string" && props["docs"].trim() ? props["docs"].trim() : undefined;
  return { key: composeNodeKey(schema, { name }), name, text: renderConceptPage({ name, attributes, parents, ...(docs ? { docs } : {}) }) };
}

// ── the whole workspace (a snapshot) ─────────────────────────────────────

/** What `packageFiles(…, EVERYTHING)` reads. */
export interface WholeDeps {
  workspace: WorkspaceStore;
  /** For the installed packages a manifest pins (`listInstalledPackages`). */
  cache: PackageCache;
  graph?: GraphBackend;
  claims?: Pick<ClaimsAuthoring, "reader"> | null;
  apps?: Pick<AppsCapability, "versionDir">;
  /** What a snapshot taken again need not read again (src/history.ts). */
  memo?: WholeMemo;
}

/** Reads kept between snapshots, each by what it is a read of: a version
 *  label, a content hash. The installed pins are kept until the history
 *  drops them (a publish, an install). */
export interface WholeMemo {
  /** `<name>@<version>` → the workflow's text. */
  workflows: Map<string, string>;
  /** `<name>#<hash>` → the step's code. */
  steps: Map<string, string>;
  /** `<name>@<version>` → the app's sources. */
  apps: Map<string, Map<string, Buffer>>;
  pins?: NonNullable<NonNullable<PackageManifest["requires"]>["packages"]>;
}

export const newWholeMemo = (): WholeMemo => ({ workflows: new Map(), steps: new Map(), apps: new Map() });

/** The manifest of a snapshot: no package is published under it. */
export const WORKSPACE_PACKAGE = { package: "strut/workspace", version: "snapshot" } as const;

/**
 * Every item the workspace holds, as a package directory — the snapshot
 * the history commits (plans/concept-history.md §2). A build's rules are
 * lifted: nothing is refused (what cannot be read is a warning and is left
 * out), nothing is renamed, nothing is walked from a pick.
 *
 *   workflows/<name>.yaml        every workflow's active version, as published
 *   steps/<name>.ts              every custom step's, helpers included;
 *   steps/<name>.claims.yaml     its live claims beside it
 *   apps/<name>/…                every app's active version, its sources
 *   concepts/<key>.md            every live Concept in the backend's own namespace
 *   namespaces/<ns>/concepts/…   every live Concept in any other
 *   graph/<Type>.yaml            every type in the ontology but strut's own,
 *                                with its rules (`allTypeFiles`)
 *   strut.yaml                   `WORKSPACE_PACKAGE`, pinning every installed package
 */
async function wholeFiles(deps: WholeDeps): Promise<PackageFiles> {
  const memo = deps.memo ?? newWholeMemo();
  const files = new Map<string, string | Buffer>();
  const warnings: string[] = [];
  const keep = (m: Map<string, unknown>, keys: Set<string>) => {
    for (const k of m.keys()) if (!keys.has(k)) m.delete(k);
  };

  const wfKeys = new Set<string>();
  for (const w of await deps.workspace.listWorkflows()) {
    const key = `${w.name}@${w.activeVersion}`;
    wfKeys.add(key);
    let text = memo.workflows.get(key);
    if (text === undefined) {
      text = await deps.workspace.getWorkflowSource(w.name, w.activeVersion).catch(() => undefined);
      if (text === undefined) {
        warnings.push(`the workflow ${w.name} ${w.activeVersion} could not be read`);
        continue;
      }
      memo.workflows.set(key, text);
    }
    files.set(`workflows/${w.name}.yaml`, text);
  }
  keep(memo.workflows, wfKeys);

  const stepKeys = new Set<string>();
  const hashes = await deps.workspace.getActiveStepHashes();
  for (const [type, hash] of Object.entries(hashes)) {
    const key = `${type}#${hash}`;
    stepKeys.add(key);
    let code = memo.steps.get(key);
    if (code === undefined) {
      const src = await deps.workspace.getStepSource(type).catch(() => null);
      if (!src || src.origin !== "custom") {
        warnings.push(`the step ${type} could not be read`);
        continue;
      }
      code = src.code;
      memo.steps.set(key, code);
    }
    files.set(`steps/${type}.ts`, code);
  }
  keep(memo.steps, stepKeys);
  if (deps.claims) {
    const always: InsideCheck = async () => ({ outside: null, steps: [] });
    const claimWarnings = new Set<string>();
    for (const type of await deps.claims.reader.claimedSubjects("step")) {
      if (!(type in hashes) || isHelperName(type)) continue;
      const kept = await stepClaims(deps.claims, type, always, claimWarnings);
      if (kept.claims.length) files.set(`steps/${type}.claims.yaml`, dumpYaml(kept.claims));
    }
    warnings.push(...claimWarnings);
  }

  const appKeys = new Set<string>();
  for (const a of await deps.workspace.listApps()) {
    const key = `${a.name}@${a.activeVersion}`;
    let sources = memo.apps.get(key);
    if (!sources) {
      const rec = await deps.workspace.getApp(a.name);
      const read = rec ? await appSources(deps, a.name, rec.version, rec.hash) : { problem: `the app ${a.name} could not be read` };
      if ("problem" in read) {
        warnings.push(read.problem);
        continue;
      }
      sources = read.files;
      memo.apps.set(key, sources);
    }
    appKeys.add(key);
    for (const [file, bytes] of sources) files.set(`apps/${a.name}/${file}`, bytes);
  }
  keep(memo.apps, appKeys);

  if (deps.graph) {
    for (const [file, text] of await allConceptFiles(deps.graph, warnings)) files.set(file, text);
    for (const [file, text] of await allTypeFiles(deps.graph, warnings)) files.set(file, text);
  }

  memo.pins ??= (await listInstalledPackages({ workspace: deps.workspace, cache: deps.cache, ...(deps.graph ? { graph: deps.graph } : {}) }))
    .filter((p): p is typeof p & { digest: string } => typeof p.digest === "string" && PACKAGE_DIGEST.test(p.digest))
    .map((p) => ({ package: p.package, digest: p.digest, source: p.source?.ref || `sha256:${p.digest.slice(7)}` }));
  const manifest: PackageManifest = { ...WORKSPACE_PACKAGE, ...(memo.pins.length ? { requires: { packages: memo.pins } } : {}) };
  files.set(MANIFEST_FILE, dumpYaml(manifest));
  return { files, manifest, warnings };
}

/**
 * Every item under one package's prefix as the workspace has it now — what
 * a repo's Commit writes into its working copy (app-repos.md §3.3). The
 * whole mode's writers held to one package: each workflow's and step's
 * active version as published (names stay as they are: an installed item
 * says what its file said), each step's live claims, each app's active
 * sources, and the package's Concept pages — those stamped `pkg/<package>/`
 * and every unstamped page under one — each a new-form page under its node
 * key (a page stamped by another seeder under one is left out, said).
 * Paths are the package's: the prefix stripped. No `strut.yaml` and no
 * `graph/`: the manifest is the repo's, and a type is the graph's.
 */
async function underFiles(deps: WholeDeps, pkg: string): Promise<PackageFiles> {
  const prefix = `${pkg}/`;
  const files = new Map<string, string | Buffer>();
  const items = new Map<string, { kind: "workflow" | "step" | "app" | "concept"; name: string }>();
  const warnings: string[] = [];
  const put = (file: string, body: string | Buffer, item: { kind: "workflow" | "step" | "app" | "concept"; name: string }) => {
    files.set(file, body);
    items.set(file, item);
  };
  for (const w of await deps.workspace.listWorkflows()) {
    if (!w.name.startsWith(prefix)) continue;
    const text = await deps.workspace.getWorkflowSource(w.name, w.activeVersion).catch(() => undefined);
    if (text === undefined) warnings.push(`the workflow ${w.name} ${w.activeVersion} could not be read`);
    else put(`workflows/${w.name.slice(prefix.length)}.yaml`, text, { kind: "workflow", name: w.name });
  }
  const types = Object.keys(await deps.workspace.getActiveStepHashes()).filter((t) => t.startsWith(prefix));
  for (const type of types) {
    const src = await deps.workspace.getStepSource(type).catch(() => null);
    if (!src || src.origin !== "custom") warnings.push(`the step ${type} could not be read`);
    else put(`steps/${type.slice(prefix.length)}.ts`, src.code, { kind: "step", name: type });
  }
  if (deps.claims) {
    const always: InsideCheck = async () => ({ outside: null, steps: [] });
    const said = new Set<string>();
    for (const type of types.filter((t) => !isHelperName(t))) {
      const kept = await stepClaims(deps.claims, type, always, said);
      if (kept.claims.length) put(`steps/${type.slice(prefix.length)}.claims.yaml`, dumpYaml(kept.claims), { kind: "step", name: type });
    }
    warnings.push(...said);
  }
  for (const a of await deps.workspace.listApps()) {
    if (!a.name.startsWith(prefix)) continue;
    const rec = await deps.workspace.getApp(a.name);
    const read = rec ? await appSources(deps, a.name, rec.version, rec.hash) : { problem: `the app ${a.name} could not be read` };
    if ("problem" in read) warnings.push(read.problem);
    else for (const [file, bytes] of read.files) put(`apps/${a.name.slice(prefix.length)}/${file}`, bytes, { kind: "app", name: a.name });
  }
  if (deps.graph) {
    const stamped = await packageConcepts(deps.graph, pkg);
    const names = new Set(stamped.map((c) => c.name));
    // The roots: a page of the package none of whose parents is one. A
    // parent the walk does not reach is read off the page as it is now.
    const schema = await deps.graph.schemas.schema("Concept");
    const roots: string[] = [];
    if (schema) {
      for (const c of stamped) {
        const parents = await deps.graph.tx(async (tx) => {
          const ups = await deps.graph!.edgeEngine.liveEdgesOf(tx, c.ref_id, "PARENT_OF", false);
          return Promise.all((ups?.edges ?? []).map(async (e) => (await deps.graph!.nodeEngine.readRaw(tx, e.other))?.props["name"]));
        });
        if (!parents.some((n) => typeof n === "string" && names.has(n))) roots.push(c.name);
      }
    }
    const problems: string[] = [];
    const said = new Set<string>();
    for (const [file, page] of await conceptFiles(deps.graph, { subtree: roots, alone: [] }, pkg, [], new Set(), problems, said)) put(file, page.text, { kind: "concept", name: page.name });
    warnings.push(...problems.map((p) => `${p} — left out`), ...said);
  }
  return { files, manifest: { package: pkg, version: "workspace" }, warnings, items };
}

/**
 * Every live Concept in every namespace as its page, in two reads: the
 * nodes, and every live `PARENT_OF` into one with its parent's name — never
 * a read per node. A page in the backend's own namespace is
 * `concepts/<key>.md`, one in any other `namespaces/<ns>/concepts/<key>.md`.
 * The page is `conceptPageFile`'s, the writer a build uses.
 */
async function allConceptFiles(graph: GraphBackend, warnings: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const schema = await graph.schemas.schema("Concept");
  if (!schema) return out;
  const d = graph.dialect;
  const fields = [...new Set(["ref_id", "name", "docs", "namespace", ...Object.keys(schema.attributes).filter((a) => !NOT_ATTRIBUTES.has(a))])];
  const nodes = await graph.query(`MATCH (n) WHERE ${d.isType("n", ["Concept"])} AND ${d.live("n")} RETURN ${d.project("n", fields)} AS p`);
  const ups = await graph.query(
    `MATCH (p)-[r:PARENT_OF]->(c) WHERE ${d.isType("c", ["Concept"])} AND ${d.live("c")} AND ${d.live("p")} AND ${d.edgeLive("r")}
     RETURN c.ref_id AS child, p.name AS parent`,
  );
  const parents = new Map<string, string[]>();
  for (const r of ups) {
    if (typeof r["child"] !== "string" || typeof r["parent"] !== "string") continue;
    const list = parents.get(r["child"]) ?? [];
    list.push(r["parent"]);
    parents.set(r["child"], list);
  }
  for (const row of nodes) {
    const props = row["p"] as Record<string, unknown>;
    const page = conceptPageFile(schema, props, parents.get(String(props["ref_id"])) ?? []);
    if (!page) continue;
    const ns = typeof props["namespace"] === "string" && props["namespace"] ? props["namespace"] : graph.namespace;
    const file = ns === graph.namespace ? `concepts/${page.key}.md` : `namespaces/${ns}/concepts/${page.key}.md`;
    if (out.has(file)) warnings.push(`two Concepts are ${file}: only one is in the snapshot`);
    else out.set(file, page.text);
  }
  return out;
}

/** An app version's sources (what its version hash covers: never `dist/`
 *  or `data.db`), checked against that hash — or why they cannot be read. */
async function appSources(
  deps: Pick<BuildDeps, "workspace" | "apps">,
  name: string,
  version: string,
  hash: string,
): Promise<{ dir: string; files: Map<string, Buffer> } | { problem: string }> {
  const at = `${name}@${version}`;
  const dir = (await deps.apps?.versionDir(name, version))?.path ?? (await deps.workspace.materializeAppVersion(name, version)).path;
  const list = await treeFiles(dir);
  if (!list.length) return { problem: `the files of ${at} are not on this host (${dir})` };
  if ((await hashTree(dir, list)) !== hash) return { problem: `the files of ${at} are not its version: its directory was edited in place — publish it again` };
  const files = new Map<string, Buffer>();
  for (const f of list) files.set(f, await readFile(join(dir, f)));
  return { dir, files };
}

/** How a carried page speaks of workflows and steps: `rename` writes each
 *  carried one under the prefix, `others` lists the ones it names that the
 *  package does not carry. */
interface PageNames {
  rename(text: string): string;
  others(text: string): Array<{ kind: "workflow" | "step"; name: string }>;
}

/** A character a workflow or step name holds around its own: a name in
 *  text is one only where neither neighbour is one of these. */
const NAME_CHAR = "A-Za-z0-9_/\\-";

/** Where `names` stand in text as names: a name with a `-`, `_` or `/` as a
 *  whole token (`legal-task-run`, not `legal-task-run-v2` nor
 *  `acme/legal-task-run`); a one-word name (`tidy`) only as a whole code
 *  span, `` `tidy` ``, so prose keeps its words. Longest first. */
function namePattern(names: readonly string[]): RegExp | null {
  const sorted = [...new Set(names)].filter(Boolean).sort((a, b) => b.length - a.length || a.localeCompare(b));
  const word = (n: string) => /^[A-Za-z0-9]+$/.test(n);
  const compound = sorted.filter((n) => !word(n)).map(escapeRe);
  const plain = sorted.filter(word).map(escapeRe);
  const alts = [
    ...(compound.length ? [`(?<![${NAME_CHAR}])(?:${compound.join("|")})(?![${NAME_CHAR}])`] : []),
    ...(plain.length ? [`(?<=\`)(?:${plain.join("|")})(?=\`)`] : []),
  ];
  return alts.length ? new RegExp(alts.join("|"), "g") : null;
}

/** Rewrites each name in `to`'s keys as its value, where it stands as a name. */
export function renamer(to: ReadonlyMap<string, string>): (text: string) => string {
  const re = namePattern([...to.keys()]);
  return (text) => (re ? text.replace(re, (m) => to.get(m) ?? m) : text);
}

/** The names among `names` that stand in `text` as names. */
export function namesIn(text: string, names: readonly string[]): Set<string> {
  const re = namePattern(names);
  return new Set(re ? text.match(re) ?? [] : []);
}

/** A workflow's text with its top-level `name:` line written as `full`, or
 *  null when there is no plain one to write (the rest of the text as it is). */
export function stampWorkflowName(text: string, full: string): string | null {
  const line = /^name:[ \t]*[^\n]*$/m;
  if (!line.test(text)) return null;
  const out = text.replace(line, `name: ${full}`);
  return (loadYaml(out) as { name?: unknown } | null)?.name === full ? out : null;
}

/** A workflow's text with a top-level `category:` line saying `category`
 *  — the one it has, rewritten, else one after its `name:` line (or first)
 *  — or null when the text would read as anything else besides. */
export function stampWorkflowCategory(text: string, category: string): string | null {
  const line = dumpYaml({ category }).trimEnd();
  if (line.includes("\n")) return null;
  const own = /^category:[^\n]*$/m;
  const name = /^name:[^\n]*$/m.exec(text);
  const out = own.test(text)
    ? text.replace(own, line)
    : name
      ? `${text.slice(0, name.index + name[0].length)}\n${line}${text.slice(name.index + name[0].length)}`
      : `${line}\n${text}`;
  try {
    const before = loadYaml(text) as Record<string, unknown> | null;
    const after = loadYaml(out) as Record<string, unknown> | null;
    if (!before || !after || after["category"] !== category) return null;
    const rest = (o: Record<string, unknown>) => JSON.stringify(Object.entries(o).filter(([k]) => k !== "category"));
    return rest(before) === rest(after) ? out : null;
  } catch {
    return null;
  }
}

/** A step's source with each `type: "<from>"` literal written as `to`, or
 *  null when there is none to write. */
export function stampStepType(code: string, from: string, to: string): string | null {
  const literal = new RegExp(`(\\btype\\s*:\\s*)(["'\`])${escapeRe(from)}\\2`, "g");
  if (!literal.test(code)) return null;
  return code.replace(literal, (_m, head: string, q: string) => `${head}${q}${to}${q}`);
}
