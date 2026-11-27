import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall } from "./_door.js";

/** `staff/invite` (plans/human-steps.md §5.8): a worker's one link. */
export default defineStep({
  type: "staff/invite",
  effect: "write",
  description:
    "Invite a worker (POST /tasks/invites): the wallet's Sphinx daemon makes a Sphinx invite — paying the mixer for it, sats the worker's starting balance plus its price — and strut answers { code, link, shortLink?, sats, status, type?, qrSvg }. " +
    "link is https://<public view>/public/join#…, for one person: on a phone (Android or iPhone) it gets Peel when they have none and signs them up with the invite, then opens Tasks (strut/tasks) — on `type` when given, which it gives them when it is invite-only. Someone who has Peel already goes straight to Tasks. " +
    "shortLink (https://<public view>/public/i/<code>) redirects to link while the invite is open: send it, not link. qrSvg is shortLink (else link) as a QR code (an SVG), as staff/types' share. sats left out is the payout settings' inviteSats. status is sending until the mixer has it, then ready. Only strut's own Workers app, shown to an admin.",
  input: z.object({
    sats: z.number().int().positive().optional().describe("The worker's starting sats; the payout settings' inviteSats when left out."),
    type: z.string().min(1).optional().describe("The kind of work the invite is for: Tasks opens it, and gives it when it is invite-only. Left out: open work alone."),
    label: z.string().max(80).optional().describe("A free label (a batch name such as \"Class A\"); the Workers app lists invites sharing one together."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const out = await staffCall(ctx, "staff/invite", "POST", "/tasks/invites", cfg);
    // The QR is of the short link when there is one: fewer modules, so it scans more easily.
    const link = typeof out["shortLink"] === "string" ? out["shortLink"] : out["link"];
    if (typeof link !== "string") return out;
    const { qrSvg } = await import("../../../move/link.js");
    return { ...out, qrSvg: qrSvg(link) };
  },
});
