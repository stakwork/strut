import { z } from "zod";
import { defineStep } from "../../../core.js";
import type { JobsCapability } from "../../../jobs.js";

/**
 * Progress (plans/live-feeds.md §4): `job.update { kind: "status", id:
 * <runId>, title, detail? }` to the run's JOB — its host's callback and
 * `job/updates` — so a person watching sees "drafting round 2" instead of
 * nothing until the turn ends. One current status per run: a newer one
 * replaces it. With `items`, it carries the turn's checklist too
 * (`detail.items`), sent whole each time, as a to-do list is rewritten: no
 * item ids to keep straight. A workflow writes it between its steps; the
 * job and builder agents are granted it to narrate a long turn. Nothing
 * without a job.
 */
export default defineStep({
  type: "job/status",
  description:
    `Tell whoever watches this run's job (the job card, an app's page) what it is doing now, in one line, and, with \`items\`, ` +
    `the turn's checklist: its steps in order and where each stands: { sent }. ` +
    `Each call replaces the last from the same run, so send the whole list every time while the turn has one. ` +
    `Nothing happens on a run with no job.`,
  input: z.object({
    title: z.string().min(1).max(500).describe("The line, in the person's words: what is happening now."),
    items: z
      .array(
        z.object({
          text: z.string().min(1).max(200).describe("One step, in the person's words."),
          state: z.enum(["todo", "doing", "done"]),
        }),
      )
      .min(1)
      .max(8)
      .optional()
      .describe("The turn's steps, in order, each `todo`, `doing` or `done`: the whole list, every call."),
    detail: z.record(z.string(), z.unknown()).optional().describe("Small and optional: `{ round: 2, of: 4 }`."),
  }),
  output: z.object({ sent: z.boolean(), job: z.string().optional() }),
  async run(cfg, ctx) {
    const job = ctx?.job;
    const notify = (ctx?.services as { jobs?: JobsCapability } | undefined)?.jobs?.notify;
    if (!job || !notify) return { sent: false };
    const detail = cfg.items ? { ...cfg.detail, items: cfg.items } : cfg.detail;
    notify(job, {
      kind: "status",
      ...(ctx.runId ? { id: ctx.runId, runId: ctx.runId } : {}),
      title: cfg.title,
      ...(detail ? { detail } : {}),
    });
    return { sent: true, job };
  },
});
