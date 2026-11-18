import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { requireAccounts } from "./_shared.js";

/** `account/links` (plans/people-and-hosts.md §2.1): the accounts the viewer
 *  linked, the newest first. */
export default defineStep({
  type: "account/links",
  effect: "read",
  description: "The accounts on other media (Sphinx) linked to you, the newest first: { links: [{ account, kind, key, address?, name?, host?, at }] }. Strut's own app's call alone.",
  input: z.object({}),
  output: z.object({
    links: z.array(
      z.object({
        account: z.string(),
        kind: z.string(),
        key: z.string(),
        address: z.string().optional(),
        name: z.string().optional(),
        host: z.string().optional(),
        at: z.number(),
      }),
    ),
  }),
  async run(_cfg, ctx?: StepContext) {
    const { accounts, actor } = requireAccounts("account/links", ctx);
    return { links: (await accounts.links(actor)).map(({ actor: _actor, ...l }) => l) };
  },
});
