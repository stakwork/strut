import { z } from "zod";
import { defineStep, isFirstParty, workflowOf, type StepContext } from "../../../core.js";
import { proposalsOf, proposalUrl } from "../../../proposals.js";
import { RUN_STEP_FLOW } from "../../../run-step.js";

/**
 * A PERSON's decision on a proposal, from strut's own app (plans/jamie-app.md
 * §3): what `POST /proposals/:id/decide` does for a person token, as the
 * page's viewer — accept applies the step in code with the recorded input
 * (the person's edits merged), reject records the reason. Only the viewer's
 * own proposals.
 *
 * It runs only as a FIRST-PARTY page's own call (`step_run`, a one-step run):
 * never from a model-written page, and never as an agent's tool — a run the
 * page launched carries the page's app too, and a model never decides what
 * it proposed.
 */
export default defineStep({
  type: "proposal/decide",
  effect: "write",
  description:
    "A person's decision on a proposal, from strut's own app only: accept runs the proposed step with its input (and `input`, the person's edits, merged), reject records `reason`. " +
    "Only the viewer's own proposals. Returns the record after the decision (status applied, rejected or failed). An agent never decides a proposal.",
  input: z.object({
    id: z.string().min(1).describe("The proposal id."),
    action: z.enum(["accept", "reject"]),
    input: z.record(z.string(), z.any()).optional().describe("The person's edits, merged one level onto the proposal's input on accept."),
    reason: z.string().optional().describe("Why, on a reject."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    if (!isFirstParty(ctx.app) || !ctx.actor || workflowOf(ctx) !== RUN_STEP_FLOW) {
      throw new Error(
        "proposal/decide is a person's decision: it runs only as strut's own app's call, for its viewer (plans/jamie-app.md §3). A person decides at POST /proposals/:id/decide; an agent never does.",
      );
    }
    const cap = proposalsOf(ctx.services);
    if (!cap?.decide) throw new Error("proposal/decide needs strut's proposals (ctx.services.proposals); the standard strut server provides them.");
    const outcome = await cap.decide(cfg.id, {
      action: cfg.action,
      ...(cfg.input ? { input: cfg.input } : {}),
      ...(cfg.reason ? { reason: cfg.reason } : {}),
      by: ctx.actor,
      scope: "peer:person",
    });
    if (outcome.status !== 200) throw new Error((outcome.body as { error: string }).error);
    const p = outcome.body as { id: string };
    return { ...p, url: proposalUrl(p.id) };
  },
});
