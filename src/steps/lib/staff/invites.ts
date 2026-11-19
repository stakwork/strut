import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall } from "./_door.js";

/** `staff/invites` (plans/human-steps.md §5.8): the invites the daemon keeps. */
export default defineStep({
  type: "staff/invites",
  effect: "read",
  description:
    "Worker invites (GET /tasks/invites): { invites, sats, why? } — each invite { code, link?, sats, status, createdAt?, type? } newest first, status sending, ready, failed, used or cancelled, link the one it was sent with (opening Tasks; none while Tasks is not in the public view), type the kind of work it is for (none: open work); sats what an invite gives when it names none; why that this server cannot invite (no_pay_credential, no_invites). Only strut's own staff app, shown to an admin.",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/invites", "GET", "/tasks/invites");
  },
});
