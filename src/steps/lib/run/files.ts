import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { RUN_FILE_MAX_BYTES } from "../../../runs.js";
import { requireRuns, inFrame, callerOf } from "./_shared.js";

export default defineStep({
  type: "run/files",
  description:
    "ONE file a run produced — from its job's directory when it ran under a job, else its own artifact directory (what its artifact links point at): { path, mediaType, bytes, text } for a text file, { …, base64 } for anything else, " +
    `cut at ${RUN_FILE_MAX_BYTES} bytes (truncated: true). The path is relative to that directory, as the run's artifacts and GET /artifacts/:runId list it, and never leaves it.`,
  input: z.object({
    workflow: z.string().describe("The workflow name."),
    runId: z.string().describe("The run id."),
    path: z.string().describe("The file, relative to the run's directory (a job's, or its artifacts)."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const file = await requireRuns(ctx.services).files(await inFrame({ workflow: cfg.workflow, runId: cfg.runId, path: cfg.path }, ctx), callerOf(ctx));
    if (!file) throw new Error(`No file "${cfg.path}" in run "${cfg.runId}" of "${cfg.workflow}"`);
    return file;
  },
});
