import { z } from "zod";
import { defineStep, withMedia } from "../../../core.js";
import { CAPTCHA_MODES, GRID_MAX, ROUND_MAX, captchaArtifact } from "../../../browser/captcha.js";
import { type Ctx, browserOf, oneOf, ONE_TARGET, shotSinkOf, target, timeoutMs } from "./_shared.js";

const count = z.number().int().min(1).max(GRID_MAX);

export default defineStep({
  type: "browser/captcha-ask",
  description:
    "Ask the PERSON to solve a captcha: crop the challenge element (`ref` or `selector`) to shots/captcha-<round>.png and write the manifest the person's card reads beside it, shots/captcha-<round>.json — the site read off the page, the time it was asked and when it expires. You see the crop: check it shows the whole challenge. " +
    "Crop the tile grid ITSELF (e.g. the challenge frame's `table`) with `grid` { rows, cols } so the person taps tiles; crop the whole challenge, no grid, for free taps (mode tap) or a text to type (mode text). Put what the challenge asks in `instruction` when the crop does not show it. " +
    "Returns { artifact, round, site, expiresAt }: list `artifact` as one of the job's artifacts, as given. The answer comes back as fractions of THIS crop: browser/tap the same element.",
  input: z
    .object({
      ...target,
      round: z.number().int().min(1).max(ROUND_MAX).describe("1 for a new captcha; the answered round + 1 for the next"),
      mode: z.enum(CAPTCHA_MODES).describe("tap: tiles or points on the image; text: characters to type; either"),
      grid: z.object({ rows: count, cols: count }).optional().describe("the tiles, when the crop is exactly a grid of them"),
      instruction: z.string().optional().describe("what the challenge asks, e.g. \"Select all images with a bus\""),
      maxRounds: z.number().int().min(1).max(ROUND_MAX).default(5).describe("rounds before giving up"),
      expiresInMs: z.number().int().positive().default(600_000).describe("how long the person has (default 10 min)"),
      timeoutMs,
    })
    .refine(oneOf("ref", "selector"), ONE_TARGET),
  output: z.object({
    artifact: z.object({ id: z.literal("captcha"), kind: z.literal("captcha"), title: z.string(), path: z.string() }),
    round: z.number(),
    site: z.string(),
    expiresAt: z.string(),
    image: z.object({ path: z.string(), url: z.string() }),
  }),
  async run(cfg, ctx: Ctx) {
    const { manifest, image, small } = await browserOf(ctx).captcha(ctx.runId, cfg, shotSinkOf(ctx));
    return withMedia(
      { artifact: captchaArtifact(manifest), round: manifest.round, site: manifest.site, expiresAt: manifest.expiresAt, image: { path: image.path, url: image.url } },
      [{ mediaType: "image/png", data: small, filename: image.path }],
    );
  },
});
