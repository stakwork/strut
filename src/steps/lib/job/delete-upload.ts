import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { JOB_UPLOADS_DIR, deleteJobUpload, jobRoot } from "../../../jobs.js";
import { idProblem } from "../../../session-store.js";

/**
 * One upload out of a job (plans/apps.md §12): the twin of `job/upload`,
 * for a page's library. Only a file under the job's `uploads/` — never
 * what a run wrote beside it.
 */
export default defineStep({
  type: "job/delete-upload",
  description:
    `Remove ONE file from a job's ${JOB_UPLOADS_DIR}/ folder, by the \`path\` job/upload returned (${JOB_UPLOADS_DIR}/<name>). ` +
    `Nothing else in the job's directory: a path outside ${JOB_UPLOADS_DIR}/ is refused. Output: { job, path, removed } — removed is false when there was no such file.`,
  input: z.object({
    job: z.string().describe("The job id."),
    path: z.string().describe(`The upload's path, relative to the job's directory (${JOB_UPLOADS_DIR}/<name>).`),
  }),
  output: z.object({ job: z.string(), path: z.string(), removed: z.boolean() }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const problem = idProblem(cfg.job);
    if (problem) throw new Error(`job/delete-upload: job "${cfg.job}" ${problem}`);
    const dataDir = (ctx.services as Partial<StrutCapabilities> | undefined)?.dataDir ?? join(tmpdir(), "strut");
    const removed = await deleteJobUpload(jobRoot(dataDir, cfg.job), cfg.job, cfg.path);
    return { job: cfg.job, path: cfg.path, removed };
  },
});
