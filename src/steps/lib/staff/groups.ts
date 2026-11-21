import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, query } from "./_door.js";

/** `staff/groups`: the groups of tasks the runs named (`task/reply`'s `group`). */
export default defineStep({
  type: "staff/groups",
  effect: "read",
  description:
    "The groups of tasks the workflows named with task/reply's group — a book its pages, a batch its photos (GET /tasks/groups): of one type when asked, the one with the newest task first, each { group, type, tasks, answers, ok, rejected, unreviewed, workers, first, last }. A group's tasks are staff/tasks { group }. Only strut's own staff app, shown to an admin.",
  input: z.object({ type: z.string().optional(), limit: z.number().int().positive().max(1000).optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/groups", "GET", `/tasks/groups${query(cfg)}`);
  },
});
