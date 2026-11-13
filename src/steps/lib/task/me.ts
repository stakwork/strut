import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { DEFAULT_PAYOUT_SETTINGS } from "../../../payments/ledger.js";
import { workerCall } from "./_shared.js";

/**
 * Who the worker is here (plans/human-steps.md §4.6, §5.1): their status
 * and the task types they hold that THIS app draws — the app's menu, each
 * with what an answer earns and whether they are QUALIFYING for it (§7.5:
 * served only tests until they qualify; a flag, never a score) — and what
 * they are owed here (§8.1): held earnings, withdrawable ones, the total — and
 * whether they may withdraw (§8.2, `payout`): open or why not, the minimum,
 * their day's cap left, the most one withdrawal may ask now, and a payout on
 * its way. The first call of anyone the store
 * has not seen writes them as `new`, which staff see and grant task types to.
 */
export default defineStep({
  type: "task/me",
  effect: "read",
  worker: true,
  description:
    "A WORKER's page asks who its viewer is here (the kit's useWorker): { actor, status, types, balance } — status new | active | suspended | banned, the task types they hold that this app draws (each with payMsat, what an answer earns now, and qualifying: true while every task they get of it is a test they qualify on), " +
    "and balance { heldMsat, withdrawableMsat, totalMsat, nextReleaseAt? }: what they are owed here, earnings in their hold and those past it, " +
    "and payout { on, why?, minMsat, dayLeftMsat, maxMsat, out? }: whether they may withdraw now (why not: off | no_wallet | no_keysend | no_address — sign in with Peel — | not_here), the least and the most one withdrawal may ask, and a payout on its way (task/withdraw). " +
    "A first call writes the viewer as a new worker, for staff to grant task types to. Only an app page's own call, as its viewer.",
  input: z.object({}),
  output: z.object({
    actor: z.string(),
    status: z.enum(["new", "active", "suspended", "banned"]),
    types: z.array(z.object({ name: z.string(), app: z.string(), payMsat: z.number(), qualifying: z.boolean() })),
    balance: z.object({ heldMsat: z.number(), withdrawableMsat: z.number(), totalMsat: z.number(), nextReleaseAt: z.number().optional() }),
    payout: z.object({
      on: z.boolean(),
      why: z.enum(["off", "no_wallet", "no_keysend", "no_address", "not_here"]).optional(),
      minMsat: z.number(),
      dayLeftMsat: z.number(),
      maxMsat: z.number(),
      out: z.object({ key: z.string(), msat: z.number(), maxFeeMsat: z.number(), at: z.number(), stale: z.boolean() }).optional(),
    }),
  }),
  async run(_cfg, ctx?: StepContext) {
    const { tasks, actor, app, address } = workerCall("task/me", ctx);
    const me = await tasks.me(actor, { app, ...(address ? { address } : {}) });
    // A host's own store pays nobody: it says so, as strut's own would.
    return { ...me, payout: me.payout ?? { on: false, why: "not_here" as const, minMsat: DEFAULT_PAYOUT_SETTINGS.minSats * 1000, dayLeftMsat: 0, maxMsat: 0 } };
  },
});
