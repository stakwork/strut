import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { jsonSchema } from "ai";
import llm, { toSdkSchema } from "./llm.js";

// OFFLINE: no model call. This covers the normalization a workflow's `schema:`
// goes through before Output.object. The bug it pins: a YAML workflow can only
// write a plain JSON Schema object, and handed one bare the SDK assumes a lazy
// thunk and throws "schema is not a function".
describe("llm step: toSdkSchema", () => {
  const SDK = Symbol.for("vercel.ai.schema");

  it("wraps a plain JSON Schema object (what YAML can write) in jsonSchema()", async () => {
    const out = (await toSdkSchema({
      type: "object",
      properties: { start: { type: "string" } },
      required: ["start"],
    })) as any;
    assert.equal(out[SDK], true);
    assert.deepEqual(out.jsonSchema.required, ["start"]);
  });

  it("passes a Zod schema through untouched", async () => {
    const s = z.object({ start: z.string() });
    assert.equal(await toSdkSchema(s), s);
  });

  it("passes an already-wrapped SDK schema through untouched", async () => {
    const s = jsonSchema({ type: "object" });
    assert.equal(await toSdkSchema(s), s);
  });

  it("leaves undefined alone (free-form text mode)", async () => {
    assert.equal(await toSdkSchema(undefined), undefined);
  });

  it("the config accepts a JSON Schema object under `schema`", () => {
    const parsed = llm.input.parse({ prompt: "x", schema: { type: "object" } });
    assert.deepEqual(parsed.schema, { type: "object" });
  });
});

// The cost on the step's output: what the provider reported for each call
// (OpenRouter's provider metadata, Numes' or Token Factory's raw usage), else the call's tokens at the model's
// price. The model is a stub put in through the model-wrapper extension point
// (every model resolveModel builds passes it), so no provider is called.
describe("llm step: cost", () => {
  const stub = (providerMetadata?: Record<string, unknown>) => ({
    specificationVersion: "v3",
    provider: "stub",
    modelId: "stub",
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: "text", text: "pong" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1_000, noCache: 1_000, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 10, text: 10, reasoning: 0 },
      },
      ...(providerMetadata ? { providerMetadata } : {}),
      warnings: [],
    }),
    doStream: async () => {
      throw new Error("not streamed");
    },
  });
  let next: unknown;
  const ctx = { services: { secrets: { get: async (name: string) => (name === "OPENROUTER_API_KEY" ? "k" : undefined), list: async () => [] } } } as any;

  it("takes the cost the provider reported, else prices the tokens", async () => {
    const { registerModelWrapper } = await import("../../extensions.js");
    registerModelWrapper(() => next);
    next = stub({ openrouter: { usage: { cost: 0.0042 } } });
    const reported = await llm.run({ prompt: "ping", model: "openrouter/acme/paid-1" }, ctx);
    assert.equal(reported.text, "pong");
    assert.equal(reported.cost, 0.0042);

    next = stub();
    const priced = await llm.run({ prompt: "ping", model: "openrouter/acme/paid-1" }, ctx);
    // No catalog loaded, an unknown OpenRouter model: OpenRouter's flat rate,
    // $0.60 in and $3 out per million.
    assert.equal(priced.cost.toFixed(7), "0.0006300");
  });
});
