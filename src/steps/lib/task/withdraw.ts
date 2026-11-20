import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { workerCall } from "./_shared.js";

/**
 * A worker withdraws what passed its hold (plans/human-steps.md §8.2): the
 * page asks for an amount, and strut keysends it to the Sphinx address the
 * worker's sign-in gave, through the payer's third door, with nobody's yes
 * per payment, inside the server's switch, its solvency check, the minimum,
 * the day's caps and one payout on its way at a time. The page chooses only
 * the amount: where it goes is the session's (`workerCall`'s `address`), so
 * the input takes `msat` and nothing else. The worker pays the routing fee,
 * at most its cap.
 */
export default defineStep({
  type: "task/withdraw",
  effect: "write",
  worker: true,
  description:
    "A WORKER's page withdraws what passed its hold (the kit's useWithdraw): { msat }, what they receive, sent by keysend to the Sphinx address their sign-in gave — never one the page names. " +
    "Answers { state: settled | pending | failed, key, msat, feeMsat, maxFeeMsat, error? }: pending is on its way (task/me shows it); the fee, at most maxFeeMsat, comes off their balance. " +
    "A refusal is `code: sentence` — no_address (sign in with Peel), payouts_off, no_pay_credential, no_keysend, wallet_short, wallet_unavailable, below_minimum, payout_out, over_balance, over_worker_day, over_server_day (with the most they may ask now), not_here. Only an app page's own call, as its viewer.",
  input: z
    .object({
      msat: z.number().int().positive().describe("What the worker receives, msat (task/me's payout.maxMsat is the most they may ask now)."),
    })
    .strict(),
  output: z.object({
    state: z.enum(["settled", "pending", "failed"]),
    key: z.string(),
    msat: z.number(),
    feeMsat: z.number(),
    maxFeeMsat: z.number(),
    error: z.string().optional(),
  }),
  async run(cfg, ctx?: StepContext) {
    const { tasks, actor, address } = workerCall("task/withdraw", ctx);
    if (!tasks.withdraw) throw new Error("not_here: this server's task store is its host's own, which pays no worker (plans/human-steps.md §8.2)");
    return tasks.withdraw(actor, { msat: cfg.msat, ...(address ? { address } : {}) });
  },
});
