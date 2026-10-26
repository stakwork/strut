/**
 * BUILD a package (plans/marketplace.md §2): what the named workflows can
 * execute, written as a package directory and put in the cache by its
 * digest — so the archive route serves it, and `installPackage` installs it
 * from `file:<the cache directory>` — with the manifest a person would write
 * by hand.
 *
 *   1. The closure: `flowClosure` per named workflow, `agentTools` globs
 *      expanded against the registry. A workflow or custom step it reaches
 *      under the prefix is an item. One outside it is a `requires.packages`
 *      pin when its active version carries an `upstream`, recorded nowhere
 *      when it is a seed's (`source: "seed"`, strut's own `job` or a host's —
 *      the installing strut must have it, and the install checks), and
 *      refuses the build otherwise — unless it is under a SIBLING the request
 *      requires, a package built here whose cached copy holds it as it is
 *      now. Core and lib types are recorded nowhere.
 *   2. Every `_` step under the prefix: helpers ride with their namespace.
 *   3. The named Concepts and the pages under each (`PARENT_OF`).
 *   4. Each step's live claims, as its `.claims.yaml` — a claim with a
 *      check that reaches outside the package and its requirements is left
 *      out, said.
 *   5. `requires`, from what can be read: secret names in configs
 *      (`secretNamesIn`) and literal `secrets.get("…")` calls in step
 *      source, literal `exec` commands, literal `runtime:` fields.
 *   6. An item in a sealed namespace refuses the build.
 *
 * Everything that refuses is collected before anything is written, and the
 * refusal names every one (`package_build_refused: …`). Building twice from
 * the same workspace gives the same digest.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
}

export interface BuildRequest {
  /** `publisher/name`: the prefix every item is under. */
  package: string;
  version: string;
  description?: string;
  license?: string;
  /** Workflows, each with everything it can execute. One outside the
   *  prefix is a pin — for what a closure that cannot be read whole reaches. */
  workflows?: string[];
  /** Custom steps beyond what the workflows reach (a step-centric package),
   *  or what such a closure reaches outside the prefix. */
  steps?: string[];
  /** Concept pages, each with the pages under it. */
  concepts?: string[];
  /** Not built yet: refused. */
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

/** A literal `secrets.get("NAME")` (or `secrets?.get`) in step source. */
const SECRET_GET = /\bsecrets\??\.get\(\s*(["'`])([^"'`\s$\\]+)\1\s*[,)]/g;

/** The record of an item's active version: where it came from. */
interface Origin {
  upstream?: Upstream;
  source?: VersionSource;
}

export async function buildPackage(deps: BuildDeps, req: BuildRequest): Promise<BuildResult> {
  const pkg = req.package;
  if (typeof pkg !== "string" || !PACKAGE_NAME.test(pkg)) throw refused(["a package is named publisher/name: two lowercase segments, [a-z][a-z0-9-]*"]);
  if (typeof req.version !== "string" || !req.version) throw refused(["a package has a version, the publisher's label (1.4.0)"]);
  if (req.apps?.length) throw new Error(`package_unsupported: ${req.apps.join(", ")} — a package with an app is not built yet`);
  if (!req.workflows?.length && !req.steps?.length && !req.concepts?.length) throw refused(["name at least one workflow, step or Concept"]);

  const prefix = `${pkg}/`;
  const under = (name: string) => name.startsWith(prefix);
  const sealed = deps.sealed ?? sealedStepPatterns();
  const registry = await deps.getRegistry();
  const custom = new Set(Object.keys(await deps.workspace.getActiveStepHashes()));
  const problems: string[] = [];
  const warnings = new Set<string>();

  const workflows = new Set<string>();
  const steps = new Set<string>();
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

  const originOf = async (kind: "workflow" | "step", name: string): Promise<Origin | null> => {
    const meta = kind === "workflow" ? await deps.workspace.getWorkflowMetadata(name) : await deps.workspace.getStepMetadata(name);
    const v = meta?.versions[meta.active];
    return meta ? { ...(v?.upstream ? { upstream: v.upstream } : {}), ...(v?.source ? { source: v.source } : {}) } : null;
  };

  // Outside the prefix: a seed's is strut's (or the host's), another
  // package's is a pin at the digest it was installed at, anything else is
  // refused — a package carries its own prefix and nobody else's items.
  const outside = async (kind: "workflow" | "step", name: string, o: Origin, by: string) => {
    if (o.source === "seed") return;
    const up = o.upstream;
    const sibling = siblings.get(packagePrefixOf(name) ?? "");
    if (sibling && (!up || up.package !== sibling.manifest.package)) {
      // A sibling built here: the item must be in it, byte for byte as it is now.
      const file = `${kind === "workflow" ? "workflows" : "steps"}/${name.slice(sibling.manifest.package.length + 1)}.${kind === "workflow" ? "yaml" : "ts"}`;
      const here = kind === "workflow" ? await deps.workspace.getWorkflowSource(name, (await deps.workspace.getWorkflowMetadata(name))!.active) : (await deps.workspace.getStepSource(name))?.code;
      const there = sibling.files.includes(file) ? await readFile(join(sibling.dir, file), "utf-8") : undefined;
      if (there === undefined || there !== here) {
        problems.push(`${by} reaches the ${kind} ${name}, which ${sibling.manifest.package} at ${sibling.digest} ${there === undefined ? "does not hold" : "holds as it was, not as it is here"} — rebuild ${sibling.manifest.package} and require its new digest`);
      }
      return;
    }
    if (!up || packagePrefixOf(name) !== up.package) {
      problems.push(`${by} reaches the ${kind} ${name}, which is outside ${prefix} and came from no package — move it under ${prefix}, install it from its package, or build its package and require it (requires.packages)`);
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
    if (under(type)) steps.add(type);
    else await outside("step", type, (await originOf("step", type)) ?? {}, by);
  };

  const reachWorkflow = async (name: string, by: string): Promise<void> => {
    if (under(name)) return; // the resolver below walks it
    const o = await originOf("workflow", name);
    if (!o) problems.push(`${by} calls the workflow ${name}, which is not here`);
    else await outside("workflow", name, o, by);
  };

  // The closure walks a workflow under the prefix and stops at one outside
  // it: a pin carries its own closure, a seed is the installing strut's.
  let root = "";
  const resolver: SubflowResolver = {
    getWorkflow: (name) => walkInto(name),
    getWorkflowVersion: (name) => walkInto(name),
  };
  const walkInto = async (name: string): Promise<Flow> => {
    if (!under(name)) return { steps: [] } as unknown as Flow;
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
  for (const name of req.workflows ?? []) {
    if (!under(name)) {
      await reachWorkflow(name, "the request");
      continue;
    }
    let flow: Flow;
    try {
      flow = await deps.workspace.getWorkflow(name);
    } catch {
      problems.push(`no workflow ${name} here`);
      continue;
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
  }
  for (const type of req.steps ?? []) {
    if (!custom.has(type)) problems.push(registry[type] ? `${type} is a step strut ships, not one a package carries` : `no custom step ${type} here`);
    else await reachStep(type, "the request");
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

  // 2. The helpers, with their namespace.
  for (const type of custom) if (under(type) && isHelperName(type)) steps.add(type);

  // 6. Sealed namespaces are strut's.
  for (const name of [...workflows, ...steps]) {
    if (isSealedStep(name, undefined, sealed)) problems.push(`${name} is in a sealed namespace (${sealed.join(", ")}): those are strut's`);
  }

  // The items' files.
  const files = new Map<string, string>();
  const rel = (name: string) => name.slice(prefix.length);
  for (const name of [...workflows].sort()) {
    const meta = await deps.workspace.getWorkflowMetadata(name);
    if (!meta) continue;
    const text = await deps.workspace.getWorkflowSource(name, meta.active);
    const declared = (loadYaml(text) as { name?: unknown } | null)?.name;
    if (declared !== undefined && declared !== name) problems.push(`the workflow ${name} says name: ${String(declared)} — a package names a workflow by its path`);
    files.set(`workflows/${rel(name)}.yaml`, text);
  }
  for (const type of [...steps].sort()) {
    const src = await deps.workspace.getStepSource(type);
    if (!src || src.origin !== "custom") {
      problems.push(`no source for the step ${type}`);
      continue;
    }
    // The install loads each step and refuses one whose defineStep is not its path.
    if (!isHelperName(type) && registry[type]?.type !== type) problems.push(`the step ${type} does not load here as ${type}`);
    files.set(`steps/${rel(type)}.ts`, src.code);
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
  if (!files.size) throw refused([`nothing under ${prefix} to package`]);

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
    for (const m of (files.get(`steps/${rel(type)}.ts`) ?? "").matchAll(SECRET_GET)) secrets.add(m[2]!);
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
    return meta?.versions[meta.active]?.source === "seed";
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
