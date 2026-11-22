import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HttpCapability } from "../../../capabilities.js";
import { BTC_CURRENCIES, createBtcPrice } from "./price.js";
import step from "./price.js";

const MEMPOOL = { time: 1_760_000_000, USD: 100000, EUR: 90000, GBP: 80000, CAD: 140000, CHF: 85000, AUD: 150000, JPY: 15000000 };
const COINBASE = { data: { currency: "BTC", rates: { USD: "101000", EUR: "91000", SEK: "1000000" } } };

/** A stub http: `mempool` / `coinbase` give a response or throw. */
function stub(over: { mempool?: () => unknown; coinbase?: () => unknown } = {}) {
  const urls: string[] = [];
  const http = (async (url: string) => {
    urls.push(url);
    const r = (url.includes("mempool") ? over.mempool?.() ?? { status: 200, body: MEMPOOL } : over.coinbase?.() ?? { status: 200, body: COINBASE }) as { status: number; body: unknown };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, body: r.body, headers: {} };
  }) as unknown as HttpCapability;
  return { http, urls };
}

describe("btc/price", () => {
  it("parses each currency from mempool", async () => {
    const { http } = stub();
    const r = createBtcPrice(http);
    for (const c of BTC_CURRENCIES) {
      const p = await r.read(c.toLowerCase());
      assert.equal(p.currency, c);
      assert.equal(p.perBtc, (MEMPOOL as Record<string, number>)[c]);
      assert.equal(p.source, "mempool.space");
      assert.equal(p.at, new Date(MEMPOOL.time * 1000).toISOString());
      assert.equal(p.cached, false);
    }
  });

  it("caches 60 s per currency, refetching after", async () => {
    const { http, urls } = stub();
    let t = 1_000_000;
    const r = createBtcPrice(http, { now: () => t });
    assert.equal((await r.read("USD")).cached, false);
    t += 59_000;
    assert.equal((await r.read("USD")).cached, true);
    assert.equal(urls.length, 1);
    await r.read("EUR");
    assert.equal(urls.length, 2, "another currency is its own reading");
    t += 2_000;
    assert.equal((await r.read("USD")).cached, false);
    assert.equal(urls.length, 3);
  });

  it("concurrent reads share one request", async () => {
    const { http, urls } = stub();
    const r = createBtcPrice(http);
    await Promise.all([r.read("USD"), r.read("USD"), r.read("usd")]);
    assert.equal(urls.length, 1);
  });

  it("falls back to coinbase on a throw, a non-200 and garbage", async () => {
    for (const mempool of [() => { throw new Error("down"); }, () => ({ status: 503, body: "x" }), () => ({ status: 200, body: { time: 1, USD: "nope" } }), () => ({ status: 200, body: "<html>" })]) {
      const r = createBtcPrice(stub({ mempool }).http);
      const p = await r.read("USD");
      assert.equal(p.source, "api.coinbase.com");
      assert.equal(p.perBtc, 101000);
    }
  });

  it("a currency only the fallback quotes comes from it; both failing throws", async () => {
    const r = createBtcPrice(stub().http);
    assert.equal((await r.read("SEK")).perBtc, 1_000_000);
    const dead = createBtcPrice(stub({ mempool: () => ({ status: 500, body: "" }), coinbase: () => ({ status: 500, body: "" }) }).http);
    await assert.rejects(dead.read("USD"), /btc\/price: .*HTTP 500/);
  });

  it("an unknown currency names the supported list", async () => {
    const r = createBtcPrice(stub().http);
    await assert.rejects(r.read("ZZZ"), /no source quotes ZZZ; supported: USD, EUR, GBP, CAD, AUD, JPY, CHF/);
    await assert.rejects(r.read("dollars"), /not a currency code; supported: USD/);
  });

  it("the step values sats, default USD, over ctx.services.http", async () => {
    const { http } = stub();
    const ctx = { services: { http } } as never;
    const out = await step.run(step.input.parse({ sats: 50_000 }), ctx);
    assert.equal(out.currency, "USD");
    assert.equal(out.fiat, 50);
    await assert.rejects(step.run(step.input.parse({}), { services: {} } as never), /http capability/);
  });
});
