// strut's side of Mothership pricing (src/llm.ts): where the root comes from, the
// price resolved once per model, and what /llm/models says about it. The
// Mothership is a local HTTP server speaking /_plugin/pricing/*.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { gatewayRootFor, listModelOptions, resolveModelPrice, startModelCatalog } from "./llm.js";
import { resetGatewayPriceCache } from "./aieo/index.js";

describe("gateway pricing in strut", () => {
  let server: Server;
  let root: string;
  const hits: string[] = [];
  const saved = process.env["STRUT_GATEWAY_URL"];
  before(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? "");
      const u = new URL(req.url ?? "/", "http://x");
      res.setHeader("content-type", "application/json");
      if (u.pathname === "/_plugin/pricing/status") {
        res.end(JSON.stringify({ catalog: { loaded: true, models: 3, url: "u" }, runtime_rows: 0, config_rows: 0 }));
      } else if (u.pathname === "/_plugin/pricing/model" && u.searchParams.get("model") === "claude-sonnet-5-5") {
        res.end(JSON.stringify({ provider: "anthropic", model: "claude-sonnet-5-5", key: "claude-sonnet-5-5", source: "catalog", input_per_mtok: 2, output_per_mtok: 10, cache_read_per_mtok: 0.1, cache_write_per_mtok: 2.5, cache_write_1h_per_mtok: 4, max_input_tokens: 1_000_000 }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "unpriced" }));
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => {
    delete process.env["STRUT_MOTHERSHIP_URL"];
    if (saved === undefined) delete process.env["STRUT_GATEWAY_URL"];
    else process.env["STRUT_GATEWAY_URL"] = saved;
    resetGatewayPriceCache();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("the root: the grant's baseUrl, else STRUT_MOTHERSHIP_URL, else STRUT_GATEWAY_URL, else none", () => {
    delete process.env["STRUT_GATEWAY_URL"];
    delete process.env["STRUT_MOTHERSHIP_URL"];
    assert.equal(gatewayRootFor(), undefined);
    assert.equal(gatewayRootFor("https://gw.example/v1/"), "https://gw.example/v1");
    process.env["STRUT_GATEWAY_URL"] = "https://env.example/";
    assert.equal(gatewayRootFor(), "https://env.example");
    assert.equal(gatewayRootFor("https://grant.example"), "https://grant.example");
    process.env["STRUT_MOTHERSHIP_URL"] = "https://ms.example/";
    assert.equal(gatewayRootFor(), "https://ms.example", "the newer name wins");
    delete process.env["STRUT_MOTHERSHIP_URL"];
  });

  it("resolveModelPrice: the Mothership's price for every provider; unpriced; none configured", async () => {
    resetGatewayPriceCache();
    hits.length = 0;
    const price = await resolveModelPrice("anthropic", "claude-sonnet-5-5", root);
    assert.equal(price?.pricing.inputTokenPrice, 2);
    assert.equal(price?.pricing.cacheWrite1hPrice, 4);
    assert.equal(await resolveModelPrice("tokenfactory", "glm-5.3", root), undefined, "404: unpriced, even a model aieo lists");
    assert.ok(hits.some((h) => h.includes("provider=tokenfactory&model=glm-5.3")), "asked with the provider as it is");
    assert.equal(await resolveModelPrice("anthropic", "claude-nope-1", root), undefined);
  });

  it("/llm/models says where prices come from and shows the cached ones", async () => {
    resetGatewayPriceCache();
    delete process.env["STRUT_GATEWAY_URL"];
    delete process.env["STRUT_MOTHERSHIP_URL"];
    const none = await listModelOptions();
    assert.deepEqual(none.pricing, { source: "mothership", gateway: null });
    assert.equal(none.models.find((m) => m.name === "anthropic/claude-sonnet-5-5")?.pricing, undefined);
    await resolveModelPrice("anthropic", "claude-sonnet-5-5", root);
    process.env["STRUT_MOTHERSHIP_URL"] = root;
    hits.length = 0;
    const cat = await listModelOptions();
    assert.equal(cat.pricing.gateway, root);
    assert.deepEqual((cat.pricing.status as any).catalog.models, 3);
    assert.equal(cat.models.find((m) => m.name === "anthropic/claude-sonnet-5-5")?.pricing?.inputTokenPrice, 2);
    assert.deepEqual(hits, ["/_plugin/pricing/status"], "the status call only, no request per model");
  });

  it("an unreachable gateway: the list still comes, with the error", async () => {
    process.env["STRUT_MOTHERSHIP_URL"] = "http://127.0.0.1:9";
    const cat = await listModelOptions();
    assert.ok(cat.models.length > 0);
    assert.ok(cat.pricing.error);
  });

  it("startModelCatalog is a deprecated no-op", async () => {
    await startModelCatalog("/nonexistent");
  });
});
