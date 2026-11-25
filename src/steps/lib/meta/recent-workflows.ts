import { z } from "zod";
import { defineStep } from "../../../core.js";
import { RECENT, recentOutput } from "../context/recent.js";
import { requireAuthoring } from "./_shared.js";

/**
 * The `Workflows` page of Recent Work (plans/recent-work.md §5): the
 * workflows this run's person owns, then the rest, newest run first.
 * Strut's own (the seeds: the orchestrator, the job, the builder) are left
 * out: a person does not mean them.
 */
export default defineStep({
  type: "meta/recent-workflows",
  description:
    "The workflows you most likely mean: { items: [{ name, what (whose: yours or on this server; its description), at (its newest run) }] }, yours first, then the rest, newest run first. meta/get-workflow for one.",
  effect: "read",
  input: z.object({}),
  output: recentOutput,
  async run(_cfg, ctx) {
    const rows = await requireAuthoring(ctx.services).recentWorkflows(ctx.actor, RECENT.pageItems);
    return {
      items: rows.map((w) => ({
        name: w.name,
        what: [w.mine ? "yours" : "on this server", w.description].filter(Boolean).join(", "),
        ...(w.lastRunAt ? { at: new Date(w.lastRunAt).toISOString() } : {}),
      })),
    };
  },
});
