import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { GROUP_MAX } from "../../../tasks/task-store.js";
import { appsOf, workerCall } from "./_shared.js";

/**
 * A worker moves THEIR OWN group (submit it when the pages are all in, reopen
 * it to add more): the moves the type's lifecycle gives its `owner`. The
 * worker is the page's signed-in viewer (`ctx.actor`), never an input; a
 * group of someone else's is refused. Accept, reject and abandon are staff's.
 */
export default defineStep({
  type: "task/group-move",
  effect: "write",
  worker: true,
  description:
    "A WORKER's page moves a group they own — the first to send a page to it — to another status (submitted, reopened: the moves the type's lifecycle gives its owner); task/history { groups: true } says each group's status. " +
    "The owner is the viewer, never an input: a group of another worker is refused (not_owner), a move the lifecycle lacks is bad_move, a missing reason reason_required. Answers { group } as task/history gives it. Only an app page's own call, as its viewer.",
  input: z.object({ type: z.string().min(1), group: z.string().min(1).max(GROUP_MAX), to: z.string().min(1), reason: z.string().optional() }),
  output: z.object({ group: z.any() }),
  async run(cfg, ctx?: StepContext) {
    const call = workerCall("task/group-move", ctx);
    if (!call.tasks.groupMove) throw new Error("task/group-move: this server's task store keeps no groups");
    return call.tasks.groupMove(call.actor, { ...cfg, ...(await appsOf(call, false)) });
  },
});
