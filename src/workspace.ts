import { readFile, writeFile, readdir, mkdir, stat, unlink, rmdir, rm, rename } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { Automation } from "./automations.js";
import type { Flow, PeerOpen } from "./core.js";
// Type-only: the graph backend stays a lazy, opt-in dependency.
import type { GraphBackend } from "./graph/backend.js";
import type { SubflowResolver } from "./runner.js";
import { readStepSourceFromDisk, type StepSource } from "./steps/registry.js";
import { contentHash, nextVersionLabel } from "./version.js";
import type { AppGrants, AppManifest } from "./apps/manifest.js";
import { appVersionDir, appsRoot, validateAppName } from "./apps/files.js";
import { evaluateExpr } from "./expr.js";
import { inputSchema, parseInputBlock, type InputBlock } from "./input-block.js";
import { claimsArgSchema, type ClaimsBlock } from "./claims-schemas.js";
import { bootEnv } from "./env.js";

// Match a `{{ params.<path> }}` reference (and ONLY a params reference) so we can
// resolve param-to-param references at load time without touching `{{ input.* }}`
// or step-output references (which don't exist until run time).
const PARAM_SELF_REF = /\{\{\s*(params(?:\.[\w$]+|\[[^\]]+\])+)\s*\}\}/g;

/**
 * Validate a workflow's YAML before it's published. Catches the single most
 * common authoring footgun: an **unquoted** template value, e.g.
 *
 *   pull_number: {{ input.pull_number }}     # WRONG
 *
 * A leading `{{` is parsed by YAML as a flow-mapping, so the value silently
 * becomes an object (which stringifies to `[object Object]`) instead of the
 * template string. Downstream this surfaces as a baffling "expected number,
 * received object". We detect it on the PARSED structure (so we don't false-
 * positive on `{{ }}` inside block-scalar message bodies) and throw a clear,
 * actionable error pointing at the fix: quote the template.
 */
export function assertValidWorkflowYaml(yamlStr: string): void {
  let parsed: unknown;
  try {
    parsed = yaml.load(yamlStr);
  } catch (err) {
    throw new Error(
      `Invalid workflow YAML: ${err instanceof Error ? err.message : String(err)}. ` +
        `Common causes: an unquoted template — always wrap templates in quotes, ` +
        `e.g. pull_number: "{{ input.pull_number }}"; or an unquoted value containing ": " ` +
        `(e.g. description: topic is not about: cats) — quote the whole value or use a block scalar (|).`,
    );
  }
  // An unquoted `{{ ... }}` value parses to an object used as a map key, which
  // serializes as the literal "[object Object]". No legitimate config contains
  // that string, so it's a reliable corruption signature.
  if (JSON.stringify(parsed ?? null).includes("[object Object]")) {
    throw new Error(
      `Workflow YAML has an unquoted template value: a "{{ ... }}" was parsed as a ` +
        `YAML object instead of a string. Wrap every template in quotes, ` +
        `e.g. pull_number: "{{ input.pull_number }}".`,
    );
  }
  // A declared `input:` block must parse too: `getWorkflow` maps a load throw
  // to 404, so a bad block that reached disk would hide the workflow.
  const input = (parsed as { input?: unknown } | null)?.input;
  if (input != null) parseInputBlock(input);
  // `sealed:` is `true` or absent. A mistyped seal must fail the publish:
  // read as "not sealed" it would open a grading harness to the meta surface.
  const sealed = (parsed as { sealed?: unknown } | null)?.sealed;
  if (sealed != null && typeof sealed !== "boolean") {
    throw new Error("Workflow YAML has an invalid `sealed:` key — it is `true` (a grading harness the meta surface may never run or reach) or absent.");
  }
  // `peer:` likewise: a mistyped one read as "open to peers" would hand
  // another strut a workflow nobody vouched for.
  const peer = (parsed as { peer?: unknown } | null)?.peer;
  if (peer != null && typeof peer !== "boolean" && peer !== "person") {
    throw new Error("Workflow YAML has an invalid `peer:` key — it is `true` (another strut may launch it), `person` (only through a credential that names a person) or absent.");
  }
  // A `claims:` block is checked for SHAPE here (every backend, no graph
  // needed) so a malformed contract fails the publish like a bad `input:`;
  // what it names (step types, the sealed check) is the claims layer's
  // check, at publish where there is one and at boot for seeded files.
  readClaimsBlock(parsed);
}

/** The `claims:` block of a parsed workflow YAML, shape-validated; undefined
 *  when absent or empty. Throws on a malformed block. */
export function readClaimsBlock(parsed: unknown): ClaimsBlock | undefined {
  const raw = (parsed as { claims?: unknown } | null)?.claims;
  if (raw == null) return undefined;
  const r = claimsArgSchema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${["claims", ...i.path].join(".")}: ${i.message}`).join("; ");
    throw new Error(
      `Workflow YAML has an invalid \`claims:\` block — ${issues}. ` +
        `It is a list of { text, checks: [{ type, config } | { description }] }, the same shape as the publish tools' \`claims\` arg.`,
    );
  }
  return r.data && r.data.length > 0 ? r.data : undefined;
}

/** The `claims:` block of a workflow YAML string (see `readClaimsBlock`). */
export function claimsBlockOf(yamlStr: string): ClaimsBlock | undefined {
  return readClaimsBlock(yaml.load(yamlStr));
}

/**
 * Resolve `{{ params.* }}` references that appear INSIDE other param values, so a
 * workflow can factor a shared value into one param and reuse it (e.g. a base
 * `podDomain` referenced by a big prompt param). Walks the params deeply; for
 * each string it substitutes only `params.*` templates (evaluated against the
 * params themselves), leaving every other template intact for run-time
 * resolution. One pass over the ORIGINAL params — chained references aren't
 * re-expanded, and the substitution uses the param DEFAULTS (a per-run override
 * of a referenced param won't retro-edit a value that embedded it). Unknown/erroring
 * refs are left verbatim rather than throwing — a reference to a param the
 * workflow does not declare too, so a prompt param that TEACHES the syntax
 * (the builder's rules: "Reference them as {{ params.name }}") reaches the
 * model as written. A declared `null` renders empty.
 */
function resolveParamSelfReferences(params: Record<string, unknown>): Record<string, unknown> {
  const resolveStr = (s: string): string =>
    s.replace(PARAM_SELF_REF, (whole, expr: string) => {
      try {
        const val = evaluateExpr(expr, { params });
        if (val === undefined) return whole;
        if (val === null) return "";
        return typeof val === "object" ? JSON.stringify(val) : String(val);
      } catch {
        return whole; // leave unresolved on any error
      }
    });
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.includes("{{") ? resolveStr(v) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(params) as Record<string, unknown>;
}

/** Parse a stored workflow version's YAML into a runnable `Flow` — the one
 *  loader every `WorkspaceStore` backend shares (param self-references are
 *  resolved once here, at load). A declared `input:` block becomes the Zod
 *  `input` schema; without one the flow accepts any input (`z.any()`). */
export function flowFromYaml(name: string, version: string, raw: string): Flow {
  const data = yaml.load(raw) as any;
  if (!data || !data.steps) {
    throw new Error(`Invalid workflow YAML for "${name}" version "${version}"`);
  }
  const inputBlock = data.input != null ? parseInputBlock(data.input) : undefined;
  return {
    name: data.name ?? name,
    input: inputBlock ? inputSchema(inputBlock) : z.any(),
    steps: data.steps,
    ...(inputBlock ? { inputBlock } : {}),
    // Resolve param-to-param references (`{{ params.* }}` nested inside another
    // param) once at load, so a shared value can be factored into one knob.
    ...(data.params != null ? { params: resolveParamSelfReferences(data.params) } : {}),
    ...(Array.isArray(data.promotes) ? { promotes: data.promotes } : {}),
    ...(data.settings != null ? { settings: data.settings } : {}),
    ...(data.sealed === true ? { sealed: true } : {}),
    ...(data.peer === true || data.peer === "person" ? { peer: data.peer as PeerOpen } : {}),
  };
}

/** Render publish content (a steps object or raw YAML) to the YAML string
 *  that gets stored — shared by every backend so hashes agree. */
export interface WorkflowContent {
  steps: any[];
  /** The declared `input:` block (see `src/input-block.ts`). */
  input?: InputBlock;
  params?: Record<string, unknown>;
  promotes?: unknown[];
  /** The contract, as a `claims:` block (plans/claims.md §2, door one). */
  claims?: ClaimsBlock;
  /** `sealed: true` — a grading harness (`src/sealed.ts`). */
  sealed?: boolean;
  /** `peer: true` — another strut may launch it (plans/federation.md §3);
   *  `"person"` — only through a credential that names a person. */
  peer?: boolean | PeerOpen;
}

export function renderWorkflowYaml(name: string, content: WorkflowContent | string): string {
  return typeof content === "string"
    ? content
    : yaml.dump(
        {
          name,
          ...(content.input != null ? { input: content.input } : {}),
          steps: content.steps,
          ...(content.params != null ? { params: content.params } : {}),
          ...(content.promotes != null ? { promotes: content.promotes } : {}),
          ...(content.claims != null ? { claims: content.claims } : {}),
          ...(content.sealed ? { sealed: true } : {}),
          ...(content.peer ? { peer: content.peer } : {}),
        },
        { lineWidth: 120, noRefs: true },
      );
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface WorkflowVersionInfo {
  createdAt: string;
  description?: string;
  /** Content hash of this version's source — internal dedup key for
   *  content-hash publishing. Not the user-facing version id. */
  hash?: string;
  /** Which door wrote this version (see `VersionSource`). Absent on versions
   *  published before it was recorded. */
  source?: VersionSource;
  /** Who published it, when the door knew (an opaque actor string). */
  actor?: string;
  /** The package this version came from, or derives from (see `Upstream`). */
  upstream?: Upstream;
}

/** Where a workflow version came from — recorded at publish, never inferred:
 *  `seed` a host's boot-time seeder (the committed template), `ui` the web
 *  UI, `api` any other HTTP caller, `builder` the chat builder's tools,
 *  `agent` the in-run `meta/*` authoring surface, `promote` a promoted param,
 *  `install` a package install (marketplace.md §3).
 *  So "is the active version still the seed?" is one lookup. */
export type VersionSource = "seed" | "ui" | "api" | "builder" | "agent" | "promote" | "install";

/** Where an installed version came from (marketplace.md §3): which package
 *  at which version, its tree digest, the source it was fetched from, and the
 *  secrets the package declares. Recorded on workflow, step and app versions;
 *  a publish over the name carries the active version's forward unless it
 *  sets (or, with `null`, clears) its own — so an edit of an installed item is
 *  a fork that still knows its base. */
export interface Upstream {
  package: string;
  version: string;
  digest: string;
  source: { ref: string };
  secrets: string[];
}

/** Provenance a publish records on the version it writes. */
export interface PublishOptions {
  source?: VersionSource;
  actor?: string;
  /** This version's upstream; `null` clears what would be carried forward. */
  upstream?: Upstream | null;
}

/** The upstream a new version records: the publish's own, none when it
 *  passes `null`, else the active version's (carried forward). */
export function upstreamFor(opts: PublishOptions | undefined, active: Upstream | undefined): Upstream | undefined {
  return opts?.upstream === null ? undefined : (opts?.upstream ?? active);
}

/** The set fields of `opts`, to spread onto a version record. */
export function provenance(opts?: PublishOptions): Pick<WorkflowVersionInfo, "source" | "actor"> {
  return {
    ...(opts?.source ? { source: opts.source } : {}),
    ...(opts?.actor ? { actor: opts.actor } : {}),
  };
}

export interface WorkflowMetadata {
  active: string;
  versions: Record<string, WorkflowVersionInfo>;
  /** Optional grouping label (e.g. an experiment name). Workflow-level, not
   *  version-level: it survives publishes and can be changed at any time via
   *  `setWorkflowCategory`. */
  category?: string;
  /** Schedules that launch this workflow (plans/automations.md).
   *  Workflow-level like `category`: editing or pausing one publishes no
   *  version, and it survives every publish. Absent = none. */
  automations?: Automation[];
  /** Optional identifier of the service that published this workflow
   *  (parallels `StepInfo.publisher`). Workflow-level provenance: the
   *  authoring capability stamps everything it publishes `"ai"` and its
   *  publish/run/run-history operations are closed over that stamped set —
   *  see `authoring.ts` and EVOLVE_SPEC §6 (run-history scoping). */
  publisher?: string;
  /** The PERSON this workflow belongs to — an opaque actor string
   *  (plans/mothership-cost-control.md §2). Set by the first publish that
   *  carries an actor, then changed only by an explicit transfer
   *  (`setWorkflowOwner`). Distinct from `publisher`, a service stamp. The
   *  owner pays for the workflow's automations. */
  owner?: string;
  /** Per-run LLM spend cap in dollars, enforced by the Mothership when the
   *  deployment routes through it (§3) — otherwise nothing reads it.
   *  Operating policy like `category`: metadata-only, no version. */
  maxRunCostUsd?: number;
}

export interface StepVersionInfo {
  createdAt: string;
  description?: string;
  /** Content hash of this version's source — internal dedup key. */
  hash?: string;
  /** The package this version came from, or derives from (see `Upstream`). */
  upstream?: Upstream;
}

export interface StepInfo {
  /** Active version id (a content hash, e.g. "c-1a2b3c4d5e"). The active
   *  version's source is materialized at `custom/<name>.ts` for the registry
   *  loader; every version (incl. active) is archived under
   *  `steps/_history/<name>/<vid>.ts`. */
  active: string;
  /** All known versions, keyed by content-hash version id. */
  versions: Record<string, StepVersionInfo>;
  /** Optional identifier of the service that published this step.
   *  Used by `deleteStepsByPublisher` for bulk lifecycle ops. */
  publisher?: string;
}

export interface StepDirMetadata {
  /** Keys are full step names with optional slashes (e.g. "gitree/save-feature"). */
  steps: Record<string, StepInfo>;
}

/** Everything a file workspace holds, read once for a one-shot import into
 *  another store (`src/graph/fs-import.ts`): each workflow's metadata with
 *  every version's YAML, each custom step's metadata with every version's
 *  source — versions in label order (v1, v2, …). */
export interface FileWorkspaceSnapshot {
  workflows: Array<{ name: string; meta: WorkflowMetadata; versions: Array<{ label: string; yaml: string; info: WorkflowVersionInfo }> }>;
  steps: Array<{ name: string; active: string; publisher?: string; versions: Array<{ label: string; code: string; info: StepVersionInfo }> }>;
  /** The app POINTERS (plans/apps.md §1.3): the directories stay where they are. */
  apps: Array<{ name: string; meta: AppMetadata }>;
}

// ── Apps (plans/apps.md §1.3) ───────────────────────────────────────────────

/** One app version: its tree hash (`treeHash`, src/version.ts) and the
 *  manifest as published — the pointer; the files are the directory
 *  `materializeAppVersion` names. */
export interface AppVersionInfo extends Pick<WorkflowVersionInfo, "source" | "actor"> {
  createdAt: string;
  hash: string;
  manifest: AppManifest;
  publisher?: string;
  upstream?: Upstream;
}

export type AppVersionSummary = Omit<AppVersionInfo, "manifest">;

/** The app's record: `apps/<name>/_metadata.json` on files, the `StrutApp`
 *  node and its `StrutAppVersion`s on the graph. */
export interface AppMetadata {
  active: string;
  versions: Record<string, AppVersionInfo>;
  /** Who published it — `ai` for the meta surface (`app/publish`), a host's
   *  stamp, or none for a person's `POST /apps`. */
  publisher?: string;
  /** The PERSON the app belongs to: the first publish's actor, as for a
   *  workflow (`WorkflowMetadata.owner`). */
  owner?: string;
  /** Shown as a TAB by the hosts that read `GET /apps` — hive's sidebar for
   *  the workspace this strut is the swarm of. The record's, never a
   *  version's: a publish keeps it, a delete clears it. Not a version pin. */
  pinned?: boolean;
  /** Every release, oldest first (plans/app-releases.md §1): a page version
   *  and the lock taken when a person made it live. Never edited. */
  releases?: AppRelease[];
  /** The live release's id: the app is HELD, `active` is that release's
   *  version and a publish records a draft. Absent = following latest. */
  live?: string;
}

/** The versions a release runs (plans/app-releases.md §2): every workflow
 *  the page version grants and every subflow they reach, and every custom
 *  step type the closure reaches, as they were when it was made live. */
export interface AppLock {
  workflows: Record<string, { version: string; hash?: string }>;
  steps: Record<string, { version: string; hash: string }>;
  /** What the closure could not see, one sentence each: it runs whatever
   *  is current. */
  floating?: string[];
}

/** A page version made live with its lock. Many may name one version. */
export interface AppRelease {
  /** `r1`, `r2`, … per app. */
  id: string;
  version: string;
  lock: AppLock;
  createdAt: string;
  /** The actor who made it live. */
  by?: string;
}

/** A release as a record lists it, without its lock. */
export type AppReleaseSummary = Omit<AppRelease, "lock">;

export interface AppListEntry {
  name: string;
  activeVersion: string;
  versions: string[];
  title: string;
  description?: string;
  icon?: string;
  grants: AppGrants;
  publisher?: string;
  owner?: string;
  /** Present (true) only when pinned as a tab. */
  pinned?: boolean;
  /** The live release's id, only while the app is held. */
  live?: string;
}

/** `getApp`: one version (the active one by default) with the app's record around it. */
export interface AppRecord {
  name: string;
  /** The version read. */
  version: string;
  hash: string;
  manifest: AppManifest;
  createdAt: string;
  upstream?: Upstream;
  active: string;
  versions: Record<string, AppVersionSummary>;
  publisher?: string;
  owner?: string;
  pinned?: boolean;
  /** The releases, oldest first (plans/app-releases.md §1). */
  releases?: AppRelease[];
  live?: string;
}

export interface PublishAppOptions extends PublishByContentOptions {
  publisher?: string;
  /** The owner to record when the app has none yet (the import carries one
   *  over); `actor` serves the same way. */
  owner?: string;
}

/** `v1, v2, …, v10` in numeric order; anything else after, alphabetically. */
export function versionLabelOrder(a: string, b: string): number {
  const n = (v: string) => (/^v(\d+)$/.test(v) ? parseInt(v.slice(1), 10) : Number.POSITIVE_INFINITY);
  return n(a) - n(b) || a.localeCompare(b);
}

/** Options for the content-hash publishers (`publishWorkflowByContent`,
 *  `publishStep`). */
export interface PublishByContentOptions extends PublishOptions {
  /** What to do when the content matches an OLDER, non-active version.
   *  `true` (default) re-points active at it — "this exact content should be
   *  live" (the author's intent, and every boot-time seeder's: a seed always
   *  matches git). `false` leaves the active pointer alone, for a caller
   *  that wants an edit made since to stay live (a never-seen hash still
   *  publishes the next `vN` and activates it). */
  reactivateKnown?: boolean;
  /** `false` writes the version without moving the active pointer — a
   *  package update beside a local fork (marketplace.md §4). Known content is
   *  then a no-op. A name with no versions yet activates its first anyway. */
  activate?: boolean;
}

export interface StepVersionsResult {
  active: string;
  versions: string[];
}

export interface WorkflowListEntry {
  name: string;
  activeVersion: string;
  versions: string[];
  description?: string;
  /** Grouping label, if the workflow has one (see WorkflowMetadata.category). */
  category?: string;
  /** Provenance stamp, if any (see WorkflowMetadata.publisher). */
  publisher?: string;
  /** The owning actor and run cap, if set (see WorkflowMetadata). */
  owner?: string;
  maxRunCostUsd?: number;
  /** The workflow's schedules, if any (see WorkflowMetadata.automations) —
   *  carried here so the scheduler's boot load is one `listWorkflows()`. */
  automations?: Automation[];
  /** Start time (epoch ms) of the most recent run, if any. Not produced by
   *  the workspace itself (runs are the run store's records) — the server's
   *  `GET /workflows` decorates entries from `RunStore.lastRunAt`. */
  lastRunAt?: number;
}

export interface StepListEntry {
  type: string;
  description?: string;
  createdAt?: string;
  publisher?: string;
}

// ── Workspace store boundary ───────────────────────────────────────────────

/**
 * The persistence boundary for workflows and steps — everything the server,
 * the authoring capability, and the chat builder need from "the workspace",
 * with no filesystem in the contract. `FileWorkspaceStore` is the default
 * implementation; a graph-backed one implements the same surface.
 *
 * Two things a workspace deliberately does NOT own: run records (the
 * `RunStore`) and local scratch (artifacts, cassettes, shell cwd — the
 * server's `dataDir`). Custom steps are executable code, so the boundary
 * exposes them two ways: as source text (`getStepSource`) and as an
 * importable directory (`materializeCustomSteps`) for the module loader.
 */
export interface WorkspaceStore extends SubflowResolver {
  /** The graph backend behind this store, when workflows/steps live in one
   *  (`Neo4jWorkspaceStore`). The claims layer hangs off the subjects' graph
   *  nodes, so it exists only when this is set (plans/claims.md). */
  readonly graph?: GraphBackend;

  // ── Workflows ──
  /** Every workflow with its version list. `lastRunAt` is NOT populated
   *  here (runs belong to the run store — the server composes it). */
  listWorkflows(): Promise<WorkflowListEntry[]>;
  getWorkflow(name: string): Promise<Flow>;
  getWorkflowVersion(name: string, version: string): Promise<Flow>;
  /** Raw YAML source of a workflow version (throws when missing). */
  getWorkflowSource(name: string, version: string): Promise<string>;
  /** Content hash of a version's source (active when omitted), or null. */
  getWorkflowHash(name: string, version?: string): Promise<string | null>;
  /** The workflow's metadata record (active version, versions, category,
   *  publisher), or null when the workflow doesn't exist. */
  getWorkflowMetadata(name: string): Promise<WorkflowMetadata | null>;
  createWorkflow(
    name: string,
    content: WorkflowContent | string,
    description?: string,
    category?: string,
    publisher?: string,
    opts?: PublishOptions,
  ): Promise<{ name: string; version: string }>;
  publishWorkflow(
    name: string,
    version: string,
    content: WorkflowContent | string,
    description?: string,
    category?: string,
    publisher?: string,
    opts?: PublishOptions,
  ): Promise<void>;
  publishWorkflowByContent(
    name: string,
    yamlStr: string,
    description?: string,
    category?: string,
    publisher?: string,
    opts?: PublishByContentOptions,
  ): Promise<{ version: string; changed: boolean }>;
  setWorkflowCategory(name: string, category: string | null): Promise<void>;
  /** Set (or clear) the owning actor — metadata-only, like the category. */
  setWorkflowOwner(name: string, owner: string | null): Promise<void>;
  /** Set (or clear) the per-run spend cap — metadata-only. */
  setWorkflowRunCap(name: string, maxRunCostUsd: number | null): Promise<void>;
  /** Replace the workflow's automations (an empty list clears the field).
   *  Metadata-only, like `setWorkflowCategory`; throws for an unknown
   *  workflow. The whole list, because every mutation is a
   *  read-modify-write of a short list in one process. */
  setWorkflowAutomations(name: string, automations: Automation[]): Promise<void>;
  setActiveVersion(name: string, version: string): Promise<void>;
  /** Remove a workflow: every version and its metadata (category, owner,
   *  cap, automations). False when there was nothing to remove. The name is
   *  free again afterwards — a later workflow under it starts at v1 with no
   *  metadata. Run records are the run store's (`RunStore.deleteRuns`). */
  deleteWorkflow(name: string): Promise<boolean>;
  setParam(
    name: string,
    param: string,
    value: unknown,
    actor?: string,
  ): Promise<{ version: string; before: unknown; after: unknown }>;

  // ── Steps (custom tier) ──
  listSteps(filter?: { publisher?: string }): Promise<StepListEntry[]>;
  publishStep(
    name: string,
    code: string,
    description?: string,
    publisher?: string,
    opts?: PublishByContentOptions,
  ): Promise<{ version: string; changed: boolean }>;
  listStepVersions(name: string): Promise<StepVersionsResult>;
  /** The step's record — active version, every version's info (hash,
   *  description, `upstream`), publisher — or null when no version is on
   *  record. The twin of `getWorkflowMetadata`. */
  getStepMetadata(name: string): Promise<StepInfo | null>;
  /** Content hash of every custom step's ACTIVE version, keyed by step
   *  type — the sibling of `getWorkflowHash`. A workflow version does not
   *  pin its steps (the registry loads whatever is active), so a launch
   *  records this on `run.start.stepHashes`: the only record of which step
   *  version a run executed (plans/claims.md §3). */
  getActiveStepHashes(): Promise<Record<string, string>>;
  getStepVersionSource(name: string, version: string): Promise<string>;
  /** One archived version as an importable file + its content hash — what
   *  a PINNED reference (`type@vN`, src/step-ref.ts) loads through
   *  `resolveStep`. The file sits beside the ACTIVE custom steps
   *  (`materializePinnedStep`), so its relative imports resolve as the
   *  active version's do: a helper it imports is the helper's active
   *  version. Throws when the step or version does not exist. */
  materializeStepVersion(name: string, version: string): Promise<{ path: string; hash: string }>;
  setActiveStepVersion(name: string, version: string): Promise<void>;
  deleteStep(name: string): Promise<boolean>;
  deleteStepsByPublisher(publisher: string): Promise<string[]>;

  // ── Apps (plans/apps.md §1.3) — the POINTERS; the files are under dataDir ──
  listApps(): Promise<AppListEntry[]>;
  /** One app at a version (the active one when omitted), or null. */
  getApp(name: string, version?: string): Promise<AppRecord | null>;
  /** Record a version: a known tree hash re-activates its version (unless
   *  `reactivateKnown: false`), new content is the next `vN`. The caller
   *  builds first and writes the files to `materializeAppVersion`'s path
   *  after (src/apps/apps.ts). A HELD app (`live` set) keeps its active
   *  version: what this records is a draft. */
  publishApp(name: string, hash: string, manifest: AppManifest, opts?: PublishAppOptions): Promise<{ version: string; changed: boolean }>;
  /** Move the active pointer by hand. A held app follows latest from here
   *  (`live` cleared): the pointer no longer names its release. */
  setActiveAppVersion(name: string, version: string): Promise<void>;
  /** Append a release (the next `rN`) and make it live: `active` moves to
   *  its version (plans/app-releases.md §1). Throws on an unknown app or
   *  version. */
  addAppRelease(name: string, release: { version: string; lock: AppLock; createdAt?: string; by?: string }): Promise<AppRelease>;
  /** Make a release live (`active` = its version), or with null follow
   *  latest again (`active` = the newest version). Throws on an unknown app
   *  or release. */
  setAppLive(name: string, live: string | null): Promise<void>;
  /** Pin the app as a tab, or unpin it (`AppMetadata.pinned`). Throws when
   *  the app does not exist. */
  setAppPinned(name: string, pinned: boolean): Promise<void>;
  /** Remove the pointers; the directories stay. False when there was none. */
  deleteApp(name: string): Promise<boolean>;
  /** The directory a version's files live in (`<dataDir>/apps/<name>/<vN>`)
   *  and its hash — the path, never a copy. Throws when the version is not
   *  on record; says nothing about whether the directory is there. */
  materializeAppVersion(name: string, version: string): Promise<{ path: string; hash: string }>;

  // ── Step source + code loading ──
  /** A step's source text across all tiers (core / lib ship with the
   *  engine; custom is this store's), or null when none is on record. */
  getStepSource(type: string): Promise<{ code: string; origin: StepSource } | null>;
  /** Ensure every ACTIVE custom step exists as an importable file and
   *  return the directory root — what `buildRegistry(customDir)` loads. A
   *  file-backed store already has it; other backends write to scratch. */
  materializeCustomSteps(): Promise<string>;
}

// ── Filesystem implementation ──────────────────────────────────────────────

export class FileWorkspaceStore implements WorkspaceStore {
  private root: string;

  constructor(root?: string) {
    this.root = root ?? bootEnv()["STRUT_WORKSPACE"] ?? "./workspace";
  }

  /** The filesystem root — an implementation detail of THIS store, not part
   *  of `WorkspaceStore`. The server's local scratch (`dataDir`) defaults to
   *  it so file-backed deployments keep one directory. */
  get path(): string {
    return this.root;
  }

  // ── Workflows ──────────────────────────────────────────────────────────

  async listWorkflows(): Promise<WorkflowListEntry[]> {
    const results: WorkflowListEntry[] = [];

    for (const name of await this.workflowNames()) {
      const meta = await this.readWorkflowMetadata(name);
      if (meta) {
        const activeDesc = meta.versions[meta.active]?.description;
        results.push({
          name,
          activeVersion: meta.active,
          versions: Object.keys(meta.versions),
          description: activeDesc,
          ...(meta.category ? { category: meta.category } : {}),
          ...(meta.publisher ? { publisher: meta.publisher } : {}),
          ...(meta.owner ? { owner: meta.owner } : {}),
          ...(meta.maxRunCostUsd != null ? { maxRunCostUsd: meta.maxRunCostUsd } : {}),
          ...(meta.automations?.length ? { automations: meta.automations } : {}),
        });
      }
    }

    return results;
  }

  async getWorkflowMetadata(name: string): Promise<WorkflowMetadata | null> {
    return this.readWorkflowMetadata(name);
  }

  /** Load the active version of a workflow. */
  async getWorkflow(name: string): Promise<Flow> {
    const meta = await this.readWorkflowMetadata(name);
    if (!meta) {
      throw new Error(`Workflow "${name}" not found`);
    }
    return this.loadFlowYaml(name, meta.active);
  }

  /** Load a specific version of a workflow. */
  async getWorkflowVersion(name: string, version: string): Promise<Flow> {
    return this.loadFlowYaml(name, version);
  }

  /** Get the raw YAML source for a workflow version. */
  async getWorkflowSource(name: string, version: string): Promise<string> {
    return readFile(join(this.workflowDir(name), `${version}.yaml`), "utf-8");
  }

  /** Content hash of a workflow version's source (active version when
   *  omitted) — recorded on `run.start` so resume can refuse to replay a
   *  journal into a different DAG (RUN_CONTROL_SPEC §5). Null when the
   *  workflow/version is unknown: hash recording degrades gracefully for
   *  runs launched from a bare Flow object. */
  async getWorkflowHash(name: string, version?: string): Promise<string | null> {
    try {
      const meta = await this.readWorkflowMetadata(name);
      if (!meta) return null;
      const v = version ?? meta.active;
      const recorded = meta.versions[v]?.hash;
      if (recorded) return recorded;
      return contentHash(await this.getWorkflowSource(name, v));
    } catch {
      return null;
    }
  }

  private async loadFlowYaml(name: string, version: string): Promise<Flow> {
    const raw = await this.getWorkflowSource(name, version);
    return flowFromYaml(name, version, raw);
  }

  /**
   * Create a brand-new workflow at v1. If a workflow `<name>` already exists,
   * a numeric suffix is appended (`<name>-2`, `<name>-3`, ...) until a free
   * slot is found. Returns the actual name written. Taken means a
   * `_metadata.json`, not a directory: `workflows/acme/` may be only the
   * namespace of `acme/linear/sync`.
   *
   * Use this for "create" intents (UI's Create Workflow dialog, AI's
   * `create_workflow` tool). For adding a new version to an existing workflow,
   * call `publishWorkflow` directly with the existing name and the next version.
   */
  async createWorkflow(
    name: string,
    content: WorkflowContent | string,
    description?: string,
    category?: string,
    publisher?: string,
    opts?: PublishOptions,
  ): Promise<{ name: string; version: string }> {
    let finalName = name;
    let n = 2;
    while (await this.readWorkflowMetadata(finalName)) {
      finalName = `${name}-${n++}`;
    }

    // If the YAML embeds a `name:` field, rewrite it so the on-disk name
    // matches the directory — runner.ts keys run storage off `workflow.name`.
    let resolvedContent = content;
    if (finalName !== name && typeof content === "string") {
      const parsed = yaml.load(content) as any;
      if (parsed && typeof parsed === "object") {
        parsed.name = finalName;
        resolvedContent = yaml.dump(parsed, { lineWidth: 120, noRefs: true });
      }
    }

    await this.publishWorkflow(finalName, "v1", resolvedContent, description, category, publisher, opts);
    return { name: finalName, version: "v1" };
  }

  /** Publish a new workflow version. Accepts steps array or raw YAML string.
   *  `category` (when provided) updates the workflow-level grouping label;
   *  `publisher` (when provided) sets the workflow-level provenance stamp. */
  async publishWorkflow(
    name: string,
    version: string,
    content: WorkflowContent | string,
    description?: string,
    category?: string,
    publisher?: string,
    opts?: PublishOptions,
  ): Promise<void> {
    // Validate BEFORE touching disk: a refused publish leaves nothing behind.
    const yamlStr = renderWorkflowYaml(name, content);
    assertValidWorkflowYaml(yamlStr);
    await this.writeWorkflowVersion(name, version, yamlStr, description, category, publisher, opts);
  }

  /** Write one version file and its metadata entry; the active pointer
   *  moves to it unless `opts.activate` is false (and the workflow has an
   *  active version to keep). The version's `upstream` is the publish's own,
   *  else the active version's carried forward. */
  private async writeWorkflowVersion(
    name: string,
    version: string,
    yamlStr: string,
    description: string | undefined,
    category: string | undefined,
    publisher: string | undefined,
    opts?: PublishByContentOptions,
  ): Promise<void> {
    const dir = this.workflowDir(name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${version}.yaml`), yamlStr, "utf-8");

    const prior = await this.readWorkflowMetadata(name);
    const meta = prior ?? { active: version, versions: {} };
    const upstream = upstreamFor(opts, prior?.versions[prior.active]?.upstream);

    meta.versions[version] = {
      createdAt: new Date().toISOString(),
      description,
      hash: contentHash(yamlStr),
      ...provenance(opts),
      ...(upstream ? { upstream } : {}),
    };
    if (!prior || opts?.activate !== false) meta.active = version;
    if (category !== undefined) meta.category = category;
    if (publisher !== undefined) meta.publisher = publisher;

    await writeFile(
      join(dir, "_metadata.json"),
      JSON.stringify(meta, null, 2),
      "utf-8",
    );
  }

  /**
   * Set (or clear, with null/"") a workflow's grouping category. Metadata-only:
   * no new version is published and the YAML content is untouched.
   */
  async setWorkflowCategory(name: string, category: string | null): Promise<void> {
    const meta = await this.readWorkflowMetadata(name);
    if (!meta) throw new Error(`Workflow "${name}" not found`);
    if (category) meta.category = category;
    else delete meta.category;
    await writeFile(
      join(this.workflowDir(name), "_metadata.json"),
      JSON.stringify(meta, null, 2),
      "utf-8",
    );
  }

  async setWorkflowOwner(name: string, owner: string | null): Promise<void> {
    await this.patchWorkflowMetadata(name, (meta) => {
      if (owner) meta.owner = owner;
      else delete meta.owner;
    });
  }

  async deleteWorkflow(name: string): Promise<boolean> {
    const dir = this.workflowDir(name);
    if (!(await this.readWorkflowMetadata(name))) return false;
    // Its own files — `_metadata.json` and the version YAMLs — and `runs/`:
    // on a file-backed deployment the run store keeps this workflow's runs
    // there, the same records `RunStore.deleteRuns` removes. Never another
    // directory: `acme/` also holds the names under it (`acme/linear/sync`).
    for (const entry of await safeReaddir(dir)) {
      if (entry.isFile()) await rm(join(dir, entry.name), { force: true });
    }
    await rm(join(dir, "runs"), { recursive: true, force: true });
    // Then the folders left empty, up to `workflows/`.
    const root = join(this.root, "workflows");
    for (let d = dir; d !== root && d.startsWith(root); d = dirname(d)) {
      try {
        await rmdir(d);
      } catch {
        break;
      }
    }
    return true;
  }

  async setWorkflowRunCap(name: string, maxRunCostUsd: number | null): Promise<void> {
    await this.patchWorkflowMetadata(name, (meta) => {
      if (maxRunCostUsd != null) meta.maxRunCostUsd = maxRunCostUsd;
      else delete meta.maxRunCostUsd;
    });
  }

  /** Read-modify-write one workflow's `_metadata.json`; throws when missing. */
  private async patchWorkflowMetadata(name: string, patch: (meta: WorkflowMetadata) => void): Promise<void> {
    const meta = await this.readWorkflowMetadata(name);
    if (!meta) throw new Error(`Workflow "${name}" not found`);
    patch(meta);
    await writeFile(
      join(this.workflowDir(name), "_metadata.json"),
      JSON.stringify(meta, null, 2),
      "utf-8",
    );
  }

  /** Replace a workflow's automations. Metadata-only, like the category. */
  async setWorkflowAutomations(name: string, automations: Automation[]): Promise<void> {
    const meta = await this.readWorkflowMetadata(name);
    if (!meta) throw new Error(`Workflow "${name}" not found`);
    if (automations.length > 0) meta.automations = automations;
    else delete meta.automations;
    await writeFile(
      join(this.workflowDir(name), "_metadata.json"),
      JSON.stringify(meta, null, 2),
      "utf-8",
    );
  }

  async setActiveVersion(name: string, version: string): Promise<void> {
    const meta = await this.readWorkflowMetadata(name);
    if (!meta) {
      throw new Error(`Workflow "${name}" not found`);
    }
    if (!(version in meta.versions)) {
      throw new Error(
        `Version "${version}" not found for workflow "${name}". Available: ${Object.keys(meta.versions).join(", ")}`,
      );
    }

    meta.active = version;
    await writeFile(
      join(this.workflowDir(name), "_metadata.json"),
      JSON.stringify(meta, null, 2),
      "utf-8",
    );
  }

  /**
   * GENERIC promote primitive: set ONE `param` default on a workflow and
   * publish it as the next sequential version (`vN+1`). Reads the active
   * version's raw YAML and round-trips the WHOLE object (so `steps`, other
   * `params`, and any `promotes` block survive), overwriting only
   * `params[param]`. Returns the new version id plus the `before`/`after`
   * values (the diff surface). This is what "promote a winner" calls once a
   * human approves — nothing here is automatic.
   */
  async setParam(
    name: string,
    param: string,
    value: unknown,
    actor?: string,
  ): Promise<{ version: string; before: unknown; after: unknown }> {
    const meta = await this.readWorkflowMetadata(name);
    if (!meta) throw new Error(`Workflow "${name}" not found`);

    const raw = await this.getWorkflowSource(name, meta.active);
    const obj = (yaml.load(raw) as Record<string, unknown>) ?? {};
    if (!obj["name"]) obj["name"] = name;
    const params =
      obj["params"] && typeof obj["params"] === "object"
        ? (obj["params"] as Record<string, unknown>)
        : {};
    const before = params[param];
    params[param] = value;
    obj["params"] = params;

    const yamlStr = yaml.dump(obj, { lineWidth: 120, noRefs: true });
    const next = nextVersionLabel(Object.keys(meta.versions));
    await this.publishWorkflow(name, next, yamlStr, undefined, undefined, undefined, { source: "promote", actor });
    return { version: next, before, after: value };
  }

  /**
   * Publish a workflow keyed by content hash but labeled with a friendly,
   * sequential version id (`v1`, `v2`, …). The hash is an internal dedup key;
   * the version id is what the UI shows. Idempotent: identical content that's
   * already active is a no-op; identical content of an older version re-points
   * active at it (no new version); changed content publishes the next `vN` and
   * activates it, retaining prior versions. This is the content-hash seeder's
   * primitive. Returns the version id and whether anything changed.
   * `opts.reactivateKnown: false` turns the "re-points active" case into a
   * no-op (see `PublishByContentOptions`).
   */
  async publishWorkflowByContent(
    name: string,
    yamlStr: string,
    description?: string,
    category?: string,
    publisher?: string,
    opts?: PublishByContentOptions,
  ): Promise<{ version: string; changed: boolean }> {
    const hash = contentHash(yamlStr);
    const meta = await this.readWorkflowMetadata(name);

    if (meta) {
      // Category is metadata-level, so reconcile it even when the content is
      // a no-op — this is how seeders retrofit categories onto existing
      // workspaces at boot.
      if (category !== undefined && meta.category !== category) {
        await this.setWorkflowCategory(name, category);
      }
      const match = Object.entries(meta.versions).find(
        ([, info]) => info.hash === hash,
      );
      if (match) {
        const [vid] = match;
        if (meta.active === vid || opts?.reactivateKnown === false || opts?.activate === false) {
          return { version: vid, changed: false };
        }
        await this.setActiveVersion(name, vid);
        return { version: vid, changed: true };
      }
    }

    const next = nextVersionLabel(meta ? Object.keys(meta.versions) : []);
    // `publisher` is only ever applied when a version is actually written —
    // never reconciled on the identical-content no-op path above, so
    // republishing a workflow's existing content verbatim cannot re-stamp
    // (and thereby claim) a workflow someone else published.
    assertValidWorkflowYaml(yamlStr);
    await this.writeWorkflowVersion(name, next, yamlStr, description, category, publisher, opts);
    return { version: next, changed: true };
  }

  // ── Steps ──────────────────────────────────────────────────────────────

  /**
   * List user-authored custom steps from `<workspace>/steps/custom/`,
   * recursively. Files starting with `_` are treated as helpers (importable
   * by sibling steps but not registered as their own step type) and are
   * omitted from the result.
   *
   * Lib steps live in the engine source tree and are not listed here.
   *
   * Pass `filter.publisher` to limit results to a specific publisher.
   */
  async listSteps(filter?: { publisher?: string }): Promise<StepListEntry[]> {
    const customDir = join(this.root, "steps", "custom");
    const meta = await this.readStepMetadata(customDir);
    const results: StepListEntry[] = [];

    const files = await findStepFilesRecursive(customDir);
    for (const file of files) {
      const stepName = stepNameFromFile(file, customDir);
      const info = meta?.steps[stepName];
      if (filter?.publisher && info?.publisher !== filter.publisher) continue;
      const activeVer = info ? info.versions[info.active] : undefined;
      results.push({
        type: stepName,
        description: activeVer?.description,
        createdAt: activeVer?.createdAt,
        publisher: info?.publisher,
      });
    }

    return results;
  }

  /**
   * Publish a custom step, keyed by content hash but labeled with a friendly,
   * sequential version id (`v1`, `v2`, …). Writes the active source to
   * `<workspace>/steps/custom/<name>.ts` (what the registry loads) and
   * archives every version under `steps/_history/<name>/<vid>.ts`.
   *
   * `name` may contain slashes to nest the file under subdirectories
   * (e.g. `"gitree/save-feature"` writes to `custom/gitree/save-feature.ts`).
   * Names starting with `_` (or with any path segment starting with `_`)
   * are treated as helper files: they're saved and importable by sibling
   * steps but are skipped by registry discovery.
   *
   * Idempotent by content hash: republishing identical content that's already
   * active is a no-op; identical content of an older version re-activates it
   * (no new version); changed content publishes the next `vN` and activates it
   * while prior versions are retained for rollback.
   *
   * Returns the version id and whether anything changed.
   *
   * Lib steps cannot be published at runtime — they ship with the engine.
   */
  async publishStep(
    name: string,
    code: string,
    description?: string,
    publisher?: string,
    opts?: PublishByContentOptions,
  ): Promise<{ version: string; changed: boolean }> {
    validateStepName(name);

    const customDir = join(this.root, "steps", "custom");
    const filePath = join(customDir, `${name}.ts`);
    const hash = contentHash(code);

    const meta = (await this.readStepMetadata(customDir)) ?? { steps: {} };
    const existing = meta.steps[name];

    // Content already known → no-op (if active) or re-activate that version
    // (unless the caller opted out of re-activation).
    if (existing) {
      const match = Object.entries(existing.versions).find(
        ([, info]) => info.hash === hash,
      );
      if (match) {
        const [vid] = match;
        let changed = false;
        if (existing.active !== vid && opts?.reactivateKnown !== false && opts?.activate !== false) {
          const archived = await readFile(this.stepVersionPath(name, vid), "utf-8");
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, archived, "utf-8");
          existing.active = vid;
          changed = true;
        }
        if (publisher !== undefined && existing.publisher !== publisher) {
          existing.publisher = publisher;
          await this.writeStepMetadata(customDir, meta);
        } else if (changed) {
          await this.writeStepMetadata(customDir, meta);
        }
        return { version: vid, changed };
      }
    }

    // New content → next sequential version. Archive it, and materialize it
    // as the active source for the registry loader unless `activate: false`
    // keeps the active one.
    const vid = nextVersionLabel(existing ? Object.keys(existing.versions) : []);
    const activate = !existing || opts?.activate !== false;
    if (activate) {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, code, "utf-8");
    }
    const archivePath = this.stepVersionPath(name, vid);
    await mkdir(dirname(archivePath), { recursive: true });
    await writeFile(archivePath, code, "utf-8");
    const upstream = upstreamFor(opts, existing?.versions[existing.active]?.upstream);

    meta.steps[name] = {
      active: activate ? vid : existing!.active,
      versions: {
        ...(existing?.versions ?? {}),
        [vid]: {
          createdAt: new Date().toISOString(),
          hash,
          ...(description !== undefined ? { description } : {}),
          ...(upstream ? { upstream } : {}),
        },
      },
      ...(publisher !== undefined
        ? { publisher }
        : existing?.publisher !== undefined
          ? { publisher: existing.publisher }
          : {}),
    };

    await this.writeStepMetadata(customDir, meta);
    return { version: vid, changed: true };
  }

  // ── Apps (plans/apps.md §1.3) ──────────────────────────────────────────
  //
  // `apps/<name>/_metadata.json` beside the version directories
  // (`apps/<name>/<vN>/`, written by the publish flow after this records the
  // pointer) and, later, the app's `data.db`. A name may carry `/`
  // (`acme/hvac/invoices`): nested folders, the metadata at the leaf, so the
  // listing walks for `_metadata.json` files and never descends into a
  // version's directory.

  private appsDir(): string {
    return appsRoot(this.root);
  }

  private appMetaPath(name: string): string {
    return join(this.appsDir(), ...name.split("/"), "_metadata.json");
  }

  private async readAppMetadata(name: string): Promise<AppMetadata | null> {
    try {
      return JSON.parse(await readFile(this.appMetaPath(name), "utf-8")) as AppMetadata;
    } catch {
      return null;
    }
  }

  private async writeAppMetadata(name: string, meta: AppMetadata): Promise<void> {
    const file = this.appMetaPath(name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(meta, null, 2), "utf-8");
  }

  /** Every app on record, by name, sorted. */
  private async appNames(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      const entries = await safeReaddir(dir);
      let versions = new Set<string>();
      if (prefix && entries.some((e) => e.isFile() && e.name === "_metadata.json")) {
        out.push(prefix);
        versions = new Set(Object.keys((await this.readAppMetadata(prefix))?.versions ?? {}));
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".") || versions.has(e.name)) continue;
        await walk(join(dir, e.name), prefix ? `${prefix}/${e.name}` : e.name);
      }
    };
    await walk(this.appsDir(), "");
    return out.sort();
  }

  async listApps(): Promise<AppListEntry[]> {
    const out: AppListEntry[] = [];
    for (const name of await this.appNames()) {
      const meta = await this.readAppMetadata(name);
      const active = meta?.versions[meta.active];
      if (!meta || !active) continue;
      out.push(appListEntry(name, meta, active));
    }
    return out;
  }

  async getApp(name: string, version?: string): Promise<AppRecord | null> {
    validateAppName(name);
    const meta = await this.readAppMetadata(name);
    if (!meta) return null;
    const label = version ?? meta.active;
    const info = meta.versions[label];
    if (!info) return null;
    return appRecord(name, meta, label, info);
  }

  async publishApp(name: string, hash: string, manifest: AppManifest, opts?: PublishAppOptions): Promise<{ version: string; changed: boolean }> {
    validateAppName(name);
    const meta = await this.readAppMetadata(name);
    if (meta) {
      const match = Object.entries(meta.versions).find(([, v]) => v.hash === hash);
      if (match) {
        const [vid] = match;
        let changed = false;
        let dirty = false;
        if (meta.active !== vid && opts?.reactivateKnown !== false && opts?.activate !== false && !meta.live) {
          meta.active = vid;
          changed = dirty = true;
        }
        if (opts?.publisher !== undefined && meta.publisher !== opts.publisher) {
          meta.publisher = opts.publisher;
          dirty = true;
        }
        const owner = opts?.owner ?? opts?.actor;
        if (!meta.owner && owner) {
          meta.owner = owner;
          dirty = true;
        }
        if (dirty) await this.writeAppMetadata(name, meta);
        return { version: vid, changed };
      }
    }
    const upstream = upstreamFor(opts, meta?.versions[meta.active]?.upstream);
    const vid = nextVersionLabel(Object.keys(meta?.versions ?? {}));
    const publisher = opts?.publisher ?? meta?.publisher;
    const owner = meta?.owner ?? opts?.owner ?? opts?.actor;
    await this.writeAppMetadata(name, {
      // Held (or `activate: false`), the new version is a draft: `active` stays.
      active: meta && (meta.live || opts?.activate === false) ? meta.active : vid,
      versions: {
        ...(meta?.versions ?? {}),
        [vid]: {
          createdAt: new Date().toISOString(),
          hash,
          manifest,
          ...(publisher !== undefined ? { publisher } : {}),
          ...(upstream ? { upstream } : {}),
          ...provenance(opts),
        },
      },
      ...(publisher !== undefined ? { publisher } : {}),
      ...(owner ? { owner } : {}),
      ...(meta?.pinned ? { pinned: true } : {}),
      ...(meta?.releases?.length ? { releases: meta.releases } : {}),
      ...(meta?.live ? { live: meta.live } : {}),
    });
    return { version: vid, changed: true };
  }

  async setActiveAppVersion(name: string, version: string): Promise<void> {
    validateAppName(name);
    const meta = await this.readAppMetadata(name);
    if (!meta) throw new Error(`App "${name}" not found`);
    if (!meta.versions[version]) {
      throw new Error(`Version "${version}" not found for app "${name}". Available: ${Object.keys(meta.versions).join(", ")}`);
    }
    meta.active = version;
    delete meta.live;
    await this.writeAppMetadata(name, meta);
  }

  async addAppRelease(name: string, release: { version: string; lock: AppLock; createdAt?: string; by?: string }): Promise<AppRelease> {
    validateAppName(name);
    const meta = await this.readAppMetadata(name);
    if (!meta) throw new Error(`App "${name}" not found`);
    if (!meta.versions[release.version]) throw new Error(`Version "${release.version}" not found for app "${name}"`);
    const made = newRelease(meta.releases ?? [], release);
    meta.releases = [...(meta.releases ?? []), made];
    meta.live = made.id;
    meta.active = made.version;
    await this.writeAppMetadata(name, meta);
    return made;
  }

  async setAppLive(name: string, live: string | null): Promise<void> {
    validateAppName(name);
    const meta = await this.readAppMetadata(name);
    if (!meta) throw new Error(`App "${name}" not found`);
    if (live === null) {
      delete meta.live;
      meta.active = newestVersion(Object.keys(meta.versions));
    } else {
      const r = meta.releases?.find((x) => x.id === live);
      if (!r) throw new Error(`Release "${live}" not found for app "${name}"`);
      meta.live = r.id;
      meta.active = r.version;
    }
    await this.writeAppMetadata(name, meta);
  }

  async setAppPinned(name: string, pinned: boolean): Promise<void> {
    validateAppName(name);
    const meta = await this.readAppMetadata(name);
    if (!meta) throw new Error(`App "${name}" not found`);
    if (pinned) meta.pinned = true;
    else delete meta.pinned;
    await this.writeAppMetadata(name, meta);
  }

  async deleteApp(name: string): Promise<boolean> {
    validateAppName(name);
    if (!(await this.readAppMetadata(name))) return false;
    // The pointer only: the version directories (and a database) stay.
    await rm(this.appMetaPath(name), { force: true });
    return true;
  }

  async materializeAppVersion(name: string, version: string): Promise<{ path: string; hash: string }> {
    validateAppName(name);
    const info = (await this.readAppMetadata(name))?.versions[version];
    if (!info) throw new Error(`Version "${version}" of app "${name}" not found`);
    return { path: appVersionDir(this.appsDir(), name, version), hash: info.hash };
  }

  /** Absolute path to an archived step version source file. */
  private stepVersionPath(name: string, version: string): string {
    return join(this.root, "steps", "_history", name, `${version}.ts`);
  }

  private async writeStepMetadata(
    customDir: string,
    meta: StepDirMetadata,
  ): Promise<void> {
    await writeFile(
      join(customDir, "_metadata.json"),
      JSON.stringify(meta, null, 2),
      "utf-8",
    );
  }

  /** List a step's versions and its active version id. */
  async listStepVersions(name: string): Promise<StepVersionsResult> {
    validateStepName(name);
    const customDir = join(this.root, "steps", "custom");
    const meta = await this.readStepMetadata(customDir);
    const info = meta?.steps[name];
    if (!info) throw new Error(`Step "${name}" not found`);
    return { active: info.active, versions: Object.keys(info.versions) };
  }

  async getStepMetadata(name: string): Promise<StepInfo | null> {
    validateStepName(name);
    return (await this.readStepMetadata(this.customStepsDir()))?.steps[name] ?? null;
  }

  async getActiveStepHashes(): Promise<Record<string, string>> {
    const meta = await this.readStepMetadata(join(this.root, "steps", "custom"));
    const out: Record<string, string> = {};
    for (const [name, info] of Object.entries(meta?.steps ?? {})) {
      const recorded = info.versions[info.active]?.hash;
      if (recorded) {
        out[name] = recorded;
        continue;
      }
      // Metadata from before hashes were recorded: hash the archived source.
      try {
        out[name] = contentHash(await readFile(this.stepVersionPath(name, info.active), "utf-8"));
      } catch {
        // No source on record → no hash → that step's runs carry no evidence.
      }
    }
    return out;
  }

  /** Get the archived source for a specific step version. */
  async getStepVersionSource(name: string, version: string): Promise<string> {
    validateStepName(name);
    return readFile(this.stepVersionPath(name, version), "utf-8");
  }

  /** Copied out of the archive (`steps/_history/<name>/<vid>.ts`, which has
   *  no helper beside it) into `steps/custom/`, beside the active steps. */
  async materializeStepVersion(name: string, version: string): Promise<{ path: string; hash: string }> {
    validateStepName(name);
    const meta = await this.readStepMetadata(join(this.root, "steps", "custom"));
    const info = meta?.steps[name]?.versions[version];
    if (!info) throw new Error(`Version "${version}" of step "${name}" not found`);
    const code = await readFile(this.stepVersionPath(name, version), "utf-8");
    const hash = info.hash ?? contentHash(code);
    const path = await materializePinnedStep(this.customStepsDir(), name, version, hash, code);
    return { path, hash };
  }

  /**
   * Switch a step's active version. Copies the archived version's source
   * into the flat `custom/<name>.ts` the registry loads, and updates the
   * active pointer in metadata.
   */
  async setActiveStepVersion(name: string, version: string): Promise<void> {
    validateStepName(name);
    const customDir = join(this.root, "steps", "custom");
    const meta = await this.readStepMetadata(customDir);
    const info = meta?.steps[name];
    if (!meta || !info) throw new Error(`Step "${name}" not found`);
    if (!(version in info.versions)) {
      throw new Error(
        `Version "${version}" not found for step "${name}". Available: ${Object.keys(info.versions).join(", ")}`,
      );
    }
    const code = await readFile(this.stepVersionPath(name, version), "utf-8");
    const filePath = join(customDir, `${name}.ts`);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, code, "utf-8");
    info.active = version;
    await this.writeStepMetadata(customDir, meta);
  }

  /**
   * Delete a single custom step by name. Removes the source file, its
   * version archive, and its metadata entry, then cleans up any empty parent
   * directories within `steps/custom/` so namespace directories disappear
   * once their last step is removed.
   *
   * No-ops silently if the step does not exist.
   */
  async deleteStep(name: string): Promise<boolean> {
    validateStepName(name);

    const customDir = join(this.root, "steps", "custom");
    const filePath = join(customDir, `${name}.ts`);

    let removed = false;
    try {
      await unlink(filePath);
      removed = true;
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }

    // Its pinned versions' files beside it (`materializePinnedStep`).
    for (const e of await safeReaddir(dirname(filePath))) {
      const file = join(dirname(filePath), e.name);
      if (e.isFile() && pinnedStepFileOf(file) === filePath) await rm(file, { force: true });
    }

    // Remove the version archive dir for this step (best-effort).
    await rm(join(this.root, "steps", "_history", name), {
      recursive: true,
      force: true,
    });

    const meta = await this.readStepMetadata(customDir);
    if (meta && meta.steps[name]) {
      delete meta.steps[name];
      await writeFile(
        join(customDir, "_metadata.json"),
        JSON.stringify(meta, null, 2),
        "utf-8",
      );
      removed = true;
    }

    if (removed) {
      await pruneEmptyDirs(dirname(filePath), customDir);
    }

    return removed;
  }

  /**
   * Bulk delete all custom steps published by `publisher`. Returns the list
   * of step names that were removed. Useful for service shutdown:
   * `await ws.deleteStepsByPublisher("mcp-gitree")` on SIGTERM tears down
   * everything a service registered in one call.
   */
  async deleteStepsByPublisher(publisher: string): Promise<string[]> {
    const customDir = join(this.root, "steps", "custom");
    const meta = await this.readStepMetadata(customDir);
    if (!meta) return [];

    const toDelete = Object.entries(meta.steps)
      .filter(([, info]) => info.publisher === publisher)
      .map(([name]) => name);

    for (const name of toDelete) {
      await this.deleteStep(name);
    }

    return toDelete;
  }

  // ── Step source + code loading ─────────────────────────────────────────

  async getStepSource(type: string): Promise<{ code: string; origin: StepSource } | null> {
    return readStepSourceFromDisk(type, this.customStepsDir());
  }

  /** Publishing already writes each active custom step to
   *  `<root>/steps/custom/<name>.ts`, so the store IS the materialization. */
  async materializeCustomSteps(): Promise<string> {
    const dir = this.customStepsDir();
    await ensureEsmScope(dir);
    return dir;
  }

  private customStepsDir(): string {
    return join(this.root, "steps", "custom");
  }

  // ── Snapshot + move aside (the one-shot import into another store) ─────

  /** Everything on record — see `FileWorkspaceSnapshot` — or null when the
   *  root holds no workflow and no custom step (nothing to import). A
   *  workflow version named by its metadata whose file is gone throws: the
   *  workspace is damaged and an import must not paper over it. A custom
   *  step file with no metadata (published before versions were recorded)
   *  is one version, `v1`. */
  async snapshot(): Promise<FileWorkspaceSnapshot | null> {
    const out: FileWorkspaceSnapshot = { workflows: [], steps: [], apps: [] };
    for (const name of await this.workflowNames()) {
      const meta = await this.readWorkflowMetadata(name);
      if (!meta) continue;
      const versions = [];
      for (const label of Object.keys(meta.versions).sort(versionLabelOrder)) {
        versions.push({ label, yaml: await this.getWorkflowSource(name, label), info: meta.versions[label]! });
      }
      out.workflows.push({ name, meta, versions });
    }
    const customDir = this.customStepsDir();
    const meta = await this.readStepMetadata(customDir);
    for (const [name, info] of Object.entries(meta?.steps ?? {})) {
      const versions = [];
      for (const label of Object.keys(info.versions).sort(versionLabelOrder)) {
        versions.push({ label, code: await this.getStepVersionSource(name, label), info: info.versions[label]! });
      }
      out.steps.push({ name, active: info.active, ...(info.publisher ? { publisher: info.publisher } : {}), versions });
    }
    for (const file of await findStepFilesRecursive(customDir)) {
      const name = stepNameFromFile(file, customDir);
      if (meta?.steps[name]) continue;
      const code = await readFile(file, "utf-8");
      out.steps.push({ name, active: "v1", versions: [{ label: "v1", code, info: { createdAt: (await stat(file)).mtime.toISOString(), hash: contentHash(code) } }] });
    }
    out.steps.sort((a, b) => a.name.localeCompare(b.name));
    for (const name of await this.appNames()) {
      const meta = await this.readAppMetadata(name);
      if (meta) out.apps.push({ name, meta });
    }
    return out.workflows.length || out.steps.length || out.apps.length ? out : null;
  }

  /** Move the workspace's own files out of the root into `to` (created):
   *  each workflow's `_metadata.json` and version YAMLs to
   *  `<to>/workflows/<name>/`, and `steps/custom` + `steps/_history` whole
   *  to `<to>/steps/`. Everything else under the root stays where it is —
   *  the run store's `workflows/<name>/runs/`, artifacts, secrets, the
   *  graph store's `steps/_graph`. After this the root reads as an empty
   *  workspace. */
  async moveAside(to: string): Promise<void> {
    for (const name of await this.workflowNames()) {
      const from = this.workflowDir(name);
      const files = (await safeReaddir(from)).filter((f) => f.isFile() && (f.name === "_metadata.json" || f.name.endsWith(".yaml")));
      if (!files.length) continue;
      const dest = join(to, "workflows", ...name.split("/"));
      await mkdir(dest, { recursive: true });
      for (const f of files) await rename(join(from, f.name), join(dest, f.name));
    }
    for (const sub of ["custom", "_history"]) {
      const from = join(this.root, "steps", sub);
      try {
        await stat(from);
      } catch {
        continue;
      }
      await mkdir(join(to, "steps"), { recursive: true });
      await rename(from, join(to, "steps", sub));
    }
    // An app's POINTER moves; its version directories stay where every
    // backend reads them (plans/apps.md §1.3).
    for (const name of await this.appNames()) {
      const dest = join(to, "apps", ...name.split("/"), "_metadata.json");
      await mkdir(dirname(dest), { recursive: true });
      await rename(this.appMetaPath(name), dest);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /** A workflow's directory: `workflows/<name>`, a slashed name nested
   *  (`workflows/acme/linear/sync`). Throws on a name the rule refuses. */
  private workflowDir(name: string): string {
    validateWorkflowName(name);
    return join(this.root, "workflows", ...name.split("/"));
  }

  /** Every workflow on disk, sorted: each directory under `workflows/` that
   *  holds a `_metadata.json`, at any depth. The walk keeps descending past
   *  one — `acme` and `acme/linear/sync` share `workflows/acme/` — and skips
   *  a workflow's `runs/` (its run records; `runs` is never a segment of a
   *  slashed name). */
  private async workflowNames(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      const entries = await safeReaddir(dir);
      if (prefix && entries.some((e) => e.isFile() && e.name === "_metadata.json")) out.push(prefix);
      for (const e of entries) {
        if (!e.isDirectory() || (prefix && e.name === "runs")) continue;
        await walk(join(dir, e.name), prefix ? `${prefix}/${e.name}` : e.name);
      }
    };
    await walk(join(this.root, "workflows"), "");
    return out.sort();
  }

  private async readWorkflowMetadata(
    name: string,
  ): Promise<WorkflowMetadata | null> {
    try {
      const raw = await readFile(
        join(this.workflowDir(name), "_metadata.json"),
        "utf-8",
      );
      return JSON.parse(raw) as WorkflowMetadata;
    } catch {
      return null;
    }
  }

  private async readStepMetadata(
    dir: string,
  ): Promise<StepDirMetadata | null> {
    try {
      const raw = await readFile(join(dir, "_metadata.json"), "utf-8");
      return JSON.parse(raw) as StepDirMetadata;
    } catch {
      return null;
    }
  }
}

/** Back-compat name for `FileWorkspaceStore` (embedders and docs). */
export { FileWorkspaceStore as WorkspaceManager };

// ── Utilities ──────────────────────────────────────────────────────────────

async function safeReaddir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The next release (`rN`) after `releases` — shared by the file and graph stores. */
export function newRelease(releases: readonly AppRelease[], r: { version: string; lock: AppLock; createdAt?: string; by?: string }): AppRelease {
  const n = Math.max(0, ...releases.map((x) => parseInt(x.id.slice(1), 10) || 0)) + 1;
  return { id: `r${n}`, version: r.version, lock: r.lock, createdAt: r.createdAt ?? new Date().toISOString(), ...(r.by ? { by: r.by } : {}) };
}

/** The newest of some version labels (`v10` after `v9`). */
export function newestVersion(labels: readonly string[]): string {
  return [...labels].sort(versionLabelOrder).at(-1) ?? "";
}

/** An `AppListEntry` from a record and its active version — shared by the
 *  file and graph stores. */
export function appListEntry(name: string, meta: Pick<AppMetadata, "active" | "versions" | "publisher" | "owner" | "pinned" | "live">, active: AppVersionInfo): AppListEntry {
  const m = active.manifest;
  return {
    name,
    activeVersion: meta.active,
    versions: Object.keys(meta.versions).sort(versionLabelOrder),
    title: m.title,
    ...(m.description ? { description: m.description } : {}),
    ...(m.icon ? { icon: m.icon } : {}),
    grants: m.grants,
    ...(meta.publisher ? { publisher: meta.publisher } : {}),
    ...(meta.owner ? { owner: meta.owner } : {}),
    ...(meta.pinned ? { pinned: true } : {}),
    ...(meta.live ? { live: meta.live } : {}),
  };
}

/** An `AppRecord` for one version — shared by the file and graph stores. */
export function appRecord(name: string, meta: AppMetadata, version: string, info: AppVersionInfo): AppRecord {
  const versions: Record<string, AppVersionSummary> = {};
  for (const label of Object.keys(meta.versions).sort(versionLabelOrder)) {
    const { manifest: _m, ...rest } = meta.versions[label]!;
    versions[label] = rest;
  }
  return {
    name,
    version,
    hash: info.hash,
    manifest: info.manifest,
    createdAt: info.createdAt,
    ...(info.upstream ? { upstream: info.upstream } : {}),
    active: meta.active,
    versions,
    ...(meta.publisher ? { publisher: meta.publisher } : {}),
    ...(meta.owner ? { owner: meta.owner } : {}),
    ...(meta.pinned ? { pinned: true } : {}),
    ...(meta.releases?.length ? { releases: meta.releases } : {}),
    ...(meta.live ? { live: meta.live } : {}),
  };
}

/**
 * Validate a workflow name (marketplace.md "Step order" 1). A name with a
 * `/` is a path of segments (`acme/linear/sync`) that the file store nests,
 * so: no empty, `.` or `..` segment, no `\` or `#` (an event path's
 * iteration mark), and no segment named `runs` — a workflow's directory
 * holds its run records in `runs/`, so `acme/runs` would land in `acme`'s.
 * A one-segment name is only refused when empty,
 * `.` or `..`: no store checked one before, and a tighter rule could refuse
 * the republish of a name someone already has.
 */
export function validateWorkflowName(name: string): void {
  if (!name.includes("/")) {
    if (!name || name === "." || name === "..") throw new Error(`Invalid workflow name "${name}"`);
    return;
  }
  if (name.includes("\\")) throw new Error(`Invalid workflow name "${name}": "\\" is not allowed`);
  // An event path is the name, then its steps, a `#` marking an iteration
  // (`acme/sync/each#2`): a name holding one would read as one.
  if (name.includes("#")) throw new Error(`Invalid workflow name "${name}": "#" is not allowed`);
  for (const seg of name.split("/")) {
    if (!seg || seg === "." || seg === "..") {
      throw new Error(`Invalid workflow name "${name}": a segment may not be empty, "." or ".."`);
    }
    if (seg === "runs") {
      throw new Error(`Invalid workflow name "${name}": "runs" is reserved (a workflow's run records live in runs/)`);
    }
  }
}

/**
 * Validate a custom step name. Allows nested names with slashes
 * (e.g. `gitree/save-feature`) and helper names with leading underscores
 * (e.g. `gitree/_shared`). Rejects path traversal and absolute paths.
 */
export function validateStepName(name: string): void {
  if (!name) {
    throw new Error("Step name cannot be empty");
  }
  if (name.startsWith("/") || name.includes("\\")) {
    throw new Error(`Invalid step name "${name}": must not contain absolute or back-slash paths`);
  }
  if (name.includes("//") || name.endsWith("/") || name.startsWith("/")) {
    throw new Error(`Invalid step name "${name}": malformed path`);
  }
  if (name.includes("@")) {
    throw new Error(`Invalid step name "${name}": "@" is reserved for version pins (type@vN)`);
  }
  if (name.startsWith("mcp/")) {
    throw new Error(`Invalid step name "${name}": "mcp/" names a registered MCP server's tools (src/mcp-registry.ts)`);
  }
  const segments = name.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") {
      throw new Error(`Invalid step name "${name}": path traversal not allowed`);
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(seg)) {
      throw new Error(
        `Invalid step name "${name}": each segment must match [a-zA-Z_][a-zA-Z0-9_-]*`,
      );
    }
  }
}

/**
 * Recursively find step files (`.ts` / `.js`) under `dir`, skipping helper
 * files (`_*`), hidden files, and test files. Returns absolute paths.
 *
 * This mirrors the registry's discovery rules so `listSteps` shows exactly
 * what the registry will load.
 */
async function findStepFilesRecursive(dir: string): Promise<string[]> {
  const results: string[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith("_") || e.name.startsWith(".")) continue;
      const nested = await findStepFilesRecursive(full);
      results.push(...nested);
    } else if (e.isFile()) {
      if (
        e.name.startsWith("_") ||
        e.name.startsWith(".") ||
        !(e.name.endsWith(".ts") || e.name.endsWith(".js")) ||
        e.name.endsWith(".test.ts") ||
        e.name.endsWith(".spec.ts")
      ) continue;
      results.push(full);
    }
  }

  return results;
}

/**
 * Convert an absolute file path under `baseDir` to a slash-separated step
 * name (extension stripped). E.g. `<base>/gitree/save-feature.ts` → `"gitree/save-feature"`.
 */
function stepNameFromFile(filePath: string, baseDir: string): string {
  const rel = relative(baseDir, filePath).replace(/\.(ts|js)$/, "");
  return rel.split(sep).join("/");
}

/**
 * Walk upward from `startDir` removing empty directories, stopping when
 * `stopDir` is reached (inclusive boundary — we never remove `stopDir`).
 * Silently ignores non-empty dirs and any errors.
 */
async function pruneEmptyDirs(startDir: string, stopDir: string): Promise<void> {
  let dir = startDir;
  while (dir.startsWith(stopDir) && dir !== stopDir) {
    try {
      await rmdir(dir);
    } catch {
      return; // not empty, or doesn't exist
    }
    dir = dirname(dir);
  }
}

/**
 * Custom step files are ESM (`import { defineStep } from "strut"`). Node and
 * tsx decide a `.ts` file's format from the nearest package.json, and a
 * workspace outside the strut package tree has none — tsx then falls back to
 * CommonJS and `require("strut")` bypasses the ESM resolve hook that makes
 * the bare specifier work (strut-resolve-hook.ts). A one-line package.json
 * beside the steps pins the format wherever the workspace lives.
 */
export async function ensureEsmScope(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const pkg = join(dir, "package.json");
  try {
    await stat(pkg);
  } catch {
    await writeFile(pkg, JSON.stringify({ type: "module" }, null, 2) + "\n", "utf-8");
  }
}

/**
 * Write a PINNED step version (`type@vN`, src/step-ref.ts) where
 * `resolveStep` imports it: BESIDE the active custom steps in `dir` (the
 * directory `materializeCustomSteps` returns), as
 * `<ns>/_<leaf>@<vN>.<hash>.ts`, so a relative import (`./_shared.js`)
 * resolves as the active version's does. A pin holds the step's own file;
 * a helper it imports is the helper's ACTIVE version, the one every other
 * step imports, so a helper changed after the pin changes the pinned step
 * too. Not the helper that was active when the pinned version was
 * published: nothing records that (the active pointer keeps no history, and
 * timestamps do not survive a re-activation, `activate: false` or the
 * fs → graph import), and a version's hash covers its own file alone
 * (`step.start.stepVersion`, `run.start.stepHashes`, evidence), so a helper
 * is an item with its own active pointer everywhere already.
 *
 * The `_` keeps registry discovery and the step listings off the file, the
 * `@` keeps every step name off it (`validateStepName`), and the hash gives
 * each content its own module URL: a label reused after a delete (labels
 * start over at `v1`) never meets the old version in the module cache.
 * Returns the file's path.
 */
export async function materializePinnedStep(dir: string, name: string, version: string, hash: string, code: string): Promise<string> {
  await ensureEsmScope(dir);
  const segments = name.split("/");
  const leaf = segments.pop()!;
  const path = join(dir, ...segments, `_${leaf}@${version}.${hash}.ts`);
  let current: string | null = null;
  try {
    current = await readFile(path, "utf-8");
  } catch {
    // absent
  }
  if (current !== code) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, code, "utf-8");
  }
  return path;
}

/** The active step file a pinned version's file sits beside
 *  (`materializePinnedStep`), or null when `file` is not one. */
export function pinnedStepFileOf(file: string): string | null {
  const m = /^_([^@]+)@.+\.ts$/.exec(basename(file));
  return m ? join(dirname(file), `${m[1]}.ts`) : null;
}
