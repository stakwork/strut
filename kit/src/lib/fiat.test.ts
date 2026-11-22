import { test } from "node:test";
import assert from "node:assert/strict";
import { FIAT_CURRENCIES, fiatToSats, formatFiat, satsToFiat } from "./fiat.js";

test("sats <-> fiat", () => {
  assert.equal(FIAT_CURRENCIES.length, 7);
  assert.equal(satsToFiat(100_000, 100_000), 100);
  assert.equal(satsToFiat(0, 5), 0);
  assert.equal(fiatToSats(100, 100_000), 100_000);
  assert.equal(fiatToSats(satsToFiat(12_345, 67_890), 67_890), 12_345);
});

test("formatFiat", () => {
  assert.equal(formatFiat(12.345, "USD", "en-US"), "$12.35");
  assert.equal(formatFiat(0.12, "EUR", "en-US"), "€0.12");
  assert.equal(formatFiat(1234.5, "JPY", "en-US"), "¥1,235");
  assert.equal(formatFiat(0.001, "USD", "en-US"), "<$0.01");
  assert.equal(formatFiat(0, "USD", "en-US"), "$0.00");
  assert.equal(formatFiat(0.2, "JPY", "en-US"), "<¥1");
});
