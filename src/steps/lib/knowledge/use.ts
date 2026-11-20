import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { proposerOf, requireAdminPage, requireTrials } from "./_shared.js";

/**
 * The page takes a test's other wording (plans/claim-trials.md §5): what a
 * person does when the change did better. An ordinary page is written at
 * once, and the history keeps it. A page whose text comes from git is never
 * changed in the graph (src/concept-sources.ts): where strut can write its
 * file the change becomes a `knowledge/write-pages` proposal, and elsewhere
 * it is refused, saying why. The test stays, and reads from the page's new
 * wording from then on.
 */
export default defineStep({
  type: "knowledge/use",
  effect: "write",
  description:
    "Put a test's other wording on the page (knowledge/test made the test). An ordinary page is changed at once: { ok, landed }. A page whose text comes from git becomes a proposal into its checkout ({ ok, proposed }), or is refused where this server has none. " +
    "Only strut's own page shown to an admin may call it.",
  input: z.object({ test: z.string().describe("The test, by id.") }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    requireAdminPage(ctx, "knowledge/use");
    const r = await requireTrials(ctx, "knowledge/use").use({ test: cfg.test, ...(ctx.actor ? { by: ctx.actor } : {}), proposer: proposerOf(ctx) });
    if (!("ok" in r)) throw new Error(r.error);
    return r;
  },
});
