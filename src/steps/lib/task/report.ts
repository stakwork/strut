import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";

/**
 * How the work by people is going: each task type's spend against its
 * limits, and what each worker did of it lately (answered, time on them,
 * per hour, earned), over `ctx.services.taskTypes.report()`. The assistant
 * answers "how is the pilot going", "what have we spent", "who is fastest"
 * with it, instead of anyone building a dashboard. Workers are actor ids;
 * names are the person's to read in Workers.
 */
export default defineStep({
  type: "task/report",
  effect: "read",
  description:
    "How the work by people is going: for each task type (one with `type`), what it has paid in all (`spentSats`, plus `workingSats` on the tasks being worked) against its limits (`limits`: budgetSats, perWorkerDay), " +
    "and for the last `days` (7 by default, at most 90) how many were answered and, per worker, answered, minutes spent on them, answers per hour and sats earned. Answers { types }. Use it to answer how the work is going, what it has cost, and who did what — never build an app or a workflow for that.",
  input: z.object({
    type: z.string().min(1).optional().describe("One task type's name; left out, every type."),
    days: z.number().int().min(1).max(90).optional().describe("How many days back the per-worker numbers go (7 by default)."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const cap = ctx?.services?.taskTypes;
    if (!cap) throw new Error("task/report needs strut's task types door (ctx.services.taskTypes); the standard strut server provides it.");
    return { types: await cap.report({ ...(cfg.type ? { type: cfg.type } : {}), ...(cfg.days ? { days: cfg.days } : {}) }) };
  },
});
