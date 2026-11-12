import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { adminDoor, bodyOrThrow } from "./_door.js";

/** The credit this server BOUGHT at other strut servers (`GET /remote/credit`,
 *  plans/paid-runs.md §10): per seller what is held, a purchase still being
 *  paid, the remote runs waiting — and with `balance`, what is left there,
 *  asked of each seller. Never a token. Buying more is an accepted
 *  `remote/buy-credit` proposal, not this. */
export default defineStep({
  type: "earnings/remote-credit",
  effect: "read",
  description:
    "The credit this server holds at other strut servers: per seller the credit (never the token), a purchase being paid, remote runs waiting, and with `balance` what is left there. Only strut's own Earnings app, shown to an admin.",
  input: z.object({ balance: z.boolean().optional().describe("Ask each seller what is left.") }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return bodyOrThrow(await adminDoor(ctx, "earnings/remote-credit").call("GET", `/remote/credit${cfg.balance ? "?balance=1" : ""}`, undefined, ctx.actor));
  },
});
