import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";

/**
 * Give someone a task type's work — ASKED by the assistant, said yes to by
 * an ADMIN on a card, like `task/set-type`. "Give me the scanning work so I
 * can try it", "give it to these three": the person no longer has to find
 * the Workers tab. It runs ONLY as a proposal an admin accepted
 * (`approver: "admin"`), and the door behind it
 * (`ctx.services.taskTypes.grant`) checks the accepted record on disk.
 * `worker` left out: the person who asked, so they try the work as
 * themselves (in the worker page here, signed in as they are).
 */
export default defineStep({
  type: "task/grant",
  effect: "write",
  approver: "admin",
  description:
    "Ask an admin to give someone a task type's work, so they can take its tasks (an invite-only type needs this; an open one does not). `worker` is a worker's actor id from task/report or Tasks and workers; left out, it is the person asking. Whoever asked for a new invite-only type, and the admin who approved it, hold it already: never ask for them. " +
    "The call becomes a card an ADMIN of this strut server approves; strut grants it when they accept. For someone NEW to Peel, an invite from Tasks and workers does this in one step; for someone who already has Peel, a grant link from there does — point the person there rather than asking for each worker.",
  input: z.object({
    type: z.string().min(1).describe("The task type's name (task/types)."),
    worker: z.string().min(1).optional().describe("The worker's actor id; left out: the person asking."),
  }),
  output: z.any(),
  async describe(cfg) {
    const who = cfg.worker ? `the worker ${cfg.worker}` : "you";
    return {
      title: `Give ${who} the "${cfg.type}" work`,
      summary: `${cfg.worker ? `The worker ${cfg.worker}` : "You"} can take tasks of "${cfg.type}" from now on, and ${cfg.worker ? "is" : "are"} paid for them like any worker. Revoke it in Tasks and workers.`,
      fields: [
        { label: "Task type", value: cfg.type },
        { label: "Who", value: cfg.worker ?? "you, as you are signed in here" },
      ],
    };
  },
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    if (!ctx.proposal) throw new Error("task/grant runs only as a proposal an admin accepted: who is given paid work is an admin's yes, never a tool call.");
    const door = ctx.services?.taskTypes;
    if (!door) throw new Error("task/grant needs strut's task types door (ctx.services.taskTypes); the standard strut server provides it.");
    return door.grant({ type: cfg.type, ...(cfg.worker ? { worker: cfg.worker } : {}) }, { proposal: ctx.proposal.id });
  },
});
