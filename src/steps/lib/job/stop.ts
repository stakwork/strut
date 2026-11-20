import { z } from "zod";
import { defineStep, isFirstParty, type StepContext } from "../../../core.js";
import type { JobsCapability } from "../../../jobs.js";
import { appScoped } from "../../../session-store.js";

/**
 * Stop what a JOB has in flight (the orchestrator's answer to "cancel
 * that"): its turn, with every run under it, and any run a turn left going
 * — a builder's test run. Without it a job that is working could only be
 * waited out (`job_busy:`), so a person who changed their mind mid-build
 * was heard only once the build was done.
 *
 * It waits for the stop to land (`JOB_STOP_WAIT_MS`), so a `job/continue`
 * right after finds the job free. A stop is cooperative, as every cancel
 * is: an agent finishes the model call it is on. One that outlasts the wait
 * comes back `stopping`, and its end wakes the conversation as a stopped
 * turn's does. A turn that ended inside the wait wakes nothing: this call's
 * result already said so.
 *
 * The job is kept — its directory, its thread, what it published — but an
 * agent stopped before its answer commits nothing to its thread, so the job
 * may not remember the turn. The result says so, since the next message
 * must carry what it needs.
 */
export default defineStep({
  type: "job/stop",
  description:
    "Stop what a JOB is doing now: the turn it is working on, and any run it left going (a test run of what it built). " +
    "Use it when the person asks to stop or cancel the job's work, or wants something other than what it is doing — never because they asked how it is going. " +
    "It waits for the work to stop and returns { job, stopped: [{ workflow, runId, turn? }], note }: `stopped` is empty when nothing was running, `turn` marks the job's own turn, and `stopping: true` means it is still finishing the step it was on. " +
    "The job, its files and what it published are kept, and job/continue takes it up again.",
  effect: "write",
  input: z.object({
    job: z.string().min(1).describe("The job id, from job/start or job/list."),
  }),
  output: z.object({
    job: z.string(),
    stopped: z.array(z.object({ workflow: z.string(), runId: z.string(), turn: z.boolean().optional() })),
    stopping: z.boolean().optional(),
    note: z.string(),
  }),
  async run(cfg, ctx: StepContext) {
    const jobs = (ctx.services as { jobs?: JobsCapability } | undefined)?.jobs;
    if (!jobs?.stop) {
      throw new Error("job/stop needs a server to stop the job's runs on (ctx.services.jobs.stop). The standard strut server provides it.");
    }
    // As job/continue: a turn an APP launched reaches only the app's jobs.
    const job = ctx.app && !isFirstParty(ctx.app) ? appScoped(ctx.app.name, cfg.job) : cfg.job;
    if (jobs.get && !(await jobs.get(job, { threads: false }))) throw new Error(`No job "${job}"`);
    const { stopped, stopping } = await jobs.stop(job, { from: ctx.runId });
    const note = !stopped.length
      ? "Nothing of this job was running."
      : stopping
        ? "Told to stop, and still finishing the step it was on. job/continue is refused until it ends; its end reaches you as a message."
        : stopped.some((r) => r.turn)
          ? "Stopped. The job may not remember the turn that was stopped: when you continue it, say again what it needs."
          : "Stopped the run the job left going. The job had ended its turn, and remembers it.";
    return { job, stopped, ...(stopping ? { stopping } : {}), note };
  },
});
