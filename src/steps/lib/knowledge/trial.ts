import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { TRIAL_N_MAX } from "../../../trials.js";
import { requireAdminPage, requireTrials } from "./_shared.js";

/**
 * RUN a check (plans/claim-trials.md §3): each of its cases, `n` times, as
 * fresh runs on the page as it is. A run is a TRIAL: nothing it starts
 * leaves it (a job, a proposal, a run on another strut are held), and the
 * check judges every sample whatever its policy. Returns at once; the
 * verdicts land as evidence, which knowledge/checks reads.
 */
export default defineStep({
  type: "knowledge/trial",
  effect: "write",
  description:
    "RUN a check on a Concept: each of its cases, `n` times, as fresh runs, each judged by the check and by every other check the same case tests. A run here is a trial: the jobs it would start, its proposals and its runs on other servers are held, so it leaves nothing behind; a case whose workflow is a job's runs as a job of its own (with what it holds, a pod), closed once it is judged. " +
    "Returns at once with { ok, batch: { id, total, done } }; the verdicts arrive as they are judged (knowledge/checks: `samples`, and `running` while any is left). Each sample spends as a run and its judge do. " +
    "Only strut's own page shown to an admin may call it.",
  input: z.object({
    claim: z.string().describe("The check, by its claim id."),
    n: z.number().int().min(1).max(TRIAL_N_MAX).default(4).describe("Samples of each case."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    requireAdminPage(ctx, "knowledge/trial");
    const r = await requireTrials(ctx, "knowledge/trial").trial({
      claim: cfg.claim,
      n: cfg.n,
      ...(ctx.actor ? { by: ctx.actor } : {}),
      // The samples spend the asking job's budget (src/jobs.ts `budgetUsd`).
      ...(ctx.budgetJob ? { budgetJob: ctx.budgetJob } : {}),
    });
    if (!("ok" in r)) throw new Error(r.error);
    return r;
  },
});
