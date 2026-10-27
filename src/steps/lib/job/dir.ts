import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { shellCapability, type StrutCapabilities } from "../../../capabilities.js";
import { holdJob, jobRoot, jobTtlMs, releaseWith, sweepJobs, touchJob } from "../../../jobs.js";

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
 * `hold: false` hands the directory out without holding it (plans/apps.md
 * §12): a library's readers — several viewers asking about a job's uploads
 * at once — never queue on `job_busy:`. A convention, not a sandbox: a run
 * that does not hold can still write, so it is for runs whose steps cannot.
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
    `Held by this run until it ends (a second run of the job fails \`job_busy:\`; a child run this one launches through meta/run-workflow shares it). Repositories checked out into it (git/checkout with workdir: "{{ $job }}") are removed once the job is idle for STRUT_WORKDIR_TTL_DAYS, and what the job holds (ctx.services.jobs — a pod a tool claimed) is released then; its other files are kept. ` +
    `With \`hold: false\` it returns the directory WITHOUT holding it, for a run that only reads what is there (a job's uploads/): several such runs of one job run at once, beside the one run that holds it, if any. Strut does not make a run that does not hold read-only — only take it for one whose steps cannot write there. ` +
    `Without a job (the Run button, a plain POST) it returns the run's own artifact directory, so the workflow still works as a one-shot. Output: { path, job?, created }\n\n${EXAMPLE}`,
  input: z.object({
    hold: z.boolean().default(true).describe("false: hand out the directory without holding it — for a run that only reads it."),
  }),
  output: z.object({
    path: z.string(),
    job: z.string().optional(),
    created: z.boolean(),
  }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const services = ctx.services as Partial<StrutCapabilities> | undefined;
    if (!ctx.job) {
      const artifacts = services?.artifacts;
      if (!artifacts) throw new Error("job/dir: this run has no job, and no artifacts capability to fall back on");
      const path = await artifacts.dir(ctx.runId);
      return { path, created: false };
    }
    const dataDir = services?.dataDir ?? join(tmpdir(), "strut");
    const root = jobRoot(dataDir, ctx.job);
    if (cfg.hold) holdJob(ctx, root, ctx.job);
    const created = !existsSync(root);
    await mkdir(root, { recursive: true });
    // Used now — so the sweep leaves this job alone.
    await touchJob(root, ctx.job);
    await sweepJobs(services?.shell ?? shellCapability(), dataDir, jobTtlMs(), { release: releaseWith(ctx.registry, ctx.services) });
    return { path: root, job: ctx.job, created };
  },
});
