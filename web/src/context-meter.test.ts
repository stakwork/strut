import { test } from "node:test";
import assert from "node:assert/strict";
import { contextMeter, formatTokens } from "./context-meter";

test("formatTokens: short counts, k, then M", () => {
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(1_000), "1k");
  assert.equal(formatTokens(351_234), "351k");
  assert.equal(formatTokens(999_400), "999k");
  assert.equal(formatTokens(999_600), "1M");
  assert.equal(formatTokens(1_000_000), "1M");
  assert.equal(formatTokens(1_048_576), "1.05M");
  assert.equal(formatTokens(200_000), "200k");
});

test("contextMeter: used / limit, warning from 80% of the window", () => {
  assert.deepEqual(contextMeter({ used: 351_234, limit: 1_000_000 }), { text: "351k / 1M", warn: false });
  assert.deepEqual(contextMeter({ used: 160_000, limit: 200_000 }), { text: "160k / 200k", warn: true });
  assert.deepEqual(contextMeter({ used: 5, limit: 0 }), { text: "5 / 0", warn: false });
});
