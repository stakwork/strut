/**
 * What every `task/*` step shares (plans/human-steps.md §5.1): the WORKER's
 * door to the task store. A worker step decides from its own caller — the
 * page's viewer, `ctx.actor`, in the app the call is for, `ctx.app` — never
 * from its input, so a page cannot name another worker (rule 5). It runs
 * only as an app page's own call through `step_run` (a one-step run): never
 * a step of a workflow, never an agent's tool — a worker is a person.
 */
import { workflowOf, type StepContext } from "../../../core.js";
import { RUN_STEP_FLOW } from "../../../run-step.js";
import type { WorkerTasksCapability } from "../../../tasks/tasks.js";

export interface WorkerCall {
  tasks: WorkerTasksCapability;
  /** The worker: the page's viewer. */
  actor: string;
  /** The calling app's name: a task type names the app that draws it. */
  app: string;
}

export function workerCall(type: string, ctx: StepContext | undefined): WorkerCall {
  if (!ctx?.app || workflowOf(ctx) !== RUN_STEP_FLOW || ctx.agentTool) {
    throw new Error(`${type} is a worker's: it runs only as an app page's own call (step_run), for the page's viewer — never a workflow's step or an agent's tool (plans/human-steps.md §5)`);
  }
  if (!ctx.actor) throw new Error(`${type}: sign in first — a worker is the page's signed-in viewer`);
  const tasks = (ctx.services as { tasks?: WorkerTasksCapability } | undefined)?.tasks;
  if (!tasks) throw new Error(`${type}: this server keeps no task store (ctx.services.tasks)`);
  return { tasks, actor: ctx.actor, app: ctx.app.name };
}
