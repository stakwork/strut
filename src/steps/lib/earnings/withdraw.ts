import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { adminDoor, paymentAnswer } from "./_door.js";

/** Withdraw: pay a BOLT11 invoice out of the wallet (`POST /earnings/withdraw`,
 *  specs/API.md §19) — the route's checks, its payer, its one payment per
 *  hash, its books. `msat` is the amount the admin confirmed. A refusal is
 *  the answer (`{ ok: false, error, code, walletCode? }`), never thrown. */
export default defineStep({
  type: "earnings/withdraw",
  description:
    "Pay a BOLT11 invoice out of this server's wallet. `msat` is what the person confirmed, and must be what the invoice asks. Answers { ok: true, state: settled | pending | failed, paymentHash, msat, feeMsat, … } or { ok: false, error, code, walletCode? }. Only strut's own Earnings app, shown to an admin.",
  input: z.object({
    invoice: z.string().min(1),
    msat: z.number().int().positive(),
    maxFeeMsat: z.number().int().nonnegative().optional(),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return paymentAnswer(await adminDoor(ctx, "earnings/withdraw").call("POST", "/earnings/withdraw", cfg, ctx.actor));
  },
});
