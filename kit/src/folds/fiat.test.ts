import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fiatOfMsat, fiatText, satsWithFiat } from "./fiat.js";
import { formats } from "./words.js";

const rate = { perBtc: { USD: 60_000, EUR: 55_000 } };

describe("fiat", () => {
  it("fiatOfMsat converts at the rate, USD by default, undefined without a figure", () => {
    assert.equal(fiatOfMsat(50_000_000, rate), 30);
    assert.equal(fiatOfMsat(50_000_000, rate, "eur"), 27.5);
    assert.equal(fiatOfMsat(1000, rate, "JPY"), undefined);
    assert.equal(fiatOfMsat(1000, undefined), undefined);
  });

  it("fiatText is currency, USD unless another code Intl knows", () => {
    assert.equal(fiatText(12.5), "$12.50");
    assert.equal(fiatText(12.5, "usd", "en-US"), "$12.50");
    assert.equal(fiatText(12.5, "EUR", "en-US"), "€12.50");
    assert.equal(fiatText(12.5, "nope", "en-US"), "$12.50");
  });

  it("satsWithFiat puts the fiat beside the sats, or leaves it off", () => {
    const en = formats("en-US");
    assert.equal(satsWithFiat(50_000, rate, en), "50 sats (≈ $0.03)");
    assert.equal(satsWithFiat(50_000, undefined, en), "50 sats");
    assert.equal(satsWithFiat(50_000, rate, en, "JPY"), "50 sats");
  });
});
