/**
 * The `run/*` steps are thin over the runs capability (`src/runs.ts`) that
 * `createStrut` builds into `ctx.services.runs` — the same layers the run
 * routes call. Unsealed: an agent takes them as `agentTools: ["run/*"]`, an
 * APP reaches them through `step_run` on its `grants.workflows`
 * (plans/apps.md §5). A SEALED workflow (a grading harness, `sealed: true`)
 * is refused by name inside the capability, as the meta/* twins refuse it:
 * these are a model's door, and what a harness was handed must stay out
 * of its reach (EVOLVE_SPEC §6).
 */
export { requireRuns, type RunsCapability } from "../../../runs.js";
