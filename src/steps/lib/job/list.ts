import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireJobIndex } from "./_shared.js";

/**
 * The job index's listing (plans/job-index.md §5) as a step, so a turn can
 * find an earlier job by words. `GET /jobs` is the same read over HTTP.
 */
export default defineStep({
  type: "job/list",
  description:
    `Earlier JOBS on this strut, newest-used first: { jobs: [{ job, title?, createdBy?, createdAt?, usedAt, busy?, runs, holds }] }. ` +
    `\`q\` searches by words: every word must appear in a job's title (its id, when it has none) or in the title or summary of something it delivered — ` +
    `so "landing page" finds the job whose plan is titled that. \`busy\` names the run working in it now. ` +
    `Then job/get for what a job produced, its files, and the thread an agent step can continue.`,
  input: z.object({
    q: z.string().optional().describe("Words to search for; all must match. Omit to list every job."),
    limit: z.number().int().positive().optional().describe("At most this many, newest-used first."),
  }),
  output: z.object({ jobs: z.array(z.any()) }),
  async run(cfg, ctx) {
    return { jobs: await requireJobIndex(ctx.services).list(cfg) };
  },
});
