import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { appsOf, workerCall } from "./_shared.js";

/**
 * A worker passes on the task they lease (plans/human-steps.md §5.1): it
 * reopens for someone else and is never handed to this worker again. With
 * `all`, a task of any app the viewer can open here, as `task/me { all }`
 * lists: the dashboard's Let go (strut/views' WorkHome) of a task another
 * app draws.
 */
export default defineStep({
  type: "task/skip",
  effect: "write",
  worker: true,
  description:
    "A WORKER's page passes on the task it leases (the kit's useTask().skip): the task reopens for another worker and is never handed to this one again. " +
    "With all: true, the lease may be of a type any app the viewer can open here draws (task/me { all }'s holding.lease): a dashboard across apps letting go of the task in hand. Only an app page's own call, as its viewer.",
  input: z.object({
    lease: z.string().min(1).describe("The lease task/next handed out."),
    reason: z.string().max(2000).optional().describe("Why, in the worker's words; kept on the lease."),
    all: z.boolean().optional().describe("A task another app draws, of any app the viewer can open here (a dashboard across apps)."),
  }),
  output: z.object({ ok: z.literal(true) }),
  async run(cfg, ctx?: StepContext) {
    const call = workerCall("task/skip", ctx);
    return call.tasks.skip(call.actor, { lease: cfg.lease, ...(await appsOf(call, cfg.all)), ...(cfg.reason === undefined ? {} : { reason: cfg.reason }) });
  },
});
