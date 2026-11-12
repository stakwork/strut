import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { adminDoor, bodyOrThrow, PAYMENT_HASH } from "./_door.js";

/** Where an Add sats invoice stands (`POST /earnings/deposits/:hash/read`):
 *  booked once it settled. */
export default defineStep({
  type: "earnings/deposit-read",
  description: "Read an Add sats invoice now: pending, settled (and booked) or expired. Only strut's own Earnings app, shown to an admin.",
  input: z.object({ paymentHash: z.string().regex(PAYMENT_HASH, "a payment hash is 64 hex characters") }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return bodyOrThrow(await adminDoor(ctx, "earnings/deposit-read").call("POST", `/earnings/deposits/${cfg.paymentHash.toLowerCase()}/read`, {}, ctx.actor));
  },
});
