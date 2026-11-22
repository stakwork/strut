/**
 * `btc/price` against the REAL sources. Skipped unless STRUT_TEST_BTC_PRICE=1:
 *
 *   npm run test:btc-price
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBtcPrice, BTC_CURRENCIES } from "./price.js";

const skip = process.env["STRUT_TEST_BTC_PRICE"] !== "1" ? "STRUT_TEST_BTC_PRICE is not 1" : false;

const http = (async (url: string) => {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null), headers: {} };
}) as never;

test("the real sources price every currency", { skip }, async () => {
  const r = createBtcPrice(http);
  for (const c of BTC_CURRENCIES) {
    const p = await r.read(c);
    console.log(`${c}: ${p.perBtc} at ${p.at} from ${p.source}`);
    assert.ok(p.perBtc > 1000 && Number.isFinite(p.perBtc));
    assert.ok(Math.abs(Date.now() - Date.parse(p.at)) < 15 * 60_000);
  }
  assert.equal((await r.read("USD")).cached, true);
});
