import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, seg } from "./_door.js";

/** `staff/group`: one managed group, its history and its tasks. */
export default defineStep({
  type: "staff/group",
  effect: "read",
  description:
    "One group of tasks whose type manages its groups, by its id (a staff/groups row's `id`; GET /tasks/groups/:id): { group, events, tasks } — group as staff/groups gives it (status, owner, idle, moves: what an admin can move it to), events the history of its status, oldest first [{ from?, to, actor, role, reason?, at, source }], and its tasks with their answers. Only strut's own staff app, shown to an admin.",
  input: z.object({ id: z.string().min(1) }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/group", "GET", `/tasks/groups/${seg(cfg.id)}`);
  },
});
