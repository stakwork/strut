import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { adminDoor, bodyOrThrow } from "./_door.js";

/** Drop a credit purchase a seller will never answer for
 *  (`DELETE /remote/purchases?seller=`), so the next one there can go. */
export default defineStep({
  type: "earnings/drop-purchase",
  description: "Forget a credit purchase at another strut server that the seller will never answer for, so a new one can go. Only strut's own Earnings app, shown to an admin.",
  input: z.object({ seller: z.string().min(1).describe("The seller's base URL.") }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return bodyOrThrow(await adminDoor(ctx, "earnings/drop-purchase").call("DELETE", `/remote/purchases?seller=${encodeURIComponent(cfg.seller)}`, undefined, ctx.actor));
  },
});
