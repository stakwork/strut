import { z } from "zod";

// ── Types ──────────────────────────────────────────────────────────────────

/** A step definition registered in the step registry.
 *
 * `TServices` is the shape of the capabilities bag injected at run time
 * via `runWorkflow({ services })`. Consumers define this as an interface
 * in their own app and pass concrete implementations per environment
 * (e.g. Neo4j in prod, in-memory in tests). Steps that don't touch
 * services leave it as the default `unknown` and ignore `ctx.services`.
 * An adapter that wants typed `http`/`secrets` can opt in by annotating
 * `defineStep<"t", In, Out, StrutCapabilities>(…)` (import the type from
 * "strut") — kept opt-in so it doesn't collide with consumer `ctx.services`
 * casts (the standard server always provides `http`/`secrets` regardless).
 */
export interface StepDef<
  TType extends string = string,
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
  TServices = unknown,
> {
  type: TType;
  description?: string;
  input: TInput;
  output: TOutput;
  /** Optional source code for this step, surfaced by `GET /steps/:type/source`
   *  and the UI's step viewer. Set by consumers that inject in-code steps via
   *  `createRegistry([...])` (which have no discoverable on-disk file) so their
   *  real implementation can still be inspected. */
  source?: string;
  run: (
    cfg: z.infer<TInput>,
    ctx: StepContext<TServices>,
  ) => Promise<z.infer<TOutput>>;
}

/** Context passed to every step's `run` function.
 *
 * `services` is the consumer-defined capabilities bag — typically a
 * record of typed interfaces (graph store, file system, LLM client, …)
 * whose concrete implementations are swapped per environment.
 */
export interface StepContext<TServices = unknown> {
  runId: string;
  path: string;
  scope: Record<string, unknown>;
  input: unknown;
  emit: (event: RunEvent) => Promise<void>;
  services: TServices;
  /** The step registry, populated by the runner. Lets a step that orchestrates
   *  OTHER steps (e.g. the `agent` step exposing registry step-types as LLM
   *  tools) look up their defs by type — without promoting itself to a
   *  runner-handled container step. Optional: absent when a step is invoked
   *  outside the runner (e.g. unit tests). Read-only by convention. */
  registry?: StepRegistry;
  /** Cooperative run control (RUN_CONTROL_SPEC §6). A step with a long
   *  internal loop should `await ctx.control?.checkpoint()` per iteration so
   *  pause/cancel take effect between iterations rather than only at the
   *  step's boundary. Optional (absent outside the runner, like `registry`);
   *  ignoring it just leaves the step coarse-grained. */
  control?: import("./run-control.js").RunControl;
  /** On resume: this step's own prior synthetic `step.end` outputs (keys are
   *  full event paths under this step's path, e.g. `wf/evolve#3`). A step
   *  that emits per-iteration synthetic `step.end` events can consume this to
   *  skip completed iterations (RUN_CONTROL_SPEC §5/§6). Absent on a fresh
   *  run or when there is nothing journaled under this step. */
  journal?: Record<string, unknown>;
  /** True when this step is executing as an AGENT'S TOOL CALL (granted via
   *  `agentTools`) rather than as a step of the workflow's DAG. A step that
   *  acts on the caller's authority reads it: what a harness workflow does
   *  deliberately and what a model inside it decided to do are not the same
   *  actor (plans/claims.md §4.1, fixed point 3). */
  agentTool?: boolean;
  /** Who launched this run — an opaque string the host resolved from the
   *  request (plans/mothership-cost-control.md §2). Strut stores and forwards
   *  it, never interprets it. Absent when nobody is known. */
  actor?: string;
  /** Who this run's spend is billed to: the actor, else the workflow's
   *  owner (§2, the principal rule). What `llmAuth` receives. */
  principal?: string;
  /** Register a run-scoped disposer: the runner calls every registered `fn`
   *  in its `finally` when the run settles — success, error AND cancel —
   *  newest first, each guarded, BEFORE the services bag's own `onRunEnd`.
   *  For a step that allocates something that must not outlive the run (a
   *  git worktree, a browser, a booted stack) and cannot reach the consumer's
   *  services hook. Subflow frames and an agent's tool-call steps share the
   *  run's list. Optional (absent outside the runner, like `registry`);
   *  a hard kill skips it like any in-process `finally`. */
  onRunEnd?: (fn: (info: RunEndInfo) => unknown) => void;
}

/** What a run's teardown hooks (`ctx.onRunEnd`, `services.onRunEnd`) are told
 *  about the settled run. */
export interface RunEndInfo {
  /** The flow's name — the run-store key the run was written under. */
  workflow: string;
  origin?: RunOrigin;
}

/** Error handling options for a step. */
export interface StepOptions {
  retry?: { max: number; delayMs: number };
  onError?: Step;
}

/** A step instance in a workflow. */
export interface Step {
  id: string;
  type: string;
  config: Record<string, unknown>;
  depends?: string | string[];
  /** Gate condition: only run this step when the gate step it depends on
   *  evaluated to this value. `true`/`false` match the boolean result of
   *  an `if` gate. Omit to always run (no gating). */
  when?: boolean;
  options?: StepOptions;
}

/**
 * A declared mapping from a value in THIS workflow's run output to a `param`
 * default on a (possibly different) target workflow — the "promote a winner"
 * surface (Tier 2). After a run, the UI resolves each spec against the run's
 * output and offers a one-click "promote": write the resolved value into the
 * target's `params[param]` default and publish a new version. Fully generic —
 * nothing keys off a specific output name; the optimize loop just declares
 * `from: bestPrompt`, `to: <targetWorkflow>.<promptParam>`.
 *
 * Inert by itself: declaring a promote NEVER writes anything. Promotion is a
 * human-reviewed action (see the diff, click Apply); only then is the target's
 * param overwritten + a new version published.
 */
export interface PromoteSpec {
  /** Dotted path into this workflow's run output (e.g. `bestPrompt`,
   *  `best.prompt`, `results[0].prompt`). */
  from: string;
  /** Destination as `"<workflow>.<param>"` — the param default to overwrite.
   *  Split on the FIRST dot (workflow names contain no dots). */
  to: string;
  /** Optional human label for the UI (defaults to the `to` string). */
  label?: string;
}

/** A workflow (flow) definition. */
export interface Flow {
  name: string;
  input: z.ZodTypeAny;
  steps: Step[];
  /** Tunable default knobs (prompts, thresholds, sample sizes, …) exposed
   *  to step configs via `{{ params.* }}`. Distinct from `input`: `input`
   *  is the per-run subject (validated, no defaults); `params` are the
   *  experiment surface (all defaults, sparsely overridden per run via
   *  `RunOptions.params`). Override precedence: run override > these
   *  defaults. Omit for workflows with no knobs. */
  params?: Record<string, unknown>;
  /** Declared "promote a run output → a target param default" mappings.
   *  Resolved against a run's output by the UI to offer one-click promotion
   *  of a winning value (e.g. an optimize loop's `bestPrompt`). */
  promotes?: PromoteSpec[];
}

/** Run event types for the JSONL log. */
export type RunEventType =
  | "step.start"
  | "step.end"
  | "step.error"
  | "step.retry"
  | "step.skipped"
  /** A completed step's journaled output was replayed on resume — zero cost,
   *  no side effects re-executed. Never a fake `step.end` (honest timings). */
  | "step.replayed"
  | "run.start"
  | "run.end"
  | "run.error"
  /** Terminal: the run tree was cooperatively cancelled (RUN_CONTROL_SPEC §3). */
  | "run.cancelled"
  /** Non-terminal markers so parked time is visible in the log (§4), and so a
   *  `run.resumed` after a terminal event reopens tails (§5.2). */
  | "run.paused"
  | "run.resumed"
  /** Non-terminal marker: cancel was REQUESTED. The run finalizes as
   *  `run.cancelled` at its next boundary — but if the process dies first,
   *  this marker is what tells boot-time auto-resume (§5.3) that the run
   *  was being cancelled, not cut off. */
  | "run.cancelling";

/** Who launched a run, when it was not a person or an API call. */
export type RunOrigin = "verify" | "schedule";

/** A single event in the run log. */
export interface RunEvent {
  ts: string;
  runId: string;
  path: string;
  type: RunEventType;
  stepType?: string;
  input?: unknown;
  output?: unknown;
  error?: { message: string; stack?: string };
  durationMs?: number;
  iteration?: number;
  /** Content hash of the workflow version this run executes, recorded on
   *  `run.start` — resume refuses to replay a journal into a DIFFERENT DAG
   *  (RUN_CONTROL_SPEC §5, validity guards). */
  workflowHash?: string;
  /** Content hash of the ACTIVE version of every workspace (custom) step
   *  this run can execute, keyed by step type — recorded on `run.start`, and
   *  again on `run.resumed` (a resume loads whatever is active THEN). A
   *  workflow version does not pin its steps, so this is the ONLY record of
   *  which step version a run executed; without an entry, the verify pass
   *  writes no evidence for that step (plans/claims.md §3–§4). */
  stepHashes?: Record<string, string>;
  /** Cassette mode the run executed under, on `run.start`; absent = live. A
   *  `replay` run is a unit test against a fixture: real evidence, weaker
   *  than live. */
  cassette?: "record" | "replay";
  /** Who launched the run, on `run.start`; absent = a person or an API call.
   *  `"verify"`: the verify pass (a check) — such runs are never themselves
   *  verified, the recursion guard. `"schedule"`: an automation's fire
   *  (plans/automations.md) — a real execution, verified like any other. */
  origin?: RunOrigin;
  /** On a scheduled run's `run.start`: the automation that fired it. */
  automation?: { id: string };
  /** On `run.start`: who launched the run (`actor`) and who pays for it
   *  (`principal`) — see `StepContext`. Recorded so a resume bills the same
   *  person even if the workflow's owner has changed since. */
  actor?: string;
  principal?: string;
  /** On `run.start`: the ORIGIN of the URL the launch asked to have the
   *  result POSTed to (`POST …/run { callback }`, src/callback.ts). The URL
   *  itself is the host's credential and never leaves the launch site. */
  callback?: { origin: string };
  /** On a CHECK run's `run.start`: which check ran, over what. Lets the
   *  verify budget be computed from the run store alone (plans/claims.md
   *  §4.1): a subject's spend today is the cost of today's runs in its
   *  checks' buckets whose `verify.subject` is that subject. */
  verify?: { checkId: string; subject: string; sourceRunId: string };
  /** On a `subflow` step's `step.start`: the child workflow it is about to
   *  execute, as resolved at THAT moment — name, pinned version if any, and
   *  the content hash of the version that will run. A nested execution is an
   *  execution of the child workflow, and this is the only record of which
   *  version it was (the child resolves when the step runs, not at launch). */
  subflow?: { workflow: string; version?: string; hash?: string };
  /** Per-run param overrides, recorded on `run.start` so a durable resume
   *  re-executes steps with the SAME knob values the original run used. */
  params?: Record<string, unknown>;
  paramOverrides?: Record<string, Record<string, unknown>>;
  /** The launching run's id, recorded on `run.start` for a NESTED run (one
   *  attached under a parent controller — RUN_CONTROL_SPEC §2.2). Absent
   *  for a root run. Boot-time auto-resume (§5.3) resumes only roots: a
   *  parent re-executing its launching step relaunches its children. */
  parentRunId?: string;
  /** Graph nodes this step reported touching (the provenance convention,
   *  plans/generic-storage.md "v2") — lifted verbatim from the output's
   *  `_nodes` marker on `step.end`, exempt from any truncation. The graph
   *  projector turns them into `ACCESSED` edges. */
  nodes?: AccessedNode[];
  /** On an `agent` step's `step.end` (and a sub-agent's tool-call
   *  `step.end`): the whole session — system prompt, task prompt, every
   *  generated turn — as AI SDK model messages, untruncated. Lifted from
   *  the output's `withMessages` marker; never part of the output itself,
   *  so templates, parent agents and run.json stay slim. */
  messages?: unknown[];
}

// ── Provenance convention: which graph nodes did a step touch? ─────────────

/** One graph node a step read or wrote, by its stable `ref_id`. */
export interface AccessedNode {
  ref_id: string;
  node_type?: string;
}

const ACCESSED_NODES_KEY = "_nodes";

/**
 * Mark a step's output with the graph nodes it touched. The marker is a
 * NON-enumerable own property of the output value (object or array), so it
 * rides along in-process — to `wrapToolsWithEmit`, which lifts it onto the
 * `step.end` event — but never reaches the model, downstream `{{ }}`
 * expressions, or a JSON serializer. Refs are deduplicated by `ref_id`;
 * empty lists and non-object outputs (error strings) are left unmarked.
 * Returns `output` for chaining: `return withAccessedNodes(result, refs)`.
 */
export function withAccessedNodes<T>(output: T, nodes: Array<AccessedNode | null | undefined>): T {
  if (output === null || typeof output !== "object") return output;
  const seen = new Set<string>();
  const list: AccessedNode[] = [];
  for (const n of nodes) {
    if (!n || typeof n.ref_id !== "string" || !n.ref_id || seen.has(n.ref_id)) continue;
    seen.add(n.ref_id);
    list.push(typeof n.node_type === "string" && n.node_type ? { ref_id: n.ref_id, node_type: n.node_type } : { ref_id: n.ref_id });
  }
  if (list.length === 0) return output;
  Object.defineProperty(output, ACCESSED_NODES_KEY, { value: list, enumerable: false, configurable: true, writable: true });
  return output;
}

/** The nodes a step output was marked with (see `withAccessedNodes`), else
 *  undefined. */
export function accessedNodesOf(output: unknown): AccessedNode[] | undefined {
  if (output === null || typeof output !== "object") return undefined;
  const v = (output as Record<string, unknown>)[ACCESSED_NODES_KEY];
  return Array.isArray(v) && v.length > 0 ? (v as AccessedNode[]) : undefined;
}

// ── Transcript marker: what did an agent step's model see and say? ─────────

const MESSAGES_KEY = "_messages";

/**
 * Mark a step's output with the model session behind it (`RunEvent.messages`).
 * Same mechanism as `withAccessedNodes`: a NON-enumerable own property, so it
 * rides along in-process — to the runner, which lifts it onto the `step.end`
 * event — but never reaches `{{ }}` templates, a parent agent's tool result,
 * or a JSON serializer. Empty lists and non-object outputs are left unmarked.
 */
export function withMessages<T>(output: T, messages: unknown[] | undefined): T {
  if (output === null || typeof output !== "object" || !messages?.length) return output;
  Object.defineProperty(output, MESSAGES_KEY, { value: messages, enumerable: false, configurable: true, writable: true });
  return output;
}

/** The session a step output was marked with (see `withMessages`), else
 *  undefined. */
export function messagesOf(output: unknown): unknown[] | undefined {
  if (output === null || typeof output !== "object") return undefined;
  const v = (output as Record<string, unknown>)[MESSAGES_KEY];
  return Array.isArray(v) && v.length > 0 ? v : undefined;
}

/** Result of running a workflow. */
export interface RunResult {
  runId: string;
  status: "success" | "error" | "cancelled";
  output?: unknown;
  error?: { message: string; stack?: string };
}

/** Run summary written to run.json. */
export interface RunSummary {
  runId: string;
  workflow: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: "success" | "error" | "cancelled";
  input: unknown;
  output?: unknown;
  error?: { message: string; stack?: string };
  /** The automation that fired this run, if one did. On the SUMMARY (not
   *  only `run.start`) so "this automation's last successful run" is a scan
   *  of summaries, never of event logs (plans/automations.md §5). */
  automation?: { id: string };
  /** Who launched the run and who was billed for it (see `StepContext`). */
  actor?: string;
  principal?: string;
  /** Content hash of the workflow version the run executed (as on
   *  `run.start`) — on the summary so "runs per version" is a summary scan. */
  workflowHash?: string;
  /** Executions per step type in this run's whole log (subflows included —
   *  they log inline), so step usage is a scan of summaries, never of event
   *  logs (`step-stats.ts`). Always written by the runner; absent only on
   *  summaries written before it existed. See `countSteps`. */
  stepCounts?: StepCounts;
}

/** Keyed by `stepType` as emitted — a step an agent called as a tool is
 *  `tool:<type>`. `step.end` = success, `step.error` = error (once per
 *  execution, after retries); `step.replayed` is not an execution. */
export type StepCounts = Record<string, { success: number; error: number; lastAt: string }>;

/** A step definition with erased generics, for use in the registry.
 *
 * The runtime is intentionally untyped over services — a registry can
 * hold steps from different consumers expecting different service
 * shapes, and the runner just hands each step whatever was passed in
 * via `RunOptions.services`. Type safety lives at `defineStep` time.
 */
export interface AnyStepDef {
  type: string;
  description?: string;
  input: z.ZodTypeAny;
  output: z.ZodTypeAny;
  /** Optional source code for in-code steps (see `StepDef.source`). */
  source?: string;
  run: (cfg: any, ctx: StepContext<any>) => Promise<any>;
}

/** Step registry — maps step type names to their definitions. */
export type StepRegistry = Record<string, AnyStepDef>;

// ── Builder functions ──────────────────────────────────────────────────────

/**
 * Define a new step type. Used in step definition files.
 *
 * ```ts
 * export default defineStep({
 *   type: "http",
 *   input: z.object({ url: z.string() }),
 *   output: z.any(),
 *   async run(cfg, ctx) { ... },
 * });
 * ```
 */
export function defineStep<
  TType extends string,
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
  TServices = unknown,
>(
  def: StepDef<TType, TInput, TOutput, TServices>,
): StepDef<TType, TInput, TOutput, TServices> {
  return def;
}

/**
 * Create a step instance for use in a workflow's `steps` array.
 *
 * ```ts
 * step("check", "http", { url: "{{ input.url }}" })
 * step("check", "http", { url: "/health" }, { retry: { max: 3, delayMs: 1000 } })
 * ```
 */
export function step(
  id: string,
  type: string,
  config: Record<string, unknown>,
  options?: StepOptions & { depends?: string | string[]; when?: boolean },
): Step {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(id)) {
    throw new Error(
      `Invalid step id "${id}": must match [a-zA-Z_][a-zA-Z0-9_]*`,
    );
  }
  const { depends, when, ...opts } = options ?? {};
  const hasOpts = Object.keys(opts).length > 0;
  return {
    id,
    type,
    config,
    ...(depends != null ? { depends } : {}),
    ...(when != null ? { when } : {}),
    ...(hasOpts ? { options: opts } : {}),
  };
}

/**
 * Define a workflow.
 *
 * ```ts
 * export default flow("deploy", {
 *   input: z.object({ service: z.string() }),
 *   steps: [
 *     step("kick", "http", { url: "/deploy", method: "POST" }),
 *     step("done", "log", { message: "deployed {{ input.service }}" }),
 *   ],
 * });
 * ```
 */
export function flow(
  name: string,
  opts: { input: z.ZodTypeAny; steps: Step[]; params?: Record<string, unknown> },
): Flow {
  // Validate step id uniqueness within this flow
  const ids = new Set<string>();
  for (const s of opts.steps) {
    if (ids.has(s.id)) {
      throw new Error(
        `Duplicate step id "${s.id}" in flow "${name}"`,
      );
    }
    ids.add(s.id);
  }
  return {
    name,
    input: opts.input,
    steps: opts.steps,
    ...(opts.params != null ? { params: opts.params } : {}),
  };
}
