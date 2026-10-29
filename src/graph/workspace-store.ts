/**
 * `GraphWorkspaceStore` — the graph-backed `WorkspaceStore`
 * (plans/generic-storage.md §7) over any `GraphBackend`: Neo4j (the swarm's
 * jarvis graph) or a LadybugDB file (plans/ladybug-backend.md). Workflows,
 * versions, steps, and step versions are nodes of strut's own types
 * (`StrutWorkflow`, `StrutWorkflowVersion`, `StrutStep`, `StrutStepVersion` —
 * the registry in `strut-schemas.ts`), linked by `VERSION_OF`,
 * `ACTIVE_VERSION`, `USES_STEP`, and `DEPENDS_ON` edges. Every write goes
 * through the shared node/edge writers; every read is one of a dozen
 * pattern-level statements written with the backend's dialect helpers
 * (`engine.ts`), so one class serves both engines. The two list reads are
 * two statements each (the parents, then every live version with the
 * `VERSION_OF` target it belongs to), joined and ordered in TS.
 *
 * Semantics mirror `FileWorkspaceStore` (the conformance suite in
 * `src/test-util/workspace-conformance.ts` is the contract), with one
 * deliberate difference: versions are CONTENT-ADDRESSED. A version node is
 * keyed by `(name, content_hash)`, and the user-facing `v1`/`v2` label is a
 * property on it. Publishing content that already exists under another
 * label re-labels that version instead of duplicating it. Node keys are
 * the HEX of the exact name (`exact_key` in strut-schemas.ts), so `pod/test`
 * and `pod_test` are two nodes; every lookup here matches on the name
 * attribute (`name` / `step_type`), never on the key.
 *
 * Custom step code is executable, so the store also materializes every
 * active custom step into a scratch directory (`materializeCustomSteps`) for
 * the module loader; the graph stays the record.
 *
 * Deleting a workflow or step soft-deletes its nodes (`deletion.ts`: they
 * stay, stamped `deleted_at`) and hard-deletes their edges. A re-publish
 * under the same name restores the nodes and writes back the edges the store
 * reads (`VERSION_OF`, `ACTIVE_VERSION`, the version's own `USES_STEP` /
 * `DEPENDS_ON`); edges other nodes had to it (another version's `USES_STEP`
 * or `DEPENDS_ON`, a claim's `ABOUT`) do not come back.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { ensureEsmScope, materializePinnedStep, pinnedStepFileOf } from "../workspace.js";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import type { Automation } from "../automations.js";
import type { Flow } from "../core.js";
import {
  assertValidWorkflowYaml,
  flowFromYaml,
  renderWorkflowYaml,
  validateStepName,
  validateWorkflowName,
  provenance,
  missingProvenance,
  upstreamFor,
  fromPackage,
  refuseUnderInstalledPackage,
  appListEntry,
  appRecord,
  newestVersion,
  newRelease,
  type AppListEntry,
  type AppLock,
  type AppMetadata,
  type AppRelease,
  type AppRecord,
  type AppVersionInfo,
  type PublishAppOptions,
  type PublishByContentOptions,
  type PublishOptions,
  type VersionSource,
  type WorkflowContent,
  type StepInfo,
  type StepListEntry,
  type StepVersionsResult,
  type Upstream,
  type WorkflowListEntry,
  type WorkflowMetadata,
  type WorkspaceStore,
} from "../workspace.js";
import type { AppManifest } from "../apps/manifest.js";
import { appVersionDir, validateAppName } from "../apps/files.js";
import { readStepSourceFromDisk, type StepSource } from "../steps/registry.js";
import { contentHash, nextVersionLabel } from "../version.js";
import type { GraphBackend } from "./backend.js";

export interface GraphWorkspaceStoreOptions {
  /** Where active custom steps are written for the module loader. Default:
   *  a per-(uri, namespace) dir under the OS temp dir. */
  materializeDir?: string;
  /** Where app versions' files live — `<dataDir>/apps` (plans/apps.md §1.3;
   *  `materializeAppVersion` names a directory under it). Default: a
   *  per-(uri, namespace) dir under the OS temp dir. */
  appsDir?: string;
}

interface WorkflowRow {
  ref_id: string;
  name: string;
  description?: string;
  category?: string;
  publisher?: string;
  active_version?: string;
  /** JSON-encoded `Automation[]` (plans/automations.md §2). */
  automations?: string;
  /** The owning actor and per-run cap (plans/mothership-cost-control.md). */
  owner?: string;
  max_run_cost_usd?: number;
}

/** A workflow row's automations; a blob that fails to parse reads as none. */
function automationsOf(w: WorkflowRow): Automation[] {
  if (!w.automations) return [];
  try {
    const list: unknown = JSON.parse(w.automations);
    return Array.isArray(list) ? (list as Automation[]) : [];
  } catch {
    return [];
  }
}

interface VersionRow {
  ref_id: string;
  name: string;
  content_hash: string;
  version_label: string;
  description?: string;
  created_at: number; // epoch seconds
  date_added_to_graph?: number;
  source: string;
  publisher?: string;
  /** `WorkflowVersionInfo.source` — `source` is the YAML here. */
  version_source?: VersionSource;
  actor?: string;
  /** JSON `Upstream`. */
  upstream?: string;
}

interface StepRow {
  ref_id: string;
  step_type: string;
  description?: string;
  publisher?: string;
  active_version?: string;
}

interface StepVersionRow {
  ref_id: string;
  step_type: string;
  content_hash: string;
  version_label: string;
  description?: string;
  created_at: number;
  date_added_to_graph?: number;
  source: string;
  publisher?: string;
  version_source?: VersionSource;
  actor?: string;
  /** JSON `Upstream`. */
  upstream?: string;
}

interface AppRow {
  ref_id: string;
  name: string;
  title?: string;
  description?: string;
  publisher?: string;
  owner?: string;
  pinned?: boolean;
  active_version?: string;
  /** The live release's id (`AppMetadata.live`). */
  live?: string;
  /** JSON `AppRelease[]`. */
  releases?: string;
}

interface AppVersionRow {
  ref_id: string;
  name: string;
  content_hash: string;
  version_label: string;
  created_at: number;
  date_added_to_graph?: number;
  /** JSON `AppManifest`. */
  manifest?: string;
  publisher?: string;
  version_source?: VersionSource;
  actor?: string;
  /** JSON `Upstream`. */
  upstream?: string;
}

const APP_FIELDS = ["ref_id", "name", "title", "description", "publisher", "owner", "pinned", "active_version", "live", "releases"] as const;
const APP_VERSION_FIELDS = ["ref_id", "name", "content_hash", "version_label", "created_at", "manifest", "publisher", "version_source", "actor", "upstream", "date_added_to_graph"] as const;

/** A JSON attribute, or undefined when absent or unreadable. */
function parseJson<T>(text: string | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

const WORKFLOW_FIELDS = ["ref_id", "name", "description", "category", "publisher", "active_version", "automations", "owner", "max_run_cost_usd"] as const;
const VERSION_FIELDS = ["ref_id", "name", "content_hash", "version_label", "description", "created_at", "source", "publisher", "version_source", "actor", "upstream", "date_added_to_graph"] as const;
const STEP_FIELDS = ["ref_id", "step_type", "description", "publisher", "active_version"] as const;
const STEP_VERSION_FIELDS = ["ref_id", "step_type", "content_hash", "version_label", "description", "created_at", "source", "publisher", "version_source", "actor", "upstream", "date_added_to_graph"] as const;

const isoFromSeconds = (s: number | undefined): string =>
  new Date((s ?? 0) * 1000).toISOString();

/** Versions in creation order: `created_at` (seconds), then the write stamp. */
const byCreation = <T extends { created_at: number; date_added_to_graph?: number }>(a: T, b: T) =>
  a.created_at - b.created_at || (a.date_added_to_graph ?? 0) - (b.date_added_to_graph ?? 0);

/** Drop undefined/null values so the writer sees only real attributes. */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

/** A patch that makes a node's attributes equal `desired` for the given
 *  keys: set the defined ones, remove the ones now undefined. */
function patchFor(
  current: Record<string, unknown>,
  desired: Record<string, unknown>,
): { set: Record<string, unknown>; remove: string[] } | null {
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  for (const [k, v] of Object.entries(desired)) {
    if (v === undefined || v === null || v === "") {
      if (current[k] !== undefined && current[k] !== null) remove.push(k);
    } else if (current[k] !== v) {
      set[k] = v;
    }
  }
  return Object.keys(set).length || remove.length ? { set, remove } : null;
}

/** Every `{ type, config }` step object in a parsed workflow, at any depth
 *  (loop/if/foreach bodies nest steps inside config). */
function collectStepRefs(node: unknown, out: Array<{ type: string; config: Record<string, unknown> }> = []) {
  if (Array.isArray(node)) {
    for (const x of node) collectStepRefs(x, out);
  } else if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o["type"] === "string" && typeof o["id"] === "string") {
      out.push({ type: o["type"], config: (o["config"] as Record<string, unknown>) ?? {} });
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") collectStepRefs(v, out);
  }
  return out;
}

export class GraphWorkspaceStore implements WorkspaceStore {
  private readonly ns: string;
  private readonly materializeDir: string;
  private readonly appsDir: string;

  constructor(
    private readonly backend: GraphBackend,
    opts: GraphWorkspaceStoreOptions = {},
  ) {
    this.ns = backend.namespace;
    const where = backend.kind === "neo4j" ? `${backend.cfg.uri}|${backend.cfg.database ?? ""}` : backend.cfg.path;
    const stamp = createHash("sha256").update(`${where}|${this.ns}`).digest("hex").slice(0, 16);
    this.materializeDir = opts.materializeDir ?? join(tmpdir(), "strut-graph-steps", stamp);
    this.appsDir = opts.appsDir ?? join(tmpdir(), "strut-graph-apps", stamp);
  }

  /** `WorkspaceStore.graph` — what turns the claims layer on. */
  get graph(): GraphBackend {
    return this.backend;
  }

  private get d() {
    return this.backend.dialect;
  }

  /** A projected row with its null fields dropped, as Neo4j's `properties()`
   *  and the Ladybug handle both report an absent property. */
  private async rows<T>(cypher: string, params: Record<string, unknown>, column = "p"): Promise<T[]> {
    return (await this.backend.query(cypher, params)).map((r) => compact(r[column] as Record<string, unknown>) as T);
  }

  // ── Reads: workflows ───────────────────────────────────────────────────

  private async workflowRow(name: string): Promise<WorkflowRow | null> {
    const d = this.d;
    const rows = await this.rows<WorkflowRow>(
      `MATCH ${d.node("w", "StrutWorkflow", { namespace: "$ns", name: "$name" })} WHERE ${d.live("w")}
       RETURN ${d.project("w", WORKFLOW_FIELDS)} AS p LIMIT 1`,
      { ns: this.ns, name },
    );
    return rows[0] ?? null;
  }

  private async versionRows(name: string): Promise<VersionRow[]> {
    const d = this.d;
    const rows = await this.rows<VersionRow>(
      `MATCH ${d.node("v", "StrutWorkflowVersion", { namespace: "$ns", name: "$name" })} WHERE ${d.live("v")}
       RETURN ${d.project("v", VERSION_FIELDS)} AS p`,
      { ns: this.ns, name },
    );
    return rows.sort(byCreation);
  }

  async listWorkflows(): Promise<WorkflowListEntry[]> {
    const d = this.d;
    const workflows = await this.rows<WorkflowRow>(
      `MATCH ${d.node("w", "StrutWorkflow", { namespace: "$ns" })} WHERE ${d.live("w")} RETURN ${d.project("w", WORKFLOW_FIELDS)} AS p`,
      { ns: this.ns },
    );
    // Every live version with the workflow it belongs to, joined here: an
    // OPTIONAL MATCH + collect is a Ladybug bug (plans/ladybug-backend.md §2).
    const versionRows = await this.backend.query(
      `MATCH ${d.node("v", "StrutWorkflowVersion", { namespace: "$ns" })}-[:VERSION_OF]->${d.node("w", "StrutWorkflow", { namespace: "$ns" })}
       WHERE ${d.live("v")} AND ${d.live("w")}
       RETURN w.ref_id AS wf, ${d.project("v", VERSION_FIELDS)} AS p`,
      { ns: this.ns },
    );
    const byWorkflow = new Map<string, VersionRow[]>();
    for (const r of versionRows) {
      const list = byWorkflow.get(String(r["wf"])) ?? [];
      list.push(compact(r["p"] as Record<string, unknown>) as unknown as VersionRow);
      byWorkflow.set(String(r["wf"]), list);
    }
    const out: WorkflowListEntry[] = [];
    for (const w of workflows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const versions = (byWorkflow.get(w.ref_id) ?? []).filter((v) => v.version_label).sort(byCreation);
      const active = versions.find((v) => v.content_hash === w.active_version);
      out.push({
        name: w.name,
        activeVersion: active?.version_label ?? "",
        versions: versions.map((v) => v.version_label),
        description: active?.description,
        ...(w.category ? { category: w.category } : {}),
        ...(w.publisher ? { publisher: w.publisher } : {}),
        ...(active?.version_source ? { activeSource: active.version_source } : {}),
        ...(w.owner ? { owner: w.owner } : {}),
        ...(w.max_run_cost_usd != null ? { maxRunCostUsd: Number(w.max_run_cost_usd) } : {}),
        ...(automationsOf(w).length ? { automations: automationsOf(w) } : {}),
      });
    }
    return out;
  }

  async getWorkflowMetadata(name: string): Promise<WorkflowMetadata | null> {
    const w = await this.workflowRow(name);
    if (!w) return null;
    const versions = await this.versionRows(name);
    const active = versions.find((v) => v.content_hash === w.active_version);
    const meta: WorkflowMetadata = { active: active?.version_label ?? "", versions: {} };
    for (const v of versions) {
      const upstream = parseJson<Upstream>(v.upstream);
      meta.versions[v.version_label] = {
        createdAt: isoFromSeconds(v.created_at),
        ...(v.description !== undefined ? { description: v.description } : {}),
        hash: v.content_hash,
        ...(v.version_source ? { source: v.version_source } : {}),
        ...(v.actor ? { actor: v.actor } : {}),
        ...(upstream ? { upstream } : {}),
      };
    }
    if (w.category) meta.category = w.category;
    if (w.publisher) meta.publisher = w.publisher;
    if (w.owner) meta.owner = w.owner;
    if (w.max_run_cost_usd != null) meta.maxRunCostUsd = Number(w.max_run_cost_usd);
    if (automationsOf(w).length) meta.automations = automationsOf(w);
    return meta;
  }

  private async versionByLabel(name: string, label: string): Promise<VersionRow | null> {
    return (await this.versionRows(name)).find((v) => v.version_label === label) ?? null;
  }

  private async activeVersion(name: string): Promise<VersionRow> {
    const w = await this.workflowRow(name);
    if (!w) throw new Error(`Workflow "${name}" not found`);
    const v = (await this.versionRows(name)).find((x) => x.content_hash === w.active_version);
    if (!v) throw new Error(`Workflow "${name}" has no active version`);
    return v;
  }

  async getWorkflow(name: string): Promise<Flow> {
    const v = await this.activeVersion(name);
    return flowFromYaml(name, v.version_label, v.source);
  }

  async getWorkflowVersion(name: string, version: string): Promise<Flow> {
    return flowFromYaml(name, version, await this.getWorkflowSource(name, version));
  }

  async getWorkflowSource(name: string, version: string): Promise<string> {
    const v = await this.versionByLabel(name, version);
    if (!v) throw new Error(`Version "${version}" of workflow "${name}" not found`);
    return v.source;
  }

  async getWorkflowHash(name: string, version?: string): Promise<string | null> {
    try {
      const v = version ? await this.versionByLabel(name, version) : await this.activeVersion(name);
      return v?.content_hash ?? null;
    } catch {
      return null;
    }
  }

  // ── Writes: workflows ──────────────────────────────────────────────────

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
    while (await this.workflowRow(finalName)) finalName = `${name}-${n++}`;
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

  async publishWorkflow(
    name: string,
    version: string,
    content: WorkflowContent | string,
    description?: string,
    category?: string,
    publisher?: string,
    opts?: PublishOptions,
  ): Promise<void> {
    const yamlStr = renderWorkflowYaml(name, content);
    assertValidWorkflowYaml(yamlStr);
    await this.writeVersion(name, version, yamlStr, description, category, publisher, opts);
  }

  /** The one write path behind publish/publishByContent/setParam: ensure the
   *  version node exists (creating, restoring, or re-labeling it), then
   *  point the workflow at it — unless `opts.activate` is false and the
   *  workflow has an active version to keep. */
  private async writeVersion(
    name: string,
    label: string,
    yamlStr: string,
    description: string | undefined,
    category: string | undefined,
    publisher: string | undefined,
    opts?: PublishByContentOptions,
  ): Promise<VersionRow> {
    validateWorkflowName(name);
    const { source: version_source, actor } = provenance(opts);
    const hash = contentHash(yamlStr);
    const { nodes } = this.backend;
    const w = await this.workflowRow(name);
    if (!w) await refuseUnderInstalledPackage("workflow", name, opts, (prefix) => this.installedUnder(prefix));
    const versions = await this.versionRows(name);
    const upstream = upstreamFor(opts, parseJson<Upstream>(versions.find((v) => v.content_hash === w?.active_version)?.upstream));
    const existing = versions.find((v) => v.content_hash === hash);
    let versionRef: string;
    if (existing) {
      // Content-addressed: same content under a new label re-labels.
      const patch = patchFor(existing as unknown as Record<string, unknown>, {
        version_label: label,
        ...(description !== undefined ? { description } : {}),
        ...(version_source ? { version_source } : {}),
        ...(actor ? { actor } : {}),
        upstream: upstream ? JSON.stringify(upstream) : undefined,
      });
      if (patch) await nodes.update(existing.ref_id, patch);
      versionRef = existing.ref_id;
    } else {
      const parsed = (yaml.load(yamlStr) as Record<string, unknown> | null) ?? {};
      const r = await nodes.write({
        type: "StrutWorkflowVersion",
        data: compact({
          name,
          content_hash: hash,
          version_label: label,
          description,
          created_at: new Date().toISOString(),
          source: yamlStr,
          params_json: parsed["params"] != null ? JSON.stringify(parsed["params"]) : undefined,
          publisher,
          version_source,
          actor,
          upstream: upstream ? JSON.stringify(upstream) : undefined,
        }),
      });
      versionRef = r.ref_id;
    }
    await this.activate(name, { ref_id: versionRef, hash, description }, category, publisher, !w || opts?.activate !== false);
    await this.linkVersionDeps(versionRef, yamlStr);
    return (await this.versionRows(name)).find((v) => v.ref_id === versionRef)!;
  }

  /** Point the workflow node (creating it if needed) at a version: mirror the
   *  version's description onto the workflow, swap the ACTIVE_VERSION edge.
   *  With `move` false the version only joins the workflow (VERSION_OF), and
   *  the pointer and description stay. */
  private async activate(
    name: string,
    version: { ref_id: string; hash: string; description: string | undefined },
    category?: string,
    publisher?: string,
    move = true,
  ): Promise<void> {
    const { nodes, edges } = this.backend;
    const w = await this.workflowRow(name);
    let wfRef: string;
    if (!w) {
      const r = await nodes.write({
        type: "StrutWorkflow",
        data: compact({ name, description: version.description, category, publisher, active_version: version.hash }),
      });
      wfRef = r.ref_id;
    } else {
      wfRef = w.ref_id;
      const desired: Record<string, unknown> = move ? { active_version: version.hash, description: version.description } : {};
      if (category !== undefined) desired["category"] = category;
      if (publisher !== undefined) desired["publisher"] = publisher;
      const patch = patchFor(w as unknown as Record<string, unknown>, desired);
      if (patch) await nodes.update(wfRef, patch);
    }
    await edges.write({ edge: "VERSION_OF", source_ref_id: version.ref_id, target_ref_id: wfRef });
    if (w && !move) return;
    await this.swapActiveEdge("StrutWorkflow", wfRef, "StrutWorkflowVersion", version.ref_id);
  }

  /** A known version's missing door, filled in by a publish of its content
   *  (`missingProvenance`). */
  private async fillDoor(row: { ref_id: string; version_source?: VersionSource; actor?: string }, opts?: PublishOptions): Promise<void> {
    const door = missingProvenance({ source: row.version_source, actor: row.actor }, opts);
    if (!door) return;
    // An absent `actor` must stay out of the patch: patchFor removes a field
    // the desired state leaves undefined, and a recorded actor is kept.
    const patch = patchFor(row as unknown as Record<string, unknown>, { version_source: door.source, ...(door.actor ? { actor: door.actor } : {}) });
    if (patch) await this.backend.nodes.update(row.ref_id, patch);
  }

  /** Point a workflow, step or app at one version: its other ACTIVE_VERSION
   *  edges deleted and this one written, in one write transaction. Through
   *  `tx`, not `query`: on a LadybugDB file `query` is the read connection,
   *  and a DELETE there fails while another write transaction is open — a
   *  run's end projection, after every run. */
  private async swapActiveEdge(sourceType: string, sourceRef: string, versionType: string, versionRef: string): Promise<void> {
    const d = this.d;
    await this.backend.tx(async (tx) => {
      await tx.run(
        `MATCH ${d.node("s", sourceType, { ref_id: "$s" })}-[r:ACTIVE_VERSION]->${d.node("v", versionType)} WHERE v.ref_id <> $v DELETE r`,
        { s: sourceRef, v: versionRef },
      );
      await this.backend.edges.write({ edge: "ACTIVE_VERSION", source_ref_id: sourceRef, target_ref_id: versionRef }, tx);
    });
  }

  /** USES_STEP → every custom step the version references; DEPENDS_ON →
   *  every workflow its subflow steps call. Only targets that exist are
   *  linked (the graph pays off in "which workflows use step X"). */
  private async linkVersionDeps(versionRef: string, yamlStr: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = yaml.load(yamlStr);
    } catch {
      return;
    }
    const refs = collectStepRefs((parsed as Record<string, unknown> | null)?.["steps"]);
    const stepTypes = [...new Set(refs.filter((r) => r.type !== "subflow").map((r) => r.type))];
    const subflows = [
      ...new Set(refs.filter((r) => r.type === "subflow" && typeof r.config["workflow"] === "string").map((r) => r.config["workflow"] as string)),
    ];
    const inputs: Array<{ edge: string; source_ref_id: string; target_ref_id: string }> = [];
    const d = this.d;
    if (stepTypes.length) {
      const rows = await this.backend.query(
        `MATCH ${d.node("s", "StrutStep", { namespace: "$ns" })} WHERE s.step_type IN $types AND ${d.live("s")} RETURN s.ref_id AS ref_id`,
        { ns: this.ns, types: stepTypes },
      );
      for (const r of rows) inputs.push({ edge: "USES_STEP", source_ref_id: versionRef, target_ref_id: r["ref_id"] as string });
    }
    if (subflows.length) {
      const rows = await this.backend.query(
        `MATCH ${d.node("w", "StrutWorkflow", { namespace: "$ns" })} WHERE w.name IN $names AND ${d.live("w")} RETURN w.ref_id AS ref_id`,
        { ns: this.ns, names: subflows },
      );
      for (const r of rows) inputs.push({ edge: "DEPENDS_ON", source_ref_id: versionRef, target_ref_id: r["ref_id"] as string });
    }
    if (inputs.length) await this.backend.edges.writeMany(inputs);
  }

  async publishWorkflowByContent(
    name: string,
    yamlStr: string,
    description?: string,
    category?: string,
    publisher?: string,
    opts?: PublishByContentOptions,
  ): Promise<{ version: string; changed: boolean }> {
    const hash = contentHash(yamlStr);
    const w = await this.workflowRow(name);
    if (w) {
      if (category !== undefined && (w.category ?? undefined) !== category) {
        await this.setWorkflowCategory(name, category);
      }
      const match = (await this.versionRows(name)).find((v) => v.content_hash === hash);
      if (match) {
        await this.fillDoor(match, opts);
        if (w.active_version === hash || opts?.reactivateKnown === false || opts?.activate === false) {
          return { version: match.version_label, changed: false };
        }
        await this.setActiveVersion(name, match.version_label);
        return { version: match.version_label, changed: true };
      }
    }
    const next = nextVersionLabel((await this.versionRows(name)).map((v) => v.version_label));
    assertValidWorkflowYaml(yamlStr);
    await this.writeVersion(name, next, yamlStr, description, category, publisher, opts);
    return { version: next, changed: true };
  }

  async setWorkflowCategory(name: string, category: string | null): Promise<void> {
    const w = await this.workflowRow(name);
    if (!w) throw new Error(`Workflow "${name}" not found`);
    const patch = patchFor(w as unknown as Record<string, unknown>, { category: category || undefined });
    if (patch) await this.backend.nodes.update(w.ref_id, patch);
  }

  async setWorkflowOwner(name: string, owner: string | null): Promise<void> {
    const w = await this.workflowRow(name);
    if (!w) throw new Error(`Workflow "${name}" not found`);
    const patch = patchFor(w as unknown as Record<string, unknown>, { owner: owner || undefined });
    if (patch) await this.backend.nodes.update(w.ref_id, patch);
  }

  async setWorkflowRunCap(name: string, maxRunCostUsd: number | null): Promise<void> {
    const w = await this.workflowRow(name);
    if (!w) throw new Error(`Workflow "${name}" not found`);
    const patch = patchFor(w as unknown as Record<string, unknown>, { max_run_cost_usd: maxRunCostUsd ?? undefined });
    if (patch) await this.backend.nodes.update(w.ref_id, patch);
  }

  async setWorkflowPublisher(name: string, publisher: string | null): Promise<void> {
    const w = await this.workflowRow(name);
    if (!w) throw new Error(`Workflow "${name}" not found`);
    const patch = patchFor(w as unknown as Record<string, unknown>, { publisher: publisher || undefined });
    if (patch) await this.backend.nodes.update(w.ref_id, patch);
  }

  async setWorkflowAutomations(name: string, automations: Automation[]): Promise<void> {
    const w = await this.workflowRow(name);
    if (!w) throw new Error(`Workflow "${name}" not found`);
    const blob = automations.length > 0 ? JSON.stringify(automations) : undefined;
    const patch = patchFor(w as unknown as Record<string, unknown>, { automations: blob });
    if (patch) await this.backend.nodes.update(w.ref_id, patch);
  }

  /** Soft, like `deleteStep`: the nodes stay, stamped `deleted_at`, and
   *  their edges go. A later publish under the same name RESTORES the
   *  workflow node (the node writer clears the markers on a key match), so the metadata that would otherwise
   *  ride along — schedules, owner, cap, category, the publisher stamp — is cleared first: the
   *  new workflow is a new one, not this one back. Versions stay deleted
   *  unless their exact content is published again. */
  async deleteWorkflow(name: string): Promise<boolean> {
    const w = await this.workflowRow(name);
    if (!w) return false;
    const remove = (["automations", "owner", "max_run_cost_usd", "category", "publisher"] as const).filter((k) => w[k] != null);
    if (remove.length) await this.backend.nodes.update(w.ref_id, { remove: [...remove] });
    for (const v of await this.versionRows(name)) await this.backend.nodes.softDelete(v.ref_id);
    await this.backend.nodes.softDelete(w.ref_id);
    return true;
  }

  async setActiveVersion(name: string, version: string): Promise<void> {
    const w = await this.workflowRow(name);
    if (!w) throw new Error(`Workflow "${name}" not found`);
    const versions = await this.versionRows(name);
    const v = versions.find((x) => x.version_label === version);
    if (!v) {
      throw new Error(
        `Version "${version}" not found for workflow "${name}". Available: ${versions.map((x) => x.version_label).join(", ")}`,
      );
    }
    await this.activate(name, { ref_id: v.ref_id, hash: v.content_hash, description: v.description });
  }

  async setParam(
    name: string,
    param: string,
    value: unknown,
    actor?: string,
  ): Promise<{ version: string; before: unknown; after: unknown }> {
    const active = await this.activeVersion(name);
    const obj = (yaml.load(active.source) as Record<string, unknown>) ?? {};
    if (!obj["name"]) obj["name"] = name;
    const params =
      obj["params"] && typeof obj["params"] === "object" ? (obj["params"] as Record<string, unknown>) : {};
    const before = params[param];
    params[param] = value;
    obj["params"] = params;
    const yamlStr = yaml.dump(obj, { lineWidth: 120, noRefs: true });
    const next = nextVersionLabel((await this.versionRows(name)).map((v) => v.version_label));
    await this.publishWorkflow(name, next, yamlStr, undefined, undefined, undefined, { source: "promote", actor });
    return { version: next, before, after: value };
  }

  // ── Reads: steps ───────────────────────────────────────────────────────

  private async stepRow(type: string): Promise<StepRow | null> {
    const d = this.d;
    const rows = await this.rows<StepRow>(
      `MATCH ${d.node("s", "StrutStep", { namespace: "$ns", step_type: "$type" })} WHERE ${d.live("s")} RETURN ${d.project("s", STEP_FIELDS)} AS p LIMIT 1`,
      { ns: this.ns, type },
    );
    return rows[0] ?? null;
  }

  private async stepVersionRows(type: string): Promise<StepVersionRow[]> {
    const d = this.d;
    const rows = await this.rows<StepVersionRow>(
      `MATCH ${d.node("v", "StrutStepVersion", { namespace: "$ns", step_type: "$type" })} WHERE ${d.live("v")}
       RETURN ${d.project("v", STEP_VERSION_FIELDS)} AS p`,
      { ns: this.ns, type },
    );
    return rows.sort(byCreation);
  }

  /** Every visible step with its active version's row (null when the
   *  pointer dangles). Helpers (`_`-prefixed segments) included. Two
   *  statements joined here (see `listWorkflows`). */
  private async stepsWithActive(): Promise<Array<{ step: StepRow; active: StepVersionRow | null }>> {
    const d = this.d;
    const steps = await this.rows<StepRow>(
      `MATCH ${d.node("s", "StrutStep", { namespace: "$ns" })} WHERE ${d.live("s")} RETURN ${d.project("s", STEP_FIELDS)} AS p`,
      { ns: this.ns },
    );
    const actives = await this.backend.query(
      `MATCH ${d.node("v", "StrutStepVersion", { namespace: "$ns" })}-[:VERSION_OF]->${d.node("s", "StrutStep", { namespace: "$ns" })}
       WHERE ${d.live("v")} AND ${d.live("s")} AND v.content_hash = s.active_version
       RETURN s.ref_id AS step, ${d.project("v", STEP_VERSION_FIELDS)} AS p`,
      { ns: this.ns },
    );
    const active = new Map(actives.map((r) => [String(r["step"]), compact(r["p"] as Record<string, unknown>) as unknown as StepVersionRow]));
    return steps
      .sort((a, b) => (a.step_type < b.step_type ? -1 : a.step_type > b.step_type ? 1 : 0))
      .map((step) => ({ step, active: active.get(step.ref_id) ?? null }));
  }

  private static isHelper(type: string): boolean {
    return type.split("/").some((seg) => seg.startsWith("_"));
  }

  async listSteps(filter?: { publisher?: string }): Promise<StepListEntry[]> {
    const out: StepListEntry[] = [];
    for (const { step, active } of await this.stepsWithActive()) {
      if (GraphWorkspaceStore.isHelper(step.step_type)) continue;
      if (filter?.publisher && step.publisher !== filter.publisher) continue;
      const upstream = parseJson<Upstream>(active?.upstream);
      out.push({
        type: step.step_type,
        description: active?.description,
        createdAt: active ? isoFromSeconds(active.created_at) : undefined,
        publisher: step.publisher,
        ...(upstream ? { upstream } : {}),
      });
    }
    return out;
  }

  async getActiveStepHashes(): Promise<Record<string, string>> {
    // `active_version` IS the active version's content hash (it mirrors the
    // ACTIVE_VERSION edge), so this is one read of the step nodes.
    const d = this.d;
    const rows = await this.backend.query(
      `MATCH ${d.node("s", "StrutStep", { namespace: "$ns" })} WHERE ${d.live("s")} AND s.active_version IS NOT NULL
       RETURN s.step_type AS type, s.active_version AS hash`,
      { ns: this.ns },
    );
    const out: Record<string, string> = {};
    for (const r of rows) if (typeof r["hash"] === "string" && r["hash"]) out[String(r["type"])] = r["hash"] as string;
    return out;
  }

  async listStepVersions(name: string): Promise<StepVersionsResult> {
    validateStepName(name);
    const s = await this.stepRow(name);
    if (!s) throw new Error(`Step "${name}" not found`);
    const versions = await this.stepVersionRows(name);
    return {
      active: versions.find((v) => v.content_hash === s.active_version)?.version_label ?? "",
      versions: versions.map((v) => v.version_label),
    };
  }

  async getStepMetadata(name: string): Promise<StepInfo | null> {
    validateStepName(name);
    const s = await this.stepRow(name);
    if (!s) return null;
    const out: StepInfo = { active: "", versions: {}, ...(s.publisher ? { publisher: s.publisher } : {}) };
    for (const v of await this.stepVersionRows(name)) {
      const upstream = parseJson<Upstream>(v.upstream);
      out.versions[v.version_label] = {
        createdAt: isoFromSeconds(v.created_at),
        ...(v.description !== undefined ? { description: v.description } : {}),
        hash: v.content_hash,
        ...(v.version_source ? { source: v.version_source } : {}),
        ...(v.actor ? { actor: v.actor } : {}),
        ...(upstream ? { upstream } : {}),
      };
      if (v.content_hash === s.active_version) out.active = v.version_label;
    }
    return out;
  }

  async getStepVersionSource(name: string, version: string): Promise<string> {
    validateStepName(name);
    const v = (await this.stepVersionRows(name)).find((x) => x.version_label === version);
    if (!v) throw new Error(`Version "${version}" of step "${name}" not found`);
    return v.source;
  }

  /** Written into the active-step scratch dir, beside the active steps it
   *  imports (`materializePinnedStep`) — materialized first, so they are
   *  there whoever calls. The sweep there keeps it while its step is live. */
  async materializeStepVersion(name: string, version: string): Promise<{ path: string; hash: string; upstream?: Upstream }> {
    validateStepName(name);
    const v = (await this.stepVersionRows(name)).find((x) => x.version_label === version);
    if (!v) throw new Error(`Version "${version}" of step "${name}" not found`);
    const dir = await this.materializeCustomSteps();
    const path = await materializePinnedStep(dir, name, version, v.content_hash, v.source);
    const upstream = parseJson<Upstream>(v.upstream);
    return { path, hash: v.content_hash, ...(upstream ? { upstream } : {}) };
  }

  /** Is an item of `prefix`'s package here — a live step, workflow or app
   *  version under `<prefix>/` that came from it? */
  private async installedUnder(prefix: string): Promise<boolean> {
    const d = this.d;
    for (const [type, field] of [["StrutWorkflowVersion", "name"], ["StrutStepVersion", "step_type"], ["StrutAppVersion", "name"]] as const) {
      const rows = await this.backend.query(
        `MATCH ${d.node("v", type, { namespace: "$ns" })} WHERE ${d.live("v")} AND v.${field} STARTS WITH $under AND v.upstream IS NOT NULL
         RETURN v.upstream AS upstream`,
        { ns: this.ns, under: `${prefix}/` },
      );
      if (fromPackage(prefix, rows.map((r) => ({ upstream: parseJson<Upstream>(r["upstream"] as string | undefined) })))) return true;
    }
    return false;
  }

  // ── Writes: steps ──────────────────────────────────────────────────────

  async publishStep(
    name: string,
    code: string,
    description?: string,
    publisher?: string,
    opts?: PublishByContentOptions,
  ): Promise<{ version: string; changed: boolean }> {
    validateStepName(name);
    const hash = contentHash(code);
    const { nodes } = this.backend;
    const existing = await this.stepRow(name);
    const versions = existing ? await this.stepVersionRows(name) : [];
    if (!existing) await refuseUnderInstalledPackage("step", name, opts, (prefix) => this.installedUnder(prefix));

    if (existing) {
      const match = versions.find((v) => v.content_hash === hash);
      if (match) {
        let changed = false;
        const desired: Record<string, unknown> = {};
        if (existing.active_version !== hash && opts?.reactivateKnown !== false && opts?.activate !== false) {
          desired["active_version"] = hash;
          desired["description"] = match.description;
          changed = true;
        }
        if (publisher !== undefined && existing.publisher !== publisher) desired["publisher"] = publisher;
        const patch = patchFor(existing as unknown as Record<string, unknown>, desired);
        if (patch) await nodes.update(existing.ref_id, patch);
        if (changed) await this.swapActiveEdge("StrutStep", existing.ref_id, "StrutStepVersion", match.ref_id);
        await this.fillDoor(match, opts);
        return { version: match.version_label, changed };
      }
    }

    const vid = nextVersionLabel(versions.map((v) => v.version_label));
    const upstream = upstreamFor(opts, parseJson<Upstream>(versions.find((v) => v.content_hash === existing?.active_version)?.upstream));
    const { source: version_source, actor } = provenance(opts);
    const v = await nodes.write({
      type: "StrutStepVersion",
      data: compact({
        step_type: name,
        content_hash: hash,
        version_label: vid,
        description,
        created_at: new Date().toISOString(),
        source: code,
        publisher: publisher ?? existing?.publisher,
        version_source,
        actor,
        upstream: upstream ? JSON.stringify(upstream) : undefined,
      }),
    });
    const move = !existing || opts?.activate !== false;
    let stepRef: string;
    if (!existing) {
      const s = await nodes.write({
        type: "StrutStep",
        data: compact({ step_type: name, description, publisher, active_version: hash }),
      });
      stepRef = s.ref_id;
    } else {
      stepRef = existing.ref_id;
      const desired: Record<string, unknown> = move ? { active_version: hash, description } : {};
      if (publisher !== undefined) desired["publisher"] = publisher;
      const patch = patchFor(existing as unknown as Record<string, unknown>, desired);
      if (patch) await nodes.update(stepRef, patch);
    }
    await this.backend.edges.write({ edge: "VERSION_OF", source_ref_id: v.ref_id, target_ref_id: stepRef });
    if (move) await this.swapActiveEdge("StrutStep", stepRef, "StrutStepVersion", v.ref_id);
    return { version: vid, changed: true };
  }

  async setActiveStepVersion(name: string, version: string): Promise<void> {
    validateStepName(name);
    const s = await this.stepRow(name);
    if (!s) throw new Error(`Step "${name}" not found`);
    const versions = await this.stepVersionRows(name);
    const v = versions.find((x) => x.version_label === version);
    if (!v) {
      throw new Error(
        `Version "${version}" not found for step "${name}". Available: ${versions.map((x) => x.version_label).join(", ")}`,
      );
    }
    const patch = patchFor(s as unknown as Record<string, unknown>, { active_version: v.content_hash, description: v.description });
    if (patch) await this.backend.nodes.update(s.ref_id, patch);
    await this.swapActiveEdge("StrutStep", s.ref_id, "StrutStepVersion", v.ref_id);
  }

  async deleteStep(name: string): Promise<boolean> {
    validateStepName(name);
    const s = await this.stepRow(name);
    if (!s) return false;
    for (const v of await this.stepVersionRows(name)) await this.backend.nodes.softDelete(v.ref_id);
    await this.backend.nodes.softDelete(s.ref_id);
    return true;
  }

  async deleteStepsByPublisher(publisher: string): Promise<string[]> {
    const names = (await this.stepsWithActive())
      .filter(({ step }) => step.publisher === publisher)
      .map(({ step }) => step.step_type);
    for (const n of names) await this.deleteStep(n);
    return names;
  }

  // ── Apps (plans/apps.md §1.3) ──────────────────────────────────────────
  //
  // `StrutApp` and `StrutAppVersion`, `VERSION_OF` + `ACTIVE_VERSION` as the
  // workflow and step pairs, and `USES_WORKFLOW` from a version to each
  // workflow its grants name — the pointers. The files are under `appsDir`
  // (`<dataDir>/apps`), never on a node. Versions are content-addressed by
  // the TREE hash, labelled `vN` like the others.

  private async appRow(name: string): Promise<AppRow | null> {
    const d = this.d;
    const rows = await this.rows<AppRow>(
      `MATCH ${d.node("a", "StrutApp", { namespace: "$ns", name: "$name" })} WHERE ${d.live("a")} RETURN ${d.project("a", APP_FIELDS)} AS p LIMIT 1`,
      { ns: this.ns, name },
    );
    return rows[0] ?? null;
  }

  private async appVersionRows(name: string): Promise<AppVersionRow[]> {
    const d = this.d;
    const rows = await this.rows<AppVersionRow>(
      `MATCH ${d.node("v", "StrutAppVersion", { namespace: "$ns", name: "$name" })} WHERE ${d.live("v")} RETURN ${d.project("v", APP_VERSION_FIELDS)} AS p`,
      { ns: this.ns, name },
    );
    return rows.sort(byCreation);
  }

  /** The record an `AppMetadata` reader expects, from the rows. */
  private appMetadata(app: AppRow, versions: AppVersionRow[]): AppMetadata | null {
    const out: AppMetadata = { active: "", versions: {} };
    for (const v of versions) {
      const manifest = parseJson<AppManifest>(v.manifest);
      if (!manifest || !v.version_label) continue;
      const upstream = parseJson<Upstream>(v.upstream);
      const info: AppVersionInfo = {
        createdAt: isoFromSeconds(v.created_at),
        hash: v.content_hash,
        manifest,
        ...(v.publisher ? { publisher: v.publisher } : {}),
        ...(v.version_source ? { source: v.version_source } : {}),
        ...(v.actor ? { actor: v.actor } : {}),
        ...(upstream ? { upstream } : {}),
      };
      out.versions[v.version_label] = info;
      if (v.content_hash === app.active_version) out.active = v.version_label;
    }
    if (app.publisher) out.publisher = app.publisher;
    if (app.owner) out.owner = app.owner;
    if (app.pinned) out.pinned = true;
    const releases = parseJson<AppRelease[]>(app.releases);
    if (releases?.length) out.releases = releases;
    if (app.live) out.live = app.live;
    return Object.keys(out.versions).length ? out : null;
  }

  async listApps(): Promise<AppListEntry[]> {
    const d = this.d;
    const apps = await this.rows<AppRow>(
      `MATCH ${d.node("a", "StrutApp", { namespace: "$ns" })} WHERE ${d.live("a")} RETURN ${d.project("a", APP_FIELDS)} AS p`,
      { ns: this.ns },
    );
    const out: AppListEntry[] = [];
    for (const a of apps.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
      const meta = this.appMetadata(a, await this.appVersionRows(a.name));
      const active = meta?.versions[meta.active];
      if (!meta || !active) continue;
      out.push(appListEntry(a.name, meta, active));
    }
    return out;
  }

  async getApp(name: string, version?: string): Promise<AppRecord | null> {
    validateAppName(name);
    const a = await this.appRow(name);
    if (!a) return null;
    const meta = this.appMetadata(a, await this.appVersionRows(name));
    if (!meta) return null;
    const label = version ?? meta.active;
    const info = meta.versions[label];
    return info ? appRecord(name, meta, label, info) : null;
  }

  async publishApp(name: string, hash: string, manifest: AppManifest, opts?: PublishAppOptions): Promise<{ version: string; changed: boolean }> {
    validateAppName(name);
    const { nodes } = this.backend;
    const existing = await this.appRow(name);
    if (!existing) await refuseUnderInstalledPackage("app", name, opts, (prefix) => this.installedUnder(prefix));
    const versions = existing ? await this.appVersionRows(name) : [];
    const owner = opts?.owner ?? opts?.actor;

    if (existing) {
      const match = versions.find((v) => v.content_hash === hash);
      if (match) {
        let changed = false;
        const desired: Record<string, unknown> = {};
        if (existing.active_version !== hash && opts?.reactivateKnown !== false && opts?.activate !== false && !existing.live) {
          const m = parseJson<AppManifest>(match.manifest);
          Object.assign(desired, { active_version: hash, title: m?.title, description: m?.description });
          changed = true;
        }
        if (opts?.publisher !== undefined && existing.publisher !== opts.publisher) desired["publisher"] = opts.publisher;
        if (!existing.owner && owner) desired["owner"] = owner;
        const patch = patchFor(existing as unknown as Record<string, unknown>, desired);
        if (patch) await nodes.update(existing.ref_id, patch);
        if (changed) await this.swapActiveEdge("StrutApp", existing.ref_id, "StrutAppVersion", match.ref_id);
        return { version: match.version_label, changed };
      }
    }

    const upstream = upstreamFor(opts, parseJson<Upstream>(versions.find((v) => v.content_hash === existing?.active_version)?.upstream));
    const vid = nextVersionLabel(versions.map((v) => v.version_label));
    const publisher = opts?.publisher ?? existing?.publisher;
    const v = await nodes.write({
      type: "StrutAppVersion",
      data: compact({
        name,
        content_hash: hash,
        version_label: vid,
        description: manifest.description,
        created_at: new Date().toISOString(),
        manifest: JSON.stringify(manifest),
        publisher,
        version_source: opts?.source,
        actor: opts?.actor,
        upstream: upstream ? JSON.stringify(upstream) : undefined,
      }),
    });
    let appRef: string;
    if (!existing) {
      const a = await nodes.write({
        type: "StrutApp",
        data: compact({ name, title: manifest.title, description: manifest.description, publisher, owner, active_version: hash }),
      });
      appRef = a.ref_id;
    } else {
      appRef = existing.ref_id;
      // Held (or `activate: false`), the new version is a draft: `active` stays.
      const desired: Record<string, unknown> = existing.live || opts?.activate === false ? {} : { active_version: hash, title: manifest.title, description: manifest.description };
      if (publisher !== undefined) desired["publisher"] = publisher;
      if (!existing.owner && owner) desired["owner"] = owner;
      const patch = patchFor(existing as unknown as Record<string, unknown>, desired);
      if (patch) await nodes.update(appRef, patch);
    }
    await this.backend.edges.write({ edge: "VERSION_OF", source_ref_id: v.ref_id, target_ref_id: appRef });
    if (!existing || (!existing.live && opts?.activate !== false)) await this.swapActiveEdge("StrutApp", appRef, "StrutAppVersion", v.ref_id);
    // USES_WORKFLOW → every workflow the grants name that the graph holds.
    const names = [...new Set(manifest.grants.workflows)];
    if (names.length) {
      const d = this.d;
      const rows = await this.backend.query(
        `MATCH ${d.node("w", "StrutWorkflow", { namespace: "$ns" })} WHERE w.name IN $names AND ${d.live("w")} RETURN w.ref_id AS ref_id`,
        { ns: this.ns, names },
      );
      for (const r of rows) await this.backend.edges.write({ edge: "USES_WORKFLOW", source_ref_id: v.ref_id, target_ref_id: r["ref_id"] as string });
    }
    return { version: vid, changed: true };
  }

  async setActiveAppVersion(name: string, version: string): Promise<void> {
    validateAppName(name);
    const a = await this.appRow(name);
    if (!a) throw new Error(`App "${name}" not found`);
    const versions = await this.appVersionRows(name);
    const v = versions.find((x) => x.version_label === version);
    if (!v) throw new Error(`Version "${version}" not found for app "${name}". Available: ${versions.map((x) => x.version_label).join(", ")}`);
    await this.pointAppAt(a, v, null);
  }

  /** Move `active` (and `ACTIVE_VERSION`) to a version and set `live` —
   *  null clears it — writing `releases` when given. */
  private async pointAppAt(a: AppRow, v: AppVersionRow, live: string | null, releases?: AppRelease[]): Promise<void> {
    const m = parseJson<AppManifest>(v.manifest);
    const patch = patchFor(a as unknown as Record<string, unknown>, {
      active_version: v.content_hash,
      title: m?.title,
      description: m?.description,
      live,
      ...(releases ? { releases: JSON.stringify(releases) } : {}),
    });
    if (patch) await this.backend.nodes.update(a.ref_id, patch);
    await this.swapActiveEdge("StrutApp", a.ref_id, "StrutAppVersion", v.ref_id);
  }

  async addAppRelease(name: string, release: { version: string; lock: AppLock; createdAt?: string; by?: string }): Promise<AppRelease> {
    validateAppName(name);
    const a = await this.appRow(name);
    if (!a) throw new Error(`App "${name}" not found`);
    const v = (await this.appVersionRows(name)).find((x) => x.version_label === release.version);
    if (!v) throw new Error(`Version "${release.version}" not found for app "${name}"`);
    const releases = parseJson<AppRelease[]>(a.releases) ?? [];
    const made = newRelease(releases, release);
    await this.pointAppAt(a, v, made.id, [...releases, made]);
    return made;
  }

  async setAppLive(name: string, live: string | null): Promise<void> {
    validateAppName(name);
    const a = await this.appRow(name);
    if (!a) throw new Error(`App "${name}" not found`);
    const versions = await this.appVersionRows(name);
    let label: string;
    if (live === null) {
      label = newestVersion(versions.map((x) => x.version_label));
    } else {
      const r = (parseJson<AppRelease[]>(a.releases) ?? []).find((x) => x.id === live);
      if (!r) throw new Error(`Release "${live}" not found for app "${name}"`);
      label = r.version;
    }
    const v = versions.find((x) => x.version_label === label);
    if (!v) throw new Error(`Version "${label}" not found for app "${name}"`);
    await this.pointAppAt(a, v, live);
  }

  async setAppPinned(name: string, pinned: boolean): Promise<void> {
    validateAppName(name);
    const a = await this.appRow(name);
    if (!a) throw new Error(`App "${name}" not found`);
    if (pinned && !a.pinned) await this.backend.nodes.update(a.ref_id, { set: { pinned: true } });
    if (!pinned && a.pinned != null) await this.backend.nodes.update(a.ref_id, { remove: ["pinned"] });
  }

  /** Soft, like `deleteWorkflow`: the stamps that would ride along on a
   *  restore are cleared first, then the nodes are marked. */
  async deleteApp(name: string): Promise<boolean> {
    validateAppName(name);
    const a = await this.appRow(name);
    if (!a) return false;
    const remove = (["owner", "publisher", "pinned", "title", "description", "active_version", "live", "releases"] as const).filter((k) => a[k] != null);
    if (remove.length) await this.backend.nodes.update(a.ref_id, { remove: [...remove] });
    for (const v of await this.appVersionRows(name)) await this.backend.nodes.softDelete(v.ref_id);
    await this.backend.nodes.softDelete(a.ref_id);
    return true;
  }

  async materializeAppVersion(name: string, version: string): Promise<{ path: string; hash: string }> {
    validateAppName(name);
    const v = (await this.appVersionRows(name)).find((x) => x.version_label === version);
    if (!v) throw new Error(`Version "${version}" of app "${name}" not found`);
    return { path: appVersionDir(this.appsDir, name, version), hash: v.content_hash };
  }

  // ── Step source + code loading ─────────────────────────────────────────

  async getStepSource(type: string): Promise<{ code: string; origin: StepSource } | null> {
    const s = await this.stepRow(type);
    if (s) {
      const v = (await this.stepVersionRows(type)).find((x) => x.content_hash === s.active_version);
      if (v) return { code: v.source, origin: "custom" };
    }
    // Core + lib ship with the engine; a non-existent custom dir keeps the
    // disk reader from ever serving a stale materialized file as "custom".
    return readStepSourceFromDisk(type, join(this.materializeDir, ".none"));
  }

  /**
   * Write every active custom step (helpers included) to the scratch dir as
   * `<name>.ts`, skipping unchanged files and deleting files for steps that
   * are no longer in the graph, so the loader never imports a stale step —
   * a pinned version's file (`materializeStepVersion`) goes with its step.
   * Cheap to call on every registry rebuild.
   */
  async materializeCustomSteps(): Promise<string> {
    const dir = this.materializeDir;
    await mkdir(dir, { recursive: true });
    await ensureEsmScope(dir);
    const wanted = new Map<string, string>();
    const live = new Set<string>();
    for (const { step, active } of await this.stepsWithActive()) {
      live.add(join(dir, `${step.step_type}.ts`));
      if (active) wanted.set(join(dir, `${step.step_type}.ts`), active.source);
    }
    for (const [file, code] of wanted) {
      let current: string | null = null;
      try {
        current = await readFile(file, "utf-8");
      } catch {
        // absent
      }
      if (current !== code) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, code, "utf-8");
      }
    }
    for (const file of await walkTs(dir)) {
      if (!wanted.has(file) && !live.has(pinnedStepFileOf(file) ?? "")) await rm(file, { force: true });
    }
    return dir;
  }
}

async function walkTs(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkTs(full)));
    else if (e.isFile() && e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** The class's first name, kept for hosts that import it (mcp's `createLabStrut`). */
export { GraphWorkspaceStore as Neo4jWorkspaceStore };
export type Neo4jWorkspaceStoreOptions = GraphWorkspaceStoreOptions;
