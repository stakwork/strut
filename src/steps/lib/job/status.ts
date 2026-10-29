import { z } from "zod";
import { defineStep } from "../../../core.js";
import type { JobsCapability } from "../../../jobs.js";

/**
 * One line of progress (plans/live-feeds.md §4): `job.update { kind:
 * "status", id: <runId>, title }` to the run's JOB — its host's callback and
 * `job/updates` — so a person watching sees "drafting round 2" instead of
 * nothing until the turn ends. One current line per run: a newer one
 * replaces it. A workflow writes it between its steps; an agent may be
 * granted it to narrate a long turn. Nothing without a job.
 */
export default defineStep({
  type: "job/status",
  description:
    `Say what this run is doing now, in one line, to whoever watches its job (the job card, an app's page): { sent }. ` +
    `A newer line from the same run replaces the older. Nothing happens on a run with no job.`,
  input: z.object({
    title: z.string().min(1).max(500).describe("The line, in the person's words: what is happening now."),
    detail: z.record(z.string(), z.unknown()).optional().describe("Small and optional: `{ round: 2, of: 4 }`."),
  }),
  output: z.object({ sent: z.boolean(), job: z.string().optional() }),
  async run(cfg, ctx) {
    const job = ctx?.job;
    const notify = (ctx?.services as { jobs?: JobsCapability } | undefined)?.jobs?.notify;
    if (!job || !notify) return { sent: false };
    notify(job, {
      kind: "status",
      ...(ctx.runId ? { id: ctx.runId, runId: ctx.runId } : {}),
      title: cfg.title,
      ...(cfg.detail ? { detail: cfg.detail } : {}),
    });
    return { sent: true, job };
  },
});
