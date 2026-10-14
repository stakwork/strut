import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";

/**
 * Door one of plans/job-claims.md §5: the work agent verifies the JOB —
 * the work, not the shape of its answer — mid-turn, before it reports.
 * The version is THIS run (`ctx.runId`, a turn still in flight) when the
 * job is the run's own; another job's is verified at its newest turn.
 * Sealed by namespace like every `meta/*` step, grantable to the job agent.
 */
export default defineStep({
  type: "meta/verify-job",
  description:
    "Verify the JOB's claims NOW — the work itself (the page renders, the endpoint answers), not this run's shape — and wait: run every check on every claim about the job, with THIS turn as the version, and return the job's ledger: each claim's status (supported | refuted | stale | unknown) with the evidence's content and locator (a screenshot's url) and each check's lastVerify ({ ran } | { skipped: policy | budget | cannot-launch | superseded | denied, reason? } | { planned: <evidence id> } — an external check waiting on a person). Checks on a job are `manual` by default: this is what fires them. Call it when you believe the work is ready, act on anything refuted or unknown (fix, or fix the check), verify again, and only then answer. A second call on the same turn measures again — a pod that was restarting is up now. `claims` narrows to claim ids; `job` defaults to this run's job.",
  input: z.object({
    job: z.string().optional().describe("The job id (default: the job this run was launched under)."),
    claims: z.array(z.string()).optional().describe("Claim ids to verify (default: every claim about the job)."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const job = cfg.job ?? ctx.job;
    if (!job) throw new Error("meta/verify-job: this run was not launched under a job — pass `job`");
    return requireAuthoring(ctx.services).verifyJob(job, { ...(cfg.claims ? { claims: cfg.claims } : {}), ...(job === ctx.job ? { runId: ctx.runId } : {}) });
  },
});
