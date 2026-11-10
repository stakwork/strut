/**
 * A run's cost cap (plans/mothership-cost-control.md §3; plans/paid-runs.md
 * §7): what the Mothership's run link carries, so the gateway refuses the
 * call that would start past it. Its own module so core can count a public
 * run's cap the way the Mothership will enforce it — core never imports
 * src/mothership.ts.
 */
import { bootEnv } from "./env.js";

/** The cap when neither the workflow nor `STRUT_RUN_MAX_COST_USD` sets one. */
export const DEFAULT_RUN_CAP_USD = 100;

/**
 * A run's cost cap: the workflow's `maxRunCostUsd`, else
 * `STRUT_RUN_MAX_COST_USD`, else the built-in default — and, when the run
 * carries a cap of its own (`runCap`: a public run's, the smallest of the
 * item's per-run cap, the workflow's and what is left of its daily cap), the
 * smaller of the two. Anything that is not a positive number is an ERROR,
 * never a fallback — `0` reads as "uncapped" to the gateway, and that must
 * never happen by way of a typo. An unset or empty env var is simply absent.
 */
export function resolveRunCap(
  workflowCap: number | undefined,
  env: Record<string, string | undefined> = bootEnv(),
  fallback = DEFAULT_RUN_CAP_USD,
  runCap?: number,
): number {
  const raw = env["STRUT_RUN_MAX_COST_USD"];
  const cap = workflowCap ?? (raw != null && raw.trim() !== "" ? Number(raw) : fallback);
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) {
    throw new Error(
      `run cost cap must be a positive number of dollars, got ${JSON.stringify(cap)} — check the workflow's maxRunCostUsd / STRUT_RUN_MAX_COST_USD`,
    );
  }
  if (runCap === undefined) return cap;
  if (typeof runCap !== "number" || !Number.isFinite(runCap) || runCap <= 0) {
    throw new Error(`a run's own cost cap must be a positive number of dollars, got ${JSON.stringify(runCap)}`);
  }
  return Math.min(cap, runCap);
}
