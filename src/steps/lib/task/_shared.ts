/**
 * What every `task/*` step shares (plans/human-steps.md §5.1): the WORKER's
 * door to the task store. A worker step decides from its own caller — the
 * page's viewer, `ctx.actor`, in the app the call is for, `ctx.app` — never
 * from its input, so a page cannot name another worker (rule 5). It runs
 * only as an app page's own call through `step_run` (a one-step run): never
 * a step of a workflow, never an agent's tool — a worker is a person.
 *
 * Where a worker's money goes (plans/human-steps.md §8.2) is decided the same
 * way: the Sphinx address their SESSION carries, which the door hands to a
 * worker step's own bag beside the worker's calls (`WORKER_ADDRESS`), never
 * a field a page sends. This is the one place a step reads it.
 */
import { workflowOf, type StepContext } from "../../../core.js";
import { RUN_STEP_FLOW } from "../../../run-step.js";
import type { WorkerTasksCapability } from "../../../tasks/tasks.js";

/** The key a door hands a worker step the session's Sphinx address under,
 *  on that call's bag alone (createStrut's `workerServicesOf`). */
export const WORKER_ADDRESS = "workerAddress";

export interface WorkerCall {
  tasks: WorkerTasksCapability;
  /** The worker: the page's viewer. */
  actor: string;
  /** The calling app's name: a task type names the app that draws it. */
  app: string;
  /** The Sphinx address the viewer's session carries, what a withdrawal
   *  pays (§8.2); absent when it carries none. */
  address?: string;
}

export function workerCall(type: string, ctx: StepContext | undefined): WorkerCall {
  if (!ctx?.app || workflowOf(ctx) !== RUN_STEP_FLOW || ctx.agentTool) {
    throw new Error(`${type} is a worker's: it runs only as an app page's own call (step_run), for the page's viewer — never a workflow's step or an agent's tool (plans/human-steps.md §5)`);
  }
  if (!ctx.actor) throw new Error(`${type}: sign in first — a worker is the page's signed-in viewer`);
  const tasks = (ctx.services as { tasks?: WorkerTasksCapability } | undefined)?.tasks;
  if (!tasks) throw new Error(`${type}: this server keeps no task store (ctx.services.tasks)`);
  const address = (ctx.services as Record<string, unknown> | undefined)?.[WORKER_ADDRESS];
  return { tasks, actor: ctx.actor, app: ctx.app.name, ...(typeof address === "string" && address ? { address } : {}) };
}
