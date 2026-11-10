/** The exchange rate. No test reaches mempool.space: the http capability is
 *  a stand-in that answers its shape. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HttpCapability, HttpResponse } from "../capabilities.js";
import {
  DEFAULT_RATE_URL,
  RateUnavailableError,
  createRate,
  rateSourceFor,
  satsForUsd,
  urlRateSource,
  usdForMsat,
  type ExchangeRate,
} from "./rate.js";

/** An http capability answering mempool's shape, counting its calls. */
function mempool(answer: () => HttpResponse | Error) {
  const calls: string[] = [];
  const http: HttpCapability = async (url) => {
    calls.push(url);
    const a = answer();
    if (a instanceof Error) throw a;
    return a;
  };
  return { http, calls };
}
const ok = (body: unknown): HttpResponse => ({ status: 200, ok: true, headers: {}, body });

describe("the exchange rate", () => {
  it("reads mempool's { time, USD } as dollars per bitcoin, named by its host", async () => {
    const m = mempool(() => ok({ time: 1_793_000_000, USD: 73_176, EUR: 63_000 }));
    const source = rateSourceFor({ http: m.http });
    assert.deepEqual(await source(), { usdPerBtc: 73_176, at: new Date(1_793_000_000_000).toISOString(), source: "mempool.space" });
    assert.deepEqual(m.calls, [DEFAULT_RATE_URL]);

    const own = mempool(() => ok({ time: 1_793_000_000, USD: 70_000 }));
    assert.equal((await rateSourceFor({ url: "https://mempool.acme.internal/api/v1/prices", http: own.http })()).source, "mempool.acme.internal");
    // A host's function wins over the URL.
    const hostRate: ExchangeRate = { usdPerBtc: 1, at: new Date(0).toISOString(), source: "host" };
    assert.equal(await rateSourceFor({ source: async () => hostRate, url: "https://x.example", http: own.http })(), hostRate);
    assert.throws(() => urlRateSource("ftp://x", own.http), /http/);
    assert.throws(() => urlRateSource("not a url", own.http), /not a URL/);
  });

  it("refuses an answer that cannot price anything", async () => {
    for (const body of [{ time: 1, USD: 0 }, { time: 1, USD: "73176" }, { USD: 73_176 }, "<html>", null]) {
      await assert.rejects(urlRateSource(DEFAULT_RATE_URL, mempool(() => ok(body)).http)(), JSON.stringify(body));
    }
    await assert.rejects(urlRateSource(DEFAULT_RATE_URL, mempool(() => ({ status: 503, ok: false, headers: {}, body: "" })).http)(), /503/);
  });

  it("keeps a reading for a minute, and a burst of reads is one request", async () => {
    let now = 0;
    let usd = 73_000;
    const m = mempool(() => ok({ time: 1_793_000_000, USD: usd }));
    const rate = createRate(rateSourceFor({ http: m.http }), { now: () => now });
    const burst = await Promise.all(Array.from({ length: 20 }, () => rate.read()));
    assert.equal(m.calls.length, 1);
    assert.ok(burst.every((r) => r.usdPerBtc === 73_000));
    now = 59_999;
    usd = 74_000;
    assert.equal((await rate.read()).usdPerBtc, 73_000);
    now = 60_000;
    assert.equal((await rate.read()).usdPerBtc, 74_000, "a minute on, it asks again");
    assert.equal(m.calls.length, 2);
    assert.equal(rate.last()!.readAt, 60_000);
  });

  it("with the source down, the last reading serves for ten minutes and then nothing does", async () => {
    let now = 0;
    let up = true;
    const m = mempool(() => (up ? ok({ time: 1_793_000_000, USD: 73_000 }) : new Error("ECONNREFUSED")));
    const rate = createRate(rateSourceFor({ http: m.http }), { now: () => now });
    await rate.read();
    up = false;
    now = 9 * 60_000 + 59_999;
    assert.equal((await rate.read()).usdPerBtc, 73_000);
    now = 10 * 60_000;
    await assert.rejects(rate.read(), (e: unknown) => e instanceof RateUnavailableError && e.code === "rate_unavailable" && /^rate_unavailable: .*ECONNREFUSED.*over 10 minutes/.test(e.message));
    // Back up: a fresh reading, no fixed fallback ever.
    up = true;
    assert.equal((await rate.read()).usdPerBtc, 73_000);
  });

  it("with no reading yet and the source down, the read fails at once", async () => {
    const rate = createRate(async () => {
      throw new Error("down");
    });
    await assert.rejects(rate.read(), (e: unknown) => e instanceof RateUnavailableError && /no reading yet/.test(e.message));
    assert.equal(rate.last(), null);
  });

  it("turns dollars into whole sats rounded up, and msat back into dollars", () => {
    assert.equal(satsForUsd(1, { usdPerBtc: 100_000 }), 1000);
    assert.equal(satsForUsd(7.5, { usdPerBtc: 73_176 }), 10_250);
    assert.equal(satsForUsd(0.01, { usdPerBtc: 73_176 }), 14, "13.67 sats is 14: never a dollar for less");
    assert.equal(satsForUsd(0, { usdPerBtc: 73_176 }), 0);
    assert.throws(() => satsForUsd(-1, { usdPerBtc: 1 }));
    assert.equal(usdForMsat(1_000_000, { usdPerBtc: 100_000 }), 1);
  });
});
