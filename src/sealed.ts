/**
 * Sealed — what the meta surface may never touch (EVOLVE_SPEC §6). The
 * `meta/*` steps an in-workflow agent gets (`authoring.ts`) run, inspect and
 * publish workflows on behalf of a model; a grading harness's run log records
 * what its graders were handed — gold and rubric text — and a candidate that
 * embeds its grader has oracle access. So a SEALED workflow or step is
 * refused by name (run, run history, verify) and a publish whose closure
 * reaches one is refused (the step by type, the workflow through a
 * `subflow`, a grader in an `agentTools` grant).
 *
 * ONE source, two shapes:
 *   - a step-namespace list: `DEFAULT_SEALED_STEPS` plus `STRUT_SEALED`
 *     (comma-separated globs, per deployment);
 *   - `sealed: true` on the thing itself — a workflow's top-level YAML key
 *     (content, so it rides in the version hash and a seeded template
 *     carries it; `Flow.sealed`) or a step def's field
 *     (`defineStep({ sealed: true })`).
 *
 * Three readers, two functions: the meta surface's gates (`authoring.ts`),
 * a check's closure when it is written (`claims-authoring.ts`, fixed point
 * 2) and when it runs (`verify.ts`). Who PUBLISHED what stays the
 * `publisher` stamp's business, unchanged: the meta surface publishes only
 * over names it stamped `ai`, and only an unstamped harness records
 * `observed` evidence.
 */
import type { StepRegistry } from "./core.js";
import { globToRegExp, type FlowClosure } from "./closure.js";

/** Sealed on every deployment: the eval primitives and the meta surface
 *  itself (no authoring one hop away). A deployment's graders seal
 *  themselves on their defs, or are added here through `STRUT_SEALED` — a
 *  grader's namespace usually also holds the producer's door
 *  (`gaia/get-task` strips the gold), so a namespace is sealed whole only
 *  when all of it is. */
export const DEFAULT_SEALED_STEPS: readonly string[] = ["eval/*", "meta/*"];

/** The deployment's sealed step globs: the defaults plus `STRUT_SEALED`. */
export function sealedStepPatterns(env: Record<string, string | undefined> = process.env): string[] {
  const extra = (env["STRUT_SEALED"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...DEFAULT_SEALED_STEPS, ...extra])];
}

/** Is `type` sealed — by namespace, or by its own def (`sealed: true`)? */
export function isSealedStep(type: string, registry?: StepRegistry, patterns: readonly string[] = sealedStepPatterns()): boolean {
  return patterns.some((p) => globToRegExp(p).test(type)) || registry?.[type]?.sealed === true;
}

/** Every string in `value`, however deep. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

/**
 * The first step a run's `params` override names that the workflow's own
 * params do not, as a phrase for an error, or null: a step type (or a
 * versioned ref to one), or a glob that reaches one. `params` are knobs
 * (prompts, thresholds); a grant (`agentTools: "{{ params.tools }}"`) read
 * from them must not be widened by whoever launches the run, or a child of
 * a job would hold tools its parent was never given, sealed or not.
 */
export function grantWidenedBy(defaults: unknown, override: unknown, registry: StepRegistry): string | null {
  const own = new Set(stringsIn(defaults));
  for (const s of stringsIn(override)) {
    if (own.has(s)) continue;
    const base = s.split("@")[0]!;
    if (registry[base]) return `"${s}"`;
    if (!s.includes("*")) continue;
    const re = globToRegExp(s);
    const reached = Object.keys(registry).find((t) => re.test(t));
    if (reached) return `"${s}" (reaches "${reached}")`;
  }
  return null;
}

/**
 * The first sealed thing a closure reaches, as a phrase for an error, or
 * null: `workflow "gaia-run"` (through a subflow), `step "gaia/evaluate"`
 * (by type), `grant "meta/*"` (an agentTools entry, as written) or
 * `grant "*" (reaches "gaia/evaluate")` (expanded over the registry).
 */
export function sealedInClosure(closure: FlowClosure, registry: StepRegistry, patterns: readonly string[] = sealedStepPatterns()): string | null {
  const sealed = (type: string) => isSealedStep(type, registry, patterns);
  for (const w of closure.workflows) if (w.sealed) return `workflow "${w.workflow}"`;
  for (const t of closure.types) if (sealed(t)) return `step "${t}"`;
  for (const grant of closure.agentTools) {
    if (sealed(grant)) return `grant "${grant}"`;
    if (!grant.includes("*")) continue;
    const re = globToRegExp(grant);
    const reached = Object.keys(registry).find((t) => re.test(t) && sealed(t));
    if (reached) return `grant "${grant}" (reaches "${reached}")`;
  }
  return null;
}
