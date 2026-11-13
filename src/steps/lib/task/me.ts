import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { workerCall } from "./_shared.js";

/**
 * Who the worker is here (plans/human-steps.md §4.6, §5.1): their status
 * and the task types they hold that THIS app draws — the app's menu. The
 * first call of anyone the store has not seen writes them as `new`, which
 * staff see and grant task types to.
 */
export default defineStep({
  type: "task/me",
  effect: "read",
  worker: true,
  description:
    "A WORKER's page asks who its viewer is here (the kit's useWorker): { actor, status, types } — status new | active | suspended | banned, and the task types they hold that this app draws. " +
    "A first call writes the viewer as a new worker, for staff to grant task types to. Only an app page's own call, as its viewer.",
  input: z.object({}),
  output: z.object({
    actor: z.string(),
    status: z.enum(["new", "active", "suspended", "banned"]),
    types: z.array(z.object({ name: z.string(), app: z.string() })),
  }),
  async run(_cfg, ctx?: StepContext) {
    const { tasks, actor, app } = workerCall("task/me", ctx);
    return tasks.me(actor, { app });
  },
});
