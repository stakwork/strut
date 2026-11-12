import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { qrSvg } from "../../../move/link.js";
import { adminDoor, bodyOrThrow } from "./_door.js";

/** Add sats: an invoice INTO the wallet for the admin to pay from their own
 *  (`POST /earnings/deposit`, specs/API.md §19), with its QR code — the
 *  `lightning:` link as an SVG data URL, since a page has no QR library. */
export default defineStep({
  type: "earnings/deposit",
  description:
    "Add sats: an invoice into this server's wallet, for an admin to pay from their own wallet. Answers { state, paymentHash, msat, expires, invoice, qr } — qr an image of the invoice. Never credit, never earnings. Only strut's own Earnings app, shown to an admin.",
  input: z.object({ sats: z.number().int().positive().describe("How many sats.") }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const out = bodyOrThrow(await adminDoor(ctx, "earnings/deposit").call("POST", "/earnings/deposit", { sats: cfg.sats }, ctx.actor));
    return typeof out["invoice"] === "string" ? { ...out, qr: qrDataUrl(out["invoice"]) } : out;
  },
});

/** A BOLT11 invoice as a QR code a wallet scans: `lightning:` and upper
 *  case (alphanumeric mode), as an SVG data URL an <img> takes. */
export function qrDataUrl(invoice: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(qrSvg(`lightning:${invoice}`.toUpperCase()).replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ')).toString("base64")}`;
}
