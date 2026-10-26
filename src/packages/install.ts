/**
 * INSTALL and UNINSTALL (plans/marketplace.md §3): a package — and every
 * package it requires — into this workspace as ordinary steps, workflows and
 * Concepts, each version stamped with its `upstream`. There is no package
 * store: what is installed is a fold over those stamps (installed.ts).
 *
 * An install is ALL OR NOTHING. Every name and every file of every package
 * in the set is checked before the first write — the prefix rule, a local
 * item under the prefix, a Concept under someone else's stamp, the step
 * types a workflow names — and a write that still fails (a step that does
 * not load, a Concept the graph refuses) takes back what this install
 * wrote. Missing secrets, binaries and runtimes are REPORTED, not refused:
 * the deployment provides them.
 *
 * A package already installed at the same digest installs again as what is
 * missing from it (a deleted item comes back; a fork stays as it is). At
 * another digest it is an UPDATE (§4), which is not built yet: refused.
 */
import { access, constants, readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { ClaimsAuthoring } from "../claims-authoring.js";
import { walkSteps } from "../closure.js";
import { findConcept, parseConceptFile, retireConcepts, seedConcepts } from "../concept-seed.js";
import type { SecretsCapability } from "../capabilities.js";
import type { Step, StepRegistry } from "../core.js";
import { hasTemplates } from "../expr.js";
import type { SubjectRef } from "../graph/claims.js";
import { isSealedStep, sealedStepPatterns } from "../sealed.js";
import { formatStepLint, lintStepSource } from "../step-lint.js";
import { baseType } from "../step-ref.js";
import { stepLoadError } from "../steps/registry.js";
import { assertValidWorkflowYaml, readClaimsBlock, type Upstream } from "../workspace.js";
import { loadYaml } from "../yaml.js";
import { fileRefPath, resolvePackage, type CachedPackage } from "./cache.js";
import type { PackageItem } from "./format.js";
import { conceptHash, conceptPrefix, listInstalledPackages, packageConcepts, type InstalledDeps, type InstalledPackage } from "./installed.js";

export interface PackageDeps extends InstalledDeps {
  /** A FRESH registry: rebuilt from the workspace, package steps fenced.
   *  The install loads the steps it published through it. */
  getRegistry(): Promise<StepRegistry>;
  /** The claims layer; without one a package's claims are skipped, said. */
  claims?: ClaimsAuthoring | null;
  /** Fires `run_when: publish` checks, as any publish does. */
  verifyPublish?(subject: SubjectRef): Promise<unknown>;
  /** The deployment's secrets, to report what `requires.secrets` lacks. */
  secrets?: SecretsCapability;
  /** PATH as the server's children see it, for `requires.binaries`. */
  path?: string;
  /** The sealed namespaces (`STRUT_SEALED` + the defaults). */
  sealed?: readonly string[];
}

export type InstallItemStatus = "installed" | "present" | "modified";

export interface PackageInstallReport {
  package: string;
  version: string;
  digest: string;
  source: { ref: string };
  /** `installed`: this call wrote something; `present`: it was all here. */
  status: "installed" | "present";
  /** `present` = already here as installed; `modified` = here and forked
   *  (or a Concept edited), left as it is. */
  items: Array<{ kind: PackageItem["kind"]; name: string; status: InstallItemStatus; version?: string }>;
}

export interface InstallResult {
  /** The package asked for (the last of `packages`) and its digest. */
  package: string;
  digest: string;
  /** Every package of the set, requirements first. */
  packages: PackageInstallReport[];
  /** What the packages need that this deployment does not provide. */
  missing: { secrets: string[]; binaries: string[]; runtimes: string[] };
  warnings: string[];
}

/** One package of the set an install resolves. */
interface Member {
  info: CachedPackage;
  source: { ref: string };
  /** Where a relative `file:` ref of its requirements resolves from. */
  base?: string;
}

const conflict = (msg: string) => new Error(`package_conflict: ${msg}`);
const isHelper = (item: PackageItem) => item.kind === "step" && !!item.helper;

/** Install the package at `ref` (pinned to `digest` when given), and first
 *  every package it requires. `actor` is recorded on every version written
 *  and owns the workflows. */
export async function installPackage(
  deps: PackageDeps,
  ref: string,
  opts: { digest?: string; actor?: string } = {},
): Promise<InstallResult> {
  const before = new Map((await listInstalledPackages(deps)).map((p) => [p.package, p]));
  const members = await resolveSet(deps, ref, opts.digest, before);
  const registry = await deps.getRegistry();
  const checked = await checkSet(deps, members, registry, before);

  const upstreamOf = (m: Member): Upstream => ({
    package: m.info.manifest.package,
    version: m.info.manifest.version,
    digest: m.info.digest,
    source: m.source,
    secrets: m.info.manifest.requires?.secrets ?? [],
  });
  const publish = { source: "install" as const, ...(opts.actor ? { actor: opts.actor } : {}) };
  const reports = new Map(members.map((m) => [m.info.manifest.package, [] as PackageInstallReport["items"]]));
  const wrote: Array<{ kind: "workflow" | "step"; name: string }> = [];
  const conceptsWritten = new Map<string, string[]>(); // package → the page files it wrote
  const { warnings } = checked;

  try {
    // Steps first, every package's, so one registry rebuild loads them all.
    for (const m of members) {
      for (const item of m.info.items.filter((i) => i.kind === "step")) {
        const here = checked.present.get(item.name);
        if (here) {
          reports.get(m.info.manifest.package)!.push({ kind: "step", name: item.name, status: here });
          continue;
        }
        const code = await readFile(join(m.info.dir, item.path), "utf-8");
        const { version } = await deps.workspace.publishStep(item.name, code, undefined, undefined, { ...publish, upstream: upstreamOf(m) });
        wrote.push({ kind: "step", name: item.name });
        reports.get(m.info.manifest.package)!.push({ kind: "step", name: item.name, status: "installed", version });
      }
    }
    const loaded = await deps.getRegistry();
    for (const w of wrote) {
      if (w.name.split("/").pop()!.startsWith("_")) continue;
      const def = loaded[w.name];
      if (def?.type === w.name) continue;
      const why = def
        ? `its defineStep says type "${def.type}" — a step's type is its path, ${w.name}`
        : ((await stepLoadError(join(await deps.workspace.materializeCustomSteps(), `${w.name}.ts`))) ?? "it did not load into the registry");
      throw new Error(`bad_package: the step ${w.name} — ${why}`);
    }
    for (const m of members) {
      for (const item of m.info.items.filter((i) => i.kind === "workflow")) {
        const here = checked.present.get(item.name);
        if (here) {
          reports.get(m.info.manifest.package)!.push({ kind: "workflow", name: item.name, status: here });
          continue;
        }
        const text = await readFile(join(m.info.dir, item.path), "utf-8");
        const description = (loadYaml(text) as { description?: unknown } | null)?.description;
        const { version } = await deps.workspace.publishWorkflowByContent(
          item.name,
          text,
          typeof description === "string" ? description : undefined,
          undefined,
          undefined,
          { ...publish, upstream: upstreamOf(m) },
        );
        wrote.push({ kind: "workflow", name: item.name });
        if (opts.actor) await deps.workspace.setWorkflowOwner(item.name, opts.actor);
        reports.get(m.info.manifest.package)!.push({ kind: "workflow", name: item.name, status: "installed", version });
      }
    }
    // Concepts, through the seeder: a set per package, stamped `pkg/<package>/`.
    if (checked.conceptsOn) {
      for (const m of members) {
        if (!m.info.items.some((i) => i.kind === "concept")) continue;
        const pkg = m.info.manifest.package;
        const outcomes = await seedConcepts(deps.graph, [{ dir: join(m.info.dir, "concepts"), prefix: conceptPrefix(pkg), keepEdited: true }]);
        const written: string[] = [];
        conceptsWritten.set(pkg, written);
        for (const o of outcomes) {
          if (o.action === "create" || o.action === "update") written.push(`${o.name}.md`);
          if (o.action === "error" || o.action === "skip") {
            throw conflict(o.action === "skip" ? `Concept ${o.name} was taken by someone else during the install` : `Concept ${o.name}: ${o.error}`);
          }
          const status: InstallItemStatus = o.action === "keep" ? (o.edited ? "modified" : "present") : "installed";
          reports.get(pkg)!.push({ kind: "concept", name: o.name, status });
        }
      }
    }
  } catch (err) {
    await takeBack(deps, wrote, conceptsWritten);
    throw err;
  }

  // The contract, once everything it names is here. A claim that will not
  // write is said, never a reason to take the install back: the code is in.
  const published = new Set(wrote.map((w) => `${w.kind}:${w.name}`));
  for (const m of checked.members) {
    for (const c of m.claims) {
      if (!published.has(`${c.subject.kind}:${c.subject.name}`)) continue;
      if (!deps.claims) {
        warnings.push(`the claims of ${c.subject.name} were not recorded: this workspace keeps no claims (a graph-backed one does)`);
        continue;
      }
      const r = await deps.claims.applyClaimsArg(c.subject, c.claims, { publisher: m.info.manifest.package, scoped: false });
      if (r.error) warnings.push(`${c.subject.name}: ${r.error}`);
      const ref: SubjectRef = c.subject.kind === "step" ? { kind: "step", type: c.subject.name } : { kind: "workflow", name: c.subject.name };
      await deps.verifyPublish?.(ref).catch(() => undefined);
    }
  }

  const root = members.at(-1)!;
  return {
    package: root.info.manifest.package,
    digest: root.info.digest,
    packages: members.map((m) => {
      const items = reports.get(m.info.manifest.package)!;
      return {
        package: m.info.manifest.package,
        version: m.info.manifest.version,
        digest: m.info.digest,
        source: m.source,
        status: items.some((i) => i.status === "installed") ? "installed" : "present",
        items,
      };
    }),
    missing: await missingFor(deps, members, opts.actor),
    warnings,
  };
}

/** The package at `ref`, then every package it requires that is not
 *  installed here at its pin, each resolved from its source hint unless the
 *  cache holds its digest already — in install order, requirements first.
 *  Exact pins union; a name pinned at two digests, or required at one and
 *  installed at another, is refused. */
async function resolveSet(deps: PackageDeps, ref: string, digest: string | undefined, installed: Map<string, InstalledPackage>): Promise<Member[]> {
  const order: Member[] = [];
  const inSet = new Map<string, string>();
  const visit = async (ref: string, digest: string | undefined, base: string | undefined, expected?: { package: string; by: string }): Promise<void> => {
    const cached = digest ? await deps.cache.get(digest) : undefined;
    const info = cached ?? (await resolvePackage(ref, { cache: deps.cache, ...(digest ? { digest } : {}), ...(base ? { base } : {}) }));
    const pkg = info.manifest.package;
    if (expected && pkg !== expected.package) {
      throw new Error(`package_name_mismatch: ${expected.by} requires ${expected.package} from ${ref}, which is the package ${pkg}`);
    }
    inSet.set(pkg, info.digest);
    const member: Member = { info, source: { ref }, ...(ref.startsWith("file:") ? { base: fileRefPath(ref, base) } : {}) };
    for (const req of info.manifest.requires?.packages ?? []) {
      const pinned = inSet.get(req.package);
      if (pinned !== undefined) {
        if (pinned !== req.digest) throw conflict(`${req.package} is required at two digests, ${pinned} and ${req.digest} (by ${pkg})`);
        continue;
      }
      const here = installed.get(req.package);
      if (here?.digest === req.digest) continue;
      if (here) throw conflict(`${pkg} requires ${req.package} at ${req.digest}, and this strut has it at ${here.digest ?? "another digest"} — updating a package is not built yet`);
      await visit(req.source, req.digest, member.base, { package: req.package, by: pkg });
    }
    order.push(member);
  };
  await visit(ref, digest, undefined);
  return order;
}

interface Checked {
  /** Items already here as this package installed them: name → `present`, or `modified` for a fork. */
  present: Map<string, "present" | "modified">;
  conceptsOn: boolean;
  warnings: string[];
}

interface MemberClaims {
  subject: { kind: "workflow" | "step"; name: string };
  claims: NonNullable<ReturnType<typeof readClaimsBlock>>;
}

/** Everything that can refuse the install, before it writes. Adds each
 *  member's claims to it. */
async function checkSet(
  deps: PackageDeps,
  members: Member[],
  registry: StepRegistry,
  installed: Map<string, InstalledPackage>,
): Promise<Checked & { members: Array<Member & { claims: MemberClaims[] }> }> {
  const out: Checked = { present: new Map(), conceptsOn: false, warnings: [] };
  const sealed = deps.sealed ?? sealedStepPatterns();
  const problems: string[] = [];

  // What the set adds, for the names its workflows may use.
  const setSteps = new Set(members.flatMap((m) => m.info.items.filter((i) => i.kind === "step" && !i.helper).map((i) => i.name)));
  const setWorkflows = new Set(members.flatMap((m) => m.info.items.filter((i) => i.kind === "workflow").map((i) => i.name)));
  const knownStep = (type: string) => !!registry[type] || setSteps.has(type);
  const workspaceWorkflows = new Set((await deps.workspace.listWorkflows()).map((w) => w.name));
  const workspaceSteps = Object.keys(await deps.workspace.getActiveStepHashes());

  const concepts = new Map<string, string>(); // page name → the package that ships it
  for (const m of members) {
    const pkg = m.info.manifest.package;
    if (m.info.items.some((i) => i.kind === "app")) {
      throw new Error(`package_unsupported: ${pkg} ships an app (apps/) — installing an app is not built yet`);
    }
    const here = installed.get(pkg);
    if (here?.digest && here.digest !== m.info.digest) {
      throw new Error(`package_update_not_built: ${pkg} ${here.version ?? ""} is installed here at ${here.digest}; updating it to ${m.info.digest} is not built yet — uninstall it first (DELETE /packages/${pkg})`.replace("  ", " "));
    }
    if (here && !here.digest) await sameConcepts(deps, m, here);
    const mine = new Map((here?.items ?? []).map((i) => [i.name, i]));

    // The prefix holds this package's items alone.
    const under = (name: string) => name.startsWith(`${pkg}/`);
    for (const name of [...workspaceWorkflows].filter(under)) if (!mine.has(name)) problems.push(`the workflow ${name} is a local one under ${pkg}/`);
    for (const name of workspaceSteps.filter(under)) if (!mine.has(name)) problems.push(`the step ${name} is a local one under ${pkg}/`);

    for (const item of m.info.items) {
      if (item.kind === "step" || item.kind === "workflow") {
        const at = mine.get(item.name);
        if (at) out.present.set(item.name, at.modified ? "modified" : "present");
        if (item.kind === "step" && isSealedStep(item.name, undefined, sealed)) problems.push(`${item.name} is in a sealed namespace (${sealed.join(", ")}): those are strut's`);
        if (item.kind === "step" && !at && registry[item.name] && !workspaceSteps.includes(item.name)) problems.push(`${item.name} is a step strut ships`);
      }
      if (item.kind === "concept") {
        const other = concepts.get(item.name);
        if (other) problems.push(`the Concept ${item.name} is in both ${other} and ${pkg}`);
        concepts.set(item.name, pkg);
      }
    }
  }
  if (problems.length) throw conflict(problems.join("; "));

  // The files: what each workflow names must be here or in the set; claims parse.
  const bad: string[] = [];
  const withClaims: Array<Member & { claims: MemberClaims[] }> = [];
  for (const m of members) {
    const claims: MemberClaims[] = [];
    for (const item of m.info.items) {
      if (item.kind === "workflow") {
        const text = await readFile(join(m.info.dir, item.path), "utf-8");
        try {
          assertValidWorkflowYaml(text);
        } catch (err) {
          bad.push(`${item.path}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        const parsed = (loadYaml(text) ?? {}) as { name?: unknown; steps?: unknown };
        if (parsed.name !== undefined && parsed.name !== item.name) bad.push(`${item.path} says name: ${String(parsed.name)} — a workflow's name is its path, ${item.name}`);
        if (!Array.isArray(parsed.steps)) {
          bad.push(`${item.path}: a workflow has a steps list`);
          continue;
        }
        bad.push(...namesIn(parsed.steps as Step[], knownStep, (w) => setWorkflows.has(w) || workspaceWorkflows.has(w)).map((p) => `${item.path} ${p}`));
        const block = readClaimsBlock(parsed);
        if (block) {
          bad.push(...checkTypes(block, knownStep).map((p) => `${item.path} claims: ${p}`));
          claims.push({ subject: { kind: "workflow", name: item.name }, claims: block });
        }
      } else if (item.kind === "step" && !isHelper(item)) {
        const findings = lintStepSource(await readFile(join(m.info.dir, item.path), "utf-8"));
        if (findings.length) out.warnings.push(`${item.name} reaches past ctx.services:\n${formatStepLint(findings)}`);
        if (!item.claims) continue;
        try {
          const block = readClaimsBlock({ claims: loadYaml(await readFile(join(m.info.dir, item.claims), "utf-8")) });
          if (!block) continue;
          bad.push(...checkTypes(block, knownStep).map((p) => `${item.claims}: ${p}`));
          claims.push({ subject: { kind: "step", name: item.name }, claims: block });
        } catch (err) {
          bad.push(`${item.claims}: ${(err instanceof Error ? err.message : String(err)).replace("Workflow YAML has an invalid `claims:` block", "not a list of claims")}`);
        }
      }
    }
    withClaims.push({ ...m, claims });
  }
  if (bad.length) throw new Error(`bad_package: ${bad.join("; ")}`);

  // Concepts: a page's name may be taken only by this package; its parent must exist.
  if (concepts.size > 0) {
    const schema = deps.graph ? await deps.graph.schemas.schema("Concept") : undefined;
    if (!deps.graph || !schema) {
      out.warnings.push(`the Concepts (${[...concepts.keys()].join(", ")}) were not installed: ${deps.graph ? "the graph has no Concept schema" : "this workspace has no graph"}`);
    } else {
      out.conceptsOn = true;
      const problems: string[] = [];
      for (const m of members) {
        const pkg = m.info.manifest.package;
        for (const item of m.info.items.filter((i) => i.kind === "concept")) {
          const page = parseConceptFile(item.path.slice("concepts/".length), await readFile(join(m.info.dir, item.path), "utf-8"), conceptPrefix(pkg));
          const existing = await findConcept(deps.graph, schema, page.name);
          const stamp = typeof existing?.unique_source_id === "string" ? existing.unique_source_id : undefined;
          if (existing && !existing.deleted && !stamp?.startsWith(conceptPrefix(pkg))) {
            problems.push(`the Concept ${page.name} is in the graph already, ${stamp ? `stamped ${stamp.replace(/@.*$/, "")}` : "made here"}`);
          }
          if (page.parent && !concepts.has(page.parent)) {
            const parent = await findConcept(deps.graph, schema, page.parent);
            if (!parent || parent.deleted) problems.push(`the Concept ${page.name} hangs under ${page.parent}, which is neither in the graph nor in the packages`);
          }
        }
      }
      if (problems.length) throw conflict(problems.join("; "));
    }
  }
  return { ...out, members: withClaims };
}

/** A package of Concepts alone, installed with no record of its digest (the
 *  cache lost it): the same digest only when every page here is stamped from
 *  a file this package ships, at that file's hash. */
async function sameConcepts(deps: PackageDeps, m: Member, here: InstalledPackage): Promise<void> {
  const pkg = m.info.manifest.package;
  const files = new Map<string, string>();
  for (const item of m.info.items.filter((i) => i.kind === "concept")) {
    files.set(item.path.slice("concepts/".length), conceptHash(await readFile(join(m.info.dir, item.path), "utf-8")));
  }
  for (const c of await packageConcepts(deps.graph, pkg)) {
    if (files.get(c.file) !== c.hash) {
      throw new Error(`package_update_not_built: ${pkg} is installed here from other files (${here.items.length} item(s)); updating it is not built yet — uninstall it first (DELETE /packages/${pkg})`);
    }
  }
}

/** What a workflow's steps name that is neither here nor in the set: a step
 *  type, a literal `agentTools` grant, a `subflow` target. Templates and
 *  globs are read at run time. */
function namesIn(steps: Step[], knownStep: (type: string) => boolean, knownWorkflow: (name: string) => boolean): string[] {
  const out = new Set<string>();
  walkSteps(steps, (s) => {
    const type = baseType(s.type);
    if (!hasTemplates(type) && !knownStep(type)) out.add(`names the step ${type}, which is neither on this strut nor in the packages`);
    const cfg = (s.config ?? {}) as Record<string, unknown>;
    for (const grant of Array.isArray(cfg["agentTools"]) ? (cfg["agentTools"] as unknown[]) : []) {
      if (typeof grant !== "string" || hasTemplates(grant) || grant.includes("*") || grant.startsWith("mcp/")) continue;
      if (!knownStep(baseType(grant))) out.add(`grants the step ${grant}, which is neither on this strut nor in the packages`);
    }
    const wf = cfg["workflow"];
    if (s.type === "subflow" && typeof wf === "string" && !hasTemplates(wf) && !knownWorkflow(wf)) {
      out.add(`calls the workflow ${wf}, which is neither on this strut nor in the packages`);
    }
  });
  return [...out];
}

/** The step types a contract's checks name that are not here or in the set. */
function checkTypes(claims: MemberClaims["claims"], knownStep: (type: string) => boolean): string[] {
  const out: string[] = [];
  for (const c of claims) for (const k of c.checks) if (k.type && !knownStep(baseType(k.type))) out.push(`a check of "${c.text}" runs the step ${k.type}, which is neither on this strut nor in the packages`);
  return out;
}

/** Undo an install's writes: the names it published (they were free) and
 *  the Concepts it wrote, retired by their stamps, then the registry
 *  without them. */
async function takeBack(deps: PackageDeps, wrote: Array<{ kind: "workflow" | "step"; name: string }>, concepts: Map<string, string[]>): Promise<void> {
  for (const w of [...wrote].reverse()) {
    await (w.kind === "workflow" ? deps.workspace.deleteWorkflow(w.name) : deps.workspace.deleteStep(w.name)).catch((err) => {
      console.warn(`[packages] could not take back the ${w.kind} ${w.name}:`, err instanceof Error ? err.message : err);
    });
  }
  const schema = concepts.size && deps.graph ? await deps.graph.schemas.schema("Concept").catch(() => undefined) : undefined;
  if (schema) for (const [pkg, files] of concepts) await retireConcepts(deps.graph!, schema, { dir: "", prefix: conceptPrefix(pkg), retired: files });
  await deps.getRegistry().catch(() => undefined);
}

/** `requires` the deployment does not meet: secrets it cannot resolve (the
 *  installer's own included), binaries not on PATH, runtimes (none can be
 *  configured yet, §11.1). */
async function missingFor(deps: PackageDeps, members: Member[], actor: string | undefined): Promise<InstallResult["missing"]> {
  const secrets = new Set<string>();
  const binaries = new Set<string>();
  const runtimes = new Set<string>();
  const view = actor && deps.secrets?.forPrincipal ? deps.secrets.forPrincipal(actor) : deps.secrets;
  for (const m of members) {
    const req = m.info.manifest.requires ?? {};
    for (const name of req.secrets ?? []) if ((await view?.get(name).catch(() => undefined)) === undefined) secrets.add(name);
    for (const bin of req.binaries ?? []) if (!(await onPath(bin, deps.path))) binaries.add(bin);
    for (const r of req.runtimes ?? []) runtimes.add(r.name);
  }
  return { secrets: [...secrets].sort(), binaries: [...binaries].sort(), runtimes: [...runtimes].sort() };
}

async function onPath(bin: string, path: string | undefined): Promise<boolean> {
  for (const dir of (path ?? "").split(delimiter).filter(Boolean)) {
    try {
      await access(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      // not in this one
    }
  }
  return false;
}

export interface UninstallResult {
  package: string;
  /** What went: the items still as the package installed them. */
  removed: Array<{ kind: PackageItem["kind"]; name: string }>;
  /** What stayed, and why: a fork or an edited page is the person's work. */
  kept: Array<{ kind: PackageItem["kind"]; name: string; reason: string }>;
}

/**
 * Uninstall: every name of the package whose active version is still the
 * one the install put there goes — the versions (soft on a graph), never the
 * runs, evidence or jobs, so history keeps the name it ran under — and every
 * untouched Concept is retired. A fork, an edited page, and the helpers
 * while a forked step of the package stays (it may import them) are kept and
 * listed. `busy` names a workflow with a run in flight, which refuses the
 * whole uninstall; `forget` drops a deleted workflow's schedules.
 */
export async function uninstallPackage(
  deps: PackageDeps,
  pkg: string,
  opts: { busy?(workflow: string): boolean; forget?(workflow: string): Promise<void> } = {},
): Promise<UninstallResult> {
  const p = (await listInstalledPackages(deps)).find((x) => x.package === pkg);
  if (!p) throw new Error(`package_not_installed: ${pkg} is not installed here`);
  const forkedStep = p.items.some((i) => i.kind === "step" && !i.helper && i.modified);
  const result: UninstallResult = { package: pkg, removed: [], kept: [] };
  const go = p.items.filter((i) => {
    if (i.kind === "concept") return false;
    if (i.modified) result.kept.push({ kind: i.kind, name: i.name, reason: "modified here (a fork)" });
    else if (i.helper && forkedStep) result.kept.push({ kind: i.kind, name: i.name, reason: "a helper a forked step of the package may import" });
    else return true;
    return false;
  });
  const busy = go.filter((i) => i.kind === "workflow" && opts.busy?.(i.name));
  if (busy.length) throw new Error(`package_busy: ${busy.map((i) => i.name).join(", ")} has a run in flight — cancel it first`);
  for (const i of go) {
    if (i.kind === "workflow") {
      await opts.forget?.(i.name);
      await deps.workspace.deleteWorkflow(i.name);
    } else await deps.workspace.deleteStep(i.name);
    result.removed.push({ kind: i.kind, name: i.name });
  }
  const pages = p.items.filter((i) => i.kind === "concept");
  if (pages.length && deps.graph) {
    const schema = await deps.graph.schemas.schema("Concept");
    const files = new Map((await packageConcepts(deps.graph, pkg)).map((c) => [c.name, c.file]));
    const retire: string[] = [];
    for (const i of pages) {
      if (i.modified === false && files.has(i.name)) retire.push(files.get(i.name)!);
      else result.kept.push({ kind: "concept", name: i.name, reason: i.modified ? "edited here" : "its file is not in the package cache, so an edit cannot be told apart" });
    }
    const retired = schema ? new Set(await retireConcepts(deps.graph, schema, { dir: "", prefix: conceptPrefix(pkg), retired: retire })) : new Set<string>();
    for (const name of pages.map((i) => i.name).filter((n) => retired.has(n))) result.removed.push({ kind: "concept", name });
  }
  return result;
}
