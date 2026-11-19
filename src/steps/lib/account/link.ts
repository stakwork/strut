import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { requireAccounts } from "./_shared.js";

/**
 * `account/link` (plans/people-and-hosts.md §2.1): a link challenge naming
 * the viewer, for Peel to sign. Shown as a QR and an Open in Peel link
 * (`peel://strut/link?url=<this strut>&challenge=<…>`); Peel signs it with
 * its Sphinx key and posts it to `POST /people/link`, which links that key to
 * the viewer. Ten minutes, once.
 */
export default defineStep({
  type: "account/link",
  effect: "write",
  description:
    "A one-time link challenge naming you, for Peel to sign: { challenge, exp, link, qr }, `link` the Open in Peel link and `qr` it as an SVG data URI. Peel signs it with its Sphinx key, and that key is linked to you. Ten minutes, once. Strut's own app's call alone.",
  input: z.object({}),
  output: z.object({ challenge: z.string(), exp: z.number(), link: z.string(), qr: z.string() }),
  async run(_cfg, ctx?: StepContext) {
    const { accounts, actor } = requireAccounts("account/link", ctx);
    return accounts.challenge(actor);
  },
});
