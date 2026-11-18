import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { requireAccounts } from "./_shared.js";

/** `account/unlink` (plans/jamie-in-tribes.md §3): removes one of the
 *  viewer's linked accounts. A host then knows nobody by it. */
export default defineStep({
  type: "account/unlink",
  effect: "write",
  description: "Removes an account linked to you (`account`: <kind>:<key>, as account/links lists it). { removed: false } when it was not yours. Strut's own app's call alone.",
  input: z.object({ account: z.string().min(1).max(260).describe("The account, <kind>:<key>.") }),
  output: z.object({ removed: z.boolean() }),
  async run(cfg, ctx?: StepContext) {
    const { accounts, actor } = requireAccounts("account/unlink", ctx);
    return { removed: await accounts.unlink(actor, cfg.account) };
  },
});
