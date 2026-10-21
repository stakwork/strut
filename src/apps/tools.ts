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
 * or a `StrutWorkflow` node); `sqlite/*` and `automation/*` not available
 * until their work items land. The call runs through `runStep` with the
 * viewer as actor and `ctx.app` set, so a run `run/launch` starts carries
 * the app too. A write — a graph write, an error report — is KEPT under
 * `step:<type>` with the actor and `app` on its summary (§9); a read is
 * not. Results are whole data, never trimmed for a model; past 5 MB they
 * are an error naming the cap.
 *
 * A JOB's app (§6) calls through the same tool: its identity is the job's
 * file token narrowed to the app's directory (`jobAppIdentity`), its
 * manifest is read from `<job dir>/<path>/app.yaml` at each call (one live
 * directory, no versions), and `ctx.app` is `{ job, path }`. A model wrote
 * its grants, and the call-time refusals above are the meta surface's
 * rules. On top of them every job app holds its OWN JOB, implicitly: its
 * runs (`run/list { job }`; `run/get`, `run/events`, `run/transcript`,
 * `run/files` on a run launched under it), its files (`run/files { job,
 * path }`, `job/read`) and its record (`job/get`) — of that job only,
 * never another's, whatever the manifest says.
 */
import { z } from "zod";
import { tool, type ToolSet } from "ai";
import { appOfIdentity } from "../auth.js";
import { globToRegExp } from "../closure.js";
import { isJobApp, type AppRef, type JobAppRef, type StepRegistry } from "../core.js";
import type { GraphReader } from "../graph/search.js";
import { jobFilePath, jobRoot } from "../jobs.js";
import type { RunStore } from "../store.js";
import { runStep, type RunStepDeps } from "../run-step.js";
import { isSealedStep } from "../sealed.js";
import { baseType } from "../step-ref.js";
import { resolveStep } from "../steps/registry.js";
import type { AppsCapability } from "./apps.js";
import { readManifest, type AppManifest } from "./manifest.js";

export const STEP_RUN_TOOL = "step_run";

/** The side map `toolsetServer` lists with the tool: an app-only tool. */
export const APP_TOOL_META: Record<string, Record<string, unknown>> = {
  [STEP_RUN_TOOL]: { ui: { visibility: ["app"] } },
};

/** A result over this is an error naming the cap (§5). */
export const STEP_RUN_RESULT_MAX_CHARS = 5 * 1024 * 1024;

/** Refused at call time whatever the manifest says (§5.1, §9): a paid or
 *  shell-shaped step runs inside a workflow the app launches. */
export const PAID_OR_SHELL: ReadonlyArray<string> = ["llm", "agent", "exec", "acp/prompt"];

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
  "graph/register-namespace": "an app writes in the workspace's namespace; a page registers none",
  "graph/project": "projecting runs into the graph is the server's own pass",
  "app/init": "an app does not author apps — the builder does, with the editor",
  "app/checkout": "an app does not author apps — the builder does, with the editor",
  "app/build": "an app does not author apps — the builder does, with the editor",
  "app/publish": "an app does not author apps — the builder does, with the editor",
  "job/dir": "a job's directory belongs to a run of the job",
};

/** Families this strut does not serve to an app yet, by work item. */
const NOT_YET: Array<[prefix: string, what: string]> = [
  ["sqlite/", "an app's own SQLite file is plans/apps.md work item 3"],
  ["automation/", "schedules from an app are plans/apps.md work item 7"],
  ["job/start", "a job's turn starts from its host, not a page — a \"continue this job\" door is later (plans/apps.md §12)"],
  ["job/continue", "a job's turn starts from its host, not a page — a \"continue this job\" door is later (plans/apps.md §12)"],
];

/** The reads of ONE run a job's app holds on the runs of its own job (§6),
 *  whatever `grants.workflows` says. */
export const JOB_RUN_READS: ReadonlySet<string> = new Set(["run/get", "run/events", "run/transcript", "run/files"]);

/** A job's own record and files, granted to that job's app implicitly. */
const JOB_READS: ReadonlySet<string> = new Set(["job/get", "job/read"]);

/** Always granted: the page's own door for its failures (§8). */
export const ALWAYS_GRANTED: ReadonlySet<string> = new Set(["app/report-error"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hasTemplate = (v: unknown): boolean => typeof v === "string" && v.includes("{{");

/** Does a grant list (types and globs, as `agentTools` takes them) reach a type? */
export function granted(list: readonly string[], type: string): boolean {
  return list.some((g) => (g.includes("*") ? globToRegExp(g).test(type) : g === type));
}

/**
 * The grant check, pure: the reason a call is refused, or null. `type` is
 * the bare type. `app` is who calls: a job's app holds its own job beyond
 * its manifest (§6). The graph-write TYPE check is `graphWriteRefusal` (it
 * reads nodes), and a job app's read of one of its job's runs on an
 * ungranted workflow is `appCallRefusal`'s (it reads the run).
 */
export function grantRefusal(type: string, config: Record<string, unknown>, manifest: AppManifest, registry: StepRegistry, app?: AppRef): string | null {
  if (ALWAYS_GRANTED.has(type)) return null;
  if (PAID_OR_SHELL.includes(type) || PAID_OR_SHELL.some((p) => p.endsWith("/*") && type.startsWith(p.slice(0, -1)))) {
    return `"${type}" is a paid or shell-shaped step: a page never calls it, whatever the manifest grants — put it in a workflow and launch that (run/launch), the workflow is the unit of spend (plans/apps.md §5.1)`;
  }
  if (isSealedStep(type, registry)) return `"${type}" is sealed — nothing an app calls (plans/apps.md §9)`;
  for (const [prefix, what] of NOT_YET) if (type === prefix || type.startsWith(prefix)) return `"${type}" is not available in this strut yet: ${what}`;
  const never = NOT_A_PAGES[type];
  if (never) return `"${type}" is not a thing a page does: ${never}`;
  const own = app && isJobApp(app) ? app.job : undefined;
  const job = config["job"];
  if (job !== undefined && (typeof job !== "string" || hasTemplate(job))) return `${type}: \`job\` must be a literal job id, not a template`;
  // A job's app reads its own job, whatever the manifest says — and no
  // other job, whatever it says (§6).
  if (JOB_READS.has(type) && own !== undefined) {
    return job === own ? null : `${type}: a job's app reads its own job (${own}) and no other — \`job: "${own}"\``;
  }
  if (type.startsWith("run/")) {
    const wf = config["workflow"];
    if (job !== undefined) {
      if (type === "run/launch") return `run/launch with \`job\`: a page does not launch a job's turn — its host does (plans/apps.md §12)`;
      if (own !== undefined && job !== own) return `${type}: a job's app reads its own job (${own}) and no other`;
      // A job's own runs and files: the job app's, implicitly.
      if (own !== undefined && (type === "run/list" || (type === "run/files" && wf === undefined))) return null;
      if (type === "run/files" && wf === undefined) return `run/files { job, path }: a job's files are its own app's to read`;
    }
    if (typeof wf !== "string" || !wf) return `${type} needs \`workflow\`${own !== undefined && type === "run/list" ? " (or `job`: your own job's runs)" : ""}`;
    if (hasTemplate(wf)) return `${type}: \`workflow\` must be a literal name, not a template`;
    if (!manifest.grants.workflows.includes(wf)) {
      return `workflow "${wf}" is not granted to this app — its grants.workflows: ${manifest.grants.workflows.length ? manifest.grants.workflows.join(", ") : "(none)"}`;
    }
    return null;
  }
  if (!granted(manifest.grants.steps, type)) {
    return `step "${type}" is not granted to this app — its grants.steps: ${manifest.grants.steps.length ? manifest.grants.steps.join(", ") : "(none)"}`;
  }
  return null;
}

/**
 * The whole check before dispatch, the reads it needs included: the pure
 * `grantRefusal`, except that a job's app reading ONE run of its own job
 * (`JOB_RUN_READS` with `workflow` + `runId`) passes on an ungranted
 * workflow once the run is found to be its job's (`runJobOf`).
 */
export async function appCallRefusal(
  type: string,
  config: Record<string, unknown>,
  manifest: AppManifest,
  registry: StepRegistry,
  app: AppRef,
  runJobOf: (workflow: string, runId: string) => Promise<string | undefined>,
): Promise<string | null> {
  const refused = grantRefusal(type, config, manifest, registry, app);
  if (!refused || !isJobApp(app) || !JOB_RUN_READS.has(type)) return refused;
  const wf = config["workflow"];
  const runId = config["runId"];
  if (typeof wf !== "string" || !wf || hasTemplate(wf) || typeof runId !== "string" || !runId || hasTemplate(runId)) return refused;
  if (manifest.grants.workflows.includes(wf)) return refused;
  if ((await runJobOf(wf, runId).catch(() => undefined)) === app.job) return null;
  return `${refused} — nor is run ${runId} one of this app's job (${app.job})`;
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
    if (!declared.includes(t)) {
      return `a graph write on "${t}" is refused: this app declares ${declared.length ? declared.join(", ") : "no graph types"} (app.yaml data.graph.types) — an app writes only the types it declares (plans/apps.md §4.3)`;
    }
  }
  return null;
}

/** Is this a write the door KEEPS as a step run (§9)? */
export function keptFromApp(type: string): boolean {
  return GRAPH_WRITES.has(type) || type === "app/report-error";
}

export interface AppToolDeps {
  apps: AppsCapability;
  registry: StepRegistry;
  /** The services bag the step runs against (`ctx.services`). */
  services: unknown;
  /** The connection's actor: the viewer, who the call runs as and who pays. */
  actor?: string;
  /** The graph's reader, for the node reads a write check needs. Default:
   *  the bag's `graph`, when the server wired one. */
  reader?: Pick<GraphReader, "getNode">;
  /** `runStep`'s deps: the real store (kept runs), the workspace, claims, the verify trigger. */
  runStepDeps: RunStepDeps;
  /** The job a run was launched under, for a job app's implicit grant on
   *  its own job's runs. Default: the run's summary, else its `run.start`,
   *  in `runStepDeps.store`. */
  runJobOf?: (workflow: string, runId: string) => Promise<string | undefined>;
  /** The server's data directory, where a job's directory is (`jobRoot`).
   *  Default: the bag's `dataDir`. */
  dataDir?: string;
}

/** The job a run was launched under, off the store: the summary's `job`,
 *  else (in flight) its `run.start`'s. */
export function runJobFromStore(store: Pick<RunStore, "getRunSummary" | "getRunEvents">) {
  return async (workflow: string, runId: string): Promise<string | undefined> => {
    const summary = await store.getRunSummary(workflow, runId);
    if (summary) return summary.job;
    return (await store.getRunEvents(workflow, runId)).find((e) => e.type === "run.start")?.job;
  };
}

/** The app a call names, with its manifest — or why there is none. A job's
 *  app is read from the job's directory at each call: one live directory. */
async function appOf(app: AppRef, deps: AppToolDeps): Promise<{ manifest: AppManifest } | { error: string }> {
  if (!isJobApp(app)) {
    const view = await deps.apps.get(app.name, app.version).catch(() => null);
    return view ? { manifest: view.manifest } : { error: `step_run: no app ${app.name}@${app.version} on this strut` };
  }
  const dataDir = deps.dataDir ?? (deps.services as { dataDir?: string } | undefined)?.dataDir;
  if (!dataDir) return { error: "step_run: a job's app needs the server's data directory" };
  let dir: string;
  try {
    dir = jobFilePath(jobRoot(dataDir, app.job), app.path);
  } catch (err) {
    return { error: `step_run: ${err instanceof Error ? err.message : String(err)}` };
  }
  const read = await readManifest(dir);
  if (!read.ok) return { error: `step_run: no app at ${app.path} in job ${app.job} — ${read.errors.join("; ")}` };
  return { manifest: read.manifest };
}

/** How an app is named in an error. */
const appLabel = (app: AppRef) => (isJobApp(app) ? `${app.path} in job ${app.job}` : `${app.name}@${app.version}`);

/** `{ step_run }` — the app tool set a door spreads beside its own. */
export function buildAppTools(deps: AppToolDeps): ToolSet {
  const reader = deps.reader ?? (deps.services as { graph?: { reader?: Pick<GraphReader, "getNode"> } } | undefined)?.graph?.reader;
  const runJobOf = deps.runJobOf ?? runJobFromStore(deps.runStepDeps.store);
  return {
    [STEP_RUN_TOOL]: tool({
      description:
        "An APP's one tool (plans/apps.md §5): run one registry step under the app's grants, as the viewer. `type` is the step (run/list, run/get, run/events, run/transcript, run/launch, run/cancel, run/workflow, run/files on a granted workflow; graph/* and any step grants.steps names; app/report-error always; a job's app also its own job — run/list { job }, a run of it, run/files { job, path }, job/get, job/read), " +
        "`config` its fields, `input` the scope its {{ input.* }} templates read, `app` the app's identity — the token the served document carries in <meta name=\"strut-app-token\">. " +
        "A refused call is an error naming the grant; a step's own failure is an error with its message. The result is the step's whole output.",
      inputSchema: z.object({
        type: z.string().describe("The step type."),
        config: z.record(z.string(), z.any()).optional().describe("The step's config (its fields)."),
        input: z.any().optional().describe("The scope the config's {{ input.* }} templates read."),
        app: z.string().describe("The app's identity: the content of the document's <meta name=\"strut-app-token\">."),
      }),
      execute: async ({ type, config, input, app: identity }) => {
        const app = appOfIdentity(identity);
        if (!app) return { error: "step_run: `app` is not a valid app identity — the token the served document carries in <meta name=\"strut-app-token\">; a token for a run's or a job's whole files, a forged or unsigned one, opens nothing" };
        const found = await appOf(app, deps);
        if ("error" in found) return found;
        const cfg = isRecord(config) ? config : {};
        const base = baseType(type);
        const refused = await appCallRefusal(base, cfg, found.manifest, deps.registry, app, runJobOf);
        if (refused) return { error: `step_run refused: ${refused}` };
        if (GRAPH_WRITES.has(base)) {
          const bad = await graphWriteRefusal(base, cfg, found.manifest, reader);
          if (bad) return { error: `step_run refused: ${bad}` };
        }
        if (!(await resolveStep(deps.registry, type).catch(() => null))) return { error: `step_run: step type "${type}" not found (${appLabel(app)})` };
        const ref: AppRef = isJobApp(app) ? { job: app.job, path: app.path } : { name: app.name, version: app.version };
        const result = await runStep(
          type,
          deps.registry,
          deps.services,
          {
            config: cfg,
            ...(input !== undefined ? { input } : {}),
            ...(deps.actor ? { actor: deps.actor, principal: deps.actor } : {}),
            app: ref,
            keep: keptFromApp(base),
            ...(deps.runStepDeps.workspace ? { workspace: deps.runStepDeps.workspace } : {}),
          },
          deps.runStepDeps,
        );
        if (result.status !== "success") {
          return { error: result.error?.message ?? (result.status === "cancelled" ? `${type} was cancelled` : `${type} failed`) };
        }
        const text = JSON.stringify(result.output ?? null) ?? "null";
        if (text.length > STEP_RUN_RESULT_MAX_CHARS) {
          return { error: `step_run: the result of ${type} is ${(text.length / 1024 / 1024).toFixed(1)} MB, over the ${STEP_RUN_RESULT_MAX_CHARS / 1024 / 1024} MB cap — ask for less (a limit, a skip, one file)` };
        }
        // Wrapped, so a step's own `error` field (a failed run's summary) is
        // never mistaken for the tool's failure (`mcpToolsFrom` reads the
        // raw output's `error`); `toModelOutput` unwraps it.
        return { result: JSON.parse(text) as unknown };
      },
      toModelOutput: ({ output }) => {
        const o = output as { error?: string; result?: unknown };
        if (o && typeof o === "object" && typeof o.error === "string") return { type: "error-json", value: { error: o.error } };
        return { type: "json", value: (o?.result ?? null) as never };
      },
    }),
  };
}
