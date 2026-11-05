import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { CLAIMS_OFF } from "../../../claims-schemas.js";
import { requirePersonOnJob } from "./_shared.js";

/**
 * A PERSON verifies a job now (plans/job-claims.md §5, door two): what
 * `POST /jobs/:id/verify` does, from strut's own app's claims card
 * (plans/jamie-app.md §5) — every claim about the job (or `claims`) checked
 * against its newest turn, `manual` checks included. `detach` answers at
 * once and the verdicts arrive on the job's live updates (`job/updates`:
 * `evidence` per check, then `verify` done), for a pass longer than a
 * page's call may wait.
 */
export default defineStep({
  type: "job/verify",
  effect: "write",
  description:
    "A person verifies a job now, from strut's own app only: every check on every claim about the job (or `claims`) runs against its newest turn — `manual` checks too — and the pass and the job's ledger come back. " +
    "`detach: true` returns { job, started: true } at once; the verdicts arrive on job/updates (kind evidence, then verify done). An agent verifies with meta/verify-job.",
  input: z.object({
    job: z.string().min(1).describe("The job id."),
    claims: z.array(z.string()).optional().describe("Claim ids to verify (default: every claim about the job)."),
    detach: z.boolean().optional().describe("Answer at once; follow the verdicts on job/updates."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const jobs = await requirePersonOnJob(ctx, "job/verify", cfg.job);
    if (!jobs.verify) throw new Error(CLAIMS_OFF);
    const out = await jobs.verify(cfg.job, { ...(cfg.claims ? { claims: cfg.claims } : {}), ...(cfg.detach ? { detach: true } : {}) });
    if (out === null) throw new Error(`No job "${cfg.job}"`);
    if (out && typeof out === "object" && "error" in out) throw new Error(String((out as { error: unknown }).error));
    return out;
  },
});
