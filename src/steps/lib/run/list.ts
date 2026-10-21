import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { RUN_LIST_DEFAULT_LIMIT, RUN_LIST_MAX_LIMIT } from "../../../runs.js";
import { requireRuns } from "./_shared.js";

export default defineStep({
  type: "run/list",
  description:
    "A workflow's runs, newest first — each run's summary without its payloads: { runId, workflow, status, startedAt, finishedAt, durationMs, error?, actor?, origin?, automation?, job?, app?, totals? (model calls, tokens, cost), artifacts? (the run's deliverables as links) }. " +
    "A run still in flight has a live status (running, paused) and no finishedAt. Filter by status, since (ISO or ms — runs started at or after), automation (an id), job. " +
    "`job` with no `workflow` lists a JOB's runs across every workflow it ran (its turns and the runs they launched). " +
    `Default limit ${RUN_LIST_DEFAULT_LIMIT}, at most ${RUN_LIST_MAX_LIMIT}. run/get has a run's input and output.`,
  input: z.object({
    workflow: z.string().optional().describe("The workflow name. Leave out with `job` for every run of the job."),
    limit: z.number().int().positive().max(RUN_LIST_MAX_LIMIT).optional().describe(`How many, newest first (default ${RUN_LIST_DEFAULT_LIMIT}).`),
    status: z.string().optional().describe("Only runs with this status: success | error | cancelled, or a live state (running, paused)."),
    since: z.union([z.string(), z.number()]).optional().describe("Only runs started at or after this moment (ISO 8601, or ms since the epoch)."),
    automation: z.string().optional().describe("Only runs an automation fired, by its id."),
    job: z.string().optional().describe("Only runs launched under this job — with no `workflow`, all of them."),
  }).refine((q) => q.workflow || q.job, { message: "run/list needs `workflow`, or `job` for a job's runs" }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    return requireRuns(ctx.services).list(cfg);
  },
});
