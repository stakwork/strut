import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { shellCapability, type StrutCapabilities } from "../../../capabilities.js";
import { holdJob, jobRoot, jobTtlMs, sweepJobs, touchJob } from "../../../jobs.js";

const EXAMPLE = `- id: dir
  type: job/dir
- id: work
  type: agent
  config:
    cwd: "{{ dir.path }}"
    session: "{{ $job }}"
    prompt: "{{ input.prompt }}"`;

/**
 * The job's directory (plans/jobs.md §2; jobs.ts) — the bridge between the
 * job a run was launched with (`ctx.job`, which workflow expressions see as
 * `{{ $job }}`) and the steps that take a path. Point an `agent` step's
 * `cwd` at `path`: the files it writes are there on the next run of the
 * job, and served at `GET /jobs/<job>/files/<path>`.
 *
 * A run with NO job (the Run button, a plain `POST …/run`) gets its own
 * artifact directory instead, so a job workflow also works as a one-shot:
 * its deliverables then resolve to `/artifacts/<runId>/…` (§3).
 */
export default defineStep({
  type: "job/dir",
  description:
    `This run's JOB directory: <dataDir>/jobs/<job>/, created on first use, the SAME path for every run launched with the same \`job\` (POST …/run { job }). ` +
    `Point an agent step's cwd at \`path\` so what it writes (plan.md, a page, screenshots) is there next turn and served at GET /jobs/<job>/files/<path>; declare deliverables in the workflow's output as artifacts: [{ id, title, path }]. ` +
    `Held by this run until it ends (a second run of the job fails \`job_busy:\`). Repositories checked out into it (git/checkout with workdir: "{{ $job }}") are removed once the job is idle for STRUT_WORKDIR_TTL_DAYS; its other files are kept. ` +
    `Without a job (the Run button, a plain POST) it returns the run's own artifact directory, so the workflow still works as a one-shot. Output: { path, job?, created }\n\n${EXAMPLE}`,
  input: z.object({}),
  output: z.object({
    path: z.string(),
    job: z.string().optional(),
    created: z.boolean(),
  }),
  async run(_cfg, ctx: StepContext<StrutCapabilities>) {
    const services = ctx.services as Partial<StrutCapabilities> | undefined;
    if (!ctx.job) {
      const artifacts = services?.artifacts;
      if (!artifacts) throw new Error("job/dir: this run has no job, and no artifacts capability to fall back on");
      const path = await artifacts.dir(ctx.runId);
      return { path, created: false };
    }
    const dataDir = services?.dataDir ?? join(tmpdir(), "strut");
    const root = jobRoot(dataDir, ctx.job);
    holdJob(ctx, root, ctx.job);
    const created = !existsSync(root);
    await mkdir(root, { recursive: true });
    // Used now — so the sweep leaves this job alone.
    await touchJob(root, ctx.job);
    await sweepJobs(services?.shell ?? shellCapability(), dataDir, jobTtlMs());
    return { path: root, job: ctx.job, created };
  },
});
