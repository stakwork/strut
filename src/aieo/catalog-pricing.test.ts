// The datasheet is the only source of model prices: id normalisation, unpriced
// models, 1h cache writes and the long-prompt tier, all from fixture sheets.
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  computeSessionCost,
  getModelPrice,
  getProviderForModel,
  modelCatalogStatus,
  modelPriceSource,
  parseModelCatalog,
  setModelCatalog,
} from "./provider.js";

const M = 1_000_000;
const usage = { input: M, cache_read: M, cache_write: M, output: M };
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const sheet = (o: object) => setModelCatalog(parseModelCatalog(JSON.stringify(o)));

const SHEET = {
  "claude-opus-5": { input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5, cache_read_input_token_cost: 5e-7, cache_creation_input_token_cost: 6.25e-6 },
  "claude-opus-5-5": { input_cost_per_token: 4e-6, output_cost_per_token: 2e-5 },
  "claude-haiku-4-5-20251001": { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
  "claude-sonnet-5": {
    input_cost_per_token: 2e-6,
    output_cost_per_token: 1e-5,
    cache_creation_input_token_cost: 2.5e-6,
    cache_creation_input_token_cost_above_1hr: 4e-6,
  },
  "claude-haiku-5-5": {
    input_cost_per_token: 1e-7,
    output_cost_per_token: 5e-7,
    cache_read_input_token_cost: 1e-8,
    cache_creation_input_token_cost: 1.25e-7,
    cache_creation_input_token_cost_above_1hr: 2e-7,
    input_cost_per_token_above_100k_tokens: 5e-7,
    output_cost_per_token_above_100k_tokens: 2.5e-6,
    cache_read_input_token_cost_above_100k_tokens: 5e-8,
    cache_creation_input_token_cost_above_100k_tokens: 6.25e-7,
    cache_creation_input_token_cost_above_1hr_above_100k_tokens: 1e-6,
    input_cost_per_token_above_200k_tokens: 9e-6,
    input_cost_per_token_batches: 5e-8,
    input_cost_per_token_batches_above_100k_tokens: 7e-7,
    input_cost_per_token_above_100k_tokens_priority: 8e-7,
  },
};

beforeEach(() => setModelCatalog(undefined));
afterEach(() => setModelCatalog(undefined));

describe("id normalisation", () => {
  it("prefix, dotted and dated ids find the sheet's row", () => {
    sheet(SHEET);
    const opus = computeSessionCost("anthropic", usage, "claude-opus-5");
    near(opus, 5 + 0.5 + 6.25 + 25);
    near(computeSessionCost("anthropic", usage, "anthropic/claude-opus-5"), opus);
    near(computeSessionCost("anthropic", { input: M, cache_read: 0, cache_write: 0, output: 0 }, "anthropic/claude-opus-5.5"), 4);
    near(computeSessionCost("anthropic", { input: M, cache_read: 0, cache_write: 0, output: 0 }, "claude-opus-5.5"), 4);
    near(computeSessionCost("anthropic", { input: M, cache_read: 0, cache_write: 0, output: 0 }, "claude-haiku-4-5-20251001"), 1, "the exact dated key");
    near(computeSessionCost("anthropic", { input: M, cache_read: 0, cache_write: 0, output: 0 }, "claude-haiku-4-5@20251001"), 1);
    near(computeSessionCost("anthropic", { input: M, cache_read: 0, cache_write: 0, output: 0 }, "claude-opus-5-20260101"), 5, "dated id, sheet holds the bare one");
    assert.equal(modelPriceSource("anthropic", "claude-opus-5.5"), "catalog");
    assert.equal(getProviderForModel("claude-opus-4-8"), "anthropic");
  });

  it("the exact dated key wins over the undated one", () => {
    sheet({ ...SHEET, "claude-haiku-4-5": { input_cost_per_token: 9e-6, output_cost_per_token: 9e-6 } });
    assert.equal(getModelPrice("anthropic", "claude-haiku-4-5-20251001")?.inputTokenPrice, 1);
    assert.equal(getModelPrice("anthropic", "claude-haiku-4-5")?.inputTokenPrice, 9);
  });

  it("gemini/ and openrouter/ keys still resolve", () => {
    sheet({
      "gemini/gemini-3.8-flash": { input_cost_per_token: 1e-7, output_cost_per_token: 2e-7 },
      "openrouter/moonshotai/kimi-k3": { input_cost_per_token: 8e-6, output_cost_per_token: 2.5e-5 },
    });
    assert.equal(getModelPrice("google", "gemini-3.8-flash")?.inputTokenPrice, 0.1);
    assert.equal(getModelPrice("openrouter", "moonshotai/kimi-k3")?.inputTokenPrice, 8);
  });
});

describe("unpriced models", () => {
  it("0, flagged and warned once: with a catalog that lacks the model, and with none", () => {
    const warn = mock.method(console, "warn", () => {});
    const err = mock.method(console, "error", () => {});
    try {
      assert.equal(computeSessionCost("anthropic", usage, "claude-nope-9"), 0, "no catalog loaded");
      assert.equal(modelPriceSource("anthropic", "claude-nope-9"), "unpriced");
      assert.equal(computeSessionCost("anthropic", usage, "claude-nope-9"), 0);
      assert.equal(warn.mock.callCount(), 1);
      assert.match(String(warn.mock.calls[0]!.arguments[0]), /no price for anthropic\/claude-nope-9.*unpriced/);
      sheet(SHEET);
      assert.equal(computeSessionCost("anthropic", usage, "claude-nope-8"), 0, "catalog without the model");
      assert.equal(computeSessionCost("openai", usage, "gpt-nope-9"), 0);
      assert.equal(warn.mock.callCount(), 3);
      assert.ok(err.mock.callCount() <= 1, "the not-loaded error is said at most once");
    } finally {
      warn.mock.restore();
      err.mock.restore();
    }
  });

  it("no catalog loaded: a model costed says so on stderr, once per process", () => {
    // The flag is process-wide: an earlier case may have spent it, so only check it never repeats.
    const err = mock.method(console, "error", () => {});
    const warn = mock.method(console, "warn", () => {});
    try {
      computeSessionCost("anthropic", usage, "claude-nope-7");
      computeSessionCost("anthropic", usage, "claude-nope-6");
      assert.ok(err.mock.callCount() <= 1);
      for (const c of err.mock.calls) assert.match(String(c.arguments[0]), /catalog.*not loaded/);
    } finally {
      err.mock.restore();
      warn.mock.restore();
    }
  });

  it("no model named: the flat rate; gateways keep their ceiling and free models stay free", () => {
    near(computeSessionCost("anthropic", usage), 3 + 0.3 + 3.75 + 15);
    assert.equal(modelPriceSource("anthropic"), "provider-default");
    assert.equal(computeSessionCost("tokenfactory", usage, "glm-5.3"), 0);
    assert.equal(computeSessionCost("tokenfactory", usage, "kimi-k3.1-pro"), 0);
    assert.equal(modelPriceSource("tokenfactory", "glm-5.3"), "table");
    near(computeSessionCost("tokenfactory", usage, "not-listed-model"), 0.6 * 3 + 2.4);
    assert.equal(modelPriceSource("tokenfactory", "not-listed-model"), "provider-default");
  });
});

describe("1h cache writes", () => {
  const w = (cache_write_1h: number) => ({ input: 0, cache_read: 0, cache_write: M, cache_write_1h, output: 0 });
  it("priced at the sheet's 1h rate; absent: at the 5m rate", () => {
    sheet(SHEET);
    assert.equal(getModelPrice("anthropic", "claude-sonnet-5")?.cacheWrite1hPrice, 4);
    near(computeSessionCost("anthropic", w(M), "claude-sonnet-5"), 4);
    near(computeSessionCost("anthropic", w(0.4 * M), "claude-sonnet-5"), 0.6 * 2.5 + 0.4 * 4);
    near(computeSessionCost("anthropic", w(0), "claude-sonnet-5"), 2.5);
    near(computeSessionCost("anthropic", w(M), "claude-opus-5"), 6.25, "no 1h rate in the sheet: the 5m rate, no invented multiplier");
  });
});

describe("long-prompt tier", () => {
  it("parses only the base _above_Nk_tokens fields, lowest threshold", () => {
    sheet(SHEET);
    const p = getModelPrice("anthropic", "claude-haiku-5-5")!;
    assert.equal(p.longContext?.aboveTokens, 100_000);
    const t = p.longContext!.pricing;
    near(t.inputTokenPrice, 0.5);
    near(t.outputTokenPrice, 2.5);
    near(t.cacheReadPrice!, 0.05);
    near(t.cacheWritePrice!, 0.625);
    near(t.cacheWrite1hPrice!, 1);
    assert.equal(getModelPrice("anthropic", "claude-opus-5")?.longContext, undefined);
  });

  it("applies above the threshold to every token of the call, not at it", () => {
    sheet(SHEET);
    near(computeSessionCost("anthropic", { input: 50_000, cache_read: 0, cache_write: 0, output: 0 }, "claude-haiku-5-5"), (50_000 * 0.1) / M);
    near(computeSessionCost("anthropic", { input: 100_000, cache_read: 0, cache_write: 0, output: 0 }, "claude-haiku-5-5"), (100_000 * 0.1) / M);
    near(
      computeSessionCost("anthropic", { input: 50_000, cache_read: 50_000, cache_write: 50_000, output: 10_000 }, "claude-haiku-5-5"),
      (50_000 * 0.5 + 50_000 * 0.05 + 50_000 * 0.625 + 10_000 * 2.5) / M,
    );
    near(computeSessionCost("anthropic", { input: 0, cache_read: 0, cache_write: 150_000, cache_write_1h: 150_000, output: 0 }, "claude-haiku-5-5"), 0.15);
  });

  it("a tier field the sheet omits falls back to the base price", () => {
    sheet({ "m-1": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, input_cost_per_token_above_200k_tokens: 3e-6 } });
    const t = getModelPrice("anthropic", "m-1")!.longContext!;
    assert.equal(t.aboveTokens, 200_000);
    assert.equal(t.pricing.inputTokenPrice, 3);
    assert.equal(t.pricing.outputTokenPrice, 2);
  });
});

describe("modelCatalogStatus", () => {
  it("not loaded, then loaded", () => {
    assert.equal(modelCatalogStatus().loaded, false);
    assert.equal(modelCatalogStatus().source, "none");
    sheet(SHEET);
    const st = modelCatalogStatus();
    assert.equal(st.loaded, true);
    assert.equal(st.models, Object.keys(SHEET).length);
  });
});
