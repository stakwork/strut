/**
 * Usage of one step type across the workspace — the Step Info flyout's
 * "Usage" section (`GET /steps/:type/stats`).
 *
 * - **workflows**: every workflow whose ACTIVE version can execute the type
 *   (its closure: loop/foreach bodies, onError, nested subflows, agentTools
 *   grants). `direct` = named in the workflow's own YAML; otherwise it is
 *   reached through a subflow.
 * - **runs**: every execution recorded in those workflows' run logs, plus
 *   the step's own kept single-step runs (`step:<type>`). An execution is a
 *   `step.end` (success) or `step.error` (failure) whose `stepType` is the
 *   type — or `tool:<type>`, the event an agent emits when it calls the step
 *   as a tool. Replays (`step.replayed`) are not executions.
 *
 * Read from each run's `RunSummary.stepCounts` (written at finalize), so the
 * cost is one small summary per run, never its event log. A workflow that
 * USED the step in an older version but no longer does is not scanned.
 */
import type { Flow, StepCounts } from "./core.js";
import { closureIncludes, flowClosure } from "./closure.js";
import type { RunStore } from "./store.js";
import { countSteps, stepRunKey } from "./store.js";
import type { WorkspaceStore } from "./workspace.js";

export interface StepStats {
  type: string;
  workflows: Array<{ name: string; direct: boolean }>;
  runs: { total: number; success: number; error: number; lastAt: string | null };
}

export async function stepStats(
  workspace: Pick<WorkspaceStore, "listWorkflows" | "getWorkflow" | "getWorkflowVersion">,
  store: Pick<RunStore, "listRuns" | "getRunSummary" | "getRunEvents" | "finalize">,
  type: string,
): Promise<StepStats> {
  const workflows: StepStats["workflows"] = [];
  for (const entry of await workspace.listWorkflows()) {
    let flow: Flow;
    try {
      flow = await workspace.getWorkflow(entry.name);
    } catch {
      continue; // unreadable workflow — nothing to report
    }
    // No resolver → the closure stops at the flow's own steps (+ agentTools).
    if (closureIncludes(await flowClosure(flow), type)) workflows.push({ name: entry.name, direct: true });
    else if (closureIncludes(await flowClosure(flow, workspace), type)) workflows.push({ name: entry.name, direct: false });
  }

  const runs: StepStats["runs"] = { total: 0, success: 0, error: 0, lastAt: null };
  const add = (counts: StepCounts) => {
    for (const key of [type, `tool:${type}`]) {
      const c = counts[key];
      if (!c) continue;
      runs.total += c.success + c.error;
      runs.success += c.success;
      runs.error += c.error;
      if (runs.lastAt == null || c.lastAt > runs.lastAt) runs.lastAt = c.lastAt;
    }
  };
  // A finished run's summary carries its counts. A run in flight has no
  // summary yet, and one finished before `stepCounts` existed has none on
  // it: both are counted from the log, and the old summary is backfilled so
  // its log is read once.
  const countsOf = async (key: string, id: string): Promise<StepCounts> => {
    const summary = await store.getRunSummary(key, id);
    if (summary?.stepCounts) return summary.stepCounts;
    const counts = countSteps(await store.getRunEvents(key, id));
    if (summary) await store.finalize(key, id, { ...summary, stepCounts: counts });
    return counts;
  };

  for (const key of [...workflows.map((w) => w.name), stepRunKey(type)]) {
    const ids = await store.listRuns(key);
    for (let i = 0; i < ids.length; i += 32) {
      (await Promise.all(ids.slice(i, i + 32).map((id) => countsOf(key, id)))).forEach(add);
    }
  }
  return { type, workflows, runs };
}
