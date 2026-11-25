import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { GROUP_MAX, LEASE_STATUSES, VERDICTS } from "../../../tasks/task-store.js";
import { appsOf, workerCall } from "./_shared.js";

/**
 * The worker's own tasks here, newest first (plans/human-steps.md §5.1):
 * their dashboard's history — each task's type, when they took it and when
 * it left their hand, how it ended, and for a paid answer what it earned,
 * when its hold ends and whether it was taken back — and what the run
 * replied after their answer (`task/reply`). Only this app's types, only
 * their own leases, and never the run, whether it was a test, or why an
 * earning was taken back (§7.2: a worker cannot tell a test) — except
 * staff's verdict on an answer and its why (§9.6), which is what to fix.
 * The groups a run put their tasks in (`task/reply`'s `group`): `groups`
 * lists theirs, `group` reads every answer of one.
 */
export default defineStep({
  type: "task/history",
  effect: "read",
  worker: true,
  description:
    "A WORKER's page lists its viewer's own tasks here, newest first (the kit's useTaskHistory): { items: [{ lease, type, ask?, taken, closed?, status, earned? }] } — ask: what the task asked, as they saw it; " +
    "status open (in hand) | submitted (answered) | skipped | expired (ran out or closed); earned { msat, releases, takenBack? } on a paid answer: what it earned, when its hold ends (then it can be withdrawn), and takenBack when it was taken back; " +
    "reply { show?, files?, at } on an answer the workflow replied to (its task/reply step): what it told them, and files [{ name, mediaType, size, path }] they open with task/file { lease, path } — poll it after an answer to wait for one. " +
    "group: the group the workflow put the task in (task/reply's group: a book, a batch); review { verdict: ok | rejected, why?, at } on an answer staff reviewed — a rejection's why is what to fix. " +
    "Only the task types this app draws — with all: true, those of every app the viewer can open here — at most the 50 newest; with group, every answer of theirs in that group instead (at most 1000). " +
    "groups: true adds groups: [{ group, type, tasks, answers, ok, rejected, unreviewed, first, last }], their own groups (only their own answers counted), the one with the newest task first; for a type that manages its groups each also has status (open, submitted, accepted, rejected, reopened, abandoned, or the type's own), statusAt, statusBy, mine (whether they own it: task/group-move moves it), idle, virtual (named before the type managed groups: read as open). Only an app page's own call, as its viewer.",
  input: z.object({ all: z.boolean().optional(), group: z.string().min(1).max(GROUP_MAX).optional(), groups: z.boolean().optional() }),
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
        group: z.string().optional(),
        review: z.object({ verdict: z.enum(VERDICTS), why: z.string().optional(), at: z.number() }).optional(),
      }),
    ),
    groups: z
      .array(
        z.object({
          group: z.string(),
          type: z.string(),
          tasks: z.number(),
          answers: z.number(),
          ok: z.number(),
          rejected: z.number(),
          unreviewed: z.number(),
          first: z.number(),
          last: z.number(),
          id: z.string().optional(),
          status: z.string().optional(),
          statusAt: z.number().optional(),
          statusBy: z.string().optional(),
          mine: z.boolean().optional(),
          virtual: z.literal(true).optional(),
          idle: z.literal(true).optional(),
        }),
      )
      .optional(),
  }),
  async run(cfg, ctx?: StepContext) {
    const call = workerCall("task/history", ctx);
    // A host's own store may keep no history: none to show.
    return call.tasks.history
      ? call.tasks.history(call.actor, { ...(await appsOf(call, cfg.all)), ...(cfg.group ? { group: cfg.group } : {}), ...(cfg.groups ? { groups: true } : {}) })
      : { items: [], ...(cfg.groups ? { groups: [] } : {}) };
  },
});
