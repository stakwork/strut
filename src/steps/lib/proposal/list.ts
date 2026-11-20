import { z } from "zod";
import { defineStep, isFirstParty, workflowOf, type StepContext } from "../../../core.js";
import { briefOf, proposalsOf, type ProposalStatus } from "../../../proposals.js";
import { RUN_STEP_FLOW } from "../../../run-step.js";

/**
 * The proposals on file (plans/proposals.md §3) as an agent reads them —
 * what is waiting on the person, what they decided. Reads only: a person
 * decides, at POST /proposals/:id/decide or in strut's own app
 * (proposal/decide).
 */
const STATUSES = ["pending", "accepted", "rejected", "applied", "failed"] as const;

export default defineStep({
  type: "proposal/list",
  description:
    "The proposals on file — tool calls waiting on the person's approval, and the ones they decided: { proposals: [{ id, step, title, status, url, rationale?, createdAt, decidedAt? }], more? }, newest first, at most `limit` (`more: true` when there are others). " +
    "status: pending (waiting), applied (accepted and done), rejected, failed (accepted, but the step failed). Filter by job, session, the workflow whose run made it, or status; `input: true` adds what each step would run with. Nothing here decides one: the person does.",
  input: z.object({
    job: z.string().optional().describe("Only this job's."),
    session: z.string().optional().describe("Only this thread's."),
    workflow: z.string().optional().describe("Only those a run of this workflow made."),
    status: z.enum(STATUSES).optional().describe("Only this status."),
    input: z.boolean().optional().describe("Also each one's `input`: what its step runs with on accept."),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const cap = proposalsOf(ctx.services);
    if (!cap) throw new Error("proposal/* steps need strut's proposals (ctx.services.proposals); the standard strut server provides them.");
    // An app's page (and what it launched) sees its viewer's own, as their
    // person token does (`visibleTo`): a page never lists another person's.
    // Strut's own page, called by the page itself, also shows an admin what
    // no conversation made (`pageSees`): the dream's. Decided on the index,
    // like the limit, so only the page returned is read (one more, for `more`).
    const own = ctx.app && isFirstParty(ctx.app) && workflowOf(ctx) === RUN_STEP_FLOW;
    const listed = await cap.list({
      ...(cfg.job ? { job: cfg.job } : {}),
      ...(cfg.session ? { session: cfg.session } : {}),
      ...(cfg.workflow ? { workflow: cfg.workflow } : {}),
      ...(cfg.status ? { status: cfg.status as ProposalStatus } : {}),
      ...(ctx.app ? { viewer: { scope: "peer:person" as const, ...(ctx.actor ? { actor: ctx.actor } : {}), ...(own && ctx.app.admin === true ? { admin: true } : {}) } } : {}),
      limit: cfg.limit + 1,
    });
    const page = listed.slice(0, cfg.limit);
    return { proposals: page.map((p) => (cfg.input ? { ...briefOf(p), input: p.input } : briefOf(p))), ...(listed.length > page.length ? { more: true } : {}) };
  },
});
