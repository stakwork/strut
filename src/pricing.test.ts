import { test } from "node:test";
import assert from "node:assert/strict";
import { usageFromResult, usageFromSteps, coerceUsage, addUsage, emptyUsage, usageForCost } from "./pricing.js";

test("usageFromResult prefers the v6 inputTokenDetails breakdown", () => {
  const u = usageFromResult({
    inputTokens: 1000,
    outputTokens: 200,
    totalTokens: 1200,
    inputTokenDetails: { noCacheTokens: 600, cacheReadTokens: 300, cacheWriteTokens: 100 },
  });
  assert.deepEqual(u, {
    inputTokens: 600,
    cacheReadTokens: 300,
    cacheWriteTokens: 100,
    outputTokens: 200,
    totalTokens: 1200,
  });
});

test("usageFromResult falls back to flat inputTokens minus cache when details absent", () => {
  const u = usageFromResult({ inputTokens: 1000, outputTokens: 200, cachedInputTokens: 300 });
  // non-cached = 1000 - 300 cacheRead - 0 cacheWrite
  assert.equal(u.inputTokens, 700);
  assert.equal(u.cacheReadTokens, 300);
  assert.equal(u.cacheWriteTokens, 0);
  assert.equal(u.outputTokens, 200);
  assert.equal(u.totalTokens, 700 + 300 + 200);
});

test("usageFromResult is safe on null / garbage", () => {
  assert.deepEqual(usageFromResult(null), emptyUsage());
  assert.deepEqual(usageFromResult(undefined), emptyUsage());
  assert.deepEqual(usageFromResult(42 as unknown), emptyUsage());
});

test("addUsage / coerceUsage sum token classes for cross-call totals", () => {
  const a = coerceUsage({ inputTokens: 10, cacheReadTokens: 5, outputTokens: 2 });
  const b = usageFromResult({ inputTokens: 20, outputTokens: 3, inputTokenDetails: { noCacheTokens: 20 } });
  const sum = addUsage(a, b);
  assert.equal(sum.inputTokens, 30);
  assert.equal(sum.cacheReadTokens, 5);
  assert.equal(sum.outputTokens, 5);
});

test("usageForCost is the exact shape aieo's computeSessionCost prices", async () => {
  const u = { inputTokens: 120_000, cacheReadTokens: 800_000, cacheWriteTokens: 50_000, outputTokens: 30_000, totalTokens: 1_000_000 };
  assert.deepEqual(usageForCost(u), { input: 120_000, cache_read: 800_000, cache_write: 50_000, output: 30_000 });
  // Pricing itself is aieo's — pin the anthropic figure so a table change
  // there is noticed here: 0.12*3 + 0.8*0.3 + 0.05*3.75 + 0.03*15 = 1.2375.
  const { computeSessionCost } = await import("aieo");
  assert.ok(Math.abs(computeSessionCost("anthropic", usageForCost(u)) - 1.2375) < 1e-9);
});

// A step whose SDK parser missed the cache (a gateway spelled the field its own
// way): the SDK reports it all as non-cached input, `raw` has the real counts.
const missed = (raw: unknown) => ({
  inputTokens: 1000,
  inputTokenDetails: { noCacheTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: undefined },
  outputTokens: 50,
  totalTokens: 1050,
  raw,
});

test("usageFromResult finds cache counts in raw usage under any spelling", () => {
  for (const raw of [
    { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 800 } },
    { prompt_tokens: 1000, prompt_tokens_details: { cached_read_tokens: 800 } },
    { prompt_tokens: 1000, prompt_tokens_details: { cache_read_tokens: 800 } },
    { prompt_tokens: 1000, cache_read_input_tokens: 800 },
  ]) {
    const u = usageFromResult(missed(raw));
    assert.equal(u.cacheReadTokens, 800, JSON.stringify(raw));
    assert.equal(u.inputTokens, 200, JSON.stringify(raw));
  }
  const w = usageFromResult(missed({ prompt_tokens_details: { cached_tokens: 0, cached_write_tokens: 300 } }));
  assert.deepEqual([w.cacheReadTokens, w.cacheWriteTokens, w.inputTokens], [0, 300, 700]);
});

test("usageFromResult reads OpenRouter's metadata copy, and keeps an Anthropic-style total whole", () => {
  const meta = { openrouter: { usage: { promptTokensDetails: { cachedTokens: 600 } } } };
  assert.equal(usageFromResult(missed(undefined), meta).cacheReadTokens, 600);
  // Anthropic convention: input excludes the cache, so it can be smaller than it.
  const a = usageFromResult(missed({ input_tokens: 1000, cache_read_input_tokens: 5000 }));
  assert.deepEqual([a.inputTokens, a.cacheReadTokens], [1000, 5000]);
});

test("usageFromResult trusts the SDK's own cache counts over raw", () => {
  const u = usageFromResult({
    inputTokens: 1000,
    inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0 },
    outputTokens: 1,
    raw: { cache_read_input_tokens: 5 },
  });
  assert.equal(u.cacheReadTokens, 900);
});

test("usageFromSteps sums each step with its own raw usage", () => {
  const u = usageFromSteps([
    { usage: missed({ prompt_tokens_details: { cached_tokens: 800 } }) },
    { usage: missed(undefined), providerMetadata: { openrouter: { usage: { promptTokensDetails: { cachedTokens: 400 } } } } },
  ]);
  assert.deepEqual([u.cacheReadTokens, u.inputTokens, u.outputTokens], [1200, 800, 100]);
  assert.deepEqual(usageFromSteps(undefined), emptyUsage());
});
