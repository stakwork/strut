import { z } from "zod";
import { defineStep } from "../../../core.js";
import { RECENT, recentOutput } from "../context/recent.js";
import { requireJobIndex } from "./_shared.js";

/**
 * The `Jobs` page of Recent Work (plans/recent-work.md §5): this run's
 * person's jobs, newest used first, with the repositories each checked out.
 * Never another person's, so a person with none has an empty list.
 */
export default defineStep({
  type: "job/recent",
  description: "YOUR recent jobs here, newest used first: { items: [{ name (its title), what (its id, its repositories, whether it is working now), at }] }. Never another person's. job/get for one.",
  effect: "read",
  input: z.object({}),
  output: recentOutput,
  async run(_cfg, ctx) {
    if (!ctx.actor) return { items: [] };
    const jobs = await requireJobIndex(ctx.services).list({ actor: ctx.actor, limit: RECENT.pageItems });
    return {
      items: jobs.map((j) => ({
        name: j.title ?? j.job,
        what: [`job ${j.job}`, j.repos?.length ? j.repos.join(", ") : "", j.busy ? "working now" : ""].filter(Boolean).join("; "),
        at: j.usedAt,
      })),
    };
  },
});
