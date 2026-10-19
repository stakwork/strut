import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { proposalsOf, proposalUrl } from "../../../proposals.js";

/** One proposal, whole: its step and input, who proposed it, the decision
 *  and the result (plans/proposals.md §2). */
export default defineStep({
  type: "proposal/get",
  description:
    "One proposal read back: { id, step, input, rationale?, title, status, createdAt, by: { workflow, runId, job?, session? }, decision?: { action, by?, at, input?, reason? }, result?: { output?, error?, at }, url }. " +
    "`input` is exactly what the step runs with on accept (plus any edits in decision.input).",
  input: z.object({ id: z.string().min(1).describe("The proposal id, from proposal/list or a tool's { proposal }.") }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const cap = proposalsOf(ctx.services);
    if (!cap) throw new Error("proposal/* steps need strut's proposals (ctx.services.proposals); the standard strut server provides them.");
    const p = await cap.get(cfg.id);
    if (!p) throw new Error(`No proposal "${cfg.id}"`);
    return { ...p, url: proposalUrl(p.id) };
  },
});
