import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { adminDoor, bodyOrThrow, PAYMENT_HASH } from "./_door.js";

/** Settle a stale send by hand (`POST /earnings/withdrawals/:hash/resolve`):
 *  record it as paid, or drop it. */
export default defineStep({
  type: "earnings/withdrawal-resolve",
  description:
    "Settle by hand a send the wallet will never answer for (stale, or through a wallet no longer set): `paid` records it in the books (with `feeMsat` when known), `drop` forgets it. Only strut's own Earnings app, shown to an admin.",
  input: z.object({
    paymentHash: z.string().regex(PAYMENT_HASH, "a payment hash is 64 hex characters"),
    action: z.enum(["paid", "drop"]),
    feeMsat: z.number().int().nonnegative().optional(),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { paymentHash, ...body } = cfg;
    return bodyOrThrow(await adminDoor(ctx, "earnings/withdrawal-resolve").call("POST", `/earnings/withdrawals/${paymentHash}/resolve`, body, ctx.actor));
  },
});
