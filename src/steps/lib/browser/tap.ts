import { z } from "zod";
import { defineStep } from "../../../core.js";
import { type Ctx, browserOf, oneOf, ONE_TARGET, target, timeoutMs } from "./_shared.js";

const fraction = z.number().min(0).max(1);

export default defineStep({
  type: "browser/tap",
  description:
    "Click points ON an element, each as fractions of its box: { nx, ny } from 0 (left / top) to 1 (right / bottom). For a person's taps on a picture of that element — a captcha's crop (browser/captcha-ask) — handed back as the same fractions: tap the SAME element you cropped, by the same ref or selector, and the clicks land where the person tapped. Clicks inside an iframe reach what it shows. Pauses `delayMs` (300) between two taps, settles after the last. Returns { url, taps }.",
  input: z
    .object({
      ...target,
      points: z.array(z.object({ nx: fraction, ny: fraction })).min(1).max(40).describe("where to click, in order"),
      delayMs: z.number().int().nonnegative().max(5000).optional().describe("pause between two taps (default 300)"),
      timeoutMs,
    })
    .refine(oneOf("ref", "selector"), ONE_TARGET),
  output: z.object({ url: z.string(), taps: z.number() }),
  async run(cfg, ctx: Ctx) {
    return browserOf(ctx).tap(ctx.runId, cfg);
  },
});
