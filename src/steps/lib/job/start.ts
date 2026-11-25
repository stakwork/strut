import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineStep, isFirstParty, type StepContext } from "../../../core.js";
import { BUILD_KIND, JOB_WORKFLOWS } from "../../../jobs.js";
import { appScoped } from "../../../session-store.js";
import { attachmentsField, handedOn, launchOnce, launchOutput, requireJobLaunch } from "./_shared.js";

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
 * ONE agent does every kind of work (plans/one-job-agent.md §1, §5): the
 * `job` workflow, which builds a workflow or an app with its own tools as
 * it changes code. `kind` is the request's KIND, by the name of its page
 * under the `Job` Concept — what the orchestrator routes by, from the list
 * closing its prompt. The job workflow opens every turn with that page
 * (job.yaml's `kindPage`), so the job starts from the kind's convention —
 * a Code Change's sizing rule, its sandbox — instead of having to open it.
 * A BUILD's kind is `Workflow Builder` (`BUILD_KIND`), the thing to build
 * named in the prompt.
 *
 * `peer` is for a build published on ANOTHER server: a workflow (or an
 * app) lives on one strut (its graph, secrets and services), so it is built
 * on the strut it belongs to, by that strut's `builder` — the one workflow
 * another strut may launch, with no shell. The local `builder` run
 * dispatches there (builder.yaml's `remote` branch). Code lives in its
 * repository and is checked out here, so a code job runs here: a phone
 * app, called "the app", once went to a builder on a peer that could not
 * push it.
 *
 * `workflow` is still taken from a caller that sends it (the orchestrator
 * no longer does): `builder` here is a job of the build's kind, and with
 * `peer` the build on that server. What a job IS, once started, is its
 * record's (`turnOf`): a builder job started before this stays one.
 *
 * `budgetUsd` is the job's budget (stadeum plans/experiments.md, "A budget
 * on a job"): the person's own figure, passed on by their conversation, set
 * on the job's record before its first run (src/jobs.ts `budgetUsd`).
 * Raising it later is a person's too (`PUT /jobs/:id/budget`), never a
 * step's: the job's own agent holds no way to change it.
 */
export default defineStep({
  type: "job/start",
  description:
    "Start a JOB for bigger work (research, a page, a plan, a code change, a workflow or an app to build — anything that needs files, the web, tools or many steps) and return at once: { job, runId, callback, workflow }. " +
    "The job runs ON ITS OWN in its own directory, with its own tools; this call does not wait for it. Its result (a reply, files, or a question) reaches the person when it ends — " +
    "so tell them in one line what you started and stop; do not wait, poll or guess its result. " +
    "To send the same job a follow-up (an answer to its question, a change), use job/continue with the `job` id this returns.",
  input: z.object({
    prompt: z.string().min(1).describe("Everything the job needs to know: what to do, for whom, and any detail from the conversation. The job does not see this conversation."),
    title: z.string().min(1).describe("A short name for the job, as the person would say it (\"Flights to Lisbon\"). How it is found later (job/list)."),
    workflow: z
      .enum(JOB_WORKFLOWS)
      .optional()
      .describe("Leave it out: one job does every kind of work, and `kind` says which. Still read from a caller that sends it: `builder` is a job of kind Workflow Builder, or with `peer` the build on that server."),
    peer: z
      .string()
      .optional()
      .describe(
        "Only for a BUILD — a workflow or an app to build, change, test or debug — published on another server: that server's id as strut/list-peers gives it (@acme-web → acme-web). The build happens there, under this job. Never for code: a repository is checked out here, whichever peer holds it.",
      ),
    repos: z
      .array(z.string())
      .optional()
      .describe(
        "Repository URLs the job works on, checked out into its directory with the person's GitHub token before it starts. List them here, not only in the prompt: a private one is reachable only through a checkout. Not with `peer`: a build on another server checks nothing out.",
      ),
    kind: z
      .string()
      .optional()
      .describe(
        "The kind of work, by its name in the list of the kinds of work a job does here (\"Code Change\"; \"Workflow Builder\" for a workflow or an app to build, change, test or debug), when the request is one of them: the job starts every turn from that kind's page. Leave it out when none fits.",
      ),
    budgetUsd: z
      .number()
      .positive()
      .optional()
      .describe(
        "The job's budget in dollars: a cap on what its model calls may spend, it and everything it runs, kept by the server — the job stops when it is spent. Only the amount the PERSON gave in this conversation (\"$100\"), never one you chose; leave it out when they named none.",
      ),
    attachments: attachmentsField,
  }),
  output: launchOutput,
  async run(cfg, ctx: StepContext) {
    const launch = requireJobLaunch(ctx.services);
    if (cfg.peer && cfg.workflow === "job") {
      throw new Error(`peer: only a build (a workflow or an app) runs on another strut server; a code job runs here, with its repositories — leave peer out, or leave workflow out for a build there`);
    }
    // A build on another server is that server's `builder`: this strut's
    // `builder` run dispatches there. It reads its own page and checks
    // nothing out, so a kind is not passed on, and `repos` is refused.
    const remote = !!cfg.peer;
    if (remote && cfg.repos?.length) {
      throw new Error(`repos: a build on another strut server checks nothing out — leave repos out, or leave peer out for work on a repository here`);
    }
    // Here, every kind of work is a job's: `workflow: builder` from a caller
    // that still sends it is a job of the build's kind.
    const kind = remote ? undefined : (cfg.kind ?? (cfg.workflow === "builder" ? BUILD_KIND : undefined));
    const attachments = await handedOn(ctx, cfg.attachments);
    return launchOnce(ctx, launch, {
      // A turn an APP launched starts its jobs in the app's namespace, where
      // its pages read them (plans/apps.md §12); a first-party app's are its
      // person's own (plans/jamie-app.md §3).
      job: ctx.app && !isFirstParty(ctx.app) ? appScoped(ctx.app.name, randomUUID()) : randomUUID(),
      title: cfg.title,
      ...(remote ? { workflow: "builder" as const } : {}),
      input: {
        prompt: cfg.prompt,
        ...(cfg.repos?.length ? { repos: cfg.repos } : {}),
        ...(cfg.peer ? { peer: cfg.peer } : {}),
        ...(kind ? { kind } : {}),
      },
      ...(attachments ? { attachments } : {}),
      ...(cfg.budgetUsd !== undefined ? { budgetUsd: cfg.budgetUsd } : {}),
    });
  },
});
