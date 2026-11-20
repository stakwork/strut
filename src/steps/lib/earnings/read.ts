import { z } from "zod";
import { defineStep, isFirstParty, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { EARNINGS_BY, checkEarningsQuery, daysBack } from "../../../payments/earnings.js";

/**
 * What this server earned from public runs and calls (plans/paid-runs.md §8):
 * `GET /earnings` as a step, for the assistant ("what did we earn this
 * week?") — over `ctx.services.earnings`, reads only; nothing here pays.
 *
 * Under `ctx.app` only a FIRST-PARTY page's call or run, and only for a
 * viewer who is an ADMIN here (`AppRef.admin`): the routes are full scope, so
 * a model-written page, or strut's own page shown to a member, reads none
 * of it. Outside an app it is the run's, as any read step is: a workflow
 * that grants it vouches for whoever may launch it.
 */
export default defineStep({
  type: "earnings/read",
  effect: "read",
  description:
    "What this strut server earned from the workflows and tools anyone may run here, in dollars: earned (what runs were charged), cost (what they spent on models), margin (earned − cost), calls and failed — " +
    "by `by`: item (each workflow or tool), day, package (each installed package, summed over its prefix) or total — plus outstanding credit (paid for, not yet charged), received (sats paid in, and the dollars they bought), deposited (sats an admin added by hand: never credit, never earnings) and withdrawn (sats paid out, with fees). `package` keeps one package's items. " +
    "`days: 7` is the last seven days counting today; or `from` / `to` as UTC days (YYYY-MM-DD); neither is all time. `wallet: true` also reads the wallet's balance in sats and dollars beside what the books say it holds. " +
    "Answers { totals, rows: [{ key, calls, failed, earned, cost, margin, price? }], outstanding, received, deposited, withdrawn, purchases, pending, wallet? }.",
  input: z.object({
    days: z.number().int().positive().max(3660).optional().describe("The last N days, counting today. Leave out with from/to."),
    from: z.string().optional().describe("The first UTC day, YYYY-MM-DD."),
    to: z.string().optional().describe("The last UTC day, YYYY-MM-DD."),
    by: z.enum(EARNINGS_BY as unknown as [string, ...string[]]).optional().describe("item (default), day, package or total."),
    package: z.string().optional().describe("Only one package's items, by its name (publisher/name): one published here is read over the items of its newest release, one installed here over its prefix."),
    wallet: z.boolean().optional().describe("Also read the wallet's balance."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    if (ctx.app && (!isFirstParty(ctx.app) || ctx.app.admin !== true)) {
      throw new Error("earnings/read is an admin's read: in an app, only strut's own page shown to an admin of this server may call it (plans/paid-runs.md §8)");
    }
    const earnings = (ctx.services as Partial<StrutCapabilities> | undefined)?.earnings;
    if (!earnings) throw new Error("earnings/read needs strut's earnings (ctx.services.earnings); the standard strut server provides them.");
    if (cfg.days !== undefined && (cfg.from || cfg.to)) throw new Error("give days, or from/to, not both");
    const q = checkEarningsQuery({
      ...(cfg.days !== undefined ? { from: daysBack(cfg.days) } : {}),
      ...(cfg.from ? { from: cfg.from } : {}),
      ...(cfg.to ? { to: cfg.to } : {}),
      ...(cfg.by ? { by: cfg.by } : {}),
      ...(cfg.package ? { package: cfg.package } : {}),
      ...(cfg.wallet ? { wallet: true } : {}),
    });
    return earnings.read(q);
  },
});
