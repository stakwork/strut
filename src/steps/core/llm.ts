import { z } from "zod";
import { defineStep, type StepContext } from "../../core.js";
import type { StrutCapabilities } from "../../capabilities.js";
import { resolveModel } from "../../llm.js";

const EXAMPLE = `- id: summarize
  type: llm
  config:
    prompt: "Summarize this: {{ fetch.body }}"
    model: claude-sonnet-5`;

/** Normalize a step's `schema` for the AI SDK. A YAML workflow can only write
 *  a plain JSON Schema object, which the SDK accepts only wrapped in
 *  `jsonSchema()` — handed a bare object it assumes a lazy thunk and throws
 *  "schema is not a function". Zod / Standard Schema values, already-wrapped
 *  SDK schemas, and thunks pass through untouched. */
export async function toSdkSchema(schema: unknown): Promise<unknown> {
  if (schema == null || typeof schema === "function") return schema;
  if (typeof schema === "object" && ("~standard" in schema || Symbol.for("vercel.ai.schema") in schema)) {
    return schema;
  }
  const { jsonSchema } = await import("ai");
  return jsonSchema(schema as Parameters<typeof jsonSchema>[0]);
}

export default defineStep({
  type: "llm",
  description: `One LLM call over a prompt — summarize, classify, extract, draft. Judgment, not arithmetic: have it return what it found (a label, a quote, a timestamp exactly as written in the source — hh:mm:ss, mm:ss, or seconds) and do conversion and math in code (exec or a custom step); set schema so numeric fields arrive typed. Output: { text }, or the structured object itself when schema is set. Needs the provider's key in the secret store or env (ANTHROPIC_API_KEY, OPENAI_API_KEY, …). For multi-step work with tools, use the agent step.\n\n${EXAMPLE}`,
  input: z.object({
    prompt: z.string().describe("the full prompt; templates resolve first"),
    schema: z
      .any()
      .optional()
      .describe(
        "JSON Schema for STRUCTURED output — the step returns the object itself, so put timestamps/numbers/labels in typed fields (in code, a Zod schema also works); omit for free-form { text }",
      ),
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
        schema: (await toSdkSchema(cfg.schema)) as any,
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
