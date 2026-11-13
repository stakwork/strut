import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { workerCall } from "./_shared.js";

/**
 * A worker answers the task they lease (plans/human-steps.md §5.1, §4.3
 * rule 4): once, checked against the task type's answer schema, before the
 * lease expires. The answer settles the task and wakes the run that asked.
 */
export default defineStep({
  type: "task/submit",
  effect: "write",
  worker: true,
  description:
    "A WORKER's page answers the task it leases (the kit's useTask().submit): `answer` must fit the task type's answer schema; one answer per lease, before it expires. " +
    "Settles the task, and the workflow run waiting on it goes on with the answer. Only an app page's own call, as its viewer.",
  input: z.object({
    lease: z.string().min(1).describe("The lease task/next handed out."),
    answer: z.unknown().describe("The answer, in the task type's answer schema."),
  }),
  output: z.object({ ok: z.literal(true) }),
  async run(cfg, ctx?: StepContext) {
    const { tasks, actor, app } = workerCall("task/submit", ctx);
    return tasks.submit(actor, { lease: cfg.lease, answer: cfg.answer, app });
  },
});
