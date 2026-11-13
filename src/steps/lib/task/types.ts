import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";

/**
 * The task types here (plans/human-steps.md §9.8): `task/set-type`'s read
 * twin, over `ctx.services.taskTypes.list()`. The builder reads the names
 * before it writes a `human` step, and a type's fields before it asks to
 * change one. How many workers hold a type, not who: who is the staff's to
 * read (the `/tasks` routes are an admin's).
 */
export default defineStep({
  type: "task/types",
  effect: "read",
  description:
    "The task types on this strut server — what a workflow's `human` step names in `task` — each with its app, answer shape (a JSON Schema), lease (leaseSeconds), expiry (withinHours), on or off (enabled), open to any signed-in worker or invite-only (open), pay (paySats, holdHours), tests and copies, " +
    "its open tasks (`openTasks`), how many workers hold it (`workers`), its answers in the last 7 days (`answeredWeek`) and its ready tests (`readyTests`: a paid open type needs at least tests.qualify of them). Answers { types }. Ask for a new type or a change with task/set-type.",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx: StepContext<StrutCapabilities>) {
    const cap = ctx?.services?.taskTypes;
    if (!cap) throw new Error("task/types needs strut's task types door (ctx.services.taskTypes); the standard strut server provides it.");
    return { types: await cap.list() };
  },
});
