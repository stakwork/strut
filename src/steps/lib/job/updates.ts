import { z } from "zod";
import { defineStep } from "../../../core.js";
import type { JobsCapability } from "../../../jobs.js";
import { FEED_MAX_WAIT_MS } from "../../../live-feed.js";
import { JOB_FEED_MAX } from "../../../jobs.js";

/**
 * A job's live updates as a step (plans/live-feeds.md §1): the shots, the
 * walkthrough frames, the holds, the verdicts, the status lines and the
 * graph writes a job reports — what its host hears on `jobCallback` — for
 * a reader that has no callback: an app's page (through `step_run`, its
 * `job` kept in the app's namespace), a workflow watching another run's
 * job. `GET /jobs/:id/updates` is the same read.
 */
export default defineStep({
  type: "job/updates",
  description:
    `A JOB's live updates after a cursor: { job, cursor, reset?, more?, updates: [{ event: "job.update", job, at, runId?, kind, url?, id?, title?, state?, detail? }] } — ` +
    `the newest state of each thing that changed (kind: image, walkthrough, a hold's kind, evidence, verify, proposal, status, graph), in the order they last changed. ` +
    `Hand \`cursor\` back as \`since\`; \`since: "now"\` reads only what changes from here. \`wait\` (ms) holds the call while nothing is new. ` +
    `\`reset\` means the cursor could not be honored (the server restarted): everything kept is returned, read again what you show.`,
  effect: "read",
  input: z.object({
    job: z.string().describe("The job id."),
    since: z.string().optional().describe('The cursor the last read returned, or "now". Omit to read everything kept.'),
    wait: z.number().int().min(0).max(FEED_MAX_WAIT_MS).optional().describe(`Hold up to this many ms while nothing is new (at most ${FEED_MAX_WAIT_MS}).`),
    limit: z.number().int().positive().max(JOB_FEED_MAX).optional(),
  }),
  output: z.object({
    job: z.string(),
    cursor: z.string(),
    reset: z.literal(true).optional(),
    more: z.literal(true).optional(),
    updates: z.array(z.any()),
  }),
  async run(cfg, ctx) {
    const jobs = (ctx?.services as { jobs?: JobsCapability } | undefined)?.jobs;
    if (!jobs?.updates) throw new Error("job/updates needs the server's job capability (ctx.services.jobs.updates); the standard strut server provides it.");
    return jobs.updates(cfg.job, { since: cfg.since, wait: cfg.wait, limit: cfg.limit });
  },
});
