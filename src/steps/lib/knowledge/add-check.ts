import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { requireAdminPage, requireTrials } from "./_shared.js";

/**
 * A CHECK a person adds to a page in the Knowledge app: one sentence the
 * work of every run that opens the page must hold to, judged by the
 * standard check (`concept-check`). The tender's twin is
 * `knowledge/add-claim`, which is sealed; this one is the admin's page's.
 */
export default defineStep({
  type: "knowledge/add-check",
  effect: "write",
  description:
    "Add a CHECK to a Concept's page: ONE sentence the work of every run that opens the page must hold to (\"Asked whether it can do something its work can do, it says yes\"). " +
    "A model judges each later run that opened the page against it; give it cases with knowledge/cases and run them with knowledge/trial. The same sentence already on the page returns that one (`existing: true`). " +
    "Only strut's own page shown to an admin may call it. Returns { ok, id }.",
  input: z.object({
    concept: z.string().describe("The Concept the check is on, by its exact name."),
    text: z.string().describe("ONE plain sentence that should hold."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    requireAdminPage(ctx, "knowledge/add-check");
    const r = await requireTrials(ctx, "knowledge/add-check").addCheck({ concept: cfg.concept, text: cfg.text, ...(ctx.actor ? { by: ctx.actor } : {}) });
    if (!("ok" in r)) throw new Error(r.error);
    return r;
  },
});
