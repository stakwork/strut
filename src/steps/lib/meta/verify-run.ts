import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";

export default defineStep({
  type: "meta/verify-run",
  description:
    "Verify a finished run NOW and wait for it: run the checks of every claim on the subjects the run executed and write the evidence. Runs are verified automatically after they finish, but DETACHED — a harness that reads claim statuses right after a run must call this first (it is single-flighted with the automatic pass and idempotent, so whichever starts second just awaits the first and nothing is written twice). Also re-verifies after a claim or check changed, and fires `manual` checks. `name` is an agent-authored workflow, or `step:<type>` for a kept meta/run-step run. Returns per-check lastVerify: { ran } | { skipped: policy | budget | cannot-launch | unknown-version | denied, reason? } | { planned: <evidence id> }; read statuses with meta/list-claims.",
  input: z.object({
    name: z.string().describe("Workflow name, or `step:<type>` for a kept single-step run"),
    runId: z.string(),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).verifyRun(cfg.name, cfg.runId);
  },
});
