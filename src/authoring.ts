import { join } from "node:path";
import type { RunEvent, RunResult, RunSummary, StepRegistry } from "./core.js";
import type { WorkspaceStore } from "./workspace.js";
import type { RunStore } from "./store.js";
import { generateRunId, stepRunKey, stepTypeOfRunKey } from "./store.js";
import { runWorkflow } from "./runner.js";
import { runStep, cassettePath, type RunStepResult } from "./run-step.js";
import { stepHashesFor } from "./closure.js";
import {
  toSubjectRef,
  type ClaimsAuthoring,
  type CheckSpecInput,
  type ClaimActor,
  type ClaimSpecInput,
  type SubjectInput,
} from "./claims-authoring.js";
import { CLAIMS_OFF } from "./claims-schemas.js";
import { stepLoadError } from "./steps/registry.js";
import type { CassetteMode } from "./cassette.js";
import type { SecretInfo } from "./secret-store.js";
import { lsSteps, searchSteps, readStepSource } from "./ai/stepHelpers.js";
import { stepSchemas } from "./ai/schemaHelpers.js";
import { validateWorkflowYaml, type ValidationResult } from "./validate.js";

/**
 * The AUTHORING core — the workspace's author/test/inspect operations, shared
 * by two consumers:
 *
 *   - the chat builder's AI tools (`ai/tools.ts`) — the human-supervised
 *     authoring surface; and
 *   - the `meta/*` lib steps — the same operations as REGISTRY STEPS, so an
 *     in-workflow agent (`agentTools: ["meta/*"]`) can author, test, and
 *     inspect candidate workflows from inside a run (EVOLVE_SPEC §5).
 *
 * The exported helpers are the shared MECHANISM (conflict checks, strict
 * load-verification, run-history reads). `buildAuthoringCapability` bakes in
 * the meta-surface POLICY on top (EVOLVE_SPEC §6): everything the capability
 * publishes is stamped `publisher: "ai"`, and its publish / run /
 * run-history operations are CLOSED over that stamped set — it refuses to
 * touch, run, or read runs of workflows it didn't publish. A harness
 * workflow's run log records what its grader steps were handed, so
 * run-history reads on unstamped workflows fail closed.
 */

/** The provenance stamp for AI-authored artifacts (steps AND workflows). */
export const AI_PUBLISHER = "ai";

// ── Run-history reads (shared mechanism) ───────────────────────────────────

/** Drop bulky input/output payloads from an event so a run's event list stays
 *  token-cheap; the caller can re-fetch a specific run's full events if needed. */
export function slimEvent(e: RunEvent) {
  return {
    type: e.type,
    path: e.path,
    ...(e.stepType ? { stepType: e.stepType } : {}),
    ...(e.durationMs != null ? { durationMs: e.durationMs } : {}),
    ...(e.iteration != null ? { iteration: e.iteration } : {}),
    ...(e.error ? { error: e.error } : {}),
  };
}

/** An agent step's `step.end` carries its whole session (`messages`) — for
 *  the events endpoint and a log store, not for the model's context. */
function withoutTranscript(e: RunEvent): Omit<RunEvent, "messages"> {
  if (!e.messages) return e;
  const { messages: _transcript, ...rest } = e;
  return rest;
}

/** List a workflow's recent runs (newest first) as slim summaries. */
export async function listRunSummaries(
  store: Pick<RunStore, "listRuns" | "getRunSummary" | "getRunEvents">,
  name: string,
  limit: number,
) {
  const ids = (await store.listRuns(name)).slice(0, limit);
  return Promise.all(
    ids.map(async (runId) => {
      const s = await store.getRunSummary(name, runId);
      return {
        runId,
        status: s?.status,
        startedAt: s?.startedAt,
        durationMs: s?.durationMs,
        ...(s?.error ? { error: s.error } : {}),
      };
    }),
  );
}

/** Read one run's summary + events (slimmed unless `fullEvents`). */
export async function readRun(
  store: Pick<RunStore, "listRuns" | "getRunSummary" | "getRunEvents">,
  name: string,
  runId: string,
  fullEvents: boolean,
) {
  const [summary, rawEvents] = await Promise.all([
    store.getRunSummary(name, runId),
    store.getRunEvents(name, runId),
  ]);
  if (!summary && rawEvents.length === 0) {
    return { error: `Run "${runId}" not found for workflow "${name}".` };
  }
  return {
    workflow: name,
    runId,
    summary,
    events: fullEvents ? rawEvents.map(withoutTranscript) : rawEvents.map(slimEvent),
  };
}

// ── Run search (shared mechanism) ──────────────────────────────────────────

export interface RunSearchOptions {
  /** Explicit run ids to search (e.g. one eval batch). Default: newest `runLimit` runs. */
  runIds?: string[];
  /** How many recent runs to scan when `runIds` is absent. Default 20. */
  runLimit?: number;
  /** Cap on returned match entries; scanning stops once reached. Default 50. */
  maxMatches?: number;
  /** Case-insensitive matching. Default true (signature hunting favors recall). */
  ignoreCase?: boolean;
}

/** One matching event from a run search. */
export interface RunSearchMatch {
  runId: string;
  path: string;
  type: string;
  stepType?: string;
  /** Matches within this one event (the snippet shows the first). */
  count: number;
  /** The matched text with surrounding context from the event's JSON. */
  snippet: string;
}

const SNIPPET_BEFORE = 80;
const SNIPPET_AFTER = 160;

/**
 * Grep across a workflow's run event logs — the cross-run question the
 * per-run `readRun` can't answer without N calls and N payloads ("which runs
 * hit `ModuleNotFoundError`, and how often?" — EVOLVE_SPEC §4.2 capture).
 * Each event is matched as its JSON line (the same shape events.jsonl holds),
 * so input/output/error payloads are all searchable; matches come back as
 * (runId, event path, snippet) tuples plus a per-run frequency summary.
 * Scanning stops at `maxMatches` (`truncated: true`) — narrow the pattern or
 * the run window rather than raising the cap.
 */
export async function searchRunEvents(
  store: Pick<RunStore, "listRuns" | "getRunSummary" | "getRunEvents">,
  name: string,
  pattern: string,
  opts: RunSearchOptions = {},
) {
  const { runLimit = 20, maxMatches = 50, ignoreCase = true } = opts;
  let re: RegExp;
  try {
    re = new RegExp(pattern, ignoreCase ? "gi" : "g");
  } catch (err) {
    return { error: `Invalid pattern: ${err instanceof Error ? err.message : String(err)}` };
  }

  const runIds = opts.runIds?.length
    ? opts.runIds
    : (await store.listRuns(name)).slice(0, runLimit);

  const matches: RunSearchMatch[] = [];
  const perRun: { runId: string; matchingEvents: number }[] = [];
  let runsScanned = 0;
  let truncated = false;

  for (const runId of runIds) {
    if (truncated) break;
    const events = await store.getRunEvents(name, runId);
    runsScanned++;
    let matchingEvents = 0;
    for (const e of events) {
      const line = JSON.stringify(e);
      re.lastIndex = 0;
      const first = re.exec(line);
      if (!first) continue;
      matchingEvents++;
      let count = 1;
      while (re.exec(line) !== null) count++;
      matches.push({
        runId,
        path: e.path,
        type: e.type,
        ...(e.stepType ? { stepType: e.stepType } : {}),
        count,
        snippet: line.slice(
          Math.max(0, first.index - SNIPPET_BEFORE),
          first.index + first[0].length + SNIPPET_AFTER,
        ),
      });
      if (matches.length >= maxMatches) {
        truncated = true;
        break;
      }
    }
    if (matchingEvents > 0) perRun.push({ runId, matchingEvents });
  }

  return {
    workflow: name,
    pattern,
    runsScanned,
    runsWithMatches: perRun,
    matches,
    ...(truncated
      ? { truncated: true, note: "Match cap reached — narrow the pattern or run window." }
      : {}),
  };
}

// ── Step publishing (shared mechanism) ─────────────────────────────────────

/** LLMs sometimes pass an object-valued arg as a JSON *string* (e.g.
 *  run_workflow's `input`). The template engine then sees a string, so
 *  `{{ input.owner }}` resolves to undefined and every field fails validation.
 *  Defensively parse a JSON string back into the object/array it represents;
 *  leave anything else untouched. */
export function coerceJsonArg(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

/** What both publish paths need. The chat builder's `AiDeps` satisfies it
 *  structurally; the authoring capability builds its own. `getRegistry` must
 *  return a FRESH registry (re-scanned from the workspace). */
export interface StepPublishDeps {
  workspace: WorkspaceStore;
  getRegistry(): Promise<StepRegistry>;
  publishingEnabled?: boolean;
}

export interface StepPublishResult {
  ok?: true;
  error?: string;
  type?: string;
  version?: string;
  changed?: boolean;
  /** Whether the published source actually loaded into the registry. */
  loaded?: boolean;
  /** The import/shape error when `loaded` is false (§5.3.4: a broken step
   *  otherwise fails silently — `loadStepFile` warns and returns null, so the
   *  step simply doesn't exist). */
  loadError?: string;
}

/** Verify a just-published step actually loads; surface the error if not. */
async function verifyLoaded(
  deps: StepPublishDeps,
  name: string,
): Promise<{ loaded: boolean; loadError?: string }> {
  const fresh = await deps.getRegistry();
  if (fresh[name]) return { loaded: true };
  const err = await stepLoadError(
    join(await deps.workspace.materializeCustomSteps(), `${name}.ts`),
  );
  return {
    loaded: false,
    loadError:
      err ??
      "step did not appear in the registry — check the source imports only 'strut' and has a valid defineStep default export",
  };
}

/** Author a NEW custom step (the chat `create_step` / `meta/create-step`
 *  mechanism): refuses existing names and built-in collisions, publishes as
 *  v1, then load-verifies the source and hands any import error back. */
export async function publishNewStep(
  deps: StepPublishDeps,
  name: string,
  code: string,
  description?: string,
  publisher?: string,
): Promise<StepPublishResult> {
  if (deps.publishingEnabled === false) {
    return { error: "Step publishing is disabled (the registry was injected at construction)." };
  }
  const customs = await deps.workspace.listSteps();
  if (customs.some((s) => s.type === name)) {
    return { error: `Step "${name}" already exists. Use edit_step to publish a new version.` };
  }
  if ((await deps.getRegistry())[name]) {
    return { error: `"${name}" conflicts with a built-in (core/lib) step. Choose another name.` };
  }
  let result;
  try {
    result = await deps.workspace.publishStep(name, code, description, publisher);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, type: name, version: result.version, ...(await verifyLoaded(deps, name)) };
}

/** Publish a NEW VERSION of an existing custom step (the chat `edit_step` /
 *  `meta/edit-step` mechanism). Pass `requirePublisher` to enforce the meta
 *  ownership rule: only steps stamped with that publisher may be edited. */
export async function publishStepVersion(
  deps: StepPublishDeps,
  type: string,
  code: string,
  description?: string,
  opts: { requirePublisher?: string } = {},
): Promise<StepPublishResult> {
  if (deps.publishingEnabled === false) {
    return { error: "Step publishing is disabled (the registry was injected at construction)." };
  }
  const customs = await deps.workspace.listSteps();
  const existing = customs.find((s) => s.type === type);
  if (!existing) {
    return {
      error: (await deps.getRegistry())[type]
        ? `"${type}" is a built-in step and can't be edited. Use create_step with a new name.`
        : `Step "${type}" not found. Use create_step to author a new step.`,
    };
  }
  if (opts.requirePublisher && existing.publisher !== opts.requirePublisher) {
    return {
      error:
        `Step "${type}" was not published by "${opts.requirePublisher}" (publisher: ` +
        `${existing.publisher ?? "none"}) — the meta surface only edits steps it authored. ` +
        `Author a new step under a different name instead.`,
    };
  }
  let result;
  try {
    result = await deps.workspace.publishStep(type, code, description);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  return {
    ok: true,
    type,
    version: result.version,
    changed: result.changed,
    ...(await verifyLoaded(deps, type)),
  };
}

// ── The capability ─────────────────────────────────────────────────────────

export interface RunStepArgs {
  config?: Record<string, unknown>;
  input?: unknown;
  params?: Record<string, unknown>;
  cassette?: CassetteMode;
  cassetteName?: string;
  /** Persist the run under `step:<type>` even when the step has no claims. */
  keep?: boolean;
}

/**
 * The authoring capability injected as `services.authoring` — what the
 * `meta/*` lib steps are thin plumbing over. Auto-provided by `createStrut`
 * (like `http` / `secrets` / `artifacts`); embedders can inject their own.
 */
export interface AuthoringCapability {
  listSteps(path?: string): Promise<unknown>;
  searchSteps(query: string): Promise<unknown>;
  /** Description + JSON Schema of config/result; `source: true` adds a
   *  lib/custom step's TypeScript (for editing or mirroring it). */
  getStep(type: string, opts?: { source?: boolean }): Promise<unknown>;
  /** `claims` (here and on `editStep` / `publishWorkflow`): the contract,
   *  authored with the code. Additive and idempotent by exact text; invalid
   *  claims block the publish (plans/claims.md §2, door one). */
  createStep(name: string, code: string, description?: string, claims?: ClaimSpecInput[]): Promise<StepPublishResult>;
  editStep(type: string, code: string, description?: string, claims?: ClaimSpecInput[]): Promise<StepPublishResult>;
  runStep(type: string, args?: RunStepArgs): Promise<RunStepResult | { error: string }>;
  listWorkflows(): Promise<unknown>;
  getWorkflow(name: string, version?: string): Promise<unknown>;
  /** Static check of workflow YAML WITHOUT publishing — the chat builder's
   *  `validate_workflow`, for in-run authors (`meta/validate-workflow`). */
  validateWorkflow(yaml: string, name?: string): Promise<ValidationResult>;
  publishWorkflow(
    name: string,
    yaml: string,
    description?: string,
    category?: string,
    claims?: ClaimSpecInput[],
  ): Promise<unknown>;
  runWorkflow(
    name: string,
    input?: unknown,
    params?: Record<string, unknown>,
    version?: string,
    /** `parentRunId` = the calling step's `ctx.runId`, linking the nested
     *  run's controller under the launching run's (subtree control).
     *  `actor` / `principal`: the launching step's — a nested run is billed
     *  like the run that launched it. */
    opts?: { parentRunId?: string; actor?: string; principal?: string },
  ): Promise<RunResult | { error: string }>;
  listRuns(name: string, limit?: number): Promise<unknown>;
  getRun(name: string, runId: string, fullEvents?: boolean): Promise<unknown>;
  searchRuns(name: string, pattern: string, opts?: RunSearchOptions): Promise<unknown>;
  listSecrets(): Promise<unknown>;

  // ── Claims (plans/claims.md §2, door two) ──
  // Publisher-scoped like everything else on this surface (fixed point 1):
  // only claims / checks stamped `ai`, only subjects it published; its
  // checks may never reach a grader (fixed point 2). On a filesystem
  // workspace each returns `{ error }`.
  addClaim(input: { subjects: SubjectInput[]; text: string; checks: CheckSpecInput[] }): Promise<unknown>;
  editClaim(id: string, text: string): Promise<unknown>;
  retireClaim(id: string): Promise<unknown>;
  listClaims(subject: SubjectInput): Promise<unknown>;
  attachClaim(id: string, subject: SubjectInput): Promise<unknown>;
  detachClaim(id: string, subject: SubjectInput): Promise<unknown>;
  addCheck(claimId: string, check: CheckSpecInput): Promise<unknown>;
  editCheck(id: string, patch: CheckSpecInput): Promise<unknown>;
  retireCheck(id: string): Promise<unknown>;
  /** Verify a finished run NOW and return per-check outcomes. Synchronous —
   *  a harness calls it before digesting, because the detached pass races it
   *  (single-flighted: whichever starts second awaits the first). */
  verifyRun(name: string, runId: string): Promise<unknown>;
  /**
   * Record an observation about a claim on a run. `caller` decides how much
   * it is worth (fixed point 3): ONLY a step of a workflow this surface did
   * not publish — a seeded harness writing its graders' verdicts — records
   * `observed`. An `ai`-published workflow, or ANY agent tool call (even
   * inside a seeded harness), records `asserted`, whatever it says.
   */
  addEvidence(
    input: { claim: string; name: string; runId: string; supports: boolean; content: string; subject?: SubjectInput; slot?: string },
    caller?: { workflow?: string; runId?: string; agentTool?: boolean },
  ): Promise<unknown>;
}

export interface AuthoringDeps extends StepPublishDeps {
  store: RunStore;
  /** Local directory for step cassettes (`runStep` record/replay). Optional:
   *  without it, cassette modes report an error instead of recording. */
  dataDir?: string;
  /** Capabilities bag threaded into `runWorkflow` / `runStep` so authored
   *  steps reach `ctx.services` (http, secrets, and any consumer services). */
  services?: unknown;
  /** Read-only view of the deployment's secret store (NAMES only — never
   *  values). Optional: `listSecrets` degrades gracefully when absent. */
  secrets?: { list(): Promise<SecretInfo[]> };
  /** Register a nested run as in-flight, creating its RunController —
   *  attached to the launching run's controller when `parentRunId` is given,
   *  so cancelling/pausing the parent reaches this run (RUN_CONTROL_SPEC
   *  §2.2 tree linkage). Also drives the runs listing ("running" vs
   *  "stale"). Optional: embedders without a live server need not care. */
  trackRun?: (
    workflow: string,
    runId: string,
    parentRunId?: string,
  ) => { controller?: import("./run-control.js").RunController; untrack: () => void };
  /** The claims layer (plans/claims.md), built once by `createStrut` where
   *  it is on (a graph workspace, `StrutOptions.claims` not false). Null /
   *  absent → no contract is accepted or recorded, and the claim operations
   *  answer `CLAIMS_OFF`. */
  claims?: ClaimsAuthoring | null;
  /** The verify pass, wherever `claims` is. */
  verifier?: import("./verify.js").Verifier | null;
}

export function buildAuthoringCapability(deps: AuthoringDeps): AuthoringCapability {
  const { workspace, store } = deps;

  const explorerDeps = async () => ({ workspace, registry: await deps.getRegistry() });

  const claims = deps.claims ?? null;
  const actor: ClaimActor = { publisher: AI_PUBLISHER, scoped: true };
  const claimsOff = { error: CLAIMS_OFF };
  /** Blocks a publish on an invalid contract; a contract passed where there
   *  is no claims layer is an error too — silently dropping it would read as
   *  "contract recorded". */
  /** `run_when: publish` checks fire at the end of a publish. */
  const publishChecks = async (kind: "step" | "workflow", name: string) => {
    if (!claims || !deps.verifier) return {};
    const r = await deps.verifier.verifyPublish(kind === "step" ? { kind, type: name } : { kind, name }).catch(() => null);
    return r && r.checks.length ? { publishChecks: r.checks.map((k) => ({ claim: k.claimId, check: k.checkId, lastVerify: k.lastVerify })) } : {};
  };
  const claimsGate = async (arg: ClaimSpecInput[] | undefined): Promise<string | null> => {
    if (!arg || arg.length === 0) return null;
    if (!claims) return CLAIMS_OFF;
    return (await claims.validateClaimsArg(arg, actor))?.error ?? null;
  };

  const findWorkflow = async (name: string) =>
    (await workspace.listWorkflows()).find((w) => w.name === name);

  /** The ownership gate: the meta surface acts only on workflows it
   *  published (EVOLVE_SPEC §6). Returns an error message, or null when the
   *  workflow exists and is stamped. */
  const notOwned = async (name: string, verb: string): Promise<string | null> => {
    // `step:<type>` — a step's kept single-step runs (plans/claims.md §3):
    // same scoping, on the step's publisher stamp.
    const stepType = stepTypeOfRunKey(name);
    if (stepType) {
      const owned = (await workspace.listSteps({ publisher: AI_PUBLISHER })).some((s) => s.type === stepType);
      return owned ? null : `Step "${stepType}" is not agent-authored — the meta surface only ${verb} steps it published.`;
    }
    const entry = await findWorkflow(name);
    if (!entry) return `Workflow "${name}" not found`;
    if (entry.publisher !== AI_PUBLISHER) {
      return (
        `Workflow "${name}" is not agent-authored (publisher: ${entry.publisher ?? "none"}) — ` +
        `the meta surface only ${verb} workflows it published. ` +
        `Author a candidate with meta/publish-workflow under a new name instead.`
      );
    }
    return null;
  };

  return {
    async listSteps(path = "steps") {
      return lsSteps(path, await explorerDeps());
    },

    async searchSteps(query) {
      return searchSteps(query, await explorerDeps());
    },

    async getStep(type, opts) {
      const d = await explorerDeps();
      const def = d.registry[type];
      if (!def) return { error: `Step type "${type}" not found` };
      const recentRuns = (await store.listRuns(stepRunKey(type))).length;
      return {
        type,
        description: def.description,
        ...stepSchemas(def),
        ...(opts?.source ? { source: (await readStepSource(type, d)) ?? null } : {}),
        ...(recentRuns ? { recentRuns } : {}),
      };
    },

    async createStep(name, code, description, contract) {
      const invalid = await claimsGate(contract);
      if (invalid) return { error: `Nothing was published — fix the claims first. ${invalid}` };
      const published = await publishNewStep(deps, name, code, description, AI_PUBLISHER);
      const result = published.ok && claims ? { ...published, claims: await claims.applyClaimsArg({ kind: "step", name }, contract, actor), ...(await publishChecks("step", name)) } : published;
      // For the in-workflow author a broken publish is a FAILURE, not a
      // warning — §5.3.4: hand the import error back loudly.
      if (result.ok && result.loaded === false) {
        return {
          ...result,
          ok: undefined,
          error: `Published as ${result.version} but the step failed to load: ${result.loadError}`,
        };
      }
      return result;
    },

    async editStep(type, code, description, contract) {
      const invalid = await claimsGate(contract);
      if (invalid) return { error: `Nothing was published — fix the claims first. ${invalid}` };
      const published = await publishStepVersion(deps, type, code, description, {
        requirePublisher: AI_PUBLISHER,
      });
      const result = published.ok && claims ? { ...published, claims: await claims.applyClaimsArg({ kind: "step", name: type }, contract, actor), ...(await publishChecks("step", type)) } : published;
      if (result.ok && result.loaded === false) {
        return {
          ...result,
          ok: undefined,
          error: `Published as ${result.version} but the step failed to load: ${result.loadError}. Prior versions are retained — fix and edit again, or roll back.`,
        };
      }
      return result;
    },

    async runStep(type, args = {}) {
      // FRESH registry: a step authored earlier in this same run must be
      // runnable here — the run's own `ctx.registry` is a start-of-run
      // snapshot and would not contain it (EVOLVE_SPEC §5.3.1).
      const registry = await deps.getRegistry();
      if (!registry[type]) return { error: `Step type "${type}" not found` };
      if (args.cassette && !deps.dataDir) {
        return { error: "Cassette record/replay is unavailable (no local data dir configured)." };
      }
      return runStep(
        type,
        registry,
        deps.services,
        {
          config: coerceJsonArg(args.config) as Record<string, unknown> | undefined,
          input: coerceJsonArg(args.input),
          params: coerceJsonArg(args.params) as Record<string, unknown> | undefined,
          workspace,
          keep: args.keep === true,
          ...(args.cassette
            ? {
                cassette: {
                  mode: args.cassette,
                  path: cassettePath(deps.dataDir!, args.cassetteName ?? type),
                },
              }
            : {}),
        },
        { store, workspace, claims: claims?.reader ?? null, onKept: (key, runId) => deps.verifier?.schedule(key, runId) },
      );
    },

    async listWorkflows() {
      return { workflows: await workspace.listWorkflows() };
    },

    async getWorkflow(name, version) {
      const entry = await findWorkflow(name);
      if (!entry) return { error: `Workflow "${name}" not found` };
      const resolved = version ?? entry.activeVersion;
      let yaml;
      try {
        yaml = await workspace.getWorkflowSource(name, resolved);
      } catch {
        return {
          error: `Version "${resolved}" not found for "${name}". Available: ${entry.versions.join(", ")}`,
        };
      }
      return {
        name,
        version: resolved,
        activeVersion: entry.activeVersion,
        versions: entry.versions,
        description: entry.description,
        publisher: entry.publisher,
        yaml,
      };
    },

    async validateWorkflow(yaml, name) {
      const workflows = await workspace.listWorkflows().catch(() => []);
      return validateWorkflowYaml(yaml, {
        registry: await deps.getRegistry(),
        workflows: workflows.map((w) => ({ name: w.name, versions: w.versions })),
        name,
      });
    },

    async publishWorkflow(name, yaml, description, category, contract) {
      const invalid = await claimsGate(contract);
      if (invalid) return { error: `Nothing was published — fix the claims first. ${invalid}` };
      const entry = await findWorkflow(name);
      if (entry && entry.publisher !== AI_PUBLISHER) {
        return {
          error:
            `Workflow "${name}" exists and is not agent-authored (publisher: ` +
            `${entry.publisher ?? "none"}). The meta surface never edits workflows it ` +
            `didn't publish — choose a new name to author a candidate.`,
        };
      }
      try {
        const result = await workspace.publishWorkflowByContent(
          name,
          yaml,
          description,
          category,
          AI_PUBLISHER,
        );
        return {
          ok: true,
          name,
          version: result.version,
          changed: result.changed,
          created: !entry,
          ...(claims ? { claims: await claims.applyClaimsArg({ kind: "workflow", name }, contract, actor), ...(await publishChecks("workflow", name)) } : {}),
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    async runWorkflow(name, input, params, version, opts) {
      const gate = await notOwned(name, "runs");
      if (gate) return { error: gate };
      let flow;
      try {
        flow = version
          ? await workspace.getWorkflowVersion(name, version)
          : await workspace.getWorkflow(name);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
      // FRESH registry, same reason as runStep: steps published mid-run are
      // invisible to the enclosing run's registry snapshot.
      const registry = await deps.getRegistry();
      const runId = generateRunId();
      // Tree linkage: attach this nested run's controller to the launching
      // run's (opts.parentRunId = the calling step's ctx.runId), so controls
      // on the parent reach it (RUN_CONTROL_SPEC §2.2).
      const tracked = deps.trackRun?.(flow.name, runId, opts?.parentRunId);
      try {
        return await runWorkflow(flow, coerceJsonArg(input) ?? {}, registry, {
          runId,
          store,
          workspace,
          services: deps.services,
          params: coerceJsonArg(params) as Record<string, unknown> | undefined,
          controller: tracked?.controller,
          workflowHash:
            (await workspace.getWorkflowHash(flow.name, version)) ?? undefined,
          stepHashes: await stepHashesFor(workspace, flow),
          ...(opts?.actor ? { actor: opts.actor } : {}),
          ...(opts?.principal ? { principal: opts.principal } : {}),
        });
      } finally {
        tracked?.untrack();
      }
    },

    async listRuns(name, limit = 20) {
      const gate = await notOwned(name, "reads run history of");
      if (gate) return { error: gate };
      return { workflow: name, runs: await listRunSummaries(store, name, limit) };
    },

    async getRun(name, runId, fullEvents = false) {
      const gate = await notOwned(name, "reads run history of");
      if (gate) return { error: gate };
      return readRun(store, name, runId, fullEvents);
    },

    async searchRuns(name, pattern, opts) {
      const gate = await notOwned(name, "reads run history of");
      if (gate) return { error: gate };
      return searchRunEvents(store, name, pattern, opts);
    },

    async listSecrets() {
      if (!deps.secrets) {
        return { error: "Secret store is not available in this deployment." };
      }
      const secrets = await deps.secrets.list();
      return { secrets: secrets.map((s) => ({ name: s.name, updatedAt: s.updatedAt })) };
    },

    // ── Claims — every call goes through the SCOPED actor ────────────────
    addClaim: async (input) => (claims ? claims.addClaim(input, actor) : claimsOff),
    editClaim: async (id, text) => (claims ? claims.editClaim(id, text, actor) : claimsOff),
    retireClaim: async (id) => (claims ? claims.retireClaim(id, actor) : claimsOff),
    listClaims: async (subject) => (claims ? claims.listClaims(subject) : claimsOff),
    attachClaim: async (id, subject) => (claims ? claims.attachClaim(id, subject, actor) : claimsOff),
    detachClaim: async (id, subject) => (claims ? claims.detachClaim(id, subject, actor) : claimsOff),
    addCheck: async (claimId, check) => (claims ? claims.addCheck(claimId, check, actor) : claimsOff),
    editCheck: async (id, patch) => (claims ? claims.editCheck(id, patch, actor) : claimsOff),
    retireCheck: async (id) => (claims ? claims.retireCheck(id, actor) : claimsOff),

    async verifyRun(name, runId) {
      if (!claims || !deps.verifier) return claimsOff;
      const gate = await notOwned(name, "verifies runs of");
      if (gate) return { error: gate };
      return deps.verifier.verifyRun(name, runId, { explicit: true });
    },

    async addEvidence(input, caller) {
      if (!claims || !deps.verifier) return claimsOff;
      const root = caller?.workflow ? await findWorkflow(caller.workflow) : undefined;
      const harness = !caller?.agentTool && !!root && root.publisher !== AI_PUBLISHER;
      return deps.verifier.addEvidence({
        claim: input.claim,
        name: input.name,
        runId: input.runId,
        supports: input.supports,
        content: input.content,
        ...(input.subject ? { subject: toSubjectRef(input.subject) } : {}),
        ...(input.slot ? { slot: input.slot } : {}),
        by: harness ? caller!.workflow! : `${AI_PUBLISHER}${caller?.runId ? `:${caller.runId}` : ""}`,
        mode: harness ? "observed" : "asserted",
      });
    },
  };
}
