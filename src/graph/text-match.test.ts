import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { corrections, cuedPredicates, distance, fold, predicateWords, textQuery, typo, words } from "./text-match.js";

describe("text matching, the parts that hold for any language", () => {
  it("words fold case and accents, in any script", () => {
    assert.equal(fold("  Zoë   Ñandú "), "zoe nandu");
    assert.deepEqual(words("Paweł's café, Москва!"), ["paweł", "s", "cafe", "москва"]);
    assert.deepEqual(words("李明 北京"), ["李明", "北京"]);
  });

  it("typo: one edit from five letters, two from nine, swaps count as one", () => {
    assert.equal(distance("lisbon", "lisbn"), 1);
    assert.equal(distance("abcd", "abdc"), 1);
    assert.ok(typo("lisbn", "lisbon"));
    assert.ok(typo("bouldring", "bouldering"));
    assert.ok(!typo("john", "joan"), "four letters must match exactly");
  });

  it("a query is its words, each once, none dropped: the index knows its own stop words", () => {
    assert.deepEqual(textQuery("where does Kate live, Kate?").terms, ["where", "does", "kate", "live"]);
  });

  it("corrections: a longer word the term starts, or a typo of a vocabulary word", () => {
    const vocab = ["renovation", "lisbon", "kate"];
    assert.deepEqual(corrections("renovat", vocab), [{ word: "renovation", weight: 0.8 }]);
    assert.deepEqual(corrections("lisbn", vocab), [{ word: "lisbon", weight: 0.6 }]);
    assert.deepEqual(corrections("kat", vocab), [], "too short to guess");
  });

  it("an edge type is named by its own words and its aliases, a word meeting a longer or shorter form of one", () => {
    const p = predicateWords(["WORKS_AT", "LIVES_IN"], new Map([["WORKS_AT", ["job_at"]]]));
    assert.equal(p.get("at"), undefined, "two letters name nothing");
    assert.deepEqual([...cuedPredicates(textQuery("where does Kate work"), p)], ["WORKS_AT"]);
    assert.deepEqual([...cuedPredicates(textQuery("Kate's jobs"), p)], ["WORKS_AT"]);
    assert.deepEqual([...cuedPredicates(textQuery("Kate's birthday"), p)], []);
  });
});
