import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { TRIAL_N_MAX } from "../../../trials.js";
import { requireAdminPage, requireTrials } from "./_shared.js";

/**
 * TEST a change to a page (plans/claim-trials.md §5): the page as it is and
 * the page with the change, run against every check on it. The test is
 * kept, both wordings with it, whatever it shows: lines taken out that make
 * it worse are proof those lines matter, and a change that does better can
 * be used (knowledge/use). Nothing on the page changes here.
 */
export default defineStep({
  type: "knowledge/test",
  effect: "write",
  description:
    "TEST a change to a Concept's page against the page as it is: every check on the page runs its cases `n` times on the changed wording, and the page is topped up to as many, so the two are measured alike. " +
    "`concept` + `docs` (the page's whole text, changed) makes the test; `test` (an id) runs an existing one again, `n` more on both. The page itself is not changed, and the test is kept with both wordings and their verdicts. " +
    "Returns at once with { ok, test, batch }; the verdicts arrive as they are judged (knowledge/checks: `tests`). Only strut's own page shown to an admin may call it.",
  input: z.object({
    concept: z.string().optional().describe("The Concept, by its exact name: with `docs`, a new test."),
    docs: z.string().optional().describe("The page's whole text with the change made."),
    test: z.string().optional().describe("An existing test, by id: run it again."),
    n: z.number().int().min(1).max(TRIAL_N_MAX).default(4).describe("Samples of each case, on each wording."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    requireAdminPage(ctx, "knowledge/test");
    if (!cfg.test && !(cfg.concept && cfg.docs !== undefined)) throw new Error("knowledge/test: give concept and docs (a new test), or test (an existing one)");
    const r = await requireTrials(ctx, "knowledge/test").test({
      ...(cfg.test ? { test: cfg.test } : { concept: cfg.concept!, docs: cfg.docs! }),
      n: cfg.n,
      ...(ctx.actor ? { by: ctx.actor } : {}),
      // The samples spend the asking job's budget (src/jobs.ts `budgetUsd`).
      ...(ctx.budgetJob ? { budgetJob: ctx.budgetJob } : {}),
    });
    if (!("ok" in r)) throw new Error(r.error);
    return r;
  },
});
