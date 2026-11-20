import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { workerCall } from "./_shared.js";

/**
 * A worker answers the task they lease (plans/human-steps.md §5.1, §4.3
 * rule 4): once, checked against the task type's answer schema, before the
 * lease expires. The answer settles the task and wakes the run that asked.
 * A type that takes files (§5.6) has them sent beside the answer, in the
 * chat's shape and caps: saved in the task's run before it settles.
 */
export default defineStep({
  type: "task/submit",
  effect: "write",
  worker: true,
  description:
    "A WORKER's page answers the task it leases (the kit's useTask().submit): `answer` must fit the task type's answer schema; one answer per lease, before it expires. " +
    "Settles the task, and the workflow run waiting on it goes on with the answer. " +
    "`attachments` are the files the task type takes with an answer (task/next's `attachments`: how many, of what types) — `[{ name, mediaType?, data }]`, base64 or a data URL, at most 10, 5 MB an image, 15 MB together — saved in the task's run, where its next steps read them. Only an app page's own call, as its viewer.",
  input: z.object({
    lease: z.string().min(1).describe("The lease task/next handed out."),
    answer: z.unknown().describe("The answer, in the task type's answer schema."),
    attachments: z
      .array(z.object({ name: z.string().min(1), mediaType: z.string().optional(), data: z.string() }))
      .optional()
      .describe("Files sent with the answer, where the task type takes them: `[{ name, mediaType?, data }]`, `data` base64 or a data URL (the kit's useTask().submit(answer, files) sends them)."),
  }),
  output: z.object({ ok: z.literal(true) }),
  async run(cfg, ctx?: StepContext) {
    const { tasks, actor, app } = workerCall("task/submit", ctx);
    return tasks.submit(actor, { lease: cfg.lease, answer: cfg.answer, ...(cfg.attachments?.length ? { attachments: cfg.attachments } : {}), app });
  },
});
