import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { briefOf, proposalsOf, type ProposalStatus } from "../../../proposals.js";

/**
 * The proposals on file (plans/proposals.md §3) as an agent reads them —
 * what is waiting on the person, what they decided. Reads only: no step
 * decides a proposal; a person does, at POST /proposals/:id/decide.
 */
const STATUSES = ["pending", "accepted", "rejected", "applied", "failed"] as const;

export default defineStep({
  type: "proposal/list",
  description:
    "The proposals on file — tool calls waiting on the person's approval, and the ones they decided: [{ id, step, title, status, url, rationale?, createdAt, decidedAt? }], newest first. " +
    "status: pending (waiting), applied (accepted and done), rejected, failed (accepted, but the step failed). Filter by job, session or status. Nothing here decides one: the person does.",
  input: z.object({
    job: z.string().optional().describe("Only this job's."),
    session: z.string().optional().describe("Only this thread's."),
    status: z.enum(STATUSES).optional().describe("Only this status."),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const cap = proposalsOf(ctx.services);
    if (!cap) throw new Error("proposal/* steps need strut's proposals (ctx.services.proposals); the standard strut server provides them.");
    const all = await cap.list({
      ...(cfg.job ? { job: cfg.job } : {}),
      ...(cfg.session ? { session: cfg.session } : {}),
      ...(cfg.status ? { status: cfg.status as ProposalStatus } : {}),
    });
    return { proposals: all.slice(0, cfg.limit).map(briefOf), total: all.length };
  },
});
