// Prices come from the Mothership and nowhere else: the client, its cache, the id
// normaliser, and what computeSessionCost does with the answer. The Mothership is
// an injected fetch standing in for the Mothership.
import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  cachedGatewayPrice,
  computeSessionCost,
  gatewayModelPrice,
  getContextLimit,
  getProviderForModel,
  modelIdCandidates,
  modelPriceSource,
  normalizeModelId,
  resetGatewayPriceCache,
  warnNoGateway,
} from "./index.js";
import { maxOutputTokensFor } from "./resolve.js";

const M = 1_000_000;
const ROOT = "http://gw.test/root";
const usage = { input: M, cache_read: M, cache_write: M, output: M };
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

const row = (o: Record<string, unknown> = {}) => ({
  provider: "anthropic",
  model: "m",
  key: "m",
  source: "catalog",
  input_per_mtok: 2,
  output_per_mtok: 10,
  cache_read_per_mtok: 0.2,
  cache_write_per_mtok: 2.5,
  cache_write_1h_per_mtok: 4,
  ...o,
});
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** The Mothership: `rows` by model id; anything else is a 404 `unpriced`. */
function gateway(rows: Record<string, unknown>) {
  const asked: string[] = [];
  const f = (async (url: string) => {
    const u = new URL(url);
    assert.equal(u.pathname, "/root/_plugin/pricing/model");
    const model = u.searchParams.get("model")!;
    asked.push(model);
    return rows[model] ? json(200, row({ model, ...(rows[model] as object) })) : json(404, { error: "unpriced", model });
  }) as unknown as typeof fetch;
  return { f, asked };
}

beforeEach(() => resetGatewayPriceCache());

describe("id normalisation", () => {
  it("strips the provider prefix, dots between digits, @date; last try drops -YYYYMMDD", () => {
    assert.equal(normalizeModelId("anthropic", "anthropic/claude-opus-5.5"), "claude-opus-5-5");
    assert.equal(normalizeModelId("anthropic", "claude-opus-5.5"), "claude-opus-5-5");
    assert.equal(normalizeModelId("anthropic", "claude-sonnet-4-5@20250929"), "claude-sonnet-4-5-20250929");
    assert.equal(normalizeModelId("google", "gemini/gemini-3.1-pro"), "gemini-3-1-pro");
    assert.deepEqual(modelIdCandidates("anthropic", "claude-opus-5"), ["claude-opus-5"]);
    assert.deepEqual(modelIdCandidates("anthropic", "claude-haiku-4-5-20251001"), ["claude-haiku-4-5-20251001", "claude-haiku-4-5"]);
    assert.deepEqual(modelIdCandidates("anthropic", "anthropic/claude-opus-5.5"), ["anthropic/claude-opus-5.5", "claude-opus-5-5"]);
    assert.equal(getProviderForModel("claude-opus-4-8"), "anthropic");
  });
});

describe("the Mothership's price", () => {
  it("is the effective rates: tokens × rates, with cache read, 5m and 1h writes", async () => {
    const g = gateway({ "claude-sonnet-5": {} });
    const price = await gatewayModelPrice("anthropic", "claude-sonnet-5", ROOT, { fetch: g.f });
    assert.ok(price);
    assert.equal(modelPriceSource("anthropic", "claude-sonnet-5", price), "mothership");
    near(computeSessionCost("anthropic", usage, "claude-sonnet-5", undefined, price), 2 + 0.2 + 2.5 + 10);
    near(computeSessionCost("anthropic", { ...usage, cache_write_1h: M }, "claude-sonnet-5", undefined, price), 2 + 0.2 + 4 + 10);
    near(computeSessionCost("anthropic", { input: 0, cache_read: 0, cache_write: M, cache_write_1h: 0.4 * M, output: 0 }, "claude-sonnet-5", undefined, price), 0.6 * 2.5 + 0.4 * 4);
  });

  it("no 1h rate in the answer: 1h writes at the 5m rate (no multiplier invented)", async () => {
    const g = gateway({ m: { cache_write_1h_per_mtok: undefined } });
    const price = await gatewayModelPrice("anthropic", "m", ROOT, { fetch: g.f });
    near(computeSessionCost("anthropic", { input: 0, cache_read: 0, cache_write: M, cache_write_1h: M, output: 0 }, "m", undefined, price), 2.5);
  });

  it("is cached per (root, provider, model) for the max-age; one request", async () => {
    let t = 0;
    const g = gateway({ m: {} });
    const opts = { fetch: g.f, now: () => t };
    await gatewayModelPrice("anthropic", "m", ROOT, opts);
    await gatewayModelPrice("anthropic", "m", ROOT + "/", opts);
    assert.equal(g.asked.length, 1);
    t = 299_000;
    await gatewayModelPrice("anthropic", "m", ROOT, opts);
    assert.equal(g.asked.length, 1);
    t = 301_000;
    await gatewayModelPrice("anthropic", "m", ROOT, opts);
    assert.equal(g.asked.length, 2);
    await gatewayModelPrice("anthropic", "m", "http://other.test/root", { fetch: g.f, now: () => t }).catch(() => {});
  });

  it("honours Cache-Control max-age", async () => {
    let t = 0;
    let n = 0;
    const f = (async () => (n++, json(200, row(), { "cache-control": "max-age=10" }))) as unknown as typeof fetch;
    const opts = { fetch: f, now: () => t };
    await gatewayModelPrice("anthropic", "m", ROOT, opts);
    t = 11_000;
    await gatewayModelPrice("anthropic", "m", ROOT, opts);
    assert.equal(n, 2);
  });

  it("a network error after a good fetch keeps the stale entry", async () => {
    let t = 0;
    let up = true;
    const g = gateway({ m: {} });
    const f = (async (...a: Parameters<typeof fetch>) => {
      if (!up) throw new Error("ECONNREFUSED");
      return g.f(...a);
    }) as typeof fetch;
    const warn = mock.method(console, "warn", () => {});
    try {
      const opts = { fetch: f, now: () => t };
      const first = await gatewayModelPrice("anthropic", "m", ROOT, opts);
      up = false;
      t = 400_000;
      const stale = await gatewayModelPrice("anthropic", "m", ROOT, opts);
      assert.deepEqual(stale, first);
      assert.match(String(warn.mock.calls[0]!.arguments[0]), /keeping the last good one/);
    } finally {
      warn.mock.restore();
    }
  });

  it("a 404 is unpriced, and cached as such", async () => {
    const g = gateway({});
    assert.equal(await gatewayModelPrice("anthropic", "claude-foo-9", ROOT, { fetch: g.f }), undefined);
    assert.equal(await gatewayModelPrice("anthropic", "claude-foo-9", ROOT, { fetch: g.f }), undefined);
    assert.deepEqual(g.asked, ["claude-foo-9"]);
  });

  it("an unreachable gateway with nothing cached: unpriced, never throws", async () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      const f = (async () => {
        throw new Error("ENOTFOUND");
      }) as unknown as typeof fetch;
      assert.equal(await gatewayModelPrice("anthropic", "m", ROOT, { fetch: f }), undefined);
    } finally {
      warn.mock.restore();
    }
  });

  it("retries once with the normalised id after a 404", async () => {
    const g = gateway({ "claude-opus-5-5": {} });
    const price = await gatewayModelPrice("anthropic", "anthropic/claude-opus-5.5", ROOT, { fetch: g.f });
    assert.ok(price);
    assert.deepEqual(g.asked, ["anthropic/claude-opus-5.5", "claude-opus-5-5"]);
    const g2 = gateway({ "claude-haiku-4-5": {} });
    assert.ok(await gatewayModelPrice("anthropic", "claude-haiku-4-5-20251001", ROOT, { fetch: g2.f }));
    assert.deepEqual(g2.asked, ["claude-haiku-4-5-20251001", "claude-haiku-4-5"]);
  });

  it("sends Google as gemini and maple / numes / tokenfactory / the rest as they are", async () => {
    const seen: string[] = [];
    const f = (async (url: string) => (seen.push(new URL(url).searchParams.get("provider")!), json(200, row()))) as unknown as typeof fetch;
    for (const p of ["google", "numes", "tokenfactory", "maple", "anthropic"]) await gatewayModelPrice(p, "m", ROOT, { fetch: f });
    assert.deepEqual(seen, ["gemini", "numes", "tokenfactory", "maple", "anthropic"]);
  });
});

describe("what a cost is", () => {
  it("an unpriced model is 0, warned once, for every provider", () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      assert.equal(modelPriceSource("anthropic", "claude-nope-1", undefined), "unpriced");
      assert.equal(computeSessionCost("anthropic", usage, "claude-nope-1"), 0);
      assert.equal(computeSessionCost("anthropic", usage, "claude-nope-1"), 0);
      assert.equal(computeSessionCost("openai", usage, "gpt-nope-1"), 0);
      for (const p of ["maple", "numes", "tokenfactory"]) assert.equal(computeSessionCost(p, usage, "unlisted-1"), 0, `${p}: no ceiling`);
      assert.equal(warn.mock.callCount(), 5);
      assert.match(String(warn.mock.calls[0]!.arguments[0]), /no Mothership price for anthropic\/claude-nope-1.*unpriced/);
    } finally {
      warn.mock.restore();
    }
  });

  it("no model named: unpriced with a warning, no flat rate", () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      assert.equal(computeSessionCost("anthropic", usage), 0);
      assert.equal(modelPriceSource("anthropic"), "unpriced");
      assert.match(String(warn.mock.calls[0]!.arguments[0]), /no model named/);
    } finally {
      warn.mock.restore();
    }
  });

  it("no Mothership at all: one console.error per process", () => {
    const err = mock.method(console, "error", () => {});
    try {
      warnNoGateway();
      warnNoGateway();
      assert.equal(err.mock.callCount(), 1);
      assert.match(String(err.mock.calls[0]!.arguments[0]), /no Mothership is configured.*unpriced/);
    } finally {
      err.mock.restore();
    }
  });

  it("the provider's reported cost wins over the Mothership's price", async () => {
    const price = await gatewayModelPrice("anthropic", "m", ROOT, { fetch: gateway({ m: {} }).f });
    assert.equal(computeSessionCost("anthropic", usage, "m", 0.25, price), 0.25);
    assert.equal(computeSessionCost("numes", usage, "z-ai/glm-5.3", 0), 0, "a reported 0 is a cost, not unpriced");
  });

  it("Token Factory / Numes / Maple models are priced from the Mothership's answer, free ones from a $0 row", async () => {
    const g = gateway({
      "glm-5.3": { input_per_mtok: 0, output_per_mtok: 0, cache_read_per_mtok: 0, cache_write_per_mtok: 0, cache_write_1h_per_mtok: 0 },
      "kimi-k3.1-pro": { input_per_mtok: 0, output_per_mtok: 0 },
      "glm-5.3-flash": { input_per_mtok: 0.15, output_per_mtok: 0.5 },
    });
    for (const [id, want] of [["glm-5.3", 0], ["kimi-k3.1-pro", 0], ["glm-5.3-flash", 0.15 + 0.5]] as const) {
      const price = await gatewayModelPrice("tokenfactory", id, ROOT, { fetch: g.f });
      assert.ok(price, id);
      assert.equal(modelPriceSource("tokenfactory", id, price), "mothership", `${id}: a $0 row is priced, not unpriced`);
      near(computeSessionCost("tokenfactory", { input: M, cache_read: 0, cache_write: 0, output: M }, id, undefined, price), want);
    }
    assert.equal(await gatewayModelPrice("tokenfactory", "not-listed", ROOT, { fetch: g.f }), undefined);
  });
});

describe("limits from the Mothership's answer", () => {
  it("the window and the output cap read the cached entry; else as before", async () => {
    const before = getContextLimit("claude-limits-1", "anthropic");
    const capBefore = maxOutputTokensFor("anthropic", "claude-limits-1");
    const g = gateway({ "claude-limits-1": { max_input_tokens: 777_000, max_output_tokens: 8_000 } });
    await gatewayModelPrice("anthropic", "claude-limits-1", ROOT, { fetch: g.f });
    assert.equal(cachedGatewayPrice("anthropic", "claude-limits-1")?.maxInputTokens, 777_000);
    assert.equal(getContextLimit("claude-limits-1", "anthropic"), 777_000);
    assert.equal(maxOutputTokensFor("anthropic", "claude-limits-1"), 8_000);
    assert.ok(capBefore > 8_000 && before !== 777_000);
  });
});
