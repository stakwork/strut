// The model catalog: bifrost's datasheet as aieo's prices, windows and output
// caps (plans/aieo-in-strut.md §6). Offline: the sheet is a fixture and the
// fetch a stand-in. The catalog is process-wide, so every case resets it.
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeSessionCost,
  getCatalogEntry,
  getContextLimit,
  getModelPrice,
  loadModelCatalog,
  parseModelCatalog,
  setModelCatalog,
  MAPLE_MODELS,
  NUMES_MODELS,
} from "./provider.js";
import { maxOutputTokensFor } from "./resolve.js";

// Per-token prices, as the datasheet writes them.
const SHEET = {
  "claude-sonnet-5-5": {
    input_cost_per_token: 2e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 2.5e-6,
    max_input_tokens: 1_000_000,
    max_output_tokens: 128_000,
  },
  "claude-haiku-4-5": { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6, max_input_tokens: 200_000, max_output_tokens: 32_000 },
  "gemini/gemini-3.8-flash": { input_cost_per_token: 3e-7, output_cost_per_token: 2.5e-6, max_input_tokens: 777_777, max_output_tokens: 65_536 },
  "gpt-5.6-luna": { input_cost_per_token: 2e-7, output_cost_per_token: 1.2e-6, max_input_tokens: 1_050_000, max_output_tokens: 16_000 },
  "xai/grok-4.7": { input_cost_per_token: 2e-6, output_cost_per_token: 6e-6, max_input_tokens: 500_000, max_output_tokens: 500_000 },
  "openrouter/moonshotai/kimi-k3": { input_cost_per_token: 1.9e-7, output_cost_per_token: 1.6e-5 },
  // Numes' free model, priced by OpenRouter: Numes' own table (0) wins.
  "openrouter/z-ai/glm-5.3": { input_cost_per_token: 7e-8, output_cost_per_token: 1.4e-6 },
  // An unlisted Numes model is priced as the OpenRouter slug it is.
  "openrouter/acme/paid-1": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
  // A bare key a Maple model id would match: Maple never reads the sheet.
  "gemma4-31b": { input_cost_per_token: 9e-6, output_cost_per_token: 9e-6 },
  "limits-only": { max_input_tokens: 5 },
};
const RAW = JSON.stringify(SHEET);
const MILLION = { input: 1_000_000, cache_read: 0, cache_write: 0, output: 1_000_000 };

afterEach(() => setModelCatalog(undefined));

describe("parseModelCatalog", () => {
  it("turns per-token prices into per-million ones and keeps the limits", () => {
    const c = parseModelCatalog(RAW);
    assert.deepEqual(c.get("claude-sonnet-5-5"), {
      pricing: { inputTokenPrice: 2, outputTokenPrice: 10, cacheReadPrice: 0.1, cacheWritePrice: 2.5 },
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
    });
    assert.deepEqual(c.get("limits-only"), { maxInputTokens: 5 });
  });

  it("refuses a sheet that prices nothing", () => {
    assert.throws(() => parseModelCatalog(JSON.stringify({ a: { max_input_tokens: 1 } })), /prices no model/);
    assert.throws(() => parseModelCatalog("<html>"), SyntaxError);
  });
});

describe("the lookup: the gateway's key rule", () => {
  it("finds a model bare, under its provider's prefix, and Google's under gemini/", () => {
    setModelCatalog(parseModelCatalog(RAW));
    assert.equal(getCatalogEntry("anthropic", "claude-sonnet-5-5")?.pricing?.inputTokenPrice, 2);
    assert.equal(getCatalogEntry("xai", "grok-4.7")?.pricing?.outputTokenPrice, 6);
    assert.equal(getCatalogEntry("google", "gemini-3.8-flash")?.maxInputTokens, 777_777);
    assert.equal(getCatalogEntry("openrouter", "moonshotai/kimi-k3")?.pricing?.outputTokenPrice, 16);
    assert.equal(getCatalogEntry("anthropic", "claude-unknown-9"), undefined);
  });

  it("Maple never reads the sheet; Numes reads it as an OpenRouter slug, after its own table", () => {
    setModelCatalog(parseModelCatalog(RAW));
    assert.equal(getCatalogEntry("maple", "gemma4-31b"), undefined);
    assert.deepEqual(getModelPrice("maple", "gemma4-31b"), MAPLE_MODELS["gemma4-31b"]!.pricing);
    assert.deepEqual(getModelPrice("numes", "z-ai/glm-5.3"), NUMES_MODELS["z-ai/glm-5.3"]!.pricing);
    assert.equal(computeSessionCost("numes", MILLION, "z-ai/glm-5.3"), 0, "free stays free");
    assert.equal(computeSessionCost("numes", MILLION, "acme/paid-1"), 3, "1M in at $1, 1M out at $2");
  });

  it("answers nothing before a catalog is loaded", () => {
    assert.equal(getCatalogEntry("anthropic", "claude-sonnet-5-5"), undefined);
    assert.equal(getModelPrice("anthropic", "claude-sonnet-5-5")?.inputTokenPrice, 2, "the built-in table answers");
    assert.equal(getModelPrice("anthropic", "claude-unknown-9"), undefined);
  });
});

describe("where a cost comes from", () => {
  it("the provider's own figure, then the model's price, then the provider's flat rate", () => {
    const usage = { input: 1_000_000, cache_read: 1_000_000, cache_write: 1_000_000, output: 1_000_000 };
    setModelCatalog(parseModelCatalog(RAW));
    assert.equal(computeSessionCost("anthropic", usage, "claude-sonnet-5-5"), 2 + 0.1 + 2.5 + 10);
    assert.equal(computeSessionCost("anthropic", usage, "claude-sonnet-5-5", 0.25), 0.25, "reported wins");
    assert.equal(computeSessionCost("anthropic", usage, "claude-unknown-9"), 0, "a model nothing prices: unpriced, 0");
    assert.equal(computeSessionCost("anthropic", usage), 3 + 0.3 + 3.75 + 15, "no model named: the flat rate");
  });
});

describe("windows and output caps", () => {
  it("the sheet's window, else aieo's table", () => {
    const before = getContextLimit("gemini-3.8-flash", "google");
    setModelCatalog(parseModelCatalog(RAW));
    assert.equal(getContextLimit("gemini-3.8-flash", "google"), 777_777);
    assert.equal(getContextLimit("claude-unknown-9", "anthropic"), 1_000_000, "the provider's default");
    setModelCatalog(undefined);
    assert.equal(getContextLimit("gemini-3.8-flash", "google"), before);
  });

  it("the sheet's output limit lowers a cap, never raises it", () => {
    setModelCatalog(parseModelCatalog(RAW));
    assert.equal(maxOutputTokensFor("anthropic", "claude-haiku-4-5"), 32_000, "under aieo's 64k");
    assert.equal(maxOutputTokensFor("anthropic", "claude-sonnet-5-5"), 128_000);
    assert.equal(
      maxOutputTokensFor("anthropic", "claude-haiku-4-5", { anthropic: { thinking: { type: "enabled", budgetTokens: 2_000 } } }),
      30_000,
      "less the thinking budget",
    );
    assert.equal(maxOutputTokensFor("openai", "gpt-5.6-luna"), 16_000);
    assert.equal(maxOutputTokensFor("xai", "grok-4.7"), 64_000, "500k in the sheet; aieo's 64k stays");
  });
});

describe("loadModelCatalog", () => {
  const ok = (body: string, status = 200) => (async () => new Response(body, { status })) as typeof fetch;
  const down = (async () => {
    throw new Error("ENOTFOUND");
  }) as typeof fetch;

  it("fetches, uses and keeps the sheet; a later boot reads the kept copy when the fetch fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aieo-catalog-"));
    const cachePath = join(dir, "models", "datasheet.json");
    assert.deepEqual(await loadModelCatalog({ cachePath, fetch: ok(RAW), refreshMs: 0 }), { models: 10, source: "fetch" });
    assert.equal(readFileSync(cachePath, "utf8"), RAW);
    assert.equal(getModelPrice("anthropic", "claude-sonnet-5-5")?.outputTokenPrice, 10);

    setModelCatalog(undefined);
    assert.deepEqual(await loadModelCatalog({ cachePath, fetch: down, refreshMs: 0 }), { models: 10, source: "cache" });
    assert.equal(getModelPrice("anthropic", "claude-sonnet-5-5")?.outputTokenPrice, 10);
  });

  it("keeps the last good sheet over a failed or empty fetch, and never throws", async () => {
    setModelCatalog(parseModelCatalog(RAW));
    assert.equal((await loadModelCatalog({ fetch: ok("oops", 500), refreshMs: 0 })).models, 10);
    assert.equal((await loadModelCatalog({ fetch: ok("{}"), refreshMs: 0 })).models, 10);
    setModelCatalog(undefined);
    assert.deepEqual(await loadModelCatalog({ fetch: down, refreshMs: 0 }), { models: 0, source: "none" });
  });

  it("an unreadable kept copy waits for the fetch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aieo-catalog-"));
    const cachePath = join(dir, "datasheet.json");
    writeFileSync(cachePath, "not json");
    assert.deepEqual(await loadModelCatalog({ cachePath, fetch: ok(RAW), refreshMs: 0 }), { models: 10, source: "fetch" });
    assert.ok(existsSync(cachePath));
    assert.equal(readFileSync(cachePath, "utf8"), RAW);
  });
});
