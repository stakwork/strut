import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { query, staffCall } from "./_door.js";

/** `staff/invites` (plans/human-steps.md §5.8): the invites the daemon keeps. */
export default defineStep({
  type: "staff/invites",
  effect: "read",
  description:
    "Worker invites (GET /tasks/invites): { invites, apps, app?, sats, why? } — each invite { code, link?, sats, status, createdAt? } newest first, status sending, ready, failed, used or cancelled, its link opening app (or the one worker app); apps the worker apps (the apps task types name that are in the public view); sats what an invite gives when it names none; why that this server cannot invite (no_pay_credential, no_invites). Only strut's own staff app, shown to an admin.",
  input: z.object({ app: z.string().min(1).optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/invites", "GET", `/tasks/invites${query(cfg)}`);
  },
});
