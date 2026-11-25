import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formats, langOf, wordsFor, LANGS } from "./words.js";

// The languages strut's worker-facing screens speak (plans/i18n.md), and
// numbers, sats and times as a locale writes them.

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-11-18T12:00:00Z");

describe("words: the page's language", () => {
  it("a locale's language when strut speaks it, else English", () => {
    assert.deepEqual(LANGS, ["en", "es"]);
    for (const [tag, lang] of [["es", "es"], ["es-MX", "es"], ["ES_es", "es"], ["en-GB", "en"], ["pt-BR", "en"], ["", "en"], [undefined, "en"], [null, "en"]] as const) {
      assert.equal(langOf(tag), lang, String(tag));
    }
  });

  it("a screen's words in that language, English when it has none there", () => {
    const words = { en: { hi: "Hi" }, es: { hi: "Hola" } };
    assert.equal(wordsFor(words, "es-419").hi, "Hola");
    assert.equal(wordsFor(words, "fr").hi, "Hi");
    assert.equal(wordsFor({ en: { hi: "Hi" } }, "es").hi, "Hi", "a screen with English alone");
  });
});

describe("words: formats", () => {
  it("sats grouped as the locale groups them, the rest of a sat dropped", () => {
    assert.equal(formats("en-US").sats(1_234_999), "1,234 sats");
    assert.equal(formats("es-MX").sats(1_234_000), "1,234 sats");
    assert.equal(formats("es").sats(12_345_000), "12.345 sats");
    assert.equal(formats("es").sats(1_000), "1 sat");
    assert.equal(formats().sats(0), "0 sats", "no locale: English");
  });

  it("how long ago and until, by the minute, the hour, then the day", () => {
    const en = formats("en-US");
    const es = formats("es");
    assert.equal(en.ago(NOW - 10_000, NOW), "now");
    assert.equal(es.ago(NOW - 10_000, NOW), "ahora");
    assert.equal(es.ago(NOW - 5 * MIN, NOW), "hace 5 min");
    assert.equal(es.ago(NOW - 3 * HOUR - MIN, NOW), "hace 3 h");
    assert.equal(es.until(NOW + 3 * HOUR - MIN, NOW), "dentro de 3 h");
    assert.equal(es.until(NOW + 10_000, NOW), "dentro de 1 min", "never in 0 minutes");
    assert.match(en.until(NOW + 3 * HOUR, NOW), /^in 3 hr/);
    assert.equal(es.ago(NOW - 3 * 24 * HOUR, NOW), es.day(NOW - 3 * 24 * HOUR), "past a day: the day");
  });

  it("a tag Intl refuses writes as English", () => {
    assert.equal(formats("not a tag!").locale, "en-US");
    assert.equal(formats("es_MX").locale, "es-MX");
  });

  it("fiat is currency, USD unless another code Intl knows", () => {
    const en = formats("en");
    assert.equal(en.fiat(12.5), "$12.50");
    assert.equal(en.fiat(12.5, "usd"), "$12.50");
    assert.equal(en.fiat(12.5, "EUR"), "€12.50");
    assert.equal(en.fiat(12.5, "nope"), "$12.50");
  });
});
