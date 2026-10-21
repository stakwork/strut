import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { JobsCapability } from "../../../jobs.js";
import { launchOnce, requireJobLaunch } from "./_shared.js";

/**
 * The next message of an existing JOB (the orchestrator's `continue_job`):
 * launches the job's workflow DETACHED under that job — its directory, its
 * thread — and returns at once, like `job/start`. WHICH workflow is the
 * record's, not the caller's: the launcher follows the job's newest turn
 * (`turnOf`, jobs.ts — a builder job stays a builder job, and one on a peer
 * carries that turn's `input.peer` along), so the caller names only the
 * job. Refused (`job_busy:`) while a run of the job is in flight, and for a
 * job not on file.
 */
export default defineStep({
  type: "job/continue",
  description:
    "Send an existing JOB its next message — the answer to its question, a change, \"go on\" — and return at once: { job, runId, callback }. " +
    "It continues in the job's own directory and thread, remembering its earlier turns, with the same hands it had (a builder job goes on building, where it builds); this call does not wait for it, and its result reaches the person when it ends. " +
    "Refused while the job is still working (job_busy: its result is on the way). The `job` id is the one job/start returned, or one job/list finds.",
  input: z.object({
    job: z.string().min(1).describe("The job id, from job/start or job/list."),
    prompt: z.string().min(1).describe("The message for the job. It does not see this conversation: include what it needs."),
    session: z.string().optional().describe("Another of the job's threads to continue (job/get lists them). Defaults to the job's own."),
  }),
  output: z.object({ job: z.string(), runId: z.string(), callback: z.boolean() }),
  async run(cfg, ctx: StepContext) {
    const launch = requireJobLaunch(ctx.services);
    const index = (ctx.services as { jobs?: JobsCapability } | undefined)?.jobs;
    if (index?.get && !(await index.get(cfg.job, { threads: false }))) throw new Error(`No job "${cfg.job}"`);
    return launchOnce(
      ctx,
      launch,
      { job: cfg.job, input: { prompt: cfg.prompt, ...(cfg.session ? { session: cfg.session } : {}) } },
      cfg.job,
    );
  },
});
