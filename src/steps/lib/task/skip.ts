import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { workerCall } from "./_shared.js";

/**
 * A worker passes on the task they lease (plans/human-steps.md §5.1): it
 * reopens for someone else and is never handed to this worker again.
 */
export default defineStep({
  type: "task/skip",
  effect: "write",
  worker: true,
  description:
    "A WORKER's page passes on the task it leases (the kit's useTask().skip): the task reopens for another worker and is never handed to this one again. Only an app page's own call, as its viewer.",
  input: z.object({
    lease: z.string().min(1).describe("The lease task/next handed out."),
    reason: z.string().max(2000).optional().describe("Why, in the worker's words; kept on the lease."),
  }),
  output: z.object({ ok: z.literal(true) }),
  async run(cfg, ctx?: StepContext) {
    const { tasks, actor, app } = workerCall("task/skip", ctx);
    return tasks.skip(actor, { lease: cfg.lease, app, ...(cfg.reason === undefined ? {} : { reason: cfg.reason }) });
  },
});
