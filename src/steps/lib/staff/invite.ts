import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall } from "./_door.js";

/** `staff/invite` (plans/human-steps.md §5.8): a new worker's one link. */
export default defineStep({
  type: "staff/invite",
  effect: "write",
  description:
    "Invite a new worker (POST /tasks/invites): the wallet's Sphinx daemon makes a Sphinx invite — paying the mixer for it, sats the worker's starting balance plus its price — and strut answers { code, link, sats, status, app, qrSvg }. " +
    "link is https://<public view>/public/join#…, to send someone new to Peel: on Android it installs Peel, signs them up with the invite and then opens the worker app at its share link (app, one of the apps the task types name that are in the public view; needed when there are several). " +
    "qrSvg is the link as a QR code (an SVG), as staff/types' share. sats left out is the payout settings' inviteSats. status is sending until the mixer has it, then ready. Only strut's own staff app, shown to an admin.",
  input: z.object({
    sats: z.number().int().positive().optional().describe("The worker's starting sats; the payout settings' inviteSats when left out."),
    app: z.string().min(1).optional().describe("The worker app the link opens, when the task types name several."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const out = await staffCall(ctx, "staff/invite", "POST", "/tasks/invites", cfg);
    if (typeof out["link"] !== "string") return out;
    const { qrSvg } = await import("../../../move/link.js");
    return { ...out, qrSvg: qrSvg(out["link"]) };
  },
});
