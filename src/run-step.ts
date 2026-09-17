import { z } from "zod";
import { stepHashesFor } from "./closure.js";
import type { Flow, StepRegistry, RunEvent, RunResult, RunSummary } from "./core.js";
import type { ClaimsReader } from "./graph/claims.js";
import { runWorkflow, type SubflowResolver } from "./runner.js";
import { MemoryRunStore, generateRunId, stepRunKey, type RunStore } from "./store.js";
import {
  withCassette,
  loadCassette,
  saveCassette,
  type CassetteMode,
} from "./cassette.js";

/**
 * Run a SINGLE step in isolation — the tight inner loop for authoring adapters.
 *
 * Unlike a workflow run (detached, launch+tail), this is synchronous: it wraps
 * the step in an ad-hoc one-step flow, runs it to completion against an
 * in-memory store, and returns the output + events directly — so the chat agent
 * (or a developer) can author → run → fix without wiring anything into a
 * workflow.
 *
 * With `cassette`, external service calls go through the record/replay wrapper:
 *   - `record` — run live, capture every `ctx.services` call to the cassette
 *     file (secrets scrubbed), so the next iteration can…
 *   - `replay` — …serve those calls from the file: offline, deterministic, no
 *     rate limits, no cost, no side effects.
 */
export interface RunStepOptions {
  /** The step's config (same shape as a workflow step's `config`). Templates
   *  like `{{ input.* }}` / `{{ params.* }}` are resolved. */
  config?: Record<string, unknown>;
  /** Workflow input, referenced in config via `{{ input.* }}`. */
  input?: unknown;
  /** Params knobs, referenced via `{{ params.* }}`. */
  params?: Record<string, unknown>;
  /** Record/replay external service calls against a cassette file. */
  cassette?: { mode: CassetteMode; path: string };
  /** Subflow resolver — only needed if the step itself is a `subflow`. */
  workspace?: SubflowResolver;
  /** Recorded on `run.start` (see `RunEvent.stepHashes`). `runStep` fills it
   *  from the workspace; pass it yourself only when calling this directly. */
  stepHashes?: Record<string, string>;
  /** `"verify"` when the verify pass runs a check through here. */
  origin?: "verify";
}

export interface RunStepResult {
  /** Id of the (in-memory) run — the id it keeps if it is persisted. */
  runId: string;
  status: "success" | "error" | "cancelled";
  output?: unknown;
  error?: { message: string; stack?: string };
  /** Every event the step emitted (start/end/error, plus nested for containers). */
  events: RunEvent[];
  /** Number of recorded service calls (present when a cassette was used). */
  recorded?: number;
}

export async function runSingleStep(
  type: string,
  registry: StepRegistry,
  services: unknown,
  opts: RunStepOptions = {},
): Promise<RunStepResult> {
  const runId = generateRunId();
  if (!registry[type]) {
    return {
      runId,
      status: "error",
      error: { message: `Step type "${type}" not found` },
      events: [],
    };
  }

  const flow: Flow = {
    name: "__run_step__",
    input: z.any(),
    steps: [{ id: "step", type, config: opts.config ?? {} }],
    ...(opts.params != null ? { params: opts.params } : {}),
  };

  const cassette = opts.cassette ? await loadCassette(opts.cassette.path) : null;
  const runServices =
    opts.cassette && cassette
      ? withCassette(services as Record<string, unknown>, {
          mode: opts.cassette.mode,
          cassette,
        })
      : services;

  const events: RunEvent[] = [];
  const result: RunResult = await runWorkflow(flow, opts.input ?? {}, registry, {
    runId,
    store: new MemoryRunStore(),
    services: runServices,
    workspace: opts.workspace,
    ...(opts.stepHashes ? { stepHashes: opts.stepHashes } : {}),
    ...(opts.cassette ? { cassette: opts.cassette.mode } : {}),
    ...(opts.origin ? { origin: opts.origin } : {}),
    onEvent: (e) => {
      events.push(e);
    },
  });

  // Persist newly-captured calls only when recording.
  if (opts.cassette?.mode === "record" && cassette) {
    await saveCassette(opts.cassette.path, cassette);
  }

  return {
    runId,
    status: result.status,
    output: result.output,
    error: result.error,
    events,
    ...(cassette ? { recorded: cassette.entries.length } : {}),
  };
}

// ── run_step: single-step runs that leave a record ───────────────────────────

export interface RunStepDeps {
  /** The REAL run store — never the throwaway one the step executes against. */
  store: RunStore;
  /** Source of `run.start.stepHashes`; also the subflow resolver. */
  workspace?: SubflowResolver & { getActiveStepHashes(): Promise<Record<string, string>> };
  /** The claims layer — null/absent on a filesystem workspace. */
  claims?: Pick<ClaimsReader, "claimsFor"> | null;
}

export interface KeptRunStepResult extends RunStepResult {
  /** The run-store key the run was persisted under (`step:<type>`) — read it
   *  back with `list_runs` / `get_run` on that key. Absent = not kept. */
  kept?: string;
}

/**
 * `runSingleStep` for the `run_step` surfaces (chat tool, `meta/run-step`,
 * `POST /steps/:type/run`), plus the two things that make a single-step run
 * usable as evidence (plans/claims.md §3):
 *
 *   - BEFORE: the active hash of every workspace step in reach goes on
 *     `run.start.stepHashes` — the only record of which version executed;
 *   - AFTER: the run still executes in memory exactly as before, and is then
 *     copied into the real store under `step:<type>` ONLY when it can become
 *     evidence — the step has an active claim — or the caller asked
 *     (`keep: true`). A step with a contract keeps its test runs; a scratch
 *     step leaves nothing behind. One graph read, after the run.
 *
 * `step:<type>` is a store key, never a workflow: no workflow listing, and no
 * workflow's `list_runs` / `search_runs`, can see these runs.
 */
export async function runStep(
  type: string,
  registry: StepRegistry,
  services: unknown,
  opts: RunStepOptions & { keep?: boolean },
  deps: RunStepDeps,
): Promise<KeptRunStepResult> {
  const { keep, ...runOpts } = opts;
  const flowSteps = [{ id: "step", type, config: runOpts.config ?? {} }];
  const stepHashes = runOpts.stepHashes ?? (await stepHashesFor(deps.workspace, { steps: flowSteps }));
  const result = await runSingleStep(type, registry, services, {
    ...runOpts,
    workspace: runOpts.workspace ?? deps.workspace,
    ...(stepHashes ? { stepHashes } : {}),
  });
  if (result.events.length === 0) return result; // never ran (unknown type)

  let wanted = keep === true;
  if (!wanted && deps.claims) {
    try {
      wanted = (await deps.claims.claimsFor({ kind: "step", type })).length > 0;
    } catch (err) {
      // The run's result must not depend on the graph being reachable.
      console.error(`[run-step] could not read claims for ${type} — run not kept:`, err);
    }
  }
  if (!wanted) return result;
  const kept = await persistStepRun(deps.store, type, result);
  return { ...result, kept };
}

/** Copy a finished single-step run (events + summary) into `store` under
 *  `step:<type>`. Returns the key. */
export async function persistStepRun(store: RunStore, type: string, result: RunStepResult): Promise<string> {
  const key = stepRunKey(type);
  for (const e of result.events) await store.append(key, result.runId, e);
  const first = result.events[0]!;
  const last = result.events[result.events.length - 1]!;
  const summary: RunSummary = {
    runId: result.runId,
    workflow: key,
    startedAt: first.ts,
    finishedAt: last.ts,
    durationMs: Date.parse(last.ts) - Date.parse(first.ts),
    status: result.status,
    input: result.events.find((e) => e.type === "run.start")?.input,
    ...(result.output !== undefined ? { output: result.output } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
  await store.finalize(key, result.runId, summary);
  return key;
}

/** Default on-disk location for a step's cassette, under the server's local
 *  data dir (`dataDir` — the workspace root for file-backed deployments). */
export function cassettePath(dataDir: string, name: string): string {
  // `name` may contain slashes (namespaced step types) — they become subdirs.
  return `${dataDir}/steps/_cassettes/${name}.json`;
}
