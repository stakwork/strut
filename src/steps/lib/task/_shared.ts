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
/** The key a door hands a worker step the apps its caller can open under
 *  (`WorkerApps`): what `task/me { all }` and `task/history { all }` list. */
export const WORKER_APPS = "workerApps";

/** The apps whose task types a worker reached through this door can open:
 *  the public view's for a visitor; undefined for every app (a member). */
export type WorkerApps = () => Promise<string[] | undefined>;

export interface WorkerCall {
  tasks: WorkerTasksCapability;
  /** The worker: the page's viewer. */
  actor: string;
  /** The calling app's name: a task type names the app that draws it. */
  app: string;
  /** The Sphinx address the viewer's session carries, what a withdrawal
   *  pays (§8.2); absent when it carries none. */
  address?: string;
  /** The apps the caller can open, for a list across apps; absent: every app. */
  apps?: WorkerApps;
}

export function workerCall(type: string, ctx: StepContext | undefined): WorkerCall {
  if (!ctx?.app || workflowOf(ctx) !== RUN_STEP_FLOW || ctx.agentTool) {
    throw new Error(`${type} is a worker's: it runs only as an app page's own call (step_run), for the page's viewer — never a workflow's step or an agent's tool (plans/human-steps.md §5)`);
  }
  if (!ctx.actor) throw new Error(`${type}: sign in first — a worker is the page's signed-in viewer`);
  const tasks = (ctx.services as { tasks?: WorkerTasksCapability } | undefined)?.tasks;
  if (!tasks) throw new Error(`${type}: this server keeps no task store (ctx.services.tasks)`);
  const bag = ctx.services as Record<string, unknown> | undefined;
  const address = bag?.[WORKER_ADDRESS];
  const apps = bag?.[WORKER_APPS];
  return {
    tasks,
    actor: ctx.actor,
    app: ctx.app.name,
    ...(typeof address === "string" && address ? { address } : {}),
    ...(typeof apps === "function" ? { apps: apps as WorkerApps } : {}),
  };
}

/** Which apps' task types a worker call reads: the calling app's alone, or
 *  with `all` every app the caller can open (`{ apps }`, or nothing to
 *  narrow by — every app). */
export async function appsOf(call: WorkerCall, all: boolean | undefined): Promise<{ app?: string; apps?: string[] }> {
  if (!all) return { app: call.app };
  const apps = await call.apps?.();
  return apps ? { apps: [...new Set([call.app, ...apps])] } : {};
}
