import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall } from "./_door.js";

/** `staff/group-set`: an admin's move of a group's status. */
export default defineStep({
  type: "staff/group-set",
  effect: "write",
  description:
    "Move a group's status (POST /tasks/groups/status): `to` one of staff/groups' `moves` for it (accept, reject, reopen, abandon: the type's lifecycle), `reason` required where the lifecycle says (a rejection, an abandon). Name the group by `type` and `group` (the key); a group named before its type managed them gets its row now. Refused with bad_move (409) when the lifecycle has no such move, reason_required (400) without a reason. Answers { group, event, reviewed? } — reviewed: the answers its type's onEnter marked. Only strut's own staff app, shown to an admin.",
  input: z.object({ type: z.string().min(1), group: z.string().min(1), to: z.string().min(1), reason: z.string().optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/group-set", "POST", "/tasks/groups/status", cfg);
  },
});
