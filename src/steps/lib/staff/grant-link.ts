import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall } from "./_door.js";

/** `staff/grant-link`: a link for someone who ALREADY has Peel (POST
 *  /tasks/invites/link): it opens the worker app in Peel and gives its first
 *  worker the app's invite-only work — no Sphinx invite, no sats. */
export default defineStep({
  type: "staff/grant-link",
  effect: "write",
  description:
    "A one-person link for someone who already has Peel (POST /tasks/invites/link): it opens the worker app (`app`, or the one worker app) in Peel and gives the first worker who opens it the app's invite-only task types. No Sphinx invite, no sats. Answers { app, code, link, peelLink }. Only strut's own staff app, shown to an admin.",
  input: z.object({ app: z.string().optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/grant-link", "POST", "/tasks/invites/link", cfg.app ? { app: cfg.app } : {});
  },
});
