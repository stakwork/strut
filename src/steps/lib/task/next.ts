import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { NEXT_WAIT_MAX_S } from "../../../tasks/tasks.js";
import { workerCall } from "./_shared.js";

/**
 * A worker takes the next task (plans/human-steps.md §5.1): the oldest open
 * task of a type they hold that THIS app draws — or of the one `type` asked
 * for — leased to them until `expires`. The worker's own live lease comes
 * back as it is, so a page that reloads gets its task again. `wait` holds up
 * to 25 s for a task to appear (the kit's `useTask` asks again as one ends).
 */
export default defineStep({
  type: "task/next",
  effect: "write",
  worker: true,
  description:
    "A WORKER's page takes the next task (the kit's useTask): the oldest open task of a type the signed-in viewer holds that this app draws (or of `type`), leased to them — " +
    "{ lease, type, show, files, expires } — or { none: true }. `wait` (seconds, at most 25) holds for a task to appear. Their own live lease comes back as it is. " +
    "Only an app page's own call, as its viewer; never a workflow step or an agent's tool.",
  input: z.object({
    type: z.string().min(1).optional().describe("One task type, drawn by this app; any type the worker holds here when left out."),
    wait: z.number().min(0).max(NEXT_WAIT_MAX_S).optional().describe(`Seconds to hold for a task to appear, at most ${NEXT_WAIT_MAX_S}; 0 (the default) answers at once.`),
  }),
  output: z.any(),
  async run(cfg, ctx?: StepContext) {
    const { tasks, actor, app } = workerCall("task/next", ctx);
    return tasks.next(actor, { app, ...(cfg.type === undefined ? {} : { type: cfg.type }), ...(cfg.wait === undefined ? {} : { wait: cfg.wait }) });
  },
});
