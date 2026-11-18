import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { qrSvg } from "../../../move/link.js";
import { requireAccounts } from "./_shared.js";

/**
 * `account/link-code` (plans/jamie-in-tribes.md §3): a one-time code that
 * links an account to the viewer. They send it by DM to the account a host
 * speaks for — the Sphinx daemon's, `to`, with its address as a QR — and the
 * host hands it back with the key that sent it (`POST /hosts/link`). Ten
 * minutes, once; a new code replaces the viewer's last. `hosts` are those
 * this server has keys for: none, and nothing links here yet.
 */
export default defineStep({
  type: "account/link-code",
  effect: "write",
  description:
    "A one-time code that links an account on another medium (Sphinx) to you: send it by DM to `to.address`, and the host that speaks for that account links the key that sent it. Ten minutes, once. Strut's own app's call alone.",
  input: z.object({}),
  output: z.object({
    code: z.string(),
    expiresAt: z.number(),
    hosts: z.array(z.string()),
    to: z.object({ kind: z.string(), address: z.string(), alias: z.string().optional(), qr: z.string() }).optional(),
  }),
  async run(_cfg, ctx?: StepContext) {
    const { accounts, actor } = requireAccounts("account/link-code", ctx);
    const { to, ...made } = await accounts.linkCode(actor);
    return {
      ...made,
      // The address as a QR a Sphinx app scans to add the contact.
      ...(to ? { to: { ...to, qr: `data:image/svg+xml;base64,${Buffer.from(qrSvg(to.address)).toString("base64")}` } } : {}),
    };
  },
});
