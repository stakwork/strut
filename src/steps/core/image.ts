import { z } from "zod";
import { defineStep, withMedia, withUsage, type StepContext } from "../../core.js";
import type { StrutCapabilities } from "../../capabilities.js";
import { loadAieo, resolveMediaModel, stepAuth } from "../../llm.js";
import { emptyUsage, type TokenUsage } from "../../pricing.js";
import { imagePreview, mediaFileName, saveMedia } from "../../media.js";

const EXAMPLE = `- id: hero
  type: image
  config:
    prompt: "A lighthouse at dusk, flat illustration: {{ input.theme }}"
    model: xai/grok-imagine-image`;

/** aieo, as `loadAieo` returns it. */
type Aieo = Awaited<ReturnType<typeof loadAieo>>;

/** The input tokens that were an image's, as OpenAI reports them per image. */
function inputImageTokens(providerMetadata: unknown): number | undefined {
  const images = (providerMetadata as { openai?: { images?: Array<{ imageTokens?: unknown }> } } | undefined)?.openai?.images;
  if (!Array.isArray(images)) return undefined;
  let sum = 0;
  for (const i of images) if (typeof i?.imageTokens === "number") sum += i.imageTokens;
  return sum;
}

/** The prompt the provider says it rewrote the request into (OpenAI's, xAI's). */
function revisedPrompt(providerMetadata: unknown): string | undefined {
  for (const meta of Object.values((providerMetadata ?? {}) as Record<string, { images?: Array<{ revisedPrompt?: unknown }> }>)) {
    const r = meta?.images?.[0]?.revisedPrompt;
    if (typeof r === "string" && r) return r;
  }
  return undefined;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export default defineStep({
  type: "image",
  description: `Make ONE image from a prompt with an image model, written to a file. Output: { path, url, mediaType, bytes, model, cost, usage, revisedPrompt? } — \`path\` is relative to the run's files (the job's directory on a job run), so declare it as a deliverable: artifacts: [{ id, kind: image, path: "{{ <step>.path }}" }]. \`cost\` is the call's dollar cost: what the provider reported (OpenRouter, xAI), else the model's datasheet price (OpenAI, Google); a model with neither is refused before the call. Models are "<provider>/<id>": xai/grok-imagine-image, openai/gpt-image-1-mini, google/gemini-2.5-flash-image, openrouter/black-forest-labs/flux.2-klein-4b (OpenRouter only where calls go to the provider directly, never through the deployment's LLM gateway). Several images: a foreach. As an agent's tool, the model sees a small copy of the image.\n\n${EXAMPLE}`,
  input: z.object({
    prompt: z.string().min(1).describe("what to draw; templates resolve first"),
    model: z
      .string()
      .min(1)
      .describe(
        "the image model as '<provider>/<id>': xai/grok-imagine-image, openai/gpt-image-1-mini, google/gemini-2.5-flash-image, google/imagen-3.0-generate-001, openrouter/<org>/<model>",
      ),
    size: z
      .string()
      .regex(/^\d+x\d+$/, "WIDTHxHEIGHT, e.g. 1024x1024")
      .optional()
      .describe("WIDTHxHEIGHT, e.g. 1024x1024 — models that take a size (OpenAI)"),
    aspectRatio: z
      .string()
      .regex(/^\d+:\d+$/, "W:H, e.g. 16:9")
      .optional()
      .describe("W:H, e.g. 16:9 — models that take an aspect ratio (Google, xAI, OpenRouter)"),
    seed: z.number().int().optional().describe("for a model that takes one"),
    providerOptions: z
      .record(z.string(), z.record(z.string(), z.any()))
      .optional()
      .describe("provider-specific settings keyed by provider, passed through: { openai: { quality: low } }"),
    name: z
      .string()
      .optional()
      .describe("the file's name, without extension (default: the step's own, e.g. hero, or each-3-pic in a foreach)"),
  }),
  output: z.object({
    path: z.string(),
    url: z.string(),
    mediaType: z.string(),
    bytes: z.number(),
    model: z.string(),
    cost: z.number(),
    usage: z.any(),
    revisedPrompt: z.string().optional(),
  }),
  async run(cfg, ctx?: StepContext<StrutCapabilities>) {
    const aieo: Aieo = await loadAieo();
    const { generateImage } = await import("ai");
    const resolved = await resolveMediaModel("image", {
      model: cfg.model,
      secrets: ctx?.services?.secrets,
      ...stepAuth(ctx),
    });
    const provider = resolved.provider as Parameters<Aieo["computeImageCost"]>[0];
    // A cost is never guessed: a model whose provider does not report what a
    // call cost, and that the datasheet does not price, is refused before
    // anything is spent.
    if (!aieo.mediaReportsCost("image", provider) && !aieo.getImagePrice(provider, resolved.modelId)) {
      throw new Error(
        `image_unpriced: no price is known for ${resolved.name}, so its cost could not be reported. ` +
          `Use a model the model catalog prices, or one whose provider reports its cost (xai/…, openrouter/…)`,
      );
    }

    const result = await generateImage({
      model: resolved.model,
      prompt: cfg.prompt,
      ...(cfg.size ? { size: cfg.size as `${number}x${number}` } : {}),
      ...(cfg.aspectRatio ? { aspectRatio: cfg.aspectRatio as `${number}:${number}` } : {}),
      ...(cfg.seed !== undefined ? { seed: cfg.seed } : {}),
      ...(cfg.providerOptions ? { providerOptions: cfg.providerOptions as any } : {}),
    });
    const image = result.image;
    const call = result.calls[0];

    const usage: TokenUsage = {
      ...emptyUsage(),
      inputTokens: num(result.usage?.inputTokens),
      outputTokens: num(result.usage?.outputTokens),
      totalTokens: num(result.usage?.totalTokens) || num(result.usage?.inputTokens) + num(result.usage?.outputTokens),
    };
    let cost = 0;
    for (const c of result.calls) {
      const one =
        aieo.mediaCostOf(c.providerMetadata) ??
        aieo.computeImageCost(provider, resolved.modelId, {
          inputTokens: c.usage?.inputTokens,
          inputImageTokens: inputImageTokens(c.providerMetadata),
          outputTokens: c.usage?.outputTokens,
          images: c.images.length,
        });
      if (one === undefined) {
        throw new Error(
          `image_unpriced: ${resolved.name} made an image but reported neither its cost nor the tokens its price needs, so its cost is unknown`,
        );
      }
      cost += one;
    }

    const saved = await saveMedia(ctx, {
      folder: "images",
      name: mediaFileName(ctx, cfg.name, "image"),
      data: image.uint8Array,
      mediaType: image.mediaType,
      kind: "image",
    });
    const revised = revisedPrompt(call?.providerMetadata);
    const out = {
      path: saved.path,
      url: saved.url,
      mediaType: saved.mediaType,
      bytes: saved.bytes,
      model: resolved.name,
      cost,
      usage,
      ...(revised ? { revisedPrompt: revised } : {}),
    };
    const preview = await imagePreview(image.uint8Array);
    withMedia(out, preview ? [{ ...preview, filename: saved.path }] : undefined);
    return withUsage(out, { modelCalls: result.calls.length || 1, usage, cost });
  },
});
