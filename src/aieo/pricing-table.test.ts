// Anthropic's built-in price table, id normalisation, the unpriced rule and the 1h / long-context tiers.
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { computeSessionCost, getProviderForModel, modelPriceSource, parseModelCatalog, setModelCatalog } from "./provider.js";

const M = 1_000_000;
const usage = { input: M, cache_read: M, cache_write: M, output: M };
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

beforeEach(() => setModelCatalog(undefined));
afterEach(() => setModelCatalog(undefined));

describe("anthropic table, no catalog", () => {
  const cases: [string, number][] = [
    ["claude-opus-5", 5 + 0.5 + 6.25 + 25],
    ["claude-sonnet-5", 2 + 0.2 + 2.5 + 10],
    ["claude-opus-5-5", 4 + 0.2 + 5 + 20],
    ["claude-sonnet-5-5", 2 + 0.1 + 2.5 + 10],
    ["claude-sonnet-4-6", 3 + 0.3 + 3.75 + 15],
    ["claude-opus-4-1", 15 + 1.5 + 18.75 + 75],
  ];
  for (const [id, want] of cases) it(id, () => near(computeSessionCost("anthropic", usage, id), want));

  it("prefix, dotted and dated ids resolve to the bare entry", () => {
    const opus = computeSessionCost("anthropic", usage, "claude-opus-5");
    near(computeSessionCost("anthropic", usage, "anthropic/claude-opus-5"), opus);
    const o55 = computeSessionCost("anthropic", usage, "claude-opus-5-5");
    near(computeSessionCost("anthropic", usage, "anthropic/claude-opus-5.5"), o55);
    near(computeSessionCost("anthropic", usage, "claude-opus-5.5"), o55);
    const haiku = computeSessionCost("anthropic", usage, "claude-haiku-4-5");
    near(haiku, 1 + 0.1 + 1.25 + 5);
    near(computeSessionCost("anthropic", usage, "claude-haiku-4-5-20251001"), haiku);
    near(computeSessionCost("anthropic", usage, "claude-sonnet-4-5@20250929"), 3 + 0.3 + 3.75 + 15);
    assert.equal(modelPriceSource("anthropic", "anthropic/claude-opus-5.5"), "table");
  });

  it("claude- ids go to anthropic", () => {
    assert.equal(getProviderForModel("claude-opus-4-8"), "anthropic");
    assert.equal(getProviderForModel("claude-foo-1"), "anthropic");
  });
});

describe("unpriced models", () => {
  it("a direct provider's unknown model is 0, flagged, warned once", () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      assert.equal(modelPriceSource("anthropic", "claude-unknown-9"), "unpriced");
      assert.equal(computeSessionCost("anthropic", usage, "claude-unknown-9"), 0);
      assert.equal(computeSessionCost("anthropic", usage, "claude-unknown-9"), 0);
      assert.equal(warn.mock.callCount(), 1);
      assert.match(String(warn.mock.calls[0]!.arguments[0]), /no price for anthropic\/claude-unknown-9.*unpriced/);
      assert.equal(computeSessionCost("openai", usage, "gpt-unknown-9"), 0);
      assert.equal(modelPriceSource("openai", "gpt-unknown-9"), "unpriced");
      assert.equal(warn.mock.callCount(), 2);
    } finally {
      warn.mock.restore();
    }
  });

  it("no model named: the flat rate; gateways keep their ceiling", () => {
    near(computeSessionCost("anthropic", usage), 3 + 0.3 + 3.75 + 15);
    assert.equal(modelPriceSource("anthropic"), "provider-default");
    assert.equal(computeSessionCost("tokenfactory", usage, "glm-5.3"), 0);
    assert.equal(computeSessionCost("tokenfactory", usage, "kimi-k3.1-pro"), 0);
    assert.equal(modelPriceSource("tokenfactory", "glm-5.3"), "table");
    near(computeSessionCost("tokenfactory", usage, "not-listed-model"), 0.6 + 0.6 + 0.6 + 2.4);
    assert.equal(modelPriceSource("tokenfactory", "not-listed-model"), "provider-default");
  });
});

describe("catalog precedence", () => {
  it("the datasheet wins over the built-in table", () => {
    setModelCatalog(parseModelCatalog(JSON.stringify({ "claude-opus-5": { input_cost_per_token: 9e-6, output_cost_per_token: 9e-5 } })));
    assert.equal(modelPriceSource("anthropic", "claude-opus-5"), "catalog");
    near(computeSessionCost("anthropic", { input: M, cache_read: 0, cache_write: 0, output: M }, "anthropic/claude-opus-5"), 99);
    near(computeSessionCost("anthropic", { input: M, cache_read: 0, cache_write: 0, output: 0 }, "claude-opus-5-5"), 4, "not in the sheet: the table");
  });

  it("parses the 1h cache-write price", () => {
    const c = parseModelCatalog(JSON.stringify({ "claude-x-1": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, cache_creation_input_token_cost: 1.25e-6, cache_creation_input_token_cost_above_1hr: 2e-6 } }));
    assert.equal(c.get("claude-x-1")!.pricing!.cacheWrite1hPrice, 2);
    setModelCatalog(c);
    near(computeSessionCost("anthropic", { input: 0, cache_read: 0, cache_write: M, cache_write_1h: M, output: 0 }, "claude-x-1"), 2);
  });
});

describe("1h cache writes", () => {
  const w = (cache_write_1h: number, cache_write = M) => ({ input: 0, cache_read: 0, cache_write, cache_write_1h, output: 0 });
  it("priced at the 1h rate", () => {
    near(computeSessionCost("anthropic", w(M), "claude-sonnet-5"), 4);
    near(computeSessionCost("anthropic", w(0.4 * M), "claude-sonnet-5"), 0.6 * 2.5 + 0.4 * 4);
    near(computeSessionCost("anthropic", w(0), "claude-sonnet-5"), 2.5);
  });
});

describe("haiku 5.5 long-context tier", () => {
  it("under 100k prompt: base rates; over: every token at the higher tier", () => {
    near(computeSessionCost("anthropic", { input: 50_000, cache_read: 0, cache_write: 0, output: 0 }, "claude-haiku-5-5"), (50_000 * 0.1) / M);
    near(computeSessionCost("anthropic", { input: 50_000, cache_read: 50_000, cache_write: 50_000, output: 10_000 }, "claude-haiku-5-5"), (50_000 * 0.5 + 50_000 * 0.05 + 50_000 * 0.625 + 10_000 * 2.5) / M);
    near(computeSessionCost("anthropic", { input: 100_000, cache_read: 0, cache_write: 0, output: 0 }, "claude-haiku-5-5"), (100_000 * 0.1) / M, "exactly 100k is not over");
  });
});
