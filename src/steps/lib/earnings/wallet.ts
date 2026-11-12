import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { adminDoor, bodyOrThrow } from "./_door.js";

/** The wallet as the Earnings app shows it: `GET /earnings/wallet?check=1`
 *  (specs/API.md §18) — which one is set, whether it receives and pays, its
 *  balance now, and `env: true` when the deployment set it (read-only
 *  here). Never a credential. The host's own wallet: `{ host: true }`. */
export default defineStep({
  type: "earnings/wallet",
  effect: "read",
  description:
    "This server's wallet: its provider (sphinx | nwc | null), whether it can receive and pay, its balance now (`check`), and `env: true` when the deployment sets it. Never a credential. Only strut's own Earnings app, shown to an admin.",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx: StepContext) {
    const a = await adminDoor(ctx, "earnings/wallet").call("GET", "/earnings/wallet?check=1", undefined, ctx.actor);
    if (a.status === 501) return { provider: null, receive: false, pay: false, host: true };
    return bodyOrThrow(a);
  },
});
