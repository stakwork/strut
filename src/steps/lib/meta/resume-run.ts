import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";

export default defineStep({
  type: "meta/resume-run",
  description:
    "Resume a run. A PAUSED run continues where it parked. A run that FAILED, was cancelled, or was cut off by a restart is HEALED: it runs again under the same id, replaying every step that succeeded (no cost, no side effects) and running the rest. By default it runs on the workflow's ACTIVE version, so a fix you just published reaches it: steps that changed since the run started re-run with everything downstream of them (listed as `changed`). `version` picks another (\"v4\"), or \"run\" for the version the run started on; `from` (a step path from meta/get-run) re-runs from that step even where it succeeded, also on a successful run. Returns at once; follow the run with meta/get-run. Refused for a SEALED workflow, and for a run billed to someone other than this run's principal.",
  input: z.object({
    name: z.string().describe("Workflow name (a sealed workflow is refused)"),
    runId: z.string().describe("Run id (from meta/list-runs or a meta/run-workflow result)"),
    from: z.string().optional().describe('A step path to re-run from (e.g. "wf/result"), even where it succeeded.'),
    version: z
      .string()
      .optional()
      .describe('"active" (default), a version label ("v4"), or "run" — the version the run started on.'),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).resumeRun(
      cfg.name,
      cfg.runId,
      {
        ...(cfg.from ? { from: cfg.from } : {}),
        ...(cfg.version === "run" ? {} : { version: cfg.version || "active" }),
      },
      { ...(ctx.principal ? { principal: ctx.principal } : {}) },
    );
  },
});
