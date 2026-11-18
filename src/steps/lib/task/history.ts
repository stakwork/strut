import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { LEASE_STATUSES } from "../../../tasks/task-store.js";
import { appsOf, workerCall } from "./_shared.js";

/**
 * The worker's own tasks here, newest first (plans/human-steps.md §5.1):
 * their dashboard's history — each task's type, when they took it and when
 * it left their hand, how it ended, and for a paid answer what it earned,
 * when its hold ends and whether it was taken back — and what the run
 * replied after their answer (`task/reply`). Only this app's types, only
 * their own leases, and never the run, whether it was a test, or why an
 * earning was taken back (§7.2: a worker cannot tell a test).
 */
export default defineStep({
  type: "task/history",
  effect: "read",
  worker: true,
  description:
    "A WORKER's page lists its viewer's own tasks here, newest first (the kit's useTaskHistory): { items: [{ lease, type, ask?, taken, closed?, status, earned? }] } — ask: what the task asked, as they saw it; " +
    "status open (in hand) | submitted (answered) | skipped | expired (ran out or closed); earned { msat, releases, takenBack? } on a paid answer: what it earned, when its hold ends (then it can be withdrawn), and takenBack when it was taken back; " +
    "reply { show?, files?, at } on an answer the workflow replied to (its task/reply step): what it told them, and files [{ name, mediaType, size, path }] they open with task/file { lease, path } — poll it after an answer to wait for one. " +
    "Only the task types this app draws — with all: true, those of every app the viewer can open here — at most the 50 newest. Only an app page's own call, as its viewer.",
  input: z.object({ all: z.boolean().optional() }),
  output: z.object({
    items: z.array(
      z.object({
        lease: z.string(),
        type: z.string(),
        ask: z.string().optional(),
        taken: z.number(),
        closed: z.number().optional(),
        status: z.enum(LEASE_STATUSES),
        earned: z.object({ msat: z.number(), releases: z.number(), takenBack: z.literal(true).optional() }).optional(),
        reply: z
          .object({
            show: z.record(z.string(), z.unknown()).optional(),
            files: z.array(z.object({ name: z.string(), mediaType: z.string(), size: z.number(), path: z.string() })).optional(),
            at: z.number(),
          })
          .optional(),
      }),
    ),
  }),
  async run(cfg, ctx?: StepContext) {
    const call = workerCall("task/history", ctx);
    // A host's own store may keep no history: none to show.
    return call.tasks.history ? call.tasks.history(call.actor, await appsOf(call, cfg.all)) : { items: [] };
  },
});
