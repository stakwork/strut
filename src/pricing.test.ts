import { test } from "node:test";
import assert from "node:assert/strict";
import { usageFromResult, coerceUsage, addUsage, emptyUsage, usageForCost } from "./pricing.js";

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
