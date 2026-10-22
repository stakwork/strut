import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { JOB_WORKFLOWS } from "../../../jobs.js";
import { launchOnce, requireJobLaunch } from "./_shared.js";

/**
 * Hand work to a new JOB and return at once (the orchestrator's
 * `start_job`, as Jamie does in Hive): launches one of strut's job-shaped
 * workflows DETACHED under a fresh job id, titled, and returns its id and
 * run id without waiting. Unlike `meta/run-workflow`, which waits for the
 * child run, the calling turn ends while the job works — a chat's session
 * stays free. The job's `run.end` (its text, artifacts resolved to links,
 * an `ask`) goes to the launching run's own `callback`, so the host that
 * asked for this turn hears the job end. `job/continue` sends the job its
 * next message.
 *
 * `workflow` picks the hands (plans/builder-job.md §2): `job` (the default)
 * for code, research and pages (and an app over the job's own results);
 * `builder` when the thing to make or change is a WORKFLOW, or an APP that
 * lives in a workspace (new, changed, or on a peer) — the authoring twins and app/*,
 * no shell. The rule lives here, on
 * the field, where the model reads it beside the call; the kinds under the
 * `Workflow Builder` Concept, in the orchestrator's prompt beside the kinds
 * under `Job`, are what it routes here. `peer` goes with `builder` only: a workflow (or
 * an app) lives on one strut (its graph, secrets and services), so it is built on
 * the strut whose workspace it belongs to, and the local `builder` run
 * dispatches there (builder.yaml's `remote` branch); code lives in its
 * repository and is checked out here, so a code job runs here.
 */
export default defineStep({
  type: "job/start",
  description:
    "Start a JOB for bigger work (research, a page, a plan, a code change, a workflow or an app to build — anything that needs files, the web, tools or many steps) and return at once: { job, runId, callback }. " +
    "The job runs ON ITS OWN in its own directory, with its own tools; this call does not wait for it. Its result (a reply, files, or a question) reaches the person when it ends — " +
    "so tell them in one line what you started and stop; do not wait, poll or guess its result. " +
    "To send the same job a follow-up (an answer to its question, a change), use job/continue with the `job` id this returns.",
  input: z.object({
    prompt: z.string().min(1).describe("Everything the job needs to know: what to do, for whom, and any detail from the conversation. The job does not see this conversation."),
    title: z.string().min(1).describe("A short name for the job, as the person would say it (\"Flights to Lisbon\"). How it is found later (job/list)."),
    workflow: z
      .enum(JOB_WORKFLOWS)
      .optional()
      .describe(
        "Which hands the job gets. `job` (the default): code, research, pages, plans, an app over this job's own results — a working directory, repositories, the shell. " +
          "`builder`: the thing to build, change, test or debug is a WORKFLOW (an automation, a pipeline, a custom step, a schedule) or an APP that lives in a workspace (new, changed, or on another strut) — the authoring tools, no shell. " +
          "A workflow or a workspace's app belongs to one strut's workspace: a builder job builds on this strut unless `peer` names another.",
      ),
    peer: z
      .string()
      .optional()
      .describe(
        "With workflow: builder only — the strut the workflow or app belongs to when it is not this one, by id as strut/list-peers gives it (@acme-web → acme-web): the build happens there, under this job. Never with workflow: job.",
      ),
    repos: z.array(z.string()).optional().describe("Repository URLs to check out into the job's directory (workflow: job only — a builder job checks nothing out)."),
  }),
  output: z.object({ job: z.string(), runId: z.string(), callback: z.boolean() }),
  async run(cfg, ctx: StepContext) {
    const launch = requireJobLaunch(ctx.services);
    const workflow = cfg.workflow ?? "job";
    if (cfg.peer && workflow !== "builder") {
      throw new Error(`peer: only a builder job runs on another strut (workflow: builder); a code job runs here, with its repositories — leave peer out, or start a builder job`);
    }
    if (cfg.repos?.length && workflow === "builder") {
      throw new Error(`repos: a builder job checks nothing out — it authors workflows through its tools; leave repos out, or start a job (workflow: job) for work on a repository`);
    }
    return launchOnce(ctx, launch, {
      job: randomUUID(),
      title: cfg.title,
      ...(cfg.workflow ? { workflow: cfg.workflow } : {}),
      input: { prompt: cfg.prompt, ...(cfg.repos?.length ? { repos: cfg.repos } : {}), ...(cfg.peer ? { peer: cfg.peer } : {}) },
    });
  },
});
