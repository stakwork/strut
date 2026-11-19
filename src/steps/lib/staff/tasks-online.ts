import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall } from "./_door.js";

/** `staff/tasks-online` (plans/human-steps.md §5.8): Tasks put in the public
 *  view, so the links staff send have somewhere to open. */
export default defineStep({
  type: "staff/tasks-online",
  effect: "write",
  description:
    "Put Tasks (strut/worker, the server's one work page) in the public view (POST /tasks/online), as the Public view tab does with nothing unticked, in the admin's name: anyone with its link sees its sign-in, and signed-in workers do their work there. Answers { app, public: true }. Only Tasks: another app goes online through the Public view or an app/make-public card. Only strut's own staff app, shown to an admin.",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/tasks-online", "POST", "/tasks/online", {});
  },
});
