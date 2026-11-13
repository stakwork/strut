import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall } from "./_door.js";

/** `staff/payout-read` (plans/human-steps.md §8.2): read a payout on its way again. */
export default defineStep({
  type: "staff/payout-read",
  effect: "read",
  description:
    "Read one payout now through the wallet it went out through (POST /tasks/payouts/:key/read): { payout, state, msat, feeMsat, maxFeeMsat, error? }; settled or failed, the books and the worker's balance follow. Only strut's own staff app, shown to an admin.",
  input: z.object({ key: z.string().regex(/^[0-9a-f]{64}$/) }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/payout-read", "POST", `/tasks/payouts/${cfg.key}/read`, {});
  },
});
