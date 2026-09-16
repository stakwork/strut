import { z } from "zod";
import { defineStep, type StepContext } from "../../core.js";
import type { StrutCapabilities } from "../../capabilities.js";
import { resolveModel } from "../../llm.js";

const EXAMPLE = `- id: summarize
  type: llm
  config:
    prompt: "Summarize this: {{ fetch.body }}"
    model: claude-sonnet-5`;

export default defineStep({
  type: "llm",
  description: `One LLM call over a prompt — summarize, classify, extract, draft. Output: { text }, or the structured object itself when schema is set. Needs the provider's key in the secret store or env (ANTHROPIC_API_KEY, OPENAI_API_KEY, …). For multi-step work with tools, use the agent step.\n\n${EXAMPLE}`,
  input: z.object({
    prompt: z.string().describe("the full prompt; templates resolve first"),
    schema: z.any().optional().describe("structured-output schema (a Zod schema, for flows defined in code); omit for free-form text"),
    provider: z
      .string()
      .optional()
      .describe("anthropic | openai | google | openrouter | xai — usually omitted (inferred from `model`)"),
    model: z
      .string()
      .optional()
      .meta({
        description:
          "model id, aieo alias ('sonnet', 'gpt', 'gemini', 'kimi', 'glm', 'grok'), or 'provider/id' ('openrouter/moonshotai/kimi-k2.6'); the provider is inferred from it when `provider` is omitted",
        // The step editor offers the deployment's model catalog (GET /llm/models).
        suggest: "llm-models",
      }),
  }),
  output: z.any(),
  async run(cfg, ctx?: StepContext<StrutCapabilities>) {
    // Dynamic import to avoid hard dependency if not using LLM steps
    const { generateText, generateObject } = await import("ai");

    // Provider/model/key via the shared resolver (src/llm.ts → aieo): the key
    // comes through the secrets boundary (secret store → env). The output
    // cap is a provider-derived infra constant (pricing.ts) — without it the
    // SDK's 4096 default truncates a long answer.
    const { model, maxOutputTokens } = await resolveModel({
      model: cfg.model ?? process.env["STRUT_LLM_MODEL"],
      provider: cfg.provider ?? process.env["STRUT_LLM_PROVIDER"],
      secrets: ctx?.services?.secrets,
    });

    if (cfg.schema) {
      // Structured output
      const result = await generateObject({
        model,
        prompt: cfg.prompt,
        schema: cfg.schema,
        maxOutputTokens,
      });
      return result.object;
    } else {
      // Free-form text
      const result = await generateText({
        model,
        prompt: cfg.prompt,
        maxOutputTokens,
      });
      return { text: result.text };
    }
  },
});
