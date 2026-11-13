import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall } from "./_door.js";

/** `staff/payout-resolve` (plans/human-steps.md §8.2): a person decides a stale payout. */
export default defineStep({
  type: "staff/payout-resolve",
  effect: "write",
  description:
    "Decide a payout the wallet will not answer for (POST /tasks/payouts/:key/resolve): action paid — the worker received it: record it, with the fee the wallet was charged (feeMsat, else 0) — or drop — they did not: the payout fails and its amount is theirs again. " +
    "Only the worker's wallet knows which. Answers { payout, action }. Only strut's own staff app, shown to an admin.",
  input: z.object({ key: z.string().regex(/^[0-9a-f]{64}$/), action: z.enum(["paid", "drop"]), feeMsat: z.number().int().min(0).optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { key, ...body } = cfg;
    return staffCall(ctx, "staff/payout-resolve", "POST", `/tasks/payouts/${key}/resolve`, body);
  },
});
