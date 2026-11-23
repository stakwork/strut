/**
 * The ONE tool an app calls (plans/apps.md §5, §7.2, §9): `step_run { type,
 * config?, input?, app }`, served on both MCP doors as an APP-ONLY tool
 * (`_meta.ui.visibility: ["app"]` — hidden from a model, callable by a
 * page). Every host relays the frame's `tools/call` here as it is and
 * names nothing: `app` is the page's own identity, the file token the file
 * route wrote into its document (`appIdentity`, auth.ts), and the
 * connection's credential says who the viewer is.
 *
 * Before dispatch the call is checked against the app's manifest, in every
 * host, whatever the host checks: `run/*` only on `grants.workflows`, any
 * other type only when `grants.steps` names it (globs as `agentTools`
 * takes them); `llm`, `agent`, `exec` and a sealed step refused at CALL
 * time whatever the manifest says (the workflow is the unit of spend —
 * §5.1); a graph WRITE refused on a type the manifest's `data.graph` does
 * not declare — the type from the config for a create, the node read first
 * for an edit or delete by `ref_id` (so a page can never rewrite a Concept
 * or a `StrutWorkflow` node); `sqlite/*` only with `grants.sqlite`, on the
 * app's own database (`ctx.app`'s, src/apps/data.ts); `automation/*` not
 * available until its work item lands. A job id the page names is the APP's — kept
 * under `app/<name>/` (`scopeAppJobs`, plans/apps.md §12), where its
 * uploads (`job/upload`) and the runs it launches under the job meet. The
 * call runs through `runStep` with the
 * viewer as actor and `ctx.app` set, so a run `run/launch` starts carries
 * the app too. A write — a graph write, `sqlite/exec` or `sqlite/batch`, an
 * error report — is KEPT under
 * `step:<type>` with the actor and `app` on its summary (§9); a read is
 * not, and a WORKER's step (`worker: true`, the `task/*` steps of
 * plans/human-steps.md §5) never is: its lease and answer are the record.
 * A worker's step is also the only call whose bag carries the worker's
 * calls of the task store (`workerServices`, §9.2): the shared bag holds
 * the `human` step's `ensure` alone.
 * A PACKAGE's own `admin: true` app shown to an admin (`packageAdminOf`:
 * the connection holds full scope, and the version is the package's) gets
 * the admin's scope for that package's steps: the call's `secrets` is bound
 * to it (`adminSecrets`, src/capabilities.ts), so those steps' fence hands
 * them `secrets.deployment` for the names the package provides
 * (src/packages/fence.ts). No other step, call or run holds it.
 * Results are whole data, never trimmed for a model; past 5 MB they
 * are an error naming the cap. Every call of a known app — refused, failed
 * or run — is counted by the monitor (./monitor.ts): what an app costs the
 * server, and the warnings when it costs too much.
 *
 * A HOST's door (`AppToolDeps.host`, plans/people-and-hosts.md §3) serves
 * the same tool to a program that brings people to strut — the Sphinx
 * daemon — on `POST /mcp` with its host key. It has no page, so `app` is
 * the app's NAME and the call runs at the live version. It is checked
 * against the app's `hosts:` in place of its grants (`hostRefusal`), as the
 * account the host named (its person, or with `unlinked: true` the key's own
 * actor); the step reads `ctx.host`. The bag is the shared one alone — no
 * admin door, no worker's calls, nothing that pays or sends — the call is
 * never first-party, and the door keeps nothing (a step's own claim may).
 */
import { z } from "zod";
import { tool, type ToolSet } from "ai";
import { appOfIdentity } from "../auth.js";
import { globToRegExp } from "../closure.js";
import { adminSecrets, type SecretsCapability } from "../capabilities.js";
import type { AppRef, HostRef, StepRegistry } from "../core.js";
import type { GraphReader } from "../graph/search.js";
import type { GraphBackend } from "../graph/backend.js";
import { pinnedTo } from "../graph/scope.js";
import { runStep, type RunStepDeps } from "../run-step.js";
import { isSealedStep } from "../sealed.js";
import { APP_NAMESPACE, appScoped } from "../session-store.js";
import { baseType } from "../step-ref.js";
import { resolveStep } from "../steps/registry.js";
import type { AppsCapability } from "./apps.js";
import { isFirstPartyName, isPreviewLabel } from "./files.js";
import { reservedAppType } from "./graph-types.js";
import type { AppManifest } from "./manifest.js";
import type { AppCallStatus, AppMonitor } from "./monitor.js";

export const STEP_RUN_TOOL = "step_run";

/** The side map `toolsetServer` lists with the tool: an app-only tool. */
export const APP_TOOL_META: Record<string, Record<string, unknown>> = {
  [STEP_RUN_TOOL]: { ui: { visibility: ["app"] } },
};

/** A result over this is an error naming the cap (§5). */
export const STEP_RUN_RESULT_MAX_CHARS = 5 * 1024 * 1024;

/** Refused at call time whatever the manifest says (§5.1, §9): a paid or
 *  shell-shaped step runs inside a workflow the app launches. `remote/*`
 *  spend (or buy) the credit this strut holds at another strut
 *  (plans/paid-runs.md §10); `remote/list` only reads. */
export const PAID_OR_SHELL: ReadonlyArray<string> = ["llm", "agent", "image", "exec", "acp/prompt", "remote/run-workflow", "remote/call", "remote/buy-credit"];

/** The graph writes (§4.3): checked against the declared types. */
export const GRAPH_WRITES: ReadonlySet<string> = new Set([
  "graph/create-node",
  "graph/edit-node",
  "graph/create-triplet",
  "graph/create-batch-triplet",
  "graph/delete-edge",
  "graph/edit-edge",
  "graph/delete-node",
  "graph/move-node",
]);

/** What a page never does, grant or no grant: shape the graph, author an
 *  app or a job's directory — those are a builder's or a run's. */
const NOT_A_PAGES: Record<string, string> = {
  "graph/create-schema": "an app declares its graph types in app.yaml (data.graph); a page registers none",
  "graph/register-namespace": "an app writes in this server's namespace; a page registers none",
  "graph/set-namespace": "moving data between namespaces is the person's own act, on a proposal they accept",
  "graph/project": "projecting runs into the graph is the server's own pass",
  "graph/query": "raw Cypher reads past the types app.yaml declares — a page reads a type's nodes with graph/find, or launches a workflow that queries (run/launch)",
  "app/init": "an app does not author apps — the builder does, with the editor",
  "app/checkout": "an app does not author apps — the builder does, with the editor",
  "app/build": "an app does not author apps — the builder does, with the editor",
  "app/publish": "an app does not author apps — the builder does, with the editor",
  "app/pin": "which apps are tabs is the person's call — the builder pins one when they ask",
  "app/grant": "what an app may reach is a person's call, made on a proposal they approve",
  "job/dir": "a job's directory belongs to a run of the job",
  "job/start": "a page runs a workflow in its own job with run/launch { job } (plans/apps.md §12); job/start is an agent's door",
  "job/continue": "a page runs a workflow in its own job with run/launch { job } (plans/apps.md §12); job/continue is an agent's door",
  "channel/send": "a page sends with useChannel, over its host's socket (plans/app-channels.md); channel/send is for the app's own steps and workflows, which strut stamps as themselves",
  "channel/read": "a page reads with useChannel, over its host's socket (plans/app-channels.md); channel/read is for the app's own steps and workflows",
  "channel/derive": "a page that could derive a room's name could derive any room's: a gatekeeper step the app grants calls channel/derive and hands the name to the players it lets in (plans/app-channels.md §6)",
};

/** Families this strut does not serve to an app yet, by work item. */
const NOT_YET: Array<[prefix: string, what: string]> = [["automation/", "schedules from an app are plans/apps.md work item 7"]];

/** SQL on the app's own database (plans/apps.md §4.4). */
const SQLITE_PREFIX = "sqlite/";

/** Where an app's jobs live (plans/apps.md §12): a job id a page names is
 *  kept under `app/<name>/`, as a peer's is kept under `peer/` — so a
 *  model-written page never launches under, or reads, a job it did not
 *  start. Every version of the app shares them. */
export const APP_JOB_NAMESPACE = APP_NAMESPACE;

export function appJobPrefix(app: string): string {
  return `${APP_JOB_NAMESPACE}${app}/`;
}

/** `id` in the app's namespace — left as it is when it already is there:
 *  a page hands back the ids its results carry (`run/list`'s `job`). */
export function appJobId(app: string, id: string): string {
  return appScoped(app, id);
}

/** A page's config with its job ids in the app's namespace: `job` wherever
 *  a step takes one, and `job/list`'s `prefix`, which a page can narrow and
 *  never leave. */
export function scopeAppJobs(app: string, type: string, config: Record<string, unknown>): Record<string, unknown> {
  let out = config;
  if (typeof config["job"] === "string") out = { ...out, job: appJobId(app, config["job"]) };
  if (type === "job/list") out = { ...out, prefix: appJobId(app, typeof config["prefix"] === "string" ? config["prefix"] : "") };
  return out;
}

/** Always granted: the page's own door for its failures (§8), and its
 *  storage (`app/state`, ./state.ts) — a framed page has no other. */
export const ALWAYS_GRANTED: ReadonlySet<string> = new Set(["app/report-error", "app/state"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hasTemplate = (v: unknown): boolean => typeof v === "string" && v.includes("{{");

/** Does a grant list (types and globs, as `agentTools` takes them) reach a type? */
export function granted(list: readonly string[], type: string): boolean {
  return list.some((g) => (g.includes("*") ? globToRegExp(g).test(type) : g === type));
}

/**
 * The grant check, pure: the reason a call is refused, or null. `type` is
 * the bare type. The graph-write TYPE check is `graphWriteRefusal` (it
 * reads nodes).
 */
export function grantRefusal(
  type: string,
  config: Record<string, unknown>,
  manifest: AppManifest,
  registry: StepRegistry,
  /** The step types granted: the page's (`grants.steps`), or a host's (`hosts.<name>.steps`). */
  steps: readonly string[] = manifest.grants.steps,
): string | null {
  if (ALWAYS_GRANTED.has(type)) return null;
  if (PAID_OR_SHELL.includes(type) || PAID_OR_SHELL.some((p) => p.endsWith("/*") && type.startsWith(p.slice(0, -1)))) {
    return `"${type}" is a paid or shell-shaped step: a page never calls it, whatever the manifest grants — put it in a workflow and launch that (run/launch), the workflow is the unit of spend (plans/apps.md §5.1)`;
  }
  if (isSealedStep(type, registry)) return `"${type}" is sealed — nothing an app calls (plans/apps.md §9)`;
  for (const [prefix, what] of NOT_YET) if (type === prefix || type.startsWith(prefix)) return `"${type}" is not available in this strut server yet: ${what}`;
  const never = NOT_A_PAGES[type];
  if (never) return `"${type}" is not a thing a page does: ${never}`;
  const job = config["job"];
  if (job !== undefined && (typeof job !== "string" || hasTemplate(job))) return `${type}: \`job\` must be a literal job id, not a template`;
  // `grants.sqlite` is the grant; the step reaches `ctx.app`'s file alone.
  if (type.startsWith(SQLITE_PREFIX)) {
    return manifest.grants.sqlite ? null : `"${type}" runs on the app's own database, and this app does not grant it — app.yaml grants: { sqlite: true } (plans/apps.md §4.4)`;
  }
  if (type.startsWith("run/")) {
    const wf = config["workflow"];
    if (typeof wf !== "string" || !wf) return `${type} needs \`workflow\``;
    if (hasTemplate(wf)) return `${type}: \`workflow\` must be a literal name, not a template`;
    if (!manifest.grants.workflows.includes(wf)) {
      return `workflow "${wf}" is not granted to this app — its grants.workflows: ${manifest.grants.workflows.length ? manifest.grants.workflows.join(", ") : "(none)"}`;
    }
    return null;
  }
  // The account widget's worker section runs `task/me` and then offers Withdraw
  // (`task/withdraw`), so a page that grants the first grants the second: it
  // pays only the calling worker's own withdrawable balance to the address
  // their session carries (`msat` the one input), which gives the app nothing
  // new. The page's own list only: a host's list (`hosts.<name>.steps`) stays
  // exactly what it names.
  if (type === "task/withdraw" && steps === manifest.grants.steps && granted(steps, "task/me")) return null;
  if (!granted(steps, type)) {
    return `step "${type}" is not granted to this app — its grants.steps: ${steps.length ? steps.join(", ") : "(none)"}`;
  }
  return null;
}

/**
 * A HOST's call (plans/people-and-hosts.md §3), pure: the reason it is
 * refused, or null. The app's `hosts:` names this host and the step type
 * (globs as `grants.steps` takes them); an account nobody linked calls only
 * where it says `unlinked: true`; and what no caller of an app's tools does
 * holds as for a page (`grantRefusal` over the host's list: no paid or shell
 * step, nothing sealed, `run/*` on `grants.workflows` alone).
 */
export function hostRefusal(type: string, config: Record<string, unknown>, manifest: AppManifest, host: HostRef, registry: StepRegistry): string | null {
  const entry = manifest.hosts?.[host.name];
  if (!entry) return `this app's hosts: does not name "${host.name}" — a person lets a host call an app's tools in its app.yaml (hosts: { ${host.name}: { steps: [...] } })`;
  if (!granted(entry.steps, type)) return `step "${type}" is not one this app lets ${host.name} call — its hosts.${host.name}.steps: ${entry.steps.join(", ")}`;
  if (host.unlinked && !entry.unlinked) {
    return `not_linked: ${host.account} is not linked to a person on this strut server, and this app's hosts.${host.name} does not say unlinked: true`;
  }
  return grantRefusal(type, config, manifest, registry, entry.steps);
}

/** The node types a graph write touches, read from its config and — for a
 *  node named by `ref_id` — the graph. A string is a reason the write
 *  cannot be checked (and so is refused). */
export async function graphWriteTypes(
  type: string,
  config: Record<string, unknown>,
  reader: Pick<GraphReader, "getNode"> | undefined,
): Promise<Set<string> | string> {
  const types = new Set<string>();
  const literal = (field: string, v: unknown): string | null => {
    if (typeof v !== "string" || !v) return `${type}: \`${field}\` must be a string`;
    if (hasTemplate(v)) return `${type}: \`${field}\` must be a literal value, not a template — an app's write is checked by the types it touches`;
    return null;
  };
  const byRef = async (field: string, ref: unknown): Promise<string | null> => {
    const bad = literal(field, ref);
    if (bad) return bad;
    if (!reader) return `${type}: no graph to read \`${field}\` from — the node's type cannot be checked`;
    const node = await reader.getNode(ref as string);
    if (!node) return `${type}: no node ${ref} (\`${field}\`)`;
    if (!node.node_type) return `${type}: node ${ref} has no type`;
    types.add(node.node_type);
    return null;
  };
  const side = async (prefix: "source" | "target", c: Record<string, unknown>): Promise<string | null> => {
    const ref = c[`${prefix}_ref_id`];
    if (ref !== undefined) return byRef(`${prefix}_ref_id`, ref);
    const bad = literal(`${prefix}_type`, c[`${prefix}_type`]);
    if (bad) return bad;
    types.add(c[`${prefix}_type`] as string);
    return null;
  };
  let problem: string | null = null;
  switch (type) {
    case "graph/create-node":
      problem = literal("node_type", config["node_type"]);
      if (!problem) types.add(config["node_type"] as string);
      break;
    case "graph/edit-node":
    case "graph/delete-node":
      problem = await byRef("ref_id", config["ref_id"]);
      break;
    case "graph/move-node":
      problem = (await byRef("ref_id", config["ref_id"])) ?? (await byRef("to_ref_id", config["to_ref_id"]));
      if (!problem && config["from_ref_id"] !== undefined) problem = await byRef("from_ref_id", config["from_ref_id"]);
      break;
    case "graph/create-triplet":
      problem = (await side("source", config)) ?? (await side("target", config));
      break;
    case "graph/create-batch-triplet": {
      const list = config["triplets"];
      if (!Array.isArray(list) || !list.length) return `${type}: \`triplets\` must be a non-empty list`;
      for (const t of list) {
        if (!isRecord(t)) return `${type}: each triplet is an object`;
        problem = (await side("source", t)) ?? (await side("target", t));
        if (problem) break;
      }
      break;
    }
    case "graph/delete-edge":
    case "graph/edit-edge":
      if (config["edge_ref_id"] !== undefined) {
        return `${type}: locate the edge by its endpoints (source_ref_id + edge_type + target_ref_id) — an app's write is checked by the types it touches, and an edge ref names none`;
      }
      problem = (await byRef("source_ref_id", config["source_ref_id"])) ?? (await byRef("target_ref_id", config["target_ref_id"]));
      break;
    default:
      return `${type}: not a graph write this door knows`;
  }
  return problem ?? types;
}

/** The reason a graph write is refused on this app's declared types, or null. */
export async function graphWriteRefusal(
  type: string,
  config: Record<string, unknown>,
  manifest: AppManifest,
  reader: Pick<GraphReader, "getNode"> | undefined,
): Promise<string | null> {
  const declared = Object.keys(manifest.data?.graph?.types ?? {});
  const touched = await graphWriteTypes(type, config, reader);
  if (typeof touched === "string") return touched;
  for (const t of touched) {
    // Whatever an older manifest declares (./graph-types.ts).
    const reserved = reservedAppType(t);
    if (reserved) return `a graph write on "${t}" is refused: ${t} ${reserved} (plans/apps.md §4.3)`;
    // Case-blind, as the graph resolves a type: a node read back carries its live casing.
    if (!declared.some((d) => d.toLowerCase() === t.toLowerCase())) {
      return `a graph write on "${t}" is refused: this app declares ${declared.length ? declared.join(", ") : "no graph types"} (app.yaml data.graph.types) — an app writes only the types it declares (plans/apps.md §4.3)`;
    }
  }
  return null;
}

/** The writes on an app's own database (§4.4): kept, as a graph write is. */
export const SQLITE_WRITES: ReadonlySet<string> = new Set(["sqlite/exec", "sqlite/batch"]);

/** Is this a write the door KEEPS as a step run (§9)? A worker's step
 *  (`worker: true`) never is (plans/human-steps.md §5.2), whatever claims
 *  it carries: the door hands its run no claims reader either. */
export function keptFromApp(type: string, registry?: StepRegistry): boolean {
  if (registry?.[type]?.worker) return false;
  return GRAPH_WRITES.has(type) || SQLITE_WRITES.has(type) || type === "app/report-error";
}

export interface AppToolDeps {
  apps: AppsCapability;
  registry: StepRegistry;
  /** The services bag the step runs against (`ctx.services`). */
  services: unknown;
  /** The connection's actor: the viewer, who the call runs as and who pays. */
  actor?: string;
  /** The viewer is an ADMIN of this strut server: the connection came with
   *  its full scope (the deployment key, an admin's session) — never a
   *  member's session or a person token (plans/member-rights.md). Stamped
   *  on every call's `AppRef.admin`, and so on every run the page launches. */
  admin?: boolean;
  /** Services added to the bag for a FIRST-PARTY page's call shown to an
   *  ADMIN (`AppRef.firstParty` and `AppRef.admin`) and no other: the admin
   *  door the `earnings/*` steps go through (src/steps/lib/earnings/_door.ts),
   *  which pays out of the wallet. Never on the shared bag, so no workflow,
   *  agent or other page's step reaches it. */
  adminServices?: Record<string, unknown>;
  /** Services added to the bag for a WORKER's step (`worker: true`, the
   *  `task/*` steps) and no other: the worker's calls of the task store
   *  (plans/human-steps.md §5.2, §9.2), `{ tasks }`. Never on the shared
   *  bag, so no workflow step, agent tool, proposal or other page's step
   *  reaches them; the step itself takes the worker from the call's
   *  viewer. */
  workerServices?: Record<string, unknown>;
  /** The graph's reader, for the node reads a write check needs. Default:
   *  the bag's `graph`, when the server wired one. */
  reader?: Pick<GraphReader, "getNode">;
  /** `runStep`'s deps: the real store (kept runs), the workspace, claims, the verify trigger. */
  runStepDeps: RunStepDeps;
  /** Where every call is counted (./monitor.ts): what an app costs the server. */
  monitor?: Pick<AppMonitor, "record">;
  /** When the request reached strut (`Date.now()`, before the gate): a
   *  call's `doorMs` in the monitor's log is the time from here to its step. */
  arrivedAt?: number;
  /** A HOST's door (`POST /mcp` with a host key, plans/people-and-hosts.md
   *  §3): `app` names the app, every call is checked against its `hosts:`
   *  (`hostRefusal`), the step runs against `services` alone with `ctx.host`
   *  set, and the door keeps nothing. `actor` is the account's person, or
   *  its key's own actor when nobody linked it. `outcome` hears how each
   *  call ended: the door's HTTP status says it. */
  host?: { ref: HostRef; outcome?: (status: AppCallStatus) => void };
  /** A VISITOR's door (`POST /public/mcp`, plans/public-surface.md §5): the
   *  identity is the public view's (`publicAppOfIdentity`), every call is
   *  checked against the public view after the grants, nothing is kept,
   *  and `viewer` names the visitor for the monitor. */
  visitor?: {
    identity: (identity: unknown) => AppRef | undefined;
    refusal: (app: AppRef, type: string, config: Record<string, unknown>, manifest: AppManifest) => Promise<string | null>;
    viewer?: string;
    /** A SIGNED-IN visitor (plans/app-repos.md §5.1): its writes are KEPT
     *  as runs with its actor, so a row it wrote says who. */
    keep?: boolean;
    /** The bag one call runs against, when it depends on the call (a
     *  signed-in visitor's graph is writable for a write alone). Default:
     *  `services`. */
    services?: (app: AppRef, manifest: AppManifest, type: string) => unknown;
  };
}

/** The app a call names, with its manifest and whether the version is
 *  strut's seed — or why there is none. Asked on every call, so it is the
 *  record's manifest as the capability remembers it (`manifestOf`), never
 *  `get`: that one lists and hashes the version's files and scans the
 *  error reports. */
async function appOf(app: AppRef, deps: AppToolDeps): Promise<{ manifest: AppManifest; seeded: boolean; package?: string } | { error: string }> {
  if (isPreviewLabel(app.version)) {
    const preview = deps.apps.previewOf(app.name, app.version);
    return preview ? { manifest: preview.manifest, seeded: false } : { error: `step_run: the preview ${app.name}@${app.version} is no longer hosted — app/look { path } again` };
  }
  const found = await deps.apps.manifestOf(app.name, app.version).catch(() => null);
  return found ?? { error: `step_run: no app ${app.name}@${app.version} on this strut server` };
}

/**
 * Is this call a FIRST-PARTY page's (plans/jamie-app.md §3)? An app strut
 * ships — a `strut/` name (reserved: no other door publishes one) at a
 * version strut seeded — shown to a PERSON: a viewer with an actor, never a
 * visitor. Such a page acts with that person's own rights, what their
 * person token has: their sessions as they are, their jobs, their runs of
 * a sealed workflow whoever launched them, their proposals. The page's
 * grants still apply, and so does everything a page never does (paid or
 * shell steps, authoring, nothing past the viewer).
 */
export function firstPartyApp(app: AppRef, seeded: boolean, actor: string | undefined, visitor: boolean): boolean {
  return !visitor && !!actor && seeded && isFirstPartyName(app.name);
}

/** The package whose OWN admin app this call is, shown to an admin: an
 *  `admin: true` app the package installed (its version's `upstream`, under
 *  its prefix), on a connection with full scope (`AppRef.admin` — the one
 *  way strut knows an admin: a member's session never gets the app's files,
 *  and its call never has `admin`). Never a host's or a visitor's call, a
 *  preview, or a run the page launches (that one runs on the shared bag).
 *  Its steps, and that package's alone, get `secrets.deployment` for the
 *  names it provides (src/packages/fence.ts). */
export function packageAdminOf(app: AppRef, manifest: AppManifest, pkg: string | undefined): string | undefined {
  return app.admin === true && manifest.admin === true && pkg && !isPreviewLabel(app.version) ? pkg : undefined;
}

/** `services` with its `secrets` bound to `pkg`'s admin call (`adminSecrets`). */
export function packageAdminBag(services: unknown, pkg: string): unknown {
  const bag = (services ?? {}) as Record<string, unknown>;
  const secrets = bag["secrets"] as SecretsCapability | undefined;
  return secrets ? { ...bag, secrets: adminSecrets(secrets, pkg) } : services;
}

/** The bag of a first-party page's call shown to an admin: the admin doors
 *  beside the shared bag, WITHOUT the deployment's `onRunEvent`. What such a
 *  call reads is its routes' alone — a test's expected answer, a grader's
 *  note (plans/human-steps.md §7.9), the wallet — and its run's events carry
 *  it, so no listener of every run's events (a host's own, the events sink)
 *  is handed them, as a grader's run is handed none (src/tasks/grade-step.ts). */
export function adminBag(services: unknown, adminServices: Record<string, unknown>): Record<string, unknown> {
  const { onRunEvent: _events, ...rest } = (services ?? {}) as Record<string, unknown>;
  return { ...rest, ...adminServices };
}

/** A call's config with the fields its step lists in `redact` as
 *  `"[redacted]"`, as a run's events keep them (src/runner.ts). */
export function redactedConfig(registry: StepRegistry, type: string, config: unknown): unknown {
  const fields = registry[type]?.redact;
  if (!fields?.length || !isRecord(config)) return config;
  const out: Record<string, unknown> = { ...config };
  for (const f of fields) if (f in out) out[f] = "[redacted]";
  return out;
}

/** `{ step_run }` — the app tool set a door spreads beside its own. */
export function buildAppTools(deps: AppToolDeps): ToolSet {
  // As the `apps` reader where the host set `graphReaders` (src/graph/scope.ts).
  const wired = (deps.services as { graph?: GraphBackend } | undefined)?.graph;
  const reader = deps.reader ?? (pinnedTo(wired, "apps") ?? wired)?.reader;
  /** One call past the identity check: the grant checks, then the step.
   *  `status` and `bytes` are what the monitor counts. */
  const dispatch = async (
    app: AppRef,
    manifest: AppManifest,
    type: string,
    config: unknown,
    input: unknown,
    pkg?: string,
  ): Promise<{ out: { error: string } | { result: unknown }; status: AppCallStatus; bytes: number }> => {
    const refuse = (error: string) => ({ out: { error }, status: "refused" as const, bytes: 0 });
    const fail = (error: string) => ({ out: { error }, status: "error" as const, bytes: 0 });
    const cfg = isRecord(config) ? config : {};
    const base = baseType(type);
    const refused = deps.host ? hostRefusal(base, cfg, manifest, deps.host.ref, deps.registry) : grantRefusal(base, cfg, manifest, deps.registry);
    if (refused) return refuse(`step_run refused: ${refused}`);
    const closed = deps.visitor ? await deps.visitor.refusal(app, base, cfg, manifest) : null;
    if (closed) return refuse(`step_run refused: ${closed}`);
    // A host's call: the shared bag, and nothing beside it. A package's own
    // admin app shown to an admin: the shared bag, its `secrets` bound to
    // that package's admin call.
    const packageAdmin = deps.host || deps.visitor ? undefined : packageAdminOf(app, manifest, pkg);
    const shared = deps.host
      ? deps.services
      : deps.visitor?.services
        ? deps.visitor.services(app, manifest, base)
        : app.firstParty && app.admin && deps.adminServices
          ? adminBag(deps.services, deps.adminServices)
          : packageAdmin
            ? packageAdminBag(deps.services, packageAdmin)
            : deps.services;
    // A worker's call leaves nothing behind but its lease and answer: no
    // claims read, so nothing makes it a kept run. Its bag alone carries
    // the worker's calls of the task store.
    const worker = deps.registry[base]?.worker === true;
    const bag = worker && deps.workerServices && !deps.host ? { ...(shared as Record<string, unknown>), ...deps.workerServices } : shared;
    if (GRAPH_WRITES.has(base)) {
      // A per-call bag's own reader: what this caller may see of the graph.
      const own = deps.visitor?.services ? (bag as { graph?: GraphBackend } | undefined)?.graph?.reader : undefined;
      const bad = await graphWriteRefusal(base, cfg, manifest, own ?? reader);
      if (bad) return refuse(`step_run refused: ${bad}`);
    }
    const resolved = await resolveStep(deps.registry, type).catch(() => null);
    if (!resolved) return refuse(`step_run: step type "${type}" not found (${app.name}@${app.version})`);
    // A host's config the step cannot take is the host's mistake, not the
    // step failing: checked before it runs, so the door answers 400 and not
    // 500 (a host sends a 5xx again forever). With `input`, templates in the
    // config resolve first, so the runner checks it.
    if (deps.host && input === undefined) {
      const checked = resolved.def.input.safeParse(cfg);
      if (!checked.success) {
        const why = checked.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ");
        return { out: { error: `step_run: ${type} cannot take this config: ${why}` }, status: "invalid", bytes: 0 };
      }
    }
    const result = await runStep(
      type,
      deps.registry,
      bag,
      {
        // A first-party page's jobs are its viewer's own: never moved.
        config: app.firstParty ? cfg : scopeAppJobs(app.name, base, cfg),
        ...(input !== undefined ? { input } : {}),
        ...(deps.actor ? { actor: deps.actor, principal: deps.actor } : {}),
        app,
        ...(deps.host ? { host: deps.host.ref } : {}),
        // A host's call is kept only as a step's own claim keeps it.
        keep: !deps.host && (!deps.visitor || !!deps.visitor.keep) && keptFromApp(base, deps.registry),
        // The page gets the output alone.
        events: false,
        ...(deps.runStepDeps.workspace ? { workspace: deps.runStepDeps.workspace } : {}),
      },
      worker ? { ...deps.runStepDeps, claims: null } : deps.runStepDeps,
    );
    if (result.status !== "success") {
      return fail(result.error?.message ?? (result.status === "cancelled" ? `${type} was cancelled` : `${type} failed`));
    }
    const text = JSON.stringify(result.output ?? null) ?? "null";
    if (text.length > STEP_RUN_RESULT_MAX_CHARS) {
      return fail(`step_run: the result of ${type} is ${(text.length / 1024 / 1024).toFixed(1)} MB, over the ${STEP_RUN_RESULT_MAX_CHARS / 1024 / 1024} MB cap — ask for less (a limit, a skip, one file)`);
    }
    // Wrapped, so a step's own `error` field (a failed run's summary) is
    // never mistaken for the tool's failure (`mcpToolsFrom` reads the
    // raw output's `error`); `toModelOutput` unwraps it.
    return { out: { result: JSON.parse(text) as unknown }, status: "ok", bytes: text.length };
  };

  /** The app a call names and its manifest, or why there is none: a page's
   *  identity (its token, at its version), or for a host the app's name at
   *  its live version (never first-party, never an admin's). */
  const appOfCall = async (identity: string): Promise<{ app: AppRef; manifest: AppManifest; package?: string } | { error: string }> => {
    if (deps.host) {
      const live = await deps.apps.manifestOf(identity).catch(() => null);
      if (!live) return { error: `step_run: no app "${identity}" on this strut server — a host names the app by its name, such as strut/staff` };
      return { app: { name: identity, version: live.version }, manifest: live.manifest };
    }
    const named = deps.visitor ? deps.visitor.identity(identity) : appOfIdentity(identity);
    if (!named) return { error: "step_run: `app` is not a valid app identity — the token the served document carries in <meta name=\"strut-app-token\">; a token for a run's or a job's files, a forged or unsigned one, opens nothing" };
    const found = await appOf(named, deps);
    if ("error" in found) return found;
    const app: AppRef = {
      name: named.name,
      version: named.version,
      ...(firstPartyApp(named, found.seeded, deps.actor, !!deps.visitor) ? { firstParty: true as const } : {}),
      ...(deps.admin && !deps.visitor ? { admin: true as const } : {}),
    };
    return { app, manifest: found.manifest, ...(found.package ? { package: found.package } : {}) };
  };

  return {
    [STEP_RUN_TOOL]: tool({
      description: deps.host
        ? "A HOST's door to an app's tools (plans/people-and-hosts.md §3): run one step the app's hosts: lets this host call, as the account x-strut-account names. `app` is the app's name (its live version runs), `type` the step, `config` its fields. " +
          "A refused call is an error naming why; a step's own failure is an error with its message. The result is the step's whole output, and the call returns once the step finished."
        : "An APP's one tool (plans/apps.md §5): run one registry step under the app's grants, as the viewer. `type` is the step (run/list, run/get, run/events, run/transcript, run/launch, run/cancel, run/workflow, run/files, run/provenance on a granted workflow; graph/* and any step grants.steps names; sqlite/query, sqlite/exec, sqlite/batch on the app's own database when grants.sqlite; app/report-error and app/state always), " +
          "`config` its fields, `input` the scope its {{ input.* }} templates read, `app` the app's identity — the token the served document carries in <meta name=\"strut-app-token\">. " +
          "A refused call is an error naming the grant; a step's own failure is an error with its message. The result is the step's whole output.",
      inputSchema: z.object({
        type: z.string().describe("The step type."),
        config: z.record(z.string(), z.any()).optional().describe("The step's config (its fields)."),
        input: z.any().optional().describe("The scope the config's {{ input.* }} templates read."),
        app: z.string().describe(deps.host ? "The app's name, such as strut/staff." : "The app's identity: the content of the document's <meta name=\"strut-app-token\">."),
      }),
      execute: async ({ type, config, input, app: identity }) => {
        const found = await appOfCall(identity);
        if ("error" in found) {
          deps.host?.outcome?.("refused");
          return found;
        }
        const { app, manifest } = found;
        const started = Date.now();
        const call = await dispatch(app, manifest, type, config, input, found.package);
        deps.host?.outcome?.(call.status);
        // A preview is the builder looking: not what the app costs people.
        if (!isPreviewLabel(app.version)) deps.monitor?.record({
          app: app.name,
          version: app.version,
          type: baseType(type),
          // What the monitor keeps of a call (a failing or fanning-out
          // call's example) never holds a field its step redacts: a test's
          // expected answer (plans/human-steps.md §7.9), a typed secret.
          config: redactedConfig(deps.registry, baseType(type), config),
          ...(deps.visitor?.viewer ?? deps.actor ? { viewer: (deps.visitor?.viewer ?? deps.actor)! } : {}),
          status: call.status,
          ms: Date.now() - started,
          ...(deps.arrivedAt !== undefined ? { doorMs: Math.max(0, started - deps.arrivedAt) } : {}),
          bytes: call.bytes,
          ...("error" in call.out ? { error: call.out.error } : {}),
          // An anonymous visitor's call: no run is ever that visitor, so
          // none could read it back from the log.
          ...(deps.visitor && !deps.actor ? { log: false as const } : {}),
        });
        return call.out;
      },
      toModelOutput: ({ output }) => {
        const o = output as { error?: string; result?: unknown };
        if (o && typeof o === "object" && typeof o.error === "string") return { type: "error-json", value: { error: o.error } };
        return { type: "json", value: (o?.result ?? null) as never };
      },
    }),
  };
}
