import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { RUN_FILE_MAX_BYTES } from "../../../runs.js";
import { requireRuns } from "./_shared.js";

export default defineStep({
  type: "run/files",
  description:
    "ONE file a run produced — from its job's directory when it ran under a job, else its own artifact directory (what its artifact links point at): { path, mediaType, bytes, text } for a text file, { …, base64 } for anything else, " +
    `cut at ${RUN_FILE_MAX_BYTES} bytes (truncated: true). The path is relative to that directory, as the run's artifacts and GET /artifacts/:runId list it, and never leaves it. ` +
    "`job` + `path` with no run reads a file of that job's directory.",
  input: z.object({
    workflow: z.string().optional().describe("The workflow name (with `runId`)."),
    runId: z.string().optional().describe("The run id (with `workflow`)."),
    job: z.string().optional().describe("Instead of a run: the job whose directory `path` is in."),
    path: z.string().describe("The file, relative to the run's directory (a job's, or its artifacts)."),
  }).refine((q) => (q.workflow && q.runId) || q.job, { message: "run/files needs `workflow` + `runId`, or `job`" }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const runs = requireRuns(ctx.services);
    const file = cfg.workflow && cfg.runId ? await runs.files({ workflow: cfg.workflow, runId: cfg.runId, path: cfg.path }) : await runs.files({ job: cfg.job!, path: cfg.path });
    if (!file) throw new Error(cfg.runId ? `No file "${cfg.path}" in run "${cfg.runId}" of "${cfg.workflow}"` : `No file "${cfg.path}" in job "${cfg.job}"`);
    return file;
  },
});
