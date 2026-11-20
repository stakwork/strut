import { z } from "zod";
import { defineStep, isFirstParty, workflowOf, type StepContext } from "../../../core.js";
import { RUN_STEP_FLOW } from "../../../run-step.js";
import { requireKnowledge } from "./_shared.js";

/**
 * What the dream did, afterwards (docs/knowledge.md "The dream"): its recent
 * cycles, each with its lessons. The dream is sealed and its lessons quote
 * the conversations it read, so this answers the same viewer who sees the
 * dream's proposals (`pageSees`, src/proposals.ts): strut's own page, shown
 * to an admin of this server, in the page's own call. Not a workflow, an
 * agent's tool, a run the page launched, a member's page or a model-written
 * one. What a cycle changed is the history's: `history/read log { run }`.
 */
export default defineStep({
  type: "knowledge/cycles",
  effect: "read",
  description:
    "The dream's recent cycles, newest first, each a run that read something: { cycles: [{ run, status, startedAt, finishedAt, tree, source?, review, turns, more?, lessons: [{ session, turn, said, concept, claim, claim_id?, recorded?, change? }], stuck, error? }] }. " +
    "`review`: its changes waited for a person (proposals) instead of landing at once. What a cycle changed in the tree is in the history: `history/read log { run }`. " +
    "Only strut's own page shown to an admin may call it: the lessons quote what people said to their assistant.",
  input: z.object({
    tree: z.string().optional().describe("Only this tree's: the root Concept's name."),
    limit: z.number().int().min(1).max(100).default(20).describe("The most cycles."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const app = ctx?.app;
    if (!app || !isFirstParty(app) || app.admin !== true || workflowOf(ctx) !== RUN_STEP_FLOW) {
      throw new Error("knowledge/cycles is an admin's: only strut's own page, shown to an admin of this server, reads what the dream learned (it quotes the conversations it read)");
    }
    const knowledge = requireKnowledge(ctx, "knowledge/cycles");
    return { cycles: await knowledge.cycles({ limit: cfg.limit, ...(cfg.tree ? { tree: cfg.tree } : {}) }) };
  },
});
