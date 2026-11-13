/**
 * `human` — a person as a step of a workflow (plans/human-steps.md §3).
 *
 * The step makes a TASK in the task store (src/tasks/) and the run PARKS on
 * it (src/park.ts): it leaves memory as `waiting`. A worker signed in to the
 * task type's app takes the task, answers it, and the answer settles it; the
 * store's `task` source (createStrut) wakes the run, which replays its
 * journal and runs this step again from the top. Each time it runs:
 *
 * 1. the task keyed by this workflow, run id and step path, made when there
 *    is none (`ctx.services.tasks.ensure`) — so a wake finds the task it made;
 * 2. open: `ctx.park("task:<id>")`;
 * 3. settled: `{ answer, by, task }`;
 * 4. expired, cancelled or disputed: an error (`task_expired:`,
 *    `task_cancelled:`, `task_disputed:`), so `onError` applies. A `retry`
 *    reads the same task again and fails again: a task is made once per step
 *    path (rule 1), so the step never asks twice.
 *
 * COPIES (§7.6): `copies` asks that many workers, each on their own lease,
 * up to the type's `copies.max` (a type without a copies rule asks one). The
 * task settles when every answer asked for is in and enough agree, by the
 * type's rule: `answer` is the agreed one, `by` the first worker who gave
 * it, and `answers` every copy in the order given, `{ answer, by, agrees }`.
 * Disagreement asks one more worker up to `max`, then the task is DISPUTED
 * and the step fails `task_disputed:` (ruled, §7.12, 6). With one copy the
 * output is as it always was, no `answers`.
 *
 * Refused before any task is made where the run could never be woken (a
 * single-step run, a public run, an agent's tool call: `ctx.parkRefusal`)
 * and in a run that may not ask a person (a stranger's public run, a run
 * another strut launched with no person's credential, and the runs either
 * started: the task store's `refusal`).
 *
 * The answer's shape, the app that draws the task, how long a lease lasts
 * and what an answer earns are the TASK TYPE's, an admin's (§6): the
 * workflow names a type and cannot set them.
 *
 * PAY (§8.1): an answer of a paid type adds `pay: { msat, usd? }` to the
 * output, `usd` at the rate when the step returns, and marks the output
 * with those dollars as the step's cost (`withUsage`, no model call), as
 * `remote/call` marks what a seller charged: the run's totals count its
 * human work beside its model calls. Never against `maxRunCostUsd` or the
 * Mothership, which brake model calls at the gateway and never see pay. With
 * no rate the output has no `usd` and nothing is marked. What is owed is the
 * ledger's `pay` row, written when the answer was accepted, never this.
 * With copies, `pay` is every copy's: each answer earned.
 */
import { z } from "zod";
import { defineStep, withUsage, workflowOf, type StepContext } from "../../core.js";
import { emptyUsage } from "../../pricing.js";
import type { StrutCapabilities } from "../../capabilities.js";
import { COPIES_MAX, FILES_MAX, TASK_PARK_PREFIX, WITHIN_HOURS_MAX } from "../../tasks/tasks.js";
import { resolveTaskFiles, taskFilesRoot } from "../../tasks/files.js";

const EXAMPLE = `- id: review
  type: human
  config:
    task: pet-match          # the task type: an admin made it
    show:                    # what the worker's app is handed
      lost: "{{ input.lost }}"
      found: "{{ input.found }}"
      guess: "{{ match.object }}"
    files: ["found.jpg", "lost/*.jpg"]   # what the worker may open
    withinHours: 48
    # copies: 2              # ask two workers; the type's copies rule decides
  options:
    onError:                 # nobody answered in time: keep the model's guess
      id: guess
      type: pack
      config:
        answer: "{{ match.object }}"
        by: model`;

export default defineStep({
  type: "human",
  description: `Ask a PERSON: make a task of a task type and wait — the run leaves memory — until a worker answers it in the type's app; the answer is this step's output, \`{ answer, by, task }\` (\`by\`: the worker), with \`pay: { msat, usd }\` when the type pays — counted in the run's cost. \`copies: N\` asks N workers (up to the type's \`copies.max\`; a type without a copies rule asks one): the answer is the one enough of them agreed on, \`by\` the first who gave it, and \`answers\` every copy as \`[{ answer, by, agrees }]\`; answers that never agree fail the step \`task_disputed:\` and \`onError\` runs. The task type (an admin's: its app, the answer's shape, its pay) must exist and be enabled. \`files\` are paths under the run's files (the job's directory on a job run, else the run's artifacts); \`*\` and \`?\` match within one folder, expanded when the task is made. Unanswered within \`withinHours\` (the type's default otherwise), the step fails \`task_expired:\` and \`onError\` runs. Not in a public run, a single-step run, or as an agent's tool.\n\n${EXAMPLE}`,
  input: z.object({
    task: z.string().min(1).describe("the task type's name (an admin makes it, with its app and the answer's shape)"),
    show: z.unknown().optional().describe("what the worker's app is handed: any JSON, at most 256 KB; name files instead of inlining them"),
    files: z
      .array(z.string().min(1))
      .max(FILES_MAX)
      .optional()
      .describe(`what the worker may open: paths under the run's files (the job's directory on a job run, else the run's artifacts); \`*\` and \`?\` match within one folder, expanded when the task is made; at most ${FILES_MAX} files`),
    withinHours: z
      .number()
      .positive()
      .max(WITHIN_HOURS_MAX)
      .optional()
      .describe("how long the task may stay unanswered, in hours (fractions allowed); the task type's default otherwise"),
    copies: z
      .number()
      .int()
      .min(1)
      .max(COPIES_MAX)
      .optional()
      .describe("how many workers answer (1 by default), at most the task type's copies.max: the task settles when enough of their answers agree, by the type's rule"),
  }),
  output: z.object({
    answer: z.unknown(),
    by: z.string(),
    task: z.string(),
    pay: z.object({ msat: z.number(), usd: z.number().optional() }).optional(),
    answers: z.array(z.object({ answer: z.unknown(), by: z.string(), agrees: z.boolean() })).optional(),
  }),
  async run(cfg, ctx?: StepContext<StrutCapabilities>) {
    // Nothing is made where nothing could wake the run.
    if (!ctx?.park) throw new Error("park_refused: the human step waits for a person, so it runs only as a step of a workflow run");
    if (ctx.agentTool) throw new Error("park_refused: an agent cannot wait in the middle of a turn — run the human step as a step of the workflow");
    const refused = ctx.parkRefusal?.(TASK_PARK_PREFIX);
    if (refused) throw new Error(`park_refused: ${refused}`);
    const tasks = ctx.services?.tasks;
    if (!tasks) throw new Error("human: this server keeps no task store (ctx.services.tasks)");

    const job = ctx.job;
    const { task, pay, answers } = await tasks.ensure(
      {
        type: cfg.task,
        workflow: workflowOf(ctx),
        runId: ctx.runId,
        path: ctx.path,
        ...(cfg.show === undefined ? {} : { show: cfg.show }),
        ...(cfg.files?.length ? { files: cfg.files } : {}),
        ...(job ? { job } : {}),
        ...(cfg.withinHours === undefined ? {} : { withinHours: cfg.withinHours }),
        ...(cfg.copies === undefined ? {} : { copies: cfg.copies }),
      },
      {
        ...(ctx.control ? { control: ctx.control } : {}),
        resolveFiles: async (entries) => {
          if (!entries.length) return entries;
          const root = await taskFilesRoot({ runId: ctx.runId, ...(job ? { job } : {}), dataDir: ctx.services.dataDir, artifacts: ctx.services.artifacts });
          return resolveTaskFiles(root, entries, job ? `the job's directory (${job})` : "the run's artifacts");
        },
      },
    );

    switch (task.status) {
      case "open":
        return ctx.park(`${TASK_PARK_PREFIX}:${task.id}`);
      case "settled": {
        const out = { answer: task.answer, by: task.by ?? "", task: task.id, ...(pay ? { pay } : {}), ...(answers ? { answers } : {}) };
        // The answer's pay in dollars, as this step's cost: the run's
        // totals count it, the model caps never do (§8.1).
        return pay?.usd ? withUsage(out, { modelCalls: 0, usage: emptyUsage(), cost: pay.usd }) : out;
      }
      case "expired":
        throw new Error(`task_expired: nobody answered task ${task.id} (${task.type}) by ${new Date(task.due).toISOString()}`);
      case "cancelled":
        throw new Error(`task_cancelled: task ${task.id} (${task.type}) was cancelled`);
      case "disputed":
        throw new Error(`task_disputed: the ${task.copies} answers to task ${task.id} (${task.type}) did not agree`);
    }
  },
});
