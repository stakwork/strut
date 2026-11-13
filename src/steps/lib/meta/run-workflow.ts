import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";

export default defineStep({
  type: "meta/run-workflow",
  description:
    "Run a published workflow with a given input, awaiting the result: { runId, status, output?, error? }. It runs as its OWN persisted run (inspect it with meta/get-run). Any workflow — a candidate you authored, a seeded one like pod-pr — except a SEALED one (a grading harness), which is refused by name. Sees steps and workflows published earlier in this same run (the registry is re-read fresh). Launched from a job run (POST …/run { job }) the child carries the same job: its {{ $job }} resolves to it and job/dir hands it the SAME directory, shared with this run rather than job_busy. The graph nodes the child run touched are reported on this step too (its log's step.end.nodes, deduplicated), so a reader of this run sees what the whole tree read or wrote. " +
    "`branch` runs it on a Concept branch (POST /branches makes one): its Concepts are the branch's, the rest of the graph live. A run on a branch runs every child on its own and may name no other.",
  input: z.object({
    name: z.string().describe("Workflow name to run"),
    input: z
      .any()
      .optional()
      .describe(
        "Input passed to the workflow as a JSON OBJECT (not a string), referenced in its steps via {{ input.* }}. Use {} if none.",
      ),
    params: z
      .record(z.string(), z.any())
      .optional()
      .describe(
        "Optional overrides for the workflow's `params` knobs (prompts, thresholds), shallow-merged over its defaults — those are runs, not versions.",
      ),
    version: z.string().optional().describe("Optional specific version. Defaults to the active version."),
    branch: z
      .string()
      .optional()
      .describe("Run it on this Concept branch (GET /branches lists them). Only from a run on main: a run on a branch runs its children on its own."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    // parentRunId links the child run's controller under this run's — so
    // cancelling/pausing this run reaches the children it launched
    // (RUN_CONTROL_SPEC §2.2 tree linkage).
    // A bare name from a workflow in a package is the package's own first
    // (src/package-lookup.ts).
    const name = ctx.resolveWorkflow ? await ctx.resolveWorkflow(cfg.name) : cfg.name;
    if (ctx.branch && cfg.branch && cfg.branch !== ctx.branch) {
      throw new Error(`branch_fixed: this run is on Concept branch "${ctx.branch}", and so is every run it starts — it cannot start one on "${cfg.branch}"`);
    }
    return requireAuthoring(ctx.services).runWorkflow(name, cfg.input, cfg.params, cfg.version, {
      parentRunId: ctx.runId,
      // Billed like the run that launched it (the principal rule, §2).
      ...(ctx.actor ? { actor: ctx.actor } : {}),
      ...(ctx.principal ? { principal: ctx.principal } : {}),
      // Under the same job (plans/jobs.md §4): the child's `{{ $job }}` and
      // `job/dir` are this run's, and it shares the directory this run holds.
      ...(ctx.job ? { job: ctx.job } : {}),
      // Its agents reach the same caller (`ctx.mcp`), as this run's do.
      ...(ctx.mcp?.length ? { mcp: ctx.mcp } : {}),
      // On this run's Concept branch, or (from main) the one named; a run on
      // a branch naming another is refused (src/branches.ts).
      ...((cfg.branch ?? ctx.branch) ? { branch: (cfg.branch ?? ctx.branch)! } : {}),
    });
  },
});
