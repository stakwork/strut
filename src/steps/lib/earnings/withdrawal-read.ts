import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { adminDoor, paymentAnswer, PAYMENT_HASH } from "./_door.js";

/** Read a send still out, now (`POST /earnings/withdrawals/:hash/read`). */
export default defineStep({
  type: "earnings/withdrawal-read",
  description: "Read a withdrawal (or a credit purchase) still on its way, now, through the wallet it went out through. Answers as earnings/withdraw does. Only strut's own Earnings app, shown to an admin.",
  input: z.object({ paymentHash: z.string().regex(PAYMENT_HASH, "a payment hash is 64 hex characters") }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return paymentAnswer(await adminDoor(ctx, "earnings/withdrawal-read").call("POST", `/earnings/withdrawals/${cfg.paymentHash}/read`, {}, ctx.actor));
  },
});
