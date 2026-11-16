import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { qrSvg } from "../../../move/link.js";
import { staffCall } from "./_door.js";

/** `staff/invite` (plans/human-steps.md §5.7): a new worker's one link. */
export default defineStep({
  type: "staff/invite",
  effect: "write",
  description:
    "Invite a new worker (POST /tasks/invites): the wallet's Sphinx daemon makes a Sphinx invite — paying the mixer for it, sats the worker's starting balance plus its price — and strut answers { code, link, sats, status, app, qr }. " +
    "link is https://<public view>/public/join#…, to send the worker: it opens Peel on Android, which signs them up with the invite and then opens the worker app (app, one of the apps the task types name that are in the public view; needed when there are several). " +
    "qr is an image of the link. sats left out is the payout settings' inviteSats. status is sending until the mixer has it, then ready. Only strut's own staff app, shown to an admin.",
  input: z.object({
    sats: z.number().int().positive().optional().describe("The worker's starting sats; the payout settings' inviteSats when left out."),
    app: z.string().min(1).optional().describe("The worker app the link opens, when the task types name several."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const out = await staffCall(ctx, "staff/invite", "POST", "/tasks/invites", cfg);
    return typeof out["link"] === "string" ? { ...out, qr: linkQr(out["link"]) } : out;
  },
});

/** A link as a QR code a phone's camera opens: an SVG data URL an <img>
 *  takes, since a page has no QR library. */
export function linkQr(link: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(qrSvg(link).replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ')).toString("base64")}`;
}
