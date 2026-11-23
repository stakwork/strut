import { z } from "zod";
import type { StrutCapabilities } from "../../../capabilities.js";
import { buildCard } from "../../../proposal-card.js";
import { proposalsOf } from "../../../proposals.js";
import { defineStep, type StepContext } from "../../../core.js";
import { proposerOf, requireTree } from "./_shared.js";

const STEP = "knowledge/merge";

/**
 * MERGE a Concept branch into main (plans/concept-evals.md item e;
 * src/branch-merge.ts): what the branch changed since its fork lands on
 * main — ordinary pages at once, pages whose text comes from git as one
 * proposal per checkout (or skipped, and listed) — then the branch is
 * dropped, its git branch kept under `refs/dropped/`. Refused, naming the
 * pages, where main changed one of them too. The step is the door of an
 * EVAL WORKFLOW, e.g. after `knowledge/compare` says `better`; strut never
 * merges on a score by itself, and grants this to nothing.
 *
 * Automatic by default; a person's yes is a setting (ruling 2): `review:
 * true` (the workflow passes its own input or param) makes the merge a
 * proposal of this step that waits for a yes, its card saying what would
 * land, be proposed and be skipped. An ADMIN's yes (`approver: "admin"`):
 * the Concept branches are the deployment's.
 */
export default defineStep({
  type: STEP,
  effect: "write",
  approver: "admin",
  description:
    "Merge a Concept BRANCH into main: what the branch changed since it was made (pages edited, added or removed, and their PARENT_OF links) is applied to main, then the branch is dropped. " +
    "A page whose text comes from git is never changed by a merge: it becomes a proposal into its checkout, or is skipped where strut has none. Refused, naming the pages, when main changed one of the same pages since. " +
    "`review: true` makes the merge itself a proposal a person accepts first. " +
    "Answers { branch, base, head, landed, proposed, skipped, commit?, dropped } — or { status: 'pending', proposal } under review.",
  input: z.object({
    branch: z.string().describe("The Concept branch, by name (GET /branches lists them)."),
    review: z.boolean().optional().describe("true: the merge waits for a person's yes, as a proposal; false or absent: it is made now."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    requireTree(ctx, STEP);
    if (ctx.branch) throw new Error(`${STEP}: a merge is main's, and this run is on Concept branch "${ctx.branch}"`);
    const branches = ctx.services?.branches;
    if (!branches) throw new Error(`${STEP} needs the Concept branches (ctx.services.branches): a graph, on the standard strut server`);
    const by = proposerOf(ctx);
    if (cfg.review && !ctx.proposal) {
      const plan = await branches.merge(cfg.branch, { dryRun: true, ...(ctx.actor ? { actor: ctx.actor } : {}) });
      const proposals = proposalsOf(ctx.services);
      if (!proposals) throw new Error(`${STEP}: review is on and this strut server records no proposals`);
      const list = (xs: Array<{ name: string }>) => (xs.length ? xs.map((x) => x.name).join(", ") : "none");
      const title = `Merge Concept branch "${cfg.branch}" into main`;
      const summary =
        `Lands on main: ${list(plan.landed)}. ` +
        (plan.proposed.length ? `Proposed into a checkout, for a yes of their own: ${plan.proposed.map((p) => `${list(p.pages)} (${p.checkout})`).join("; ")}. ` : "") +
        (plan.skipped.length ? `Skipped, their text comes from git: ${list(plan.skipped)}. ` : "") +
        `Then the branch is dropped, its history kept.`;
      const input = { branch: cfg.branch };
      const card = buildCard({
        input,
        title,
        summary,
        described: {
          fields: [
            { label: "Branch", value: cfg.branch, kind: "ref" },
            { label: "Lands", value: list(plan.landed) },
            { label: "Proposed", value: plan.proposed.map((p) => `${list(p.pages)} → ${p.checkout}`).join("; ") || "none" },
            { label: "Skipped", value: list(plan.skipped) },
          ],
          actions: { accept: "Merge", reject: "Keep main as it is" },
        },
      });
      const rec = await proposals.propose({ step: STEP, input, title, summary, card, approver: "admin", by });
      return { status: "pending", proposal: rec.id, url: `/proposals/${encodeURIComponent(rec.id)}`, plan };
    }
    return branches.merge(cfg.branch, { ...(ctx.actor ? { actor: ctx.actor } : {}), ...(ctx.proposal ? {} : { run: ctx.runId }), by });
  },
});
