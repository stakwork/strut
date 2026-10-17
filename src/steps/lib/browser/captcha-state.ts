import { z } from "zod";
import { defineStep } from "../../../core.js";
import { CAPTCHA_STATES, ROUND_MAX, captchaArtifact, markCaptcha } from "../../../browser/captcha.js";
import { type Ctx, shotSinkOf } from "./_shared.js";

const artifact = z.object({ id: z.literal("captcha"), kind: z.literal("captcha"), title: z.string(), path: z.string() });

export default defineStep({
  type: "browser/captcha-state",
  description:
    "Set where a captcha round stands — waiting, sent, solved, failed or expired — on its manifest (shots/captcha-<round>.json, browser/captcha-ask's), so the person's card says so, and return the round's artifact to list. Returns { marked, artifact? }: marked false when that round was never asked here (round 0: none was).",
  input: z.object({
    round: z.number().int().min(0).max(ROUND_MAX).describe("the round; 0 when none was asked"),
    state: z.enum(CAPTCHA_STATES),
  }),
  output: z.object({ marked: z.boolean(), artifact: artifact.optional() }),
  async run(cfg, ctx: Ctx) {
    const marked = cfg.round ? await markCaptcha(shotSinkOf(ctx), cfg.round, cfg.state) : null;
    return marked ? { marked: true, artifact: captchaArtifact(marked.manifest) } : { marked: false };
  },
});
