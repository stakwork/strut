import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";

export default defineStep({
  type: "meta/list-workflows",
  description:
    "List published workflows — each one's name, description, category, active version, publisher stamp, `owner`, and the newest version's `actor` (the person who last published it; absent for seeds/installs) and `published_at` (ISO UTC) — up to `limit` (default 100); the result carries `total` and a `hint` when the list was cut, so pass `query` then (keywords; every word must hit the name, category or description). Use to discover what exists before authoring — only workflows stamped publisher 'ai' can be republished through the meta surface; any workflow can be run and its runs read except a SEALED one (a grading harness). meta/get-workflow for a workflow's YAML and versions.",
  input: z.object({
    query: z
      .string()
      .optional()
      .describe("Keywords to filter by — every word must hit the name, category or description. Omit to list everything (up to limit)."),
    actor: z.string().optional().describe("Only workflows whose newest version was published by (or owned by) an actor containing this, case-insensitive — 'evan' matches 'Evanfeenstra-cmd…'."),
    sort: z.enum(["name", "recent"]).optional().describe("'recent' = most recently published first (answers 'what did X work on last?', with actor). Default: by name."),
    limit: z.number().int().positive().optional().describe("Max workflows to return (default 100)."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).listWorkflows(cfg.query, cfg.limit, { actor: cfg.actor, sort: cfg.sort === "recent" ? "recent" : undefined });
  },
});
