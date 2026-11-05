import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { CLAIMS_OFF } from "../../../claims-schemas.js";
import { requirePersonOnJob } from "./_shared.js";

/**
 * A PERSON's verdict on a claim about a job (plans/job-claims.md §7): what
 * `POST /claims/:id/evidence { job, runId }` does, from strut's own app's
 * claims card (plans/jamie-app.md §5) — "it does / it does not", about one
 * of the job's turns, `asserted` and `by: person`. A check that waits on a
 * person's look (an open slot) is answered this way: pass its `slot`.
 */
export default defineStep({
  type: "job/evidence",
  effect: "write",
  description:
    "A person's verdict on a claim about a job, from strut's own app only: `supports` true or false about the job's turn `runId`, with `content` saying what they saw. " +
    "Recorded as asserted evidence by a person; `slot` answers a check that is waiting on a person's look. Returns { ok, evidence, filled, subject }.",
  input: z.object({
    job: z.string().min(1).describe("The job id."),
    claim: z.string().min(1).describe("The claim id (job/get's claims)."),
    runId: z.string().min(1).describe("The job's turn the verdict is about — its newest, usually."),
    supports: z.boolean().describe("true: it does what the claim says; false: it does not."),
    content: z.string().min(1).describe("What the person saw, in their words."),
    slot: z.string().optional().describe("The open slot to answer (an external check's evidence id)."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const jobs = await requirePersonOnJob(ctx, "job/evidence", cfg.job);
    if (!jobs.evidence) throw new Error(CLAIMS_OFF);
    const out = await jobs.evidence({ job: cfg.job, claim: cfg.claim, runId: cfg.runId, supports: cfg.supports, content: cfg.content, ...(cfg.slot ? { slot: cfg.slot } : {}) });
    if (out && typeof out === "object" && "error" in out) throw new Error(String((out as { error: unknown }).error));
    return out;
  },
});
