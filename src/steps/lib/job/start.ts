import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { launchOnce, requireJobLaunch } from "./_shared.js";

/**
 * Hand work to a new JOB and return at once (the orchestrator's
 * `start_job`, as Jamie does in Hive): launches strut's `job` workflow
 * DETACHED under a fresh job id, titled, and returns its id and run id
 * without waiting. Unlike `meta/run-workflow`, which waits for the child
 * run, the calling turn ends while the job works — a chat's session stays
 * free. The job's `run.end` (its text, artifacts resolved to links, an
 * `ask`) goes to the launching run's own `callback`, so the host that asked
 * for this turn hears the job end. `job/continue` sends the job its next
 * message.
 */
export default defineStep({
  type: "job/start",
  description:
    "Start a JOB for bigger work (research, a page, a plan — anything that needs files, the web or many steps) and return at once: { job, runId, callback }. " +
    "The job runs ON ITS OWN in its own directory, with its own tools; this call does not wait for it. Its result (a reply, files, or a question) reaches the person when it ends — " +
    "so tell them in one line what you started and stop; do not wait, poll or guess its result. " +
    "To send the same job a follow-up (an answer to its question, a change), use job/continue with the `job` id this returns.",
  input: z.object({
    prompt: z.string().min(1).describe("Everything the job needs to know: what to do, for whom, and any detail from the conversation. The job does not see this conversation."),
    title: z.string().min(1).describe("A short name for the job, as the person would say it (\"Flights to Lisbon\"). How it is found later (job/list)."),
    repos: z.array(z.string()).optional().describe("Repository URLs to check out into the job's directory."),
  }),
  output: z.object({ job: z.string(), runId: z.string(), callback: z.boolean() }),
  async run(cfg, ctx: StepContext) {
    const launch = requireJobLaunch(ctx.services);
    return launchOnce(ctx, launch, {
      job: randomUUID(),
      title: cfg.title,
      input: { prompt: cfg.prompt, ...(cfg.repos?.length ? { repos: cfg.repos } : {}) },
    });
  },
});
