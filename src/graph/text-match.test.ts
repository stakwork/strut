import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  capitalised,
  corrections,
  distance,
  fold,
  namedInText,
  predicateWords,
  rankScores,
  stem,
  textQuery,
  typo,
  unmatched,
  words,
  type MatchDoc,
} from "./text-match.js";

describe("text matching", () => {
  it("words fold case, accents and apostrophes, in any script", () => {
    assert.deepEqual(words("Kate's Café, São Paulo!"), ["kate", "cafe", "sao", "paulo"]);
    assert.deepEqual(words("Katherine’s"), ["katherine"], "a possessive is dropped before the apostrophe");
    assert.deepEqual(words("李明 in 北京, Олег"), ["李明", "in", "北京", "олег"]);
    assert.equal(fold("مُحَمَّد علي"), fold("محمد علي"), "Arabic vowel marks are dropped");
  });

  it("stem brings word forms together, both sides alike", () => {
    for (const [a, b] of [["cycling", "cycles"], ["designers", "design"], ["baked", "baking"], ["lives", "live"], ["works", "work"]]) {
      assert.equal(stem(a!), stem(b!), `${a} / ${b}`);
    }
    assert.equal(stem("class"), "class", "a double s is not a plural");
    assert.equal(stem("олега"), "олега", "only Latin words are stemmed");
  });

  it("typo: one edit from five letters, two from nine, swaps count as one", () => {
    assert.equal(distance("stakwork", "stakwrok"), 1);
    assert.ok(typo("priyah", "priya"));
    assert.ok(typo("bouldring", "bouldering"));
    assert.ok(!typo("john", "joan"), "four letters must match exactly");
  });

  it("a query is its terms, without stop words; I/me makes it about the user", () => {
    const tq = textQuery("what's my job");
    assert.deepEqual(tq.terms, ["job"]);
    assert.ok(tq.self);
    assert.ok(!textQuery("where does Kate work").self);
  });

  it("names: capitalised words of a title, and inside a sentence", () => {
    assert.deepEqual(capitalised("Gareth Jones"), ["gareth", "jones"]);
    assert.deepEqual(namedInText("Cycling to work. Gareth Jones moved to Cardiff."), ["jones", "cardiff"], "a sentence's first word is not a name for that");
  });

  it("corrections: a typo of a vocabulary word, or a longer word the term starts", () => {
    assert.deepEqual(corrections("lisbn", ["lisbon", "london"]).map((c) => c.word), ["lisbon"]);
    assert.deepEqual(corrections("renovat", ["renovation", "kitchen"]).map((c) => c.word), ["renovation"]);
    assert.deepEqual(corrections("kitchen", ["kitchen"]), [], "the word itself is no correction");
  });

  it("predicate words come from the predicates' own names", () => {
    const p = predicateWords(["works_at", "LIVES_IN", "knows"]);
    assert.ok(p.get(stem("work"))?.has("works_at"));
    assert.ok(p.get(stem("lived"))?.has("LIVES_IN"));
    assert.equal(p.get("at"), undefined, "a stop word names nothing");
  });

  describe("rankScores", () => {
    const rank = (q: string, docs: MatchDoc[], opts: Parameters<typeof rankScores>[2] = {}) => {
      const scores = rankScores(textQuery(q), docs, opts);
      return docs.map((d, i) => ({ d: d.title ?? d.text, s: scores[i]! })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.d);
    };

    it("rare words outweigh common ones", () => {
      const docs: MatchDoc[] = [
        { text: "Kate likes cooking" },
        { text: "Jon likes cycling" },
        { text: "Sam likes cooking" },
        { text: "Mia likes drawing" },
      ];
      assert.deepEqual(rank("Kate likes", docs)[0], "Kate likes cooking");
    });

    it("a word naming a fact's predicate lifts that fact above its subject", () => {
      const docs: MatchDoc[] = [
        { text: "Kate", title: "Kate" },
        { text: "Kate works at Figma. Kate joined Figma.", predicate: "works_at" },
        { text: "Kate lives in Bath.", predicate: "lives_in" },
        { text: "Jon cycles to work.", predicate: "prefers" },
      ];
      const ranked = rank("where does Kate work", docs, { predicates: predicateWords(["works_at", "lives_in", "prefers"]), total: 200 });
      assert.equal(ranked[0], "Kate works at Figma. Kate joined Figma.");
    });

    it("a name is not stemmed: Jones is not Jon", () => {
      const docs: MatchDoc[] = [{ text: "Gareth Jones lives in Cardiff" }, { text: "Jon lives in Bristol" }];
      assert.deepEqual(rank("Jon", docs, { names: new Set(["jones"]) }), ["Jon lives in Bristol"]);
    });

    it("I/me favours the user's docs", () => {
      const docs: MatchDoc[] = [{ text: "Marcus does not eat pork" }, { text: "The user does not eat meat", self: true }];
      assert.equal(rank("what do I eat", docs)[0], "The user does not eat meat");
    });

    it("a correction counts, below the word itself", () => {
      const docs: MatchDoc[] = [{ text: "Lisbon", title: "Lisbon" }];
      assert.deepEqual(rank("Lisbn", docs), [], "no correction, no match");
      assert.deepEqual(rank("Lisbn", docs, { extra: new Map([["lisbn", corrections("lisbn", ["lisbon"])]]) }), ["Lisbon"]);
    });

    it("unspaced text matches as a substring", () => {
      assert.deepEqual(rank("北京", [{ text: "李明住在北京" }]), ["李明住在北京"]);
    });
  });

  it("unmatched: the terms no doc holds as a word or a substring", () => {
    const docs: MatchDoc[] = [{ text: "Katherine Moss" }];
    assert.deepEqual(unmatched(textQuery("Katherine Lisbn"), docs), ["lisbn"]);
    assert.deepEqual(unmatched(textQuery("Kate"), docs), ["kate"], "no table of short forms: Kate is not Katherine unless the node says so");
  });
});
