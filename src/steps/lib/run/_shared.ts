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
import { z } from "zod";

export { requireRuns, type RunsCapability } from "../../../runs.js";

/**
 * A run's input as a tool takes it: a JSON object, so the model is told to
 * send one. Models often send an object field as its JSON text instead;
 * that text is parsed back to the object, so what runs (and what a
 * proposal of the call records, and a card shows) is the object.
 */
export function runInput(description: string) {
  const parsed = (value: unknown) => {
    if (typeof value !== "string") return value;
    try {
      const object: unknown = JSON.parse(value);
      return object && typeof object === "object" && !Array.isArray(object) ? object : value;
    } catch {
      return value;
    }
  };
  return z.preprocess(parsed, z.record(z.string(), z.any())).optional().describe(description);
}
