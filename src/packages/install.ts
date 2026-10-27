/**
 * INSTALL and UNINSTALL (plans/marketplace.md §3): a package — and every
 * package it requires — into this workspace as ordinary steps, workflows,
 * apps and Concepts, each version stamped with its `upstream`. There is no
 * package store: what is installed is a fold over those stamps (installed.ts).
 *
 * An install is ALL OR NOTHING. Every name and every file of every package
 * in the set is checked before the first write — the prefix rule, a local
 * item under the prefix, a Concept under someone else's stamp, the step
 * types a workflow names, and each app BUILT against this strut's kit (the
 * kit is the installing strut's, so the build is the compatibility check)
 * — and a write that still fails (a step that does not load, a Concept the
 * graph refuses) takes back what this install wrote. An app is published
 * through the apps capability, so an app's publish does at install what it
 * does anywhere. Missing secrets, binaries and runtimes are REPORTED, not
 * refused: the deployment provides them.
 *
 * Two DOORS write a package. A person's (`install`, `POST /packages/install`)
 * installs it, and installs the same digest again as what is missing from
 * it (a deleted item comes back; a fork stays as it is); another digest is
 * an UPDATE, which a person's door refuses until it asks first (§4, §8).
 * The operator's distro (`distro`, §12, §12.1) applies a release with no
 * ask — its publish was the accept — and is the door that updates, item by
 * item (§4's table): an item whose active version the package wrote is
 * FAST-FORWARDED to the release's; a fork gets the release's version BESIDE
 * it, the fork staying active; an item the release no longer ships is
 * RETIRED when untouched and kept when forked; an edited Concept is left as
 * it is. A package the distro wrote is the distro's: a person's door
 * refuses to write or remove it.
 *
 * Every step the install makes active is LOADED before the first write,
 * beside the helpers as they will be (§12 step 6), so an update is not
 * written and then taken back: no store deletes one version. What still
 * fails after a write is taken back by re-pointing an updated item at the
 * version that was active, and deleting a new one.
 */
import { randomBytes } from "node:crypto";
import { access, constants, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import type { AppsCapability } from "../apps/apps.js";
import { buildApp, type BuildDeps as AppBuildDeps } from "../apps/build.js";
import { copyAppDir } from "../apps/files.js";
import { readManifest } from "../apps/manifest.js";
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
import { stepFileType, stepLoadError } from "../steps/registry.js";
import { contentHash, treeHash } from "../version.js";
import { assertValidWorkflowYaml, ensureEsmScope, readClaimsBlock, type Upstream } from "../workspace.js";
import { loadYaml } from "../yaml.js";
import { fileRefPath, resolvePackage, type CachedPackage } from "./cache.js";
import type { PackageItem } from "./format.js";
import {
  conceptHash,
  conceptPrefix,
  listInstalledPackages,
  packageConcepts,
  type InstalledDeps,
  type InstalledItem,
  type InstalledPackage,
  type PackageDoor,
} from "./installed.js";

export type { PackageDoor } from "./installed.js";

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
  /** Builds and publishes an app; without it a package with an app is refused. */
  apps?: AppsCapability;
}

/** What happened to one item: `installed` new here; `present` already here
 *  as the package has it; `modified` here and forked (or a Concept edited),
 *  left as it is; `updated` fast-forwarded to the release; `diverged` the
 *  release's version recorded beside a fork, which stays active; `retired`
 *  dropped by the release and removed; `kept` dropped by the release and
 *  kept, with the reason. */
export type InstallItemStatus = "installed" | "present" | "modified" | "updated" | "diverged" | "retired" | "kept";

export interface PackageInstallReport {
  package: string;
  version: string;
  digest: string;
  source: { ref: string };
  /** `installed`: this call wrote something; `updated`: it moved the
   *  package from another digest (`from`); `present`: it was all here. */
  status: "installed" | "updated" | "present";
  /** The release it was at before an update. */
  from?: { version?: string; digest?: string };
  items: Array<{ kind: PackageItem["kind"]; name: string; status: InstallItemStatus; version?: string; reason?: string }>;
}

export interface InstallOptions {
  /** The digest `ref` must resolve to. */
  digest?: string;
  /** Recorded on every version written; owns the new workflows. */
  actor?: string;
  /** Who writes it (`install` unless said): the distro's door applies a
   *  release with no ask and updates (§12). Code only: no route takes it. */
  door?: PackageDoor;
  /** A workflow with a run in flight: one the release drops refuses the update. */
  busy?(workflow: string): boolean;
  /** Drops a retired workflow's schedules. */
  forget?(workflow: string): Promise<void>;
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
 *  every package it requires — through the distro's door, updating it and
 *  them (the module comment). */
export async function installPackage(deps: PackageDeps, ref: string, opts: InstallOptions = {}): Promise<InstallResult> {
  const door = opts.door ?? "install";
  const before = new Map((await listInstalledPackages(deps)).map((p) => [p.package, p]));
  const members = await resolveSet(deps, ref, opts.digest, before, door);
  const registry = await deps.getRegistry();
  // The apps are copied out of the cache to build (a build writes `dist/`),
  // and the steps to a trial directory to load.
  const scratch = join(deps.cache.root, ".install", randomBytes(8).toString("hex"));
  try {
    return await installSet(deps, members, registry, before, scratch, { ...opts, door });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** A workflow, step or app the release ships, and what the install does with it. */
type ItemPlan =
  | { action: "new" }
  /** Here as the release has it; `modified`: a fork a person's door leaves alone. */
  | { action: "present" | "modified" }
  /** The package wrote the active version: the release's becomes active. */
  | { action: "update"; previous: string }
  /** A fork: the release's version is recorded beside it, not made active. */
  | { action: "diverge" };

/** A workflow, step or app the install writes: a new one (taken back by
 *  deleting it), or an update (by re-pointing it at `previous`). */
interface Wrote {
  kind: "workflow" | "step" | "app";
  name: string;
  previous?: string;
}

async function installSet(
  deps: PackageDeps,
  members: Member[],
  registry: StepRegistry,
  before: Map<string, InstalledPackage>,
  scratch: string,
  opts: InstallOptions & { door: PackageDoor },
): Promise<InstallResult> {
  const checked = await checkSet(deps, members, registry, before, scratch, opts.door);
  const retiring = retirements(checked, members);
  const busy = retiring.filter((i) => i.go && i.item.kind === "workflow" && opts.busy?.(i.item.name));
  if (busy.length) throw new Error(`package_busy: ${busy.map((i) => i.item.name).join(", ")} has a run in flight, and the release no longer ships it — cancel it first`);

  const upstreamOf = (m: Member): Upstream => ({
    package: m.info.manifest.package,
    version: m.info.manifest.version,
    digest: m.info.digest,
    source: m.source,
    secrets: m.info.manifest.requires?.secrets ?? [],
  });
  const publish = { source: opts.door, ...(opts.actor ? { actor: opts.actor } : {}) };
  const reports = new Map(members.map((m) => [m.info.manifest.package, [] as PackageInstallReport["items"]]));
  const wrote: Wrote[] = [];
  const conceptsWritten = new Map<string, string[]>(); // package → the page files it wrote
  const { warnings } = checked;
  /** What a publish of an item records, and how it is written. */
  const options = (m: Member, plan: ItemPlan) => ({ ...publish, upstream: upstreamOf(m), ...(plan.action === "diverge" ? { activate: false } : {}) });
  /** Report an item, and remember a write the install would take back. */
  const done = (m: Member, kind: Wrote["kind"], name: string, plan: ItemPlan, version?: string) => {
    if (plan.action === "new") wrote.push({ kind, name });
    if (plan.action === "update") wrote.push({ kind, name, previous: plan.previous });
    const status: InstallItemStatus = plan.action === "new" ? "installed" : plan.action === "update" ? "updated" : plan.action === "diverge" ? "diverged" : plan.action;
    reports.get(m.info.manifest.package)!.push({ kind, name, status, ...(version && plan.action !== "present" && plan.action !== "modified" ? { version } : {}) });
  };
  const writes = (plan: ItemPlan) => plan.action !== "present" && plan.action !== "modified";

  try {
    // Steps first, every package's, so one registry rebuild loads them all.
    for (const m of members) {
      for (const item of m.info.items.filter((i) => i.kind === "step")) {
        const plan = checked.plan.get(item.name)!;
        if (!writes(plan)) {
          done(m, "step", item.name, plan);
          continue;
        }
        const code = await readFile(join(m.info.dir, item.path), "utf-8");
        const { version } = await deps.workspace.publishStep(item.name, code, undefined, undefined, options(m, plan));
        done(m, "step", item.name, plan, version);
      }
    }
    // The trial load found nothing; this is the registry as it now is.
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
        const plan = checked.plan.get(item.name)!;
        if (!writes(plan)) {
          done(m, "workflow", item.name, plan);
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
          options(m, plan),
        );
        if (plan.action === "new" && opts.actor) await deps.workspace.setWorkflowOwner(item.name, opts.actor);
        done(m, "workflow", item.name, plan, version);
      }
    }
    // Apps, an app after the apps of the set it imports: its build finds
    // them published. A person's publish, as installing is a person's act.
    for (const m of members) {
      for (const item of m.info.items.filter((i) => i.kind === "app")) {
        const plan = checked.plan.get(item.name)!;
        if (!writes(plan)) done(m, "app", item.name, plan);
      }
    }
    for (const app of checked.apps) {
      const plan = checked.plan.get(app.name)!;
      const r = await deps.apps!.publish(app.dir, app.name, { surface: "person", ...options(app.member, plan) });
      if (!r.ok) throw new Error(`bad_package: the app ${app.name} — ${r.errors.join("; ")}`);
      done(app.member, "app", app.name, plan, r.version);
    }
    // Concepts, through the seeder: a set per package, stamped `pkg/<package>/`.
    if (checked.conceptsOn) {
      for (const m of members) {
        if (!m.info.items.some((i) => i.kind === "concept")) continue;
        const pkg = m.info.manifest.package;
        const here = before.get(pkg);
        const update = opts.door === "distro" && !!here;
        // An update leaves a page edited here out of the set: the seeder
        // writes a page whose file changed over any edit. So is a page whose
        // edit cannot be told (its old file is not in the cache).
        const edited = new Set(update ? here!.items.filter((i) => i.kind === "concept" && i.modified !== false).map((i) => i.name) : []);
        const shipped = m.info.items.filter((i) => i.kind === "concept");
        let dir = join(m.info.dir, "concepts");
        if (shipped.some((i) => edited.has(i.name))) {
          dir = join(scratch, "concepts", ...pkg.split("/"));
          await mkdir(dir, { recursive: true });
          for (const i of shipped) if (!edited.has(i.name)) await writeFile(join(dir, i.path.slice("concepts/".length)), await readFile(join(m.info.dir, i.path)));
        }
        for (const i of shipped) if (edited.has(i.name)) reports.get(pkg)!.push({ kind: "concept", name: i.name, status: "modified" });
        const outcomes = shipped.every((i) => edited.has(i.name)) ? [] : await seedConcepts(deps.graph, [{ dir, prefix: conceptPrefix(pkg), keepEdited: true }]);
        const written: string[] = [];
        conceptsWritten.set(pkg, written);
        for (const o of outcomes) {
          // Taken back by retiring: a page this call made, never one an update rewrote.
          if (o.action === "create" || (o.action === "update" && !update)) written.push(`${o.name}.md`);
          if (o.action === "error" || o.action === "skip") {
            throw conflict(o.action === "skip" ? `Concept ${o.name} was taken by someone else during the install` : `Concept ${o.name}: ${o.error}`);
          }
          const status: InstallItemStatus = o.action === "keep" ? (o.edited ? "modified" : "present") : o.action === "update" && update ? "updated" : "installed";
          reports.get(pkg)!.push({ kind: "concept", name: o.name, status });
        }
      }
    }
  } catch (err) {
    await takeBack(deps, wrote, conceptsWritten);
    throw err;
  }

  // What the release no longer ships, once the release is in: retired when
  // untouched, kept when forked. A removal that fails is said, never a
  // reason to take the release back.
  if (retiring.length) {
    for (const r of retiring) {
      const report = reports.get(r.pkg)!;
      if (!r.go) {
        report.push({ kind: r.item.kind, name: r.item.name, status: "kept", reason: r.reason! });
        continue;
      }
      if (r.item.kind === "concept") continue; // retired below, by their stamps
      try {
        if (r.item.kind === "workflow") {
          await opts.forget?.(r.item.name);
          await deps.workspace.deleteWorkflow(r.item.name);
        } else if (r.item.kind === "app") await (deps.apps ? deps.apps.delete(r.item.name) : deps.workspace.deleteApp(r.item.name));
        else if (r.item.kind === "step") await deps.workspace.deleteStep(r.item.name);
        report.push({ kind: r.item.kind, name: r.item.name, status: "retired" });
      } catch (err) {
        warnings.push(`the ${r.item.kind} ${r.item.name}, which the release no longer ships, was not removed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const pages = retiring.filter((r) => r.go && r.item.kind === "concept");
    if (pages.length && deps.graph) {
      const schema = await deps.graph.schemas.schema("Concept");
      for (const [pkg, names] of groupBy(pages)) {
        const files = new Map((await packageConcepts(deps.graph, pkg)).map((c) => [c.name, c.file]));
        const gone = schema ? new Set(await retireConcepts(deps.graph, schema, { dir: "", prefix: conceptPrefix(pkg), retired: names.map((n) => files.get(n)).filter((f): f is string => !!f) })) : new Set<string>();
        for (const name of names) {
          if (gone.has(name)) reports.get(pkg)!.push({ kind: "concept", name, status: "retired" });
          else warnings.push(`the Concept ${name}, which the release no longer ships, was not retired`);
        }
      }
    }
    if (retiring.some((r) => r.go && r.item.kind === "step")) await deps.getRegistry();
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
  const kinds = ["step", "workflow", "app", "concept"];
  for (const items of reports.values()) items.sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.name.localeCompare(b.name));
  return {
    package: root.info.manifest.package,
    digest: root.info.digest,
    packages: members.map((m) => {
      const items = reports.get(m.info.manifest.package)!;
      const here = before.get(m.info.manifest.package);
      const moved = !!here?.digest && here.digest !== m.info.digest;
      const changed = items.some((i) => ["installed", "updated", "diverged", "retired"].includes(i.status));
      return {
        package: m.info.manifest.package,
        version: m.info.manifest.version,
        digest: m.info.digest,
        source: m.source,
        status: moved ? "updated" : changed ? "installed" : "present",
        ...(moved ? { from: { ...(here!.version ? { version: here!.version } : {}), digest: here!.digest } } : {}),
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
 *  Exact pins union; a name pinned at two digests is refused, and so is one
 *  required at one digest and installed at another — unless the distro's
 *  door is installing, which updates it first (§4). */
async function resolveSet(deps: PackageDeps, ref: string, digest: string | undefined, installed: Map<string, InstalledPackage>, door: PackageDoor): Promise<Member[]> {
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
      if (here && door === "install") {
        throw conflict(`${pkg} requires ${req.package} at ${req.digest}, and this strut has it at ${here.digest ?? "another digest"} — updating a package from a person's door is not built yet`);
      }
      await visit(req.source, req.digest, member.base, { package: req.package, by: pkg });
    }
    order.push(member);
  };
  await visit(ref, digest, undefined);
  return order;
}

interface Checked {
  /** Each workflow, step and app of the set, by name: what the install does with it. */
  plan: Map<string, ItemPlan>;
  /** By package: the items installed here that its release no longer
   *  ships (an update through the distro's door). */
  dropped: Map<string, InstalledItem[]>;
  conceptsOn: boolean;
  warnings: string[];
  /** The apps to publish, built once in their staged directory, in the
   *  order they can be published: each after the set's apps it imports. */
  apps: Array<{ name: string; dir: string; member: Member }>;
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
  scratch: string,
  door: PackageDoor,
): Promise<Checked & { members: Array<Member & { claims: MemberClaims[] }> }> {
  const out: Checked = { plan: new Map(), dropped: new Map(), conceptsOn: false, warnings: [], apps: [] };
  const sealed = deps.sealed ?? sealedStepPatterns();
  const problems: string[] = [];

  // What the set adds, for the names its workflows may use.
  const setSteps = new Set(members.flatMap((m) => m.info.items.filter((i) => i.kind === "step" && !i.helper).map((i) => i.name)));
  const setWorkflows = new Set(members.flatMap((m) => m.info.items.filter((i) => i.kind === "workflow").map((i) => i.name)));
  const knownStep = (type: string) => !!registry[type] || setSteps.has(type);
  const workspaceWorkflows = new Set((await deps.workspace.listWorkflows()).map((w) => w.name));
  const workspaceSteps = Object.keys(await deps.workspace.getActiveStepHashes());
  const workspaceApps = (await deps.workspace.listApps()).map((a) => a.name);

  const concepts = new Map<string, string>(); // page name → the package that ships it
  for (const m of members) {
    const pkg = m.info.manifest.package;
    if (!deps.apps && m.info.items.some((i) => i.kind === "app")) {
      throw new Error(`package_unsupported: ${pkg} ships an app (apps/), and this strut hosts no apps`);
    }
    const here = installed.get(pkg);
    if (here && door === "install") {
      if (here.door === "distro") throw new Error(`package_distro_owned: ${pkg} was installed here by the distro, which updates and removes it`);
      if (here.digest && here.digest !== m.info.digest) {
        throw new Error(`package_update_not_built: ${pkg} ${here.version ?? ""} is installed here at ${here.digest}; updating it to ${m.info.digest} from a person's door is not built yet (it asks first) — uninstall it first (DELETE /packages/${pkg})`.replace("  ", " "));
      }
      if (!here.digest) await sameConcepts(deps, m, here);
    }
    const mine = new Map((here?.items ?? []).map((i) => [i.name, i]));
    if (here && door === "distro") {
      const ships = new Set(m.info.items.map((i) => `${i.kind}:${i.name}`));
      const gone = here.items.filter((i) => !ships.has(`${i.kind}:${i.name}`));
      if (gone.length) out.dropped.set(pkg, gone);
    }

    // The prefix holds this package's items alone.
    const under = (name: string) => name.startsWith(`${pkg}/`);
    for (const name of [...workspaceWorkflows].filter(under)) if (!mine.has(name)) problems.push(`the workflow ${name} is a local one under ${pkg}/`);
    for (const name of workspaceSteps.filter(under)) if (!mine.has(name)) problems.push(`the step ${name} is a local one under ${pkg}/`);
    for (const name of workspaceApps.filter(under)) if (!mine.has(name)) problems.push(`the app ${name} is a local one under ${pkg}/`);

    for (const item of m.info.items) {
      if (item.kind === "step" || item.kind === "workflow" || item.kind === "app") {
        const at = mine.get(item.name);
        out.plan.set(item.name, at ? await planItem(deps, m, item, at, door) : { action: "new" });
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

  // Steps: each one the install makes active LOADS, as its own type,
  // before anything is written.
  bad.push(...(await trialLoad(deps, members, out.plan, join(scratch, "trial"))));
  if (bad.length) throw new Error(`bad_package: ${bad.join("; ")}`);

  // Apps: each one the install publishes BUILDS against this strut's kit,
  // with the set's workflows and apps in reach, before anything is written.
  const publishes = (name: string) => ["new", "update", "diverge"].includes(out.plan.get(name)?.action ?? "");
  const staged = new Map<string, { dir: string; hash: string; member: Member; path: string }>();
  for (const m of members) {
    for (const item of m.info.items.filter((i) => i.kind === "app" && publishes(i.name))) {
      const dir = join(scratch, ...item.name.split("/"));
      await copyAppDir(join(m.info.dir, item.path), dir, { dist: false });
      staged.set(item.name, { dir, hash: await treeHash(dir), member: m, path: item.path });
    }
  }
  const imports = new Map<string, string[]>();
  for (const [name, app] of staged) {
    const read = await readManifest(app.dir);
    if (!read.ok) {
      bad.push(`${app.path}/app.yaml: ${read.errors.join("; ")}`);
      continue;
    }
    for (const g of read.manifest.grants.steps) {
      if (!g.includes("*") && !knownStep(baseType(g))) bad.push(`the app ${name} grants the step ${g}, which is neither on this strut nor in the packages`);
    }
    const base = deps.apps!.buildDeps(name);
    const buildDeps: AppBuildDeps = {
      ...base,
      // An app of the set resolves to its staged directory; a pin of one is
      // this strut's label, which it has none of yet.
      resolveApp: async (n, v) => {
        const s = staged.get(n);
        if (s) return v ? null : { name: n, version: "install", dir: s.dir, hash: s.hash };
        return base.resolveApp ? base.resolveApp(n, v) : null;
      },
      installedApps: async () => [...new Set([...((await base.installedApps?.()) ?? []), ...staged.keys()])].sort(),
      workflowExists: async (wf) => setWorkflows.has(wf) || ((await base.workflowExists?.(wf)) ?? false),
    };
    const built = await buildApp(app.dir, buildDeps);
    if (!built.ok) bad.push(`the app ${name} does not build on this strut — ${built.errors.join("; ")}`);
    else imports.set(name, built.imports.map((i) => i.name).filter((n) => staged.has(n)));
  }
  if (bad.length) throw new Error(`bad_package: ${bad.join("; ")}`);
  // Each after the apps of the set it imports (the build refuses a cycle).
  const placed = new Set<string>();
  for (let progress = true; progress; ) {
    progress = false;
    for (const [name, app] of staged) {
      if (placed.has(name) || !(imports.get(name) ?? []).every((n) => placed.has(n))) continue;
      placed.add(name);
      out.apps.push({ name, dir: app.dir, member: app.member });
      progress = true;
    }
  }

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

/** What an install does with an item it ships that is here already (§4's
 *  table, through the distro's door). A person's door installs only what is
 *  missing, so it leaves every item that is here as it is. */
async function planItem(deps: PackageDeps, m: Member, item: PackageItem, at: InstalledItem, door: PackageDoor): Promise<ItemPlan> {
  if (door === "install") return { action: at.modified ? "modified" : "present" };
  const active = await activeVersion(deps, item.kind as Wrote["kind"], item.name);
  if (!active) return { action: "new" };
  const path = join(m.info.dir, item.path);
  const hash = item.kind === "app" ? await treeHash(path) : contentHash(await readFile(path, "utf-8"));
  if (active.hash === hash) return { action: "present" };
  return at.modified ? { action: "diverge" } : { action: "update", previous: active.label };
}

/** An item's active version: its label and content hash. */
async function activeVersion(deps: PackageDeps, kind: Wrote["kind"], name: string): Promise<{ label: string; hash?: string } | undefined> {
  if (kind === "workflow") {
    const meta = await deps.workspace.getWorkflowMetadata(name);
    return meta ? { label: meta.active, hash: meta.versions[meta.active]?.hash } : undefined;
  }
  if (kind === "step") {
    const meta = await deps.workspace.getStepMetadata(name);
    return meta ? { label: meta.active, hash: meta.versions[meta.active]?.hash } : undefined;
  }
  const rec = await deps.workspace.getApp(name);
  return rec ? { label: rec.active, hash: rec.versions[rec.active]?.hash } : undefined;
}

/** Load each step the install makes active, as discovery would, from a
 *  trial directory that holds its namespace as it will be: the release's
 *  file for what the install writes or already has as the release has it,
 *  this strut's own for a fork it leaves active (§12 step 6). Nothing is
 *  written to the workspace. The problems, each naming the step. */
async function trialLoad(deps: PackageDeps, members: Member[], plan: Map<string, ItemPlan>, dir: string): Promise<string[]> {
  const fileOf = (name: string) => join(dir, ...`${name}.ts`.split("/"));
  const check: string[] = [];
  for (const m of members) {
    for (const item of m.info.items.filter((i) => i.kind === "step")) {
      const action = plan.get(item.name)?.action;
      const local = action === "modified" || action === "diverge";
      const code = local ? (await deps.workspace.getStepSource(item.name))?.code : await readFile(join(m.info.dir, item.path), "utf-8");
      if (code === undefined) continue;
      await mkdir(dirname(fileOf(item.name)), { recursive: true });
      await writeFile(fileOf(item.name), code);
      if (!isHelper(item) && (action === "new" || action === "update")) check.push(item.name);
    }
  }
  if (!check.length) return [];
  await ensureEsmScope(dir);
  const problems: string[] = [];
  for (const name of check) {
    const r = await stepFileType(fileOf(name));
    if ("error" in r) problems.push(`the step ${name} — ${r.error}`);
    else if (r.type !== name) problems.push(`the step ${name} — its defineStep says type "${r.type}" — a step's type is its path, ${name}`);
  }
  return problems;
}

/** An item a release no longer ships, and whether it goes. */
interface Retirement {
  pkg: string;
  item: InstalledItem;
  go: boolean;
  /** Why it stays. */
  reason?: string;
}

/** What each release drops (§4): an untouched item goes; a fork, an edited
 *  Concept and a page whose edit cannot be told stay, and so does a helper
 *  while a step of the package stays forked (it may import the helper). */
function retirements(checked: Checked, members: Member[]): Retirement[] {
  const out: Retirement[] = [];
  for (const [pkg, items] of checked.dropped) {
    const shipped = members.find((m) => m.info.manifest.package === pkg)?.info.items ?? [];
    const forkedStep =
      items.some((i) => i.kind === "step" && !i.helper && i.modified) ||
      shipped.some((i) => i.kind === "step" && !isHelper(i) && ["modified", "diverge"].includes(checked.plan.get(i.name)?.action ?? ""));
    for (const item of items) {
      if (item.kind === "concept" && item.modified !== false) {
        out.push({ pkg, item, go: false, reason: item.modified ? "edited here" : "its file is not in the package cache, so an edit cannot be told apart" });
      } else if (item.modified) out.push({ pkg, item, go: false, reason: "modified here (a fork)" });
      else if (item.helper && forkedStep) out.push({ pkg, item, go: false, reason: "a helper a forked step of the package may import" });
      else out.push({ pkg, item, go: true });
    }
  }
  return out;
}

/** The Concepts that go, by package. */
function groupBy(rs: Retirement[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rs) out.set(r.pkg, [...(out.get(r.pkg) ?? []), r.item.name]);
  return out;
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

/** Undo an install's writes: the names it published new (they were free)
 *  go; an item it updated points at the version that was active again,
 *  which the fold then reads as what is installed (the new version stays,
 *  inactive: no store deletes one version); the Concepts it made are
 *  retired by their stamps; then the registry as it was. */
async function takeBack(deps: PackageDeps, wrote: Wrote[], concepts: Map<string, string[]>): Promise<void> {
  const repoint = async (w: Wrote & { previous: string }) => {
    if ((await activeVersion(deps, w.kind, w.name))?.label === w.previous) return;
    if (w.kind === "workflow") await deps.workspace.setActiveVersion(w.name, w.previous);
    else if (w.kind === "step") await deps.workspace.setActiveStepVersion(w.name, w.previous);
    else await deps.workspace.setActiveAppVersion(w.name, w.previous);
  };
  for (const w of [...wrote].reverse()) {
    const undo: Promise<unknown> =
      w.previous !== undefined
        ? repoint(w as Wrote & { previous: string })
        : w.kind === "workflow"
          ? deps.workspace.deleteWorkflow(w.name)
          : w.kind === "step"
            ? deps.workspace.deleteStep(w.name)
            : deps.apps
              ? deps.apps.delete(w.name)
              : deps.workspace.deleteApp(w.name);
    await undo.catch((err) => {
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
 * whole uninstall; `forget` drops a deleted workflow's schedules. A package
 * the distro installed is removed only through the distro's `door`.
 */
export async function uninstallPackage(
  deps: PackageDeps,
  pkg: string,
  opts: { busy?(workflow: string): boolean; forget?(workflow: string): Promise<void>; door?: PackageDoor } = {},
): Promise<UninstallResult> {
  const p = (await listInstalledPackages(deps)).find((x) => x.package === pkg);
  if (!p) throw new Error(`package_not_installed: ${pkg} is not installed here`);
  if (p.door === "distro" && opts.door !== "distro") throw new Error(`package_distro_owned: ${pkg} was installed here by the distro, which updates and removes it`);
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
    } else if (i.kind === "app") await (deps.apps ? deps.apps.delete(i.name) : deps.workspace.deleteApp(i.name));
    else await deps.workspace.deleteStep(i.name);
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
