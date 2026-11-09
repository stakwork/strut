import { z } from "zod";
import { defineStep, workflowOf, type StepContext } from "../../../core.js";
import { proposalsOf, proposalUrl } from "../../../proposals.js";
import { RUN_STEP_FLOW } from "../../../run-step.js";

/** One proposal, whole: its step and input, who proposed it, the decision
 *  and the result (plans/proposals.md §2). A page's own call (an app's
 *  `step_run`) also gets `viewer: { admin }` — whether its viewer is an admin
 *  here (`AppRef.admin`), so a card says "an admin must approve this" in
 *  place of an Accept the decision would refuse (`approver: admin`). */
export default defineStep({
  type: "proposal/get",
  description:
    "One proposal read back: { id, step, input, rationale?, title, approver?, status, createdAt, by: { workflow, runId, job?, session? }, decision?: { action, by?, at, input?, reason? }, result?: { output?, error?, at }, url }. " +
    "`input` is exactly what the step runs with on accept (plus any edits in decision.input). `approver: admin`: only an admin of this strut server accepts it.",
  input: z.object({ id: z.string().min(1).describe("The proposal id, from proposal/list or a tool's { proposal }.") }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const cap = proposalsOf(ctx.services);
    if (!cap) throw new Error("proposal/* steps need strut's proposals (ctx.services.proposals); the standard strut server provides them.");
    const p = await cap.get(cfg.id);
    if (!p) throw new Error(`No proposal "${cfg.id}"`);
    // A page's own call: whether its viewer may accept what only an admin does.
    const page = ctx.app && workflowOf(ctx) === RUN_STEP_FLOW;
    return { ...p, url: proposalUrl(p.id), ...(page ? { viewer: { admin: ctx.app!.admin === true } } : {}) };
  },
});
